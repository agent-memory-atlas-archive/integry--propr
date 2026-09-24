/**
 * Shared dashboard queries.
 *
 * The dashboard answers four questions from three sources of truth: task state
 * (running, queued, blocked), outcome events (recent history) and aggregated
 * execution data (stats). Every count the dashboard shows is derived here so
 * `/api/dashboard/summary`, `/api/dashboard/active`, `/api/dashboard/attention`
 * and the task pages cannot drift apart.
 *
 * Attention is derived from work state only. Notification read/dismissal state
 * lives in `notification_user_states` and is deliberately never read here:
 * dismissing a notification must not resolve a blocker.
 */

import type { Knex } from 'knex';
// Type-only: the enum's runtime module reaches the shared DB connection, which
// route modules must not import. The assertion below keeps the literals below
// tied to `PlanIssueStatus` at compile time.
import type { PlanIssueStatus } from '@propr/core';
import { loadCritiqueScores, toScoreNumber } from './critiqueScore.js';

/** Worker lifecycle states the UI labels "Active"/"Implementing". */
export const RUNNING_TASK_STATES = ['processing', 'claude_execution', 'post_processing', 'active'] as const;

/** Worker lifecycle states the UI labels "Waiting". */
export const QUEUED_TASK_STATES = ['pending', 'queued', 'waiting'] as const;

/**
 * Explicit "a human must act" task states. These mirror the states
 * `apps/desktop/src/native-notifications.ts` already treats as attention
 * states, including both their snake_case and kebab-case spellings.
 */
export const ATTENTION_TASK_STATES = [
  'action_required', 'action-required', 'needs_attention', 'needs-attention',
] as const;

/** Terminal lifecycle states. Cancelled work is terminal but not an outcome of quality. */
export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Plan issue statuses that await a human decision.
 *
 * `under_review` means a pull request is open and nobody has decided about it
 * yet. `pending` (never started) is backlog, and `in_refinement` /
 * `refinement_processing` / `processing` are states the system is working
 * through on its own, so none of them belong in an attention list.
 */
export const HUMAN_DECISION_PLAN_ISSUE_STATUSES = ['under_review'] as const;

// Compile-time proof that the literals above remain real PlanIssueStatus values.
type AssertPlanIssueStatuses =
  typeof HUMAN_DECISION_PLAN_ISSUE_STATUSES[number] extends `${PlanIssueStatus}` ? true : never;
const PLAN_ISSUE_STATUSES_ARE_VALID: AssertPlanIssueStatuses = true;
void PLAN_ISSUE_STATUSES_ARE_VALID;

/**
 * How far back an unresolved failure is still considered actionable, and how
 * many *finished* rows a single dashboard read will project.
 *
 * `MAX_WORK_ROWS` bounds recent completions only. Open work — running, queued
 * and action-required tasks — and the unresolved failures behind the attention
 * count are never truncated by it: a display limit that drops a running task
 * would make the running count claim that work does not exist.
 */
export const WORK_LOOKBACK_DAYS = 14;
export const MAX_WORK_ROWS = 2000;

/** Bound on one `IN (...)` list, so a large failure set cannot overflow a bind limit. */
const ID_CHUNK_SIZE = 500;

