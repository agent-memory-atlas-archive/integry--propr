import type { McpErrorEnvelope } from './errorEnvelope.js';
import type { McpOperations, LifecycleOutcome, LifecycleState, Operation } from './operations.js';

const startedTaskStates = new Set(['processing', 'claude_execution', 'post_processing']);
const terminalStates = new Set<LifecycleOutcome>(['completed', 'failed', 'cancelled']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.length > 0) as string | undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Translate the compatibility state into the persisted public lifecycle. */
export function lifecycleFromLegacy(state: unknown): LifecycleState {
  if (['running', 'accepted', 'posted', 'queued', 'browser_required'].includes(String(state))) return 'accepted';
  if (['completed', 'failed', 'cancelled'].includes(String(state))) return String(state) as LifecycleState;
  return 'unknown';
}

/** Collect stable output handles regardless of which legacy receipt layer exposed them. */
export function artifactsFromReceipt(row: Operation, receipt: Record<string, unknown>): Record<string, unknown> {
  const result = record(receipt.result) ?? {};
  const continuation = record(result.continuation) ?? {};
  const target = record(receipt.targetState) ?? {};
  const targetIssues: Record<string, unknown>[] = Array.isArray(target.issues)
    ? target.issues.map(record).filter((value): value is Record<string, unknown> => !!value) : [];
  const artifacts: Record<string, unknown> = {};

  const taskId = nonEmptyString(target.taskId, target.task_id, continuation.taskId, result.taskId,
    ...targetIssues.flatMap(issue => [issue.taskId, issue.task_id]));
  if (taskId) artifacts.taskId = taskId;

  const repository = nonEmptyString(result.repository, row.repository);
  const pullRequestNumber = positiveInteger(
    result.pullRequest, result.pr_number, result.prNumber,
    continuation.pullRequest, continuation.pr_number,
    target.pullRequest, target.pr_number,
    ...targetIssues.flatMap(issue => [issue.pullRequest, issue.pr_number]),
  );
  if (repository && pullRequestNumber) artifacts.pullRequest = {
    repository,
    number: pullRequestNumber,
    url: `https://github.com/${repository}/pull/${pullRequestNumber}`,
  };

  const issueNumbers = new Set<number>();
  for (const value of [result.issueNumber, result.issue_number, continuation.issueNumber, target.issueNumber, target.issue_number]) {
    const number = positiveInteger(value);
    if (number) issueNumbers.add(number);
  }
  if (Array.isArray(result.issues)) for (const value of result.issues) {
    const number = positiveInteger(record(value)?.number, record(value)?.issueNumber, value);
    if (number) issueNumbers.add(number);
  }
  for (const issue of targetIssues) {
    const number = positiveInteger(issue.number, issue.issueNumber, issue.issue_number);
    if (number) issueNumbers.add(number);
  }
  if (repository && issueNumbers.size) artifacts.issues = [...issueNumbers].map(number => ({
    repository,
    number,
    url: `https://github.com/${repository}/issues/${number}`,
  }));

  const commentId = positiveInteger(result.commentId, continuation.commentId, target.commentId);
  if (commentId) artifacts.commentId = commentId;
  return artifacts;
}

function lifecycleOutcome(
  row: Operation,
  target: Record<string, unknown> | undefined,
  receiptState: string,
  targetState: string,
): LifecycleOutcome | undefined {
  if (terminalStates.has(receiptState as LifecycleOutcome)) return receiptState as LifecycleOutcome;
  if (row.tool === 'run_ultrafix' || (!target?.taskId && !target?.task_id)) return undefined;
  return terminalStates.has(targetState as LifecycleOutcome) ? targetState as LifecycleOutcome : undefined;
}

async function syncCancellation(
  operations: McpOperations,
  row: Operation,
  receipt: Record<string, unknown>,
): Promise<void> {
  if (row.tool !== 'cancel_operation') return;
  const result = record(receipt.result);
  const sourceId = nonEmptyString(result?.operationId);
  if (sourceId && result?.cancellation === 'confirmed') await operations.finish(sourceId, 'cancelled');
}

/** Persist tracker observations without allowing stale concurrent polls to undo newer lifecycle facts. */
export async function syncLifecycle(
  operations: McpOperations,
  row: Operation,
  receipt: Record<string, unknown>,
): Promise<void> {
  const artifacts = artifactsFromReceipt(row, receipt);
  if (Object.keys(artifacts).length) await operations.recordArtifacts(row.id, artifacts);

  const target = record(receipt.targetState);
  if (target) await operations.recordProgress(row.id, target);

  const targetState = String(target?.state ?? '');
  const receiptState = String(receipt.state ?? '');
  if (startedTaskStates.has(targetState) || receiptState === 'running') {
    await operations.markStarted(row.id, epochMilliseconds(target?.timestamp));
  }

  const outcome = lifecycleOutcome(row, target, receiptState, targetState);
  if (outcome) {
    const result = record(receipt.result);
    await operations.finish(row.id, outcome, record(result?.error) as McpErrorEnvelope | undefined);
  }

  await syncCancellation(operations, row, receipt);
}
