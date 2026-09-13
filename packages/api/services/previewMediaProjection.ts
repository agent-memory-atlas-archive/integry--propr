import type { Knex } from 'knex';
import {
  db as defaultDb, getAuthenticatedOctokit, loadMonitoredReposRaw, resolveRepositoryVisualPreviewSettings,
  parsePublishedVisualPreviews, parseGoalArtifacts,
} from '@propr/core';
import { trustedPreviewMedia, type Notification, type PublishedVisualPreview } from '@propr/shared';

export interface PreviewSource { repository: string; prNumbers: number[] }
export interface PreviewProjection { previews: PublishedVisualPreview[]; unavailable?: boolean }
interface Dependencies {
  loadRepos?: typeof loadMonitoredReposRaw;
  getOctokit?: typeof getAuthenticatedOctokit;
}

/** Bounded cache of parsed published bodies only. Policy is re-read before every projection. */
export function createPreviewMediaReader(deps: Dependencies = {}) {
  const cache = new Map<string, { expires: number; value: Promise<PreviewProjection> }>();
  const loadRepos = deps.loadRepos ?? loadMonitoredReposRaw;
  const getOctokit = deps.getOctokit ?? getAuthenticatedOctokit;

  async function enabledRepositories(repositories: string[]): Promise<Set<string>> {
    if (!repositories.length) return new Set();
    try {
      const repos = await loadRepos();
      return new Set(repositories.map(name => name.trim().toLowerCase())
        .filter(name => resolveRepositoryVisualPreviewSettings(repos, name).enabled));
    } catch { return new Set(); } // Fail closed, including legacy/unconfigured repositories.
  }

  async function readPr(repository: string, prNumber: number): Promise<PreviewProjection> {
    const key = `${repository}#${prNumber}`;
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.value;
    const entry = { expires: Date.now() + 60_000, value: Promise.resolve<PreviewProjection>({ previews: [] }) };
    entry.value = (async () => {
      try {
        const [owner, repo] = repository.split('/');
        const octokit = await getOctokit();
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner, repo, pull_number: prNumber, request: { timeout: 4000 },
        });
        return { previews: parsePublishedVisualPreviews(response.data.body) };
      } catch {
        entry.expires = Date.now() + 10_000;
        return { previews: [], unavailable: true };
      }
    })();
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > 512) cache.delete(cache.keys().next().value!);
    return entry.value;
  }

  async function project(sources: readonly PreviewSource[], limit = 3): Promise<PreviewProjection[]> {
    const enabled = await enabledRepositories(sources.filter(source => source.prNumbers.length).map(source => source.repository));
    const reads = new Map<string, { repository: string; number: number }>();
    const keys = sources.map(source => {
      const repository = source.repository.trim().toLowerCase();
      if (!enabled.has(repository) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) return [];
      return [...new Set(source.prNumbers)].filter(number => Number.isSafeInteger(number) && number > 0).map(number => {
        const key = `${repository}#${number}`;
        reads.set(key, { repository, number });
        return key;
      });
    });
    const entries = [...reads.entries()];
    const results = new Map<string, PreviewProjection>();
    let next = 0;
    // One batch response to clients, with deduplicated, bounded GitHub concurrency.
    await Promise.all(Array.from({ length: Math.min(6, entries.length) }, async () => {
      while (next < entries.length) {
        const [key, source] = entries[next++];
        results.set(key, await readPr(source.repository, source.number));
      }
    }));
    return keys.map(sourceKeys => ({
      previews: trustedPreviewMedia(sourceKeys.flatMap(key => results.get(key)?.previews ?? []), limit),
      ...(sourceKeys.some(key => results.get(key)?.unavailable) ? { unavailable: true } : {}),
    }));
  }

  return { project, enabledRepositories };
}

export const previewMediaReader = createPreviewMediaReader();

function record(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function taskPreviewSource(row: Record<string, unknown>): PreviewSource {
  const initial = record(row.initial_job_data);
  const result = record(row.final_result);
  return { repository: String(row.repository ?? ''), prNumbers: [
    row.pr_number || initial.pullRequestNumber || record(record(result.postProcessing).pr).number,
  ].filter((number): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0) };
}

export function goalPreviewSource(row: { repository: string; final_pr_number: number | null; artifact_refs: unknown }): PreviewSource {
  const artifacts = parseGoalArtifacts(row.artifact_refs as string | null);
  return { repository: row.repository, prNumbers: [
    ...(row.final_pr_number ? [row.final_pr_number] : []),
    ...artifacts.filter(artifact => artifact?.type === 'pull_request'
      && artifact.url === `https://github.com/${row.repository}/pull/${artifact.number}`).map(artifact => artifact.number),
  ] };
}

export async function projectNotificationPreviews(
  notifications: readonly Notification[], reader = previewMediaReader, database: Knex = defaultDb,
): Promise<Notification[]> {
  const sources = notifications.map(notification => notification.kind === 'task' && notification.severity === 'success'
    ? { repository: notification.target.repository, prNumbers: notification.target.prNumber ? [notification.target.prNumber] : [] }
    : { repository: '', prNumbers: [] });
  // Older immutable completion events may predate the task's persisted PR identity.
  const missing = notifications.filter(notification => notification.kind === 'task'
    && notification.severity === 'success' && !notification.target.prNumber);
  if (missing.length) {
    const enabled = await reader.enabledRepositories(missing.map(notification => notification.target.type === 'task' ? notification.target.repository : ''));
    const taskIds = missing.flatMap(notification => notification.kind === 'task'
      && enabled.has(notification.target.repository.trim().toLowerCase()) ? [notification.target.taskId] : []);
    if (taskIds.length) {
      try {
        const tasks = await database('tasks').whereIn('task_id', taskIds)
          .where(function () { this.whereNull('task_type').orWhereNot('task_type', 'goal'); })
          .select('task_id', 'repository', 'pr_number', 'initial_job_data', 'final_result');
        const byId = new Map(tasks.map(row => [row.task_id, taskPreviewSource(row)]));
        notifications.forEach((notification, index) => {
          if (notification.kind !== 'task' || notification.severity !== 'success' || sources[index].prNumbers.length) return;
          const source = byId.get(notification.target.taskId);
          if (source?.repository.toLowerCase() === notification.target.repository.trim().toLowerCase()) sources[index] = source;
        });
      } catch { /* Optional media must not make the Inbox unavailable. */ }
    }
  }
  const media = await reader.project(sources, 1);
  return notifications.map((notification, index) => {
    const fields = { ...notification };
    delete fields.previewMedia;
    return { ...fields, ...(media[index].previews.length ? { previewMedia: media[index].previews } : {}) } as Notification;
  });
}