function chunk<T>(values: readonly T[], size: number = ID_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/** Rolling window used by the summary strip's "completed" count. */
export const RECENT_COMPLETION_WINDOW_HOURS = 24;

const RUNNING = new Set<string>(RUNNING_TASK_STATES);
const QUEUED = new Set<string>(QUEUED_TASK_STATES);
const ATTENTION = new Set<string>(ATTENTION_TASK_STATES);

export const isRunningState = (state: string): boolean => RUNNING.has(state);
export const isQueuedState = (state: string): boolean => QUEUED.has(state);
export const isAttentionState = (state: string): boolean => ATTENTION.has(state);

/** Human-readable phase for a lifecycle state. Never a synthesised percentage. */
export function phaseLabel(state: string): string | null {
  if (state === 'processing') return 'Preparing';
  if (state === 'claude_execution') return 'Implementing';
  if (state === 'post_processing') return 'Finishing up';
  if (state === 'active') return 'Running';
  if (isQueuedState(state)) return 'Waiting';
  return null;
}

export interface DashboardTaskRow {
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  taskType: string | null;
  modelName: string | null;
  title: string | null;
  state: string;
  stateTimestamp: string;
  reason: string | null;
  createdAt: string;
}

interface RawTaskRow {
  task_id: string;
  repository: string;
  issue_number: number | null;
  pr_number?: number | null;
  task_type: string | null;
  model_name: string | null;
  initial_job_data: unknown;
  final_result?: unknown;
  state: string;
  state_timestamp: string;
  reason: string | null;
  created_at: string;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function taskTitle(initialJobData: unknown): string | null {
  const jobData = parseJson(initialJobData);
  if (!jobData) return null;
  if (typeof jobData.title === 'string' && jobData.title.trim()) return jobData.title;
  const issueRef = parseJson(jobData.issueRef);
  return typeof issueRef?.title === 'string' && issueRef.title.trim() ? issueRef.title : null;
}

function taskPrNumber(row: RawTaskRow): number | null {
  if (typeof row.pr_number === 'number') return row.pr_number;
  const jobData = parseJson(row.initial_job_data);
  if (typeof jobData?.pullRequestNumber === 'number') return jobData.pullRequestNumber;
  const finalResult = parseJson(row.final_result);
  const postProcessing = parseJson(finalResult?.postProcessing);
  const pullRequest = parseJson(postProcessing?.pr);
  return typeof pullRequest?.number === 'number' ? pullRequest.number : null;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

function mapTaskRow(row: RawTaskRow): DashboardTaskRow {
  return {
    taskId: String(row.task_id),
    repository: String(row.repository),
    issueNumber: row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number),
    prNumber: taskPrNumber(row),
    taskType: row.task_type ?? null,
    modelName: row.model_name ?? null,
    title: taskTitle(row.initial_job_data),
    state: String(row.state),
    stateTimestamp: toIso(row.state_timestamp),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Every task joined to its own latest history row.
 *
 * Goal tasks are excluded exactly as `getTasksFromDb` excludes them, so the
 * dashboard and the task pages count the same population.
 */
export function latestTaskStateQuery(db: Knex, repository: string): Knex.QueryBuilder {
  const query = db('tasks as t')
    .where(function (this: Knex.QueryBuilder) {
      this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
    })
    .joinRaw(`
      JOIN task_history AS h ON h.history_id = (
        SELECT latest_h.history_id
        FROM task_history AS latest_h
        WHERE latest_h.task_id = t.task_id
        ORDER BY latest_h.timestamp DESC
        LIMIT 1
      )
    `);
  if (repository && repository !== 'all') query.where('t.repository', repository);
  return query;
}

const TASK_COLUMNS = [
  't.task_id', 't.repository', 't.issue_number', 't.pr_number', 't.task_type', 't.model_name',
  't.initial_job_data', 't.final_result', 't.created_at',
  'h.state', 'h.timestamp as state_timestamp', 'h.reason',
];

/** A completion that can supersede a failure in the same thread. */
export interface ThreadCompletion {
  key: string;
  completedAt: string;
}

/**
 * One dashboard read's task rows, split by how each set may be bounded.
 *
 * `open` and `failed` decide counts the dashboard states as fact, so neither
 * is truncated. Only `recentlyCompleted` — a display sample — carries a row
 * limit, and the count beside it is read from the database rather than from
 * the sample, so a limit can never shrink a number.
 */
export interface DashboardWorkRows {
  /** Every task whose latest state is running, queued or action-required. */
  open: DashboardTaskRow[];
  /** Every task whose latest state is a failure inside the lookback window. */
  failed: DashboardTaskRow[];
  /** Completions that could supersede one of `failed`, whatever the row limit. */
  supersedingCompletions: ThreadCompletion[];
  /** A bounded, newest-first sample of completions inside the recent window. */
  recentlyCompleted: DashboardTaskRow[];
  /** How many completions the recent window actually holds. */
  completedRecentlyCount: number;
}

/**
 * Completions that can retire one of the loaded failures.
 *
 * Only the issue threads that actually have a failure are read, so recovery
 * detection stays correct without loading every completion on the instance.
 * A failure on a task with no issue number is its own thread, and that task's
 * latest state is the failure, so no completion can supersede it.
 */
async function loadSupersedingCompletions(
  db: Knex,
  repository: string,
  failed: readonly DashboardTaskRow[],
  since: string,
): Promise<ThreadCompletion[]> {
  const issueNumbers = [...new Set(
    failed.map(row => row.issueNumber).filter((value): value is number => value !== null),
  )];
  if (issueNumbers.length === 0) return [];

  const completions: ThreadCompletion[] = [];
  for (const batch of chunk(issueNumbers)) {
    const rows = await latestTaskStateQuery(db, repository)
      .where('h.state', 'completed')
      .where('h.timestamp', '>=', since)
      .whereIn('t.issue_number', batch)
      .select('t.task_id', 't.repository', 't.issue_number', 'h.timestamp as state_timestamp') as Array<Record<string, unknown>>;
    for (const row of rows) {
      completions.push({
        key: workKey({
          repository: String(row.repository),
          issueNumber: row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number),
          taskId: String(row.task_id),
        }),
        completedAt: toIso(row.state_timestamp),
      });
    }
  }
  return completions;
}

/**
 * Loads the open work set plus the finished work the dashboard reasons about.
 *
 * Open work and unresolved failures are read in full: they are what the
 * running, queued and attention counts describe. Completed work is bounded by
 * `WORK_LOOKBACK_DAYS` because a completion older than that cannot retire a
 * listed failure, and the recent-completion sample is bounded by
 * `MAX_WORK_ROWS` while its count is aggregated in the database.
 */
export async function loadDashboardWorkRows(
  db: Knex,
  repository: string,
  options: { now?: Date; lookbackDays?: number; recentWindowHours?: number } = {},
): Promise<DashboardWorkRows> {
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? WORK_LOOKBACK_DAYS;
  const lookback = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const recentWindowHours = options.recentWindowHours ?? RECENT_COMPLETION_WINDOW_HOURS;
  const recentSince = new Date(now.getTime() - recentWindowHours * 60 * 60 * 1000).toISOString();
  const openStates = [...RUNNING_TASK_STATES, ...QUEUED_TASK_STATES, ...ATTENTION_TASK_STATES];

  const recentCompletions = (): Knex.QueryBuilder => latestTaskStateQuery(db, repository)
    .where('h.state', 'completed')
    .where('h.timestamp', '>=', recentSince);

  const [openRows, failedRows, recentRows, recentCount] = await Promise.all([
    latestTaskStateQuery(db, repository)
      .whereIn('h.state', openStates)
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc') as unknown as Promise<RawTaskRow[]>,
    latestTaskStateQuery(db, repository)
      .where('h.state', 'failed')
      .where('h.timestamp', '>=', lookback)
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc') as unknown as Promise<RawTaskRow[]>,
    recentCompletions()
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc')
      .limit(MAX_WORK_ROWS) as unknown as Promise<RawTaskRow[]>,
    recentCompletions().count({ total: '*' }).first() as Promise<{ total?: number | string } | undefined>,
  ]);

  const failed = failedRows.map(mapTaskRow);
  return {
    open: openRows.map(mapTaskRow),
    failed,
    supersedingCompletions: await loadSupersedingCompletions(db, repository, failed, lookback),
    recentlyCompleted: recentRows.map(mapTaskRow),
    completedRecentlyCount: Number(recentCount?.total ?? 0),
  };
}

export interface PlanIssueDecisionRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
  taskId: string | null;
  updatedAt: string;
}

/**
 * The run behind a plan issue that never recorded one.
 *
 * A pull request under review was produced by a task, but older plan issues
 * were written without the link. Resolving the newest task on the same issue
 * thread gives the decision the same task identity the rest of the dashboard
 * uses, so the list a count opens can show the work the count is about.
 */
async function resolveDecisionTasks(
  db: Knex,
  repository: string,
  decisions: readonly PlanIssueDecisionRow[],
): Promise<Map<string, string>> {
  const issueNumbers = [...new Set(decisions.filter(row => row.taskId === null).map(row => row.issueNumber))];
  if (issueNumbers.length === 0) return new Map();

  const newestByThread = new Map<string, string>();
  for (const batch of chunk(issueNumbers)) {
    const query = db('tasks as t')
      .where(function (this: Knex.QueryBuilder) {
        this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
      })
      .whereIn('t.issue_number', batch)
      .select('t.task_id', 't.repository', 't.issue_number')
      // Ascending, so the last write for a thread is its newest run.
      .orderBy('t.created_at', 'asc');
    if (repository && repository !== 'all') query.where('t.repository', repository);
    for (const row of await query as Array<Record<string, unknown>>) {
      newestByThread.set(`${String(row.repository)}#${Number(row.issue_number)}`, String(row.task_id));
    }
  }
  return newestByThread;
}

/** Plan issues waiting on a human decision, oldest first. */
export async function loadPlanIssueDecisions(db: Knex, repository: string): Promise<PlanIssueDecisionRow[]> {
  const query = db('plan_issues')
    .whereIn('status', [...HUMAN_DECISION_PLAN_ISSUE_STATUSES])
    .select('id', 'repository', 'issue_number', 'pr_number', 'status', 'task_id', 'updated_at')
    .orderBy('updated_at', 'asc')
    .limit(MAX_WORK_ROWS);
  if (repository && repository !== 'all') query.where('repository', repository);

  const rows = await query as Array<Record<string, unknown>>;
  const decisions = rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    updatedAt: toIso(row.updated_at),
  }));

  const resolved = await resolveDecisionTasks(db, repository, decisions);
  return decisions.map(decision => decision.taskId !== null
    ? decision
    : { ...decision, taskId: resolved.get(`${decision.repository}#${decision.issueNumber}`) ?? null });
}

