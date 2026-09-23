/**
 * GitHub Actions access for follow-up CI suspension, kept deliberately narrow:
 * it can read a pull request head, list the runs of one SHA, and cancel or
 * rerun one run. Nothing here decides when those operations are allowed.
 */

import { isEligibleValidationWorkflow, loadValidationWorkflowPolicy, type ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';

/** Runs in these statuses have not produced a result yet, so cancelling one only discards work a new commit would invalidate. */
const CANCELABLE_RUN_STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
/** A run that still occupies a runner, including one waiting for manual approval. */
export const PENDING_RUN_STATUSES: ReadonlySet<string> = new Set([...CANCELABLE_RUN_STATUSES, 'action_required']);

export interface WorkflowRunSummary {
    id: number;
    name?: string | null;
    /** Workflow file path, for example `.github/workflows/pr-build-check.yml`. Part of the workflow's identity for the eligibility policy. */
    path?: string | null;
    event?: string | null;
    status?: string | null;
    conclusion?: string | null;
    head_sha?: string | null;
    workflow_id?: number;
    /** Attempt number GitHub reports; a higher one proves a rerun was accepted. */
    run_attempt?: number;
    pull_requests?: Array<{ number: number }> | null;
}

export interface CiSuspensionOctokit {
    request(route: string, parameters?: Record<string, unknown>): Promise<{ status?: number; data: unknown }>;
}

export interface SuspensionTarget {
    owner: string;
    repo: string;
    pullRequestNumber: number;
}

export class CiActionsPermissionError extends Error {
    constructor(readonly operation: string, message: string) {
        super(`GitHub Actions ${operation} was refused: ${message}`);
        this.name = 'CiActionsPermissionError';
    }
}

export function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
    return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function isPermissionError(error: unknown): boolean {
    const { status, message } = error as { status?: number; message?: string };
    return status === 403 || /resource not accessible by integration/i.test(message ?? '');
}

/** GitHub answers a cancel/rerun that no longer applies with 409; the outcome is already what the caller wanted. */
function isConflict(error: unknown): boolean {
    return (error as { status?: number }).status === 409;
}

function isMissing(error: unknown): boolean {
    return (error as { status?: number }).status === 404;
}

/**
 * Ownership is proven by GitHub's own pull request association plus an exact
 * head SHA match, and the workflow itself must be eligible under the validation
 * workflow policy: an event alone never qualifies a run, and a branch name
 * never does either.
 */
export function isCancelableValidationRun(
    run: WorkflowRunSummary,
    target: { pullRequestNumber: number; headSha: string; policy?: ValidationWorkflowPolicy },
): boolean {
    if (!isEligibleValidationWorkflow(run, target.policy ?? loadValidationWorkflowPolicy())) return false;
    if (!CANCELABLE_RUN_STATUSES.has((run.status ?? '').toLowerCase())) return false;
    if (!sameSha(run.head_sha, target.headSha)) return false;
    return (run.pull_requests ?? []).some(pullRequest => pullRequest?.number === target.pullRequestNumber);
}

/** One page of runs; a busy head can carry more, so discovery never stops at the first page. */
const RUNS_PER_PAGE = 100;
/** Safety stop for pagination: 10 pages of runs for a single commit is already far past any real validation matrix. */
const MAX_RUN_PAGES = 10;

export async function listRunsForSha(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    headSha: string,
): Promise<WorkflowRunSummary[]> {
    const runs: WorkflowRunSummary[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
            owner: target.owner,
            repo: target.repo,
            head_sha: headSha,
            per_page: RUNS_PER_PAGE,
            page,
        });
        const data = response.data as { workflow_runs?: WorkflowRunSummary[]; total_count?: number } | undefined;
        const pageRuns = data?.workflow_runs ?? [];
        for (const run of pageRuns) {
            // Pages shift while runs start and finish; the same run must not be handled twice.
            if (seen.has(run.id)) continue;
            seen.add(run.id);
            runs.push(run);
        }
        if (pageRuns.length < RUNS_PER_PAGE) break;
        if (typeof data?.total_count === 'number' && seen.size >= data.total_count) break;
    }
    return runs;
}

export async function getRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
): Promise<WorkflowRunSummary | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return response.data as WorkflowRunSummary;
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

export async function getPullRequestHead(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
): Promise<{ sha: string; open: boolean } | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: target.owner, repo: target.repo, pull_number: target.pullRequestNumber,
        });
        const data = response.data as { state?: string; head?: { sha?: string } };
        if (!data?.head?.sha) return undefined;
        return { sha: data.head.sha, open: data.state === 'open' };
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

export async function cancelRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
): Promise<boolean> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return true;
    } catch (error) {
        // 409 means the run already reached a terminal state on its own.
        if (isConflict(error)) return false;
        if (isPermissionError(error)) throw new CiActionsPermissionError('cancellation', (error as Error).message);
        throw error;
    }
}

/**
 * `restarted` — GitHub accepted this rerun; `exists` — the validation the caller
 * wanted is already there; `unconfirmed` — the request failed with no evidence
 * that it landed, so the obligation stays and the next pass retries it.
 */
export type RerunOutcome = 'restarted' | 'exists' | 'unconfirmed';

export async function rerunRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
    evidence: { attempt?: number } = {},
): Promise<RerunOutcome> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return 'restarted';
    } catch (error) {
        // A run GitHub already restarted answers 409; the validation the caller wanted exists.
        if (isConflict(error)) return 'exists';
        if (isPermissionError(error)) throw new CiActionsPermissionError('rerun', (error as Error).message);
        // The response can be lost after GitHub accepted the rerun. The run itself
        // is the evidence: a higher attempt, or a run that is no longer completed,
        // means the restart happened and must not be requested again.
        const live = await getRun(octokit, target, runId).catch(() => undefined);
        if (!live) return 'unconfirmed';
        const attemptAdvanced = typeof live.run_attempt === 'number' && typeof evidence.attempt === 'number'
            && live.run_attempt > evidence.attempt;
        const runningAgain = PENDING_RUN_STATUSES.has((live.status ?? '').toLowerCase());
        return attemptAdvanced || runningAgain ? 'restarted' : 'unconfirmed';
    }
}
