/**
 * Recorded completions — the dashboard's second source of truth.
 *
 * The "Completed" feed lists one outcome per entity, newest first.
 * Completions are recorded events, so they are read from task history rather
 * than from a task's current state: a run that completed and is now being
 * followed up still completed.
 *
 * Failures are not listed here: an unresolved failure is something a person
 * has to act on, so it belongs in the attention list. Cancellations and jobs
 * that were skipped or rescheduled are bookkeeping, not results, and appear in
 * neither.
 */

import type { Knex } from 'knex';
import {
  chunk,
  mapTaskRow,
  QUEUED_TASK_STATES,
  RUNNING_TASK_STATES,
  TASK_COLUMNS,
  terminalTransitionQuery,
  toIso,
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

export interface CompletedRow extends DashboardTaskRow {
  /** Completed task outcomes rolled into this entity, excluding duplicate transitions. */
  eventCount: number;
  /**
   * What the run actually produced, from the recap recorded on its completion,
   * or null when the only thing recorded is that it finished.
   */
  recap: string | null;
  /** Review score out of 10; only reviews carry one, and only when recorded. */
  reviewScore: number | null;
}

/** Candidates read per page while a title search looks for its matches. */
const SEARCH_PAGE_SIZE = 500;

/**
 * A completion recorded for a job that decided there was nothing to do. It is
 * stored as `completed` so the run is not retried, but nothing was produced.
 */
const SKIPPED_REASON_PATTERN = 'PR comment job skipped%';

/** Recaps that only restate that the run finished, which the feed already says. */
const GENERIC_RECAPS = new Set([
  'completed the pull request follow-up.',
]);

/** `Score 8/10` or `Scores 8/10, 6/10`, as written by the review recap. */
const REVIEW_SCORE_PART = /^Scores?\s+(.+)$/i;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function recapFrom(metadata: Record<string, unknown>): string | null {
  const direct = metadata.notificationRecap;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const prResult = parseJsonObject(metadata.prResult).notificationRecap;
  return typeof prResult === 'string' && prResult.trim() ? prResult.trim() : null;
}

interface CompletionDetails {
  recap: string | null;
  commandMode: string | null;
}

/**
 * States that open a run. A completion is terminal, so a task that records one
 * of these after completing has been started again, and what it records from
 * then on belongs to the new run.
 */
const RUN_START_STATES: readonly string[] = [...QUEUED_TASK_STATES, ...RUNNING_TASK_STATES];

/**
 * The newest recap and command mode recorded by the run each row's completion
 * belongs to.
 *
 * A run can record more than one completion ("implementation completed",
 * then "PR ready"), and the recap is not always on the newest one, so every
 * completion of that run is read and the newest that says something wins. The
 * run's history is read back from the listed completion and stops where the
 * run started: a task that is followed up runs again under the same id, and a
 * recap or review score from an earlier run must not be shown as the result of
 * a later one that recorded none.
 */
async function loadCompletionDetails(db: Knex, rows: readonly DashboardTaskRow[]): Promise<Map<string, CompletionDetails>> {
  const details = new Map<string, CompletionDetails>();
  const completedAt = new Map(rows.map(row => [row.taskId, Date.parse(row.stateTimestamp)]));
  const runStarted = new Set<string>();
  for (const batch of chunk(rows.map(row => row.taskId))) {
    const history = await db('task_history')
      .whereIn('task_id', batch)
      .whereIn('state', ['completed', ...RUN_START_STATES])
      .select('task_id', 'state', 'timestamp', 'metadata')
      .orderBy([{ column: 'timestamp', order: 'desc' }, { column: 'history_id', order: 'desc' }]) as Array<Record<string, unknown>>;
    for (const entry of history) {
      const taskId = String(entry.task_id);
      if (runStarted.has(taskId)) continue;
      // Anything after the listed completion belongs to a later run, including
      // a restart recorded in the same millisecond, which sorts before it.
      if (Date.parse(toIso(entry.timestamp)) > (completedAt.get(taskId) ?? Number.NEGATIVE_INFINITY)) continue;
      if (entry.state !== 'completed') {
        if (details.has(taskId)) runStarted.add(taskId);
        continue;
      }
      const metadata = parseJsonObject(entry.metadata);
      const current = details.get(taskId) ?? { recap: null, commandMode: null };
      const commandMode = typeof metadata.commandMode === 'string' ? metadata.commandMode : null;
      details.set(taskId, {
        recap: current.recap ?? recapFrom(metadata),
        commandMode: current.commandMode ?? commandMode,
      });
    }
  }
  return details;
}

function isReviewRun(row: DashboardTaskRow, commandMode: string | null): boolean {
  return commandMode === 'review' || row.taskType === 'review' || /^Review PR #\d+:/i.test(row.title ?? '');
}

/**
 * A review recap split into its score and the part worth reading.
 *
 * The recap reads `Score 8/10 · 2 issues found: …`. The score becomes the
 * row's score badge — with more than one reviewer, the lowest, because that is
 * the one that decides whether the pull request is ready — and what remains is
 * the detail line.
 */
function splitReviewRecap(recap: string | null): { score: number | null; detail: string | null } {
  if (!recap) return { score: null, detail: null };
  let score: number | null = null;
  const rest: string[] = [];
  for (const part of recap.split(' · ')) {
    const scorePart = REVIEW_SCORE_PART.exec(part.trim());
    if (scorePart) {
      const scores = [...scorePart[1].matchAll(/(\d+(?:\.\d+)?)\s*\/\s*10/g)].map(match => Number(match[1]));
      if (scores.length > 0) score = Math.min(...scores);
      continue;
    }
    rest.push(part);
  }
  const detail = rest.join(' · ').trim();
  return { score, detail: detail || null };
}

function meaningfulRecap(recap: string | null): string | null {
  if (!recap) return null;
  return GENERIC_RECAPS.has(recap.toLowerCase()) ? null : recap;
}

/**
 * Group before limiting or searching so retries cannot crowd other entities
 * off the page. Keep the newest outcome (and its own recap/score), with the
 * count of completed tasks behind it. Duplicate terminal transitions within a
 * task and skipped work remain excluded by terminalTransitionQuery.
 *
 * Identity follows mapTaskRow's PR resolution, including legacy PR task IDs
 * and PRs recorded only in final_result. Goal and issue keys are fallbacks;
 * repository and entity kind are both part of the partition.
 */
function entityCompletions(db: Knex, repository: string): Knex.QueryBuilder {
  const completed = terminalTransitionQuery(db, repository, 'completed', { excludeReasonLike: SKIPPED_REASON_PATTERN })
    .select(TASK_COLUMNS);
  const validJob = "CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END";
  const validResult = "CASE WHEN json_valid(final_result) THEN final_result ELSE '{}' END";
  const numbered = db.from('completed').select('*').select(db.raw(`
    COALESCE(pr_number,
      CASE WHEN json_type(${validJob}, '$.pullRequestNumber') IN ('integer', 'real')
        THEN json_extract(${validJob}, '$.pullRequestNumber') END,
      CASE WHEN task_type IN ('pr-comment', 'review', 'merge_conflict')
        OR substr(task_id, 1, 11) = 'pr-comment-'
        OR substr(task_id, 1, 12) = 'pr-comments-'
        THEN issue_number END,
      CASE WHEN json_type(${validResult}, '$.postProcessing.pr.number') IN ('integer', 'real')
        THEN json_extract(${validResult}, '$.postProcessing.pr.number') END
    ) AS entity_pr_number,
    CASE WHEN json_type(${validJob}, '$.goalId') = 'text'
      THEN NULLIF(trim(json_extract(${validJob}, '$.goalId')), '') END AS entity_goal_id,
    COALESCE(
      CASE WHEN json_type(${validJob}, '$.title') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.title')), '') END,
      CASE WHEN json_type(${validJob}, '$.issueRef.title') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.issueRef.title')), '') END,
      CASE WHEN json_type(${validJob}, '$.branchName') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.branchName')), '') END
    ) AS resolved_title
  `));
  const entities = db.from('numbered').select('*').select(db.raw(`
    CASE
      WHEN entity_pr_number IS NOT NULL THEN 'pr:' || entity_pr_number
      WHEN entity_goal_id IS NOT NULL THEN 'goal:' || entity_goal_id
      WHEN issue_number IS NOT NULL THEN 'issue:' || issue_number
      ELSE 'task:' || task_id
    END AS entity_key
  `));
  const ranked = db.from('entities').select('*').select(db.raw(`
    ROW_NUMBER() OVER (
      PARTITION BY repository, entity_key ORDER BY state_timestamp DESC, task_id DESC
    ) AS entity_rank,
    COUNT(*) OVER (PARTITION BY repository, entity_key) AS event_count,
    FIRST_VALUE(resolved_title) OVER (
      PARTITION BY repository, entity_key
      ORDER BY (resolved_title IS NULL), state_timestamp DESC, task_id DESC
    ) AS entity_title
  `));
  return db.with('completed', completed).with('numbered', numbered)
    .with('entities', entities).with('ranked', ranked)
    .from('ranked').where('entity_rank', 1);
}

/** Recent entity outcomes, optionally narrowed by their decoded title. */
export async function loadCompletedRows(
  db: Knex,
  repository: string,
  options: { limit?: number; search?: string } = {},
): Promise<CompletedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const search = options.search?.trim().toLowerCase() ?? '';
  type EntityRow = RawTaskRow & { event_count: number; entity_title: string | null };
  const candidates = (after: EntityRow | null, pageSize: number): Knex.QueryBuilder => {
    const query = entityCompletions(db, repository)
      .select('*')
      .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }])
      .limit(pageSize);
    if (after) {
      query.where(function (this: Knex.QueryBuilder) {
        this.where('state_timestamp', '<', after.state_timestamp)
          .orWhere(function (this: Knex.QueryBuilder) {
            this.where('state_timestamp', '=', after.state_timestamp).andWhere('task_id', '<', after.task_id);
          });
      });
    }
    return query;
  };

  const mapped: Array<DashboardTaskRow & { eventCount: number }> = [];
  let after: EntityRow | null = null;
  const pageSize = search ? SEARCH_PAGE_SIZE : limit;
  do {
    const page = await candidates(after, pageSize) as EntityRow[];
    for (const row of page) {
      const mappedRow = { ...mapTaskRow(row), title: row.entity_title };
      if (!search || (mappedRow.title ?? '').toLowerCase().includes(search)) {
        mapped.push({ ...mappedRow, eventCount: Number(row.event_count) });
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1];
  } while (mapped.length < limit);
  const visible = mapped.slice(0, limit);
  if (visible.length === 0) return [];

  const details = await loadCompletionDetails(db, visible);
  return visible.map(row => {
    const detail = details.get(row.taskId) ?? { recap: null, commandMode: null };
    if (isReviewRun(row, detail.commandMode)) {
      const review = splitReviewRecap(detail.recap);
      return { ...row, recap: meaningfulRecap(review.detail), reviewScore: review.score };
    }
    return { ...row, recap: meaningfulRecap(detail.recap), reviewScore: null };
  });
}