/**
 * The thread a task belongs to. Follow-ups, retries and PR comment runs for the
 * same issue or pull request share a key, so a newer run can supersede an older
 * failure. Tasks without an issue number are their own thread.
 */
export function workKey(row: Pick<DashboardTaskRow, 'repository' | 'issueNumber' | 'taskId'>): string {
  return row.issueNumber === null ? `${row.repository}#task:${row.taskId}` : `${row.repository}#${row.issueNumber}`;
}

export interface AttentionItem {
  id: string;
  category: 'blocked' | 'decision';
  kind: 'task_failed' | 'task_action_required' | 'plan_review';
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  state: string;
  detail: string | null;
  since: string;
}

export interface DashboardWorkProjection {
  running: DashboardTaskRow[];
  queued: DashboardTaskRow[];
  attention: AttentionItem[];
  /** A capped sample; `counts.completedRecently` is the real total. */
  recentlyCompleted: DashboardTaskRow[];
  counts: {
    needsAttention: number;
    running: number;
    queued: number;
    completedRecently: number;
  };
}

/**
 * Derives every dashboard work list and count from one row set.
 *
 * Recovery-aware exclusion: a failure is suppressed while the same thread has
 * running or queued work, or once a later run of that thread has completed.
 * The system is already fixing it, so it belongs in `active`, not `attention`.
 */
