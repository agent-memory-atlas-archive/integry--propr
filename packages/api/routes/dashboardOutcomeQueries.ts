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
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

interface CompletionRow extends DashboardTaskRow {
  completionId: number;
}

export interface CompletionUpdate extends CompletionRow {
  /**
   * What the run actually produced, from the recap recorded on its completion,
   * or null when the only thing recorded is that it finished.
   */
  recap: string | null;
  /** Review score out of 10; only reviews carry one, and only when recorded. */
  reviewScore: number | null;
}

export interface CompletedRow extends CompletionUpdate {
  /** Includes the latest outcome; earlierUpdates excludes it. */
  eventCount: number;
  earlierUpdates: CompletionUpdate[];
}

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
async function loadCompletionDetails(db: Knex, rows: readonly CompletionRow[]): Promise<Map<number, CompletionDetails>> {
  const details = new Map<number, CompletionDetails>();
  for (const batch of chunk([...new Set(rows.map(row => row.taskId))])) {
    const history = await db('task_history')
      .whereIn('task_id', batch)
      .whereIn('state', ['completed', ...RUN_START_STATES])
      .select('task_id', 'history_id', 'state', 'timestamp', 'metadata')
      .orderBy([{ column: 'timestamp', order: 'desc' }, { column: 'history_id', order: 'desc' }]) as Array<Record<string, unknown>>;
    const byTask = new Map<string, Array<Record<string, unknown>>>();
    for (const entry of history) {
      const taskId = String(entry.task_id);
      const entries = byTask.get(taskId) ?? [];
      entries.push(entry);
      byTask.set(taskId, entries);
    }
    for (const row of rows.filter(row => byTask.has(row.taskId))) {
      const current: CompletionDetails = { recap: null, commandMode: null };
      let found = false;
      for (const entry of byTask.get(row.taskId)!) {
        if (!found && Number(entry.history_id) !== row.completionId) continue;
        found = true;
        const metadata = parseJsonObject(entry.metadata);
        current.commandMode ??= typeof metadata.commandMode === 'string' ? metadata.commandMode : null;
        if (entry.state !== 'completed') break;
        current.recap ??= meaningfulRecap(recapFrom(metadata));
      }
      details.set(row.completionId, current);
    }
  }
  return details;
}

