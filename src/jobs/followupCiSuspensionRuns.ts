/**
 * GitHub Actions access for follow-up CI suspension, kept deliberately narrow:
 * it can read a pull request head, list the runs of one SHA, and cancel or
 * rerun one run. Nothing here decides when those operations are allowed.
 */

/** Runs in these statuses have not produced a result yet, so cancelling one only discards work a new commit would invalidate. */
const CANCELABLE_RUN_STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
/** Only pull request validation is ever cancelled. `push`, `release`, `deployment`, `workflow_dispatch` and `schedule` runs are out of scope by construction. */
const VALIDATION_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'pull_request_target']);
/** A run that still occupies a runner, including one waiting for manual approval. */
export const PENDING_RUN_STATUSES: ReadonlySet<string> = new Set([...CANCELABLE_RUN_STATUSES, 'action_required']);

export interface WorkflowRunSummary {
    id: number;
    name?: string | null;
    event?: string | null;
    status?: string | null;
    conclusion?: string | null;
    head_sha?: string | null;
    workflow_id?: number;
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
 * head SHA match. Branch names alone never qualify a run for cancellation.
 */
export function isCancelableValidationRun(
    run: WorkflowRunSummary,
    target: { pullRequestNumber: number; headSha: string },
): boolean {
    if (!VALIDATION_EVENTS.has((run.event ?? '').toLowerCase())) return false;
    if (!CANCELABLE_RUN_STATUSES.has((run.status ?? '').toLowerCase())) return false;
    if (!sameSha(run.head_sha, target.headSha)) return false;
    return (run.pull_requests ?? []).some(pullRequest => pullRequest?.number === target.pullRequestNumber);
}

export async function listRunsForSha(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    headSha: string,
): Promise<WorkflowRunSummary[]> {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
        owner: target.owner,
        repo: target.repo,
        head_sha: headSha,
        per_page: 100,
    });
    const data = response.data as { workflow_runs?: WorkflowRunSummary[] } | undefined;
    return data?.workflow_runs ?? [];
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

export async function rerunRun(
    octokit: CiSuspensionOctokit,
    target: SuspensionTarget,
    runId: number,
): Promise<boolean> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
            owner: target.owner, repo: target.repo, run_id: runId,
        });
        return true;
    } catch (error) {
        // A run GitHub already restarted answers 409; the validation the caller wanted exists.
        if (isConflict(error)) return false;
        if (isPermissionError(error)) throw new CiActionsPermissionError('rerun', (error as Error).message);
        throw error;
    }
}