export function projectDashboardWork(
  rows: DashboardWorkRows,
  planIssues: readonly PlanIssueDecisionRow[],
): DashboardWorkProjection {
  const running: DashboardTaskRow[] = [];
  const queued: DashboardTaskRow[] = [];
  const attentionRows: DashboardTaskRow[] = [];
  const recovering = new Set<string>();
  const completedAt = new Map<string, number>();

  for (const row of rows.open) {
    const key = workKey(row);
    if (isRunningState(row.state)) {
      running.push(row);
      recovering.add(key);
    } else if (isQueuedState(row.state)) {
      queued.push(row);
      recovering.add(key);
    } else if (isAttentionState(row.state)) {
      attentionRows.push(row);
    }
  }

  for (const completion of rows.supersedingCompletions) {
    const timestamp = Date.parse(completion.completedAt);
    completedAt.set(completion.key, Math.max(completedAt.get(completion.key) ?? 0, timestamp));
  }

  const blocked: AttentionItem[] = [];
  for (const row of attentionRows) {
    blocked.push({
      id: `task:${row.taskId}`,
      category: 'blocked',
      kind: 'task_action_required',
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      title: row.title,
      state: row.state,
      detail: row.reason,
      since: row.stateTimestamp,
    });
  }
  for (const row of rows.failed) {
    const key = workKey(row);
    // Already being retried or auto-recovered, or superseded by a later success.
    if (recovering.has(key)) continue;
    if ((completedAt.get(key) ?? 0) > Date.parse(row.stateTimestamp)) continue;
    blocked.push({
      id: `task:${row.taskId}`,
      category: 'blocked',
      kind: 'task_failed',
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      title: row.title,
      state: row.state,
      detail: row.reason,
      since: row.stateTimestamp,
    });
  }

  const decisions: AttentionItem[] = planIssues.map(issue => ({
    id: `plan-issue:${issue.id}`,
    category: 'decision' as const,
    kind: 'plan_review' as const,
    taskId: issue.taskId,
    repository: issue.repository,
    issueNumber: issue.issueNumber,
    prNumber: issue.prNumber,
    title: null,
    state: issue.status,
    detail: issue.status === 'under_review' ? 'Pull request is awaiting review' : null,
    since: issue.updatedAt,
  }));

  const oldestFirst = (a: AttentionItem, b: AttentionItem): number =>
    Date.parse(a.since) - Date.parse(b.since);
  // Blocking problems first, then pending decisions; oldest first within each.
  const attention = [...blocked.sort(oldestFirst), ...decisions.sort(oldestFirst)];

  const byOldest = (a: DashboardTaskRow, b: DashboardTaskRow): number =>
    Date.parse(a.stateTimestamp) - Date.parse(b.stateTimestamp);

  return {
    running: [...running].sort(byOldest),
    queued: [...queued].sort(byOldest),
    attention,
    recentlyCompleted: rows.recentlyCompleted,
    counts: {
      needsAttention: attention.length,
      running: running.length,
      queued: queued.length,
      // Counted in the database: the sample above is capped for display, and a
      // display cap must never be reported as how much work finished.
      completedRecently: rows.completedRecentlyCount,
    },
  };
}