function isReviewRun(row: DashboardTaskRow, commandMode: string | null): boolean {
  if (commandMode !== null) return commandMode === 'review';
  return row.taskType === 'review' || /^Review PR #\d+:/i.test(row.title ?? '');
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
 * count of completed runs behind it. Duplicate terminal transitions within a
 * run and skipped work remain excluded, while a later run cannot erase a review.
 *
 * Identity follows mapTaskRow's PR resolution, including legacy PR task IDs
 * and PRs recorded only in final_result. Goal and issue keys are fallbacks;
 * repository and entity kind are both part of the partition.
 */
function entityCompletions(db: Knex, repository: string): Knex.QueryBuilder {
  // Keep one outcome per run, not per task: a review and a subsequent fix can
  // reuse the same task ID. Consecutive completion writes are still one run.
  const history = db('task_history')
    .whereIn('state', ['completed', ...RUN_START_STATES])
    .select('task_id', 'history_id', 'state', 'timestamp', 'reason').select(db.raw(`
    SUM(CASE WHEN state IN (${RUN_START_STATES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END)
      OVER (PARTITION BY task_id ORDER BY timestamp, history_id) AS run_id
  `, [...RUN_START_STATES]));
  const runs = db.from('completion_history').where('state', 'completed')
    .where(query => query.whereNull('reason').orWhereNot('reason', 'like', SKIPPED_REASON_PATTERN))
    .select('*').select(db.raw(`ROW_NUMBER() OVER (
      PARTITION BY task_id, run_id ORDER BY timestamp DESC, history_id DESC
    ) AS completion_rank`));
  const completed = db('tasks as t').join('completion_runs as h', 'h.task_id', 't.task_id')
    .where('h.completion_rank', 1)
    .where(query => query.whereNull('t.task_type').orWhereNot('t.task_type', 'goal'))
    .modify(query => { if (repository && repository !== 'all') query.where('t.repository', repository); })
    .select(TASK_COLUMNS).select('h.history_id');
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
  // Window sorts must not carry the task's potentially megabyte-sized job
  // and result JSON. Resolve identity/title first, rank compact rows, then
  // retrieve payloads for the selected outcomes.
  const entities = db.from('numbered').select(
    'task_id', 'repository', 'issue_number', 'pr_number', 'task_type', 'model_name',
    'created_at', 'state', 'state_timestamp', 'reason', 'history_id',
    'resolved_title',
  ).select(db.raw(`
    CASE
      WHEN entity_pr_number IS NOT NULL THEN 'pr:' || entity_pr_number
      WHEN entity_goal_id IS NOT NULL THEN 'goal:' || entity_goal_id
      WHEN issue_number IS NOT NULL THEN 'issue:' || issue_number
      ELSE 'task:' || task_id
    END AS entity_key
  `));
  const ranked = db.from('entities').select('*').select(db.raw(`
    ROW_NUMBER() OVER (
      PARTITION BY repository, entity_key ORDER BY state_timestamp DESC, task_id DESC, history_id DESC
    ) AS entity_rank,
    COUNT(*) OVER (PARTITION BY repository, entity_key) AS event_count,
    FIRST_VALUE(resolved_title) OVER (
      PARTITION BY repository, entity_key
      ORDER BY (resolved_title IS NULL), state_timestamp DESC, task_id DESC, history_id DESC
    ) AS entity_title
  `));
  return db.with('completion_history', history).with('completion_runs', runs).with('completed', completed).with('numbered', numbered)
    .with('entities', entities).with('ranked', ranked)
    .from('ranked');
}

/** Recent entity outcomes, optionally narrowed by their decoded title. */
export async function loadCompletedRows(
  db: Knex,
  repository: string,
  options: { limit?: number; search?: string } = {},
): Promise<CompletedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const search = options.search?.trim().toLowerCase() ?? '';
  type EntityRow = RawTaskRow & { history_id: number; event_count: number; entity_key: string; entity_title: string | null };
  // Choose parents before hydrating any task JSON. Searching decodes titles
  // with JavaScript's Unicode case folding, as before, but reads the compact
  // parent titles once instead of rerunning all windows for every 500 matches.
  const parents = () => db.from('ranked').where('entity_rank', 1)
    .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }]);
  let selectedKeys: Array<[string, string]> | undefined;
  if (search) {
    const titles = await entityCompletions(db, repository).where('entity_rank', 1)
      .select('repository', 'entity_key', 'entity_title')
      .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }]) as EntityRow[];
    selectedKeys = titles.filter(row => (row.entity_title ?? '').toLowerCase().includes(search))
      .slice(0, limit).map(row => [row.repository, row.entity_key]);
    if (selectedKeys.length === 0) return [];
  }

  // A single materialized ranking supplies both parents and earlier updates.
  // Limiting parents never limits an entity's history or changes its count.
  const selectedQuery = entityCompletions(db, repository);
  if (selectedKeys) selectedQuery.whereIn(['repository', 'entity_key'], selectedKeys);
  else selectedQuery.whereIn(['repository', 'entity_key'], parents().select('repository', 'entity_key').limit(limit));
  const selected = await selectedQuery.select('*')
    .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }, { column: 'history_id', order: 'desc' }]) as Array<EntityRow & { entity_rank: number }>;
  const payloads = new Map<string, Pick<RawTaskRow, 'initial_job_data' | 'final_result'>>();
  for (const batch of chunk([...new Set(selected.map(row => row.task_id))])) {
    for (const row of await db('tasks').whereIn('task_id', batch)
      .select('task_id', 'initial_job_data', 'final_result')) payloads.set(row.task_id, row);
  }
  const hydrate = (row: EntityRow): CompletionRow => ({
    ...mapTaskRow({ ...row, ...payloads.get(row.task_id) }), completionId: row.history_id,
  });
  const visible = selected.filter(row => Number(row.entity_rank) === 1).map(row => ({
    ...hydrate(row), title: row.entity_title, eventCount: Number(row.event_count), entityKey: row.entity_key,
  }));
  const earlier = selected.filter(row => Number(row.entity_rank) > 1);
  const earlierRows = earlier.map(hydrate);
  const details = await loadCompletionDetails(db, [...visible, ...earlierRows]);
  const withDetails = (row: CompletionRow): CompletionUpdate => {
    const detail = details.get(row.completionId) ?? { recap: null, commandMode: null };
    if (isReviewRun(row, detail.commandMode)) {
      const review = splitReviewRecap(detail.recap);
      return { ...row, taskType: 'review', recap: meaningfulRecap(review.detail), reviewScore: review.score };
    }
    const taskType = detail.commandMode === 'default' ? 'follow-up' : detail.commandMode ?? row.taskType;
    return { ...row, taskType, recap: meaningfulRecap(detail.recap), reviewScore: null };
  };
  const updates = new Map<string, CompletionUpdate[]>();
  for (const [index, raw] of earlier.entries()) {
    const key = JSON.stringify([raw.repository, raw.entity_key]);
    const group = updates.get(key) ?? [];
    group.push(withDetails(earlierRows[index]));
    updates.set(key, group);
  }
  return visible.map(row => ({
    ...withDetails(row), eventCount: row.eventCount,
    earlierUpdates: updates.get(JSON.stringify([row.repository, row.entityKey])) ?? [],
  }));
}