/**
 * The task identities behind the attention list.
 *
 * The attention count links to a task list, and that list has to be the same
 * work: the same recovery exclusions, the same plan reviews awaiting a
 * decision, and the runs behind decisions that never recorded a task link. So
 * the list is built from this projection rather than from a second guess at
 * what "needs attention" means.
 */
export async function loadAttentionTaskIds(
  db: Knex,
  repository: string,
  options: { now?: Date } = {},
): Promise<string[]> {
  const work = await loadDashboardWork(db, repository, options);
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const item of work.attention) {
    if (item.taskId === null || seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    taskIds.push(item.taskId);
  }
  return taskIds;
}

/** One dashboard read of every work source, already projected. */
export async function loadDashboardWork(
  db: Knex,
  repository: string,
  options: { now?: Date; lookbackDays?: number; recentWindowHours?: number } = {},
): Promise<DashboardWorkProjection> {
  const [rows, planIssues] = await Promise.all([
    loadDashboardWorkRows(db, repository, options),
    loadPlanIssueDecisions(db, repository),
  ]);
  return projectDashboardWork(rows, planIssues);
}

export interface OutcomeRow extends DashboardTaskRow {
  planIssueStatus: string | null;
  /** Implementation critique score out of 10, or null when none was recorded. */
  score: number | null;
}

/**
 * Tasks joined to their latest recorded transition into one terminal state.
 *
 * Outcomes are recorded events, so they are read from history rather than from
 * a task's current state: a run that failed and is now being retried still
 * failed, and dropping that record would rewrite both the feed and the success
 * rate the moment the retry starts.
 *
 * One row per task per state is the deduplication: a task's "implementation
 * completed" and "PR ready" entries share a terminal state and collapse into
 * the single outcome they describe, while a task that failed and later
 * completed keeps both of its outcomes. Confining the lookup to the window
 * keeps an event that happened inside it from being displaced by a later one
 * outside it. Heartbeats, indexing updates and CI entries never reach this set
 * because only terminal task lifecycle states are read.
 */
export function terminalTransitionQuery(
  db: Knex,
  repository: string,
  state: string,
  window: { from?: Date; to?: Date } = {},
): Knex.QueryBuilder {
  const bindings: unknown[] = [state];
  let windowSql = '';
  if (window.from) {
    windowSql += ' AND lh.timestamp >= ?';
    bindings.push(window.from.toISOString());
  }
  if (window.to) {
    windowSql += ' AND lh.timestamp < ?';
    bindings.push(window.to.toISOString());
  }

  const query = db('tasks as t')
    .where(function (this: Knex.QueryBuilder) {
      this.whereNull('t.task_type').orWhereNot('t.task_type', 'goal');
    })
    .joinRaw(`
      JOIN task_history AS h ON h.history_id = (
        SELECT lh.history_id
        FROM task_history AS lh
        WHERE lh.task_id = t.task_id AND lh.state = ?${windowSql}
        ORDER BY lh.timestamp DESC
        LIMIT 1
      )
    `, bindings);
  if (repository && repository !== 'all') query.where('t.repository', repository);
  return query;
}

/**
 * Recent recorded outcomes, newest first.
 *
 * Each terminal state is read separately and merged, so one long run of
 * completions cannot crowd the failures out of the feed before the limit is
 * applied to the merged, ordered result.
 */
export async function loadOutcomeRows(
  db: Knex,
  repository: string,
  options: { limit?: number; since?: Date } = {},
): Promise<OutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const perState = await Promise.all(TERMINAL_TASK_STATES.map(state =>
    terminalTransitionQuery(db, repository, state, { from: options.since })
      .select(TASK_COLUMNS)
      .orderBy('h.timestamp', 'desc')
      .limit(limit) as unknown as Promise<RawTaskRow[]>));

  const mapped = perState.flat()
    .map(mapTaskRow)
    .sort((a, b) => Date.parse(b.stateTimestamp) - Date.parse(a.stateTimestamp))
    .slice(0, limit);
  if (mapped.length === 0) return [];

  // One task can carry two outcomes (it failed, then a retry completed), so the
  // enrichment reads each task once.
  const taskIds = [...new Set(mapped.map(row => row.taskId))];
  const [planRows, scores] = await Promise.all([
    db('plan_issues')
      .whereIn('task_id', taskIds)
      .whereNotNull('task_id')
      .select('task_id', 'status')
      .orderBy('id', 'asc') as unknown as Promise<Array<Record<string, unknown>>>,
    loadCritiqueScores(db, taskIds),
  ]);
  const statusByTask = new Map<string, string>();
  for (const row of planRows) statusByTask.set(String(row.task_id), String(row.status));

  return mapped.map(row => ({
    ...row,
    planIssueStatus: statusByTask.get(row.taskId) ?? null,
    score: toScoreNumber(scores.get(row.taskId)),
  }));
}

export interface PlanIssueOutcomeRow {
  id: number;
  repository: string;
  issueNumber: number;
  prNumber: number | null;
  status: string;
  taskId: string | null;
  occurredAt: string;
}

/**
 * Review results recorded against plan issues, newest first.
 *
 * A merge or a close happens after the implementation run finished, so it is a
 * separate outcome from that run's completion rather than a duplicate of it.
 */
export async function loadPlanIssueOutcomes(
  db: Knex,
  repository: string,
  options: { limit?: number } = {},
): Promise<PlanIssueOutcomeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const query = db('plan_issues')
    .whereIn('status', ['merged', 'closed'])
    .select('id', 'repository', 'issue_number', 'pr_number', 'status', 'task_id', 'updated_at')
    .orderBy('updated_at', 'desc')
    .limit(limit);
  if (repository && repository !== 'all') query.where('repository', repository);

  const rows = await query as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: Number(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    status: String(row.status),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    occurredAt: toIso(row.updated_at),
  }));
}
