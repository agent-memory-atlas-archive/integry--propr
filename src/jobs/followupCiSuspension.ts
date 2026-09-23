import { getAuthenticatedOctokit, getStateManager, isCancelCiDuringFollowupEnabledForRepository, logger, TaskStates } from '@propr/core';
import type { ContinuationRecord, PullRequestReference } from './prContinuation.js';
import {
    CiActionsPermissionError, cancelRun, getPullRequestHead, getRun, isCancelableValidationRun,
    listRunsForSha, PENDING_RUN_STATUSES, rerunRun, sameSha,
    type CiSuspensionOctokit, type SuspensionTarget, type WorkflowRunSummary,
} from './followupCiSuspensionRuns.js';
import {
    deleteSuspension, loadSuspensions, nowMs, parseCancelledRuns, repositoryKey, reserveSuspension,
    saveCancelledRuns, splitRepository, SUSPENSION_ACTIVE, SUSPENSION_RESTORING, targetOf,
    type CancelledRun, type CiSuspensionRecord, type CiSuspensionStoreDeps,
} from './followupCiSuspensionStore.js';

/**
 * Cancels the GitHub Actions validation of a pull request head that a follow-up
 * implementation is about to replace, and owns the obligation to bring that
 * validation back when no replacement commit is published.
 *
 * Opt-in per repository ("Cancel CI while follow-up implementation is in
 * progress") and strictly scoped: only queued/in-progress runs of pull request
 * workflows that GitHub itself associates with the captured pull request and
 * captured head SHA are touched. Release, deployment, manual, branch and
 * other-pull-request runs, other revisions and non-Actions checks are not.
 */

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

/** Absolute lifetime of a suspension. Reached only when its owner never reported a terminal state; CI is never suppressed beyond it. */
export const MAX_SUSPENSION_AGE_MS = 6 * 60 * 60 * 1000;
/** Restoration attempts before the obligation is dropped with an error log rather than retried forever. */
export const MAX_RESTORE_ATTEMPTS = 60;
const DEFAULT_RESTORE_BUDGET_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface SuspensionLogger {
    debug(details: Record<string, unknown>, message: string): void;
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
}

export interface CiSuspensionDeps extends CiSuspensionStoreDeps {
    octokit?: CiSuspensionOctokit;
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getTaskState?: (taskId: string) => Promise<{ state: string } | null>;
    log?: SuspensionLogger;
    sleep?: (ms: number) => Promise<void>;
    restoreBudgetMs?: number;
    pollIntervalMs?: number;
}

export interface BeginSuspensionResult {
    suspended: boolean;
    reason: 'suspended' | 'disabled' | 'no_destination' | 'head_unavailable' | 'permission_denied' | 'error';
    cancelledRunIds: number[];
}

export interface RestoreSuspensionResult {
    reason: 'restarted' | 'head_replaced' | 'pull_request_closed' | 'pending' | 'permission_denied' | 'abandoned';
    restartedRunIds: number[];
    pendingRunIds: number[];
}

export { CiActionsPermissionError, isCancelableValidationRun } from './followupCiSuspensionRuns.js';
export { PR_CI_SUSPENSIONS_TABLE, SUSPENSION_ACTIVE, SUSPENSION_RESTORING } from './followupCiSuspensionStore.js';
export type { SuspensionTarget } from './followupCiSuspensionRuns.js';
export type { CancelledRun, CiSuspensionRecord } from './followupCiSuspensionStore.js';

const defaultLogger: SuspensionLogger = logger as unknown as SuspensionLogger;

async function resolveOctokit(deps: CiSuspensionDeps): Promise<CiSuspensionOctokit> {
    return deps.octokit ?? (await getAuthenticatedOctokit() as unknown as CiSuspensionOctokit);
}

function resolveLog(deps: CiSuspensionDeps): SuspensionLogger {
    return deps.log ?? defaultLogger;
}

function delay(deps: CiSuspensionDeps, ms: number): Promise<void> {
    if (deps.sleep) return deps.sleep(ms);
    return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * The publication destination decides which validation is about to become
 * obsolete. A continuation routes implementation to its own pull request; a
 * reservation without a pull request has no validation to suspend yet.
 */
export function resolveFollowupCiSuspensionTarget(
    ref: PullRequestReference,
    continuation?: Pick<ContinuationRecord, 'repository' | 'continuation_pr'>,
): SuspensionTarget | null {
    if (!continuation) {
        return { owner: ref.repoOwner, repo: ref.repoName, pullRequestNumber: ref.pullRequestNumber };
    }
    if (!continuation.continuation_pr) return null;
    const { owner, repo } = splitRepository(continuation.repository);
    if (!owner || !repo) return null;
    return { owner, repo, pullRequestNumber: continuation.continuation_pr };
}

/**
 * Cancels every queued/in-progress validation run of the captured head that is
 * not cancelled yet, appending each one to `runs` as it goes. A failure part way
 * through therefore still leaves the caller with everything already cancelled,
 * so no cancellation is ever forgotten.
 */
async function cancelPendingRuns(
    params: { target: SuspensionTarget; headSha: string; runs: CancelledRun[] },
    deps: CiSuspensionDeps,
): Promise<number[]> {
    const { target, headSha, runs } = params;
    const octokit = await resolveOctokit(deps);
    const cancelledNow: number[] = [];
    for (const run of await listRunsForSha(octokit, target, headSha)) {
        if (!isCancelableValidationRun(run, { pullRequestNumber: target.pullRequestNumber, headSha })) continue;
        if (await cancelRun(octokit, target, run.id)) cancelledNow.push(run.id);
        const known = runs.find(entry => entry.id === run.id);
        if (known) {
            known.restarted = false;
            continue;
        }
        runs.push({ id: run.id, name: run.name ?? undefined, workflowId: run.workflow_id, restarted: false });
    }
    return cancelledNow;
}

/**
 * Cancels the validation of the destination head and records the obligation to
 * restore it. Never throws: an unavailable or unauthorized Actions API leaves
 * CI untouched and the implementation running.
 */
export async function beginFollowupCiSuspension(
    params: { target: SuspensionTarget; taskId: string; correlationId?: string },
    deps: CiSuspensionDeps = {},
): Promise<BeginSuspensionResult> {
    const { target, taskId, correlationId } = params;
    const log = resolveLog(deps);
    const repository = repositoryKey(target.owner, target.repo);
    const key = { repository, pull_request: target.pullRequestNumber };
    const runs: CancelledRun[] = [];
    try {
        const isEnabled = deps.isEnabled ?? isCancelCiDuringFollowupEnabledForRepository;
        if (!await isEnabled(target.owner, target.repo)) {
            return { suspended: false, reason: 'disabled', cancelledRunIds: [] };
        }
        const octokit = await resolveOctokit(deps);
        const live = await getPullRequestHead(octokit, target);
        if (!live?.open) {
            log.info({ repository, pullRequest: target.pullRequestNumber }, 'Skipping follow-up CI suspension: no open pull request head to suspend');
            return { suspended: false, reason: 'head_unavailable', cancelledRunIds: [] };
        }
        const headSha = live.sha;
        runs.push(...await reserveSuspension({ target, headSha, taskId, correlationId }, deps));
        const cancelledRunIds = await cancelPendingRuns({ target, headSha, runs }, { ...deps, octokit });
        await saveCancelledRuns(deps, key, runs);
        log.info({ repository, pullRequest: target.pullRequestNumber, headSha, taskId, cancelledRunIds },
            'Suspended pull request validation for the duration of the follow-up implementation');
        return { suspended: true, reason: 'suspended', cancelledRunIds };
    } catch (error) {
        const permission = error instanceof CiActionsPermissionError;
        // Runs cancelled before the failure still have to be restored, so the record
        // stays and reconciliation takes it over. With nothing cancelled there is no
        // obligation to keep, and an unusable Actions API must not be retried forever.
        await (runs.length > 0
            ? saveCancelledRuns(deps, key, runs)
            : deleteSuspension(deps, key)).catch(() => undefined);
        const details = { repository, pullRequest: target.pullRequestNumber, taskId, error: (error as Error).message, pendingRestore: runs.length };
        if (permission) {
            log.error(details, 'Cannot cancel pull request validation: the GitHub App needs Actions "Read and write" access. Implementation continues with CI untouched');
        } else {
            log.warn(details, 'Failed to suspend pull request validation; implementation continues with CI untouched');
        }
        return { suspended: false, reason: permission ? 'permission_denied' : 'error', cancelledRunIds: [] };
    }
}

/** Resolves the destination and suspends its validation; used by the implementation path. */
export async function suspendObsoleteValidationForImplementation(
    params: {
        ref: PullRequestReference;
        continuation?: Pick<ContinuationRecord, 'repository' | 'continuation_pr'>;
        taskId: string;
        correlationId?: string;
    },
    deps: CiSuspensionDeps = {},
): Promise<BeginSuspensionResult> {
    const target = resolveFollowupCiSuspensionTarget(params.ref, params.continuation);
    if (!target) return { suspended: false, reason: 'no_destination', cancelledRunIds: [] };
    return beginFollowupCiSuspension({ target, taskId: params.taskId, correlationId: params.correlationId }, deps);
}

/**
 * Cancels runs that GitHub queued after the suspension started. Runs of a newly
 * published head carry a different SHA and are never matched here.
 */
export async function sweepFollowupCiSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps = {},
): Promise<{ reason: 'swept' | 'head_replaced' | 'pull_request_closed'; cancelledRunIds: number[] }> {
    const target = targetOf(record);
    const octokit = await resolveOctokit(deps);
    const live = await getPullRequestHead(octokit, target);
    if (!live?.open) {
        await deleteSuspension(deps, record);
        return { reason: 'pull_request_closed', cancelledRunIds: [] };
    }
    if (!sameSha(live.sha, record.head_sha)) {
        // A replacement commit is published: its validation must run normally and
        // the superseded revision is never restarted.
        await deleteSuspension(deps, record);
        resolveLog(deps).info({ repository: record.repository, pullRequest: record.pull_request, headSha: live.sha },
            'Released follow-up CI suspension: a replacement commit was published');
        return { reason: 'head_replaced', cancelledRunIds: [] };
    }
    const runs = parseCancelledRuns(record);
    try {
        return { reason: 'swept', cancelledRunIds: await cancelPendingRuns({ target, headSha: record.head_sha, runs }, { ...deps, octokit }) };
    } finally {
        await saveCancelledRuns(deps, record, runs).catch(() => undefined);
    }
}

/**
 * Decides what one cancelled run still needs. Runs that are still finishing stay
 * pending; runs that produced their own result, disappeared, or already have a
 * fresh run of the same workflow need no restart.
 */
async function restartCancelledRun(
    run: CancelledRun,
    context: { target: SuspensionTarget; octokit: CiSuspensionOctokit; liveRuns: WorkflowRunSummary[]; activeWorkflowIds: Set<number> },
): Promise<'pending' | 'settled' | 'restarted'> {
    const { target, octokit, liveRuns, activeWorkflowIds } = context;
    const liveRun = liveRuns.find(candidate => candidate.id === run.id) ?? await getRun(octokit, target, run.id);
    if (!liveRun) return 'settled';
    if ((liveRun.status ?? '').toLowerCase() !== 'completed') return 'pending';
    if ((liveRun.conclusion ?? '').toLowerCase() !== 'cancelled') return 'settled';
    if (run.workflowId !== undefined && activeWorkflowIds.has(run.workflowId)) return 'settled';
    // A run GitHub restarted in the meantime reports a conflict; its validation exists either way.
    return await rerunRun(octokit, target, run.id) ? 'restarted' : 'settled';
}

/**
 * Brings the cancelled validation back for a head that is still current.
 * Cancellation is asynchronous and the rerun API requires a completed run, so
 * runs that are still finishing stay recorded and are retried by reconciliation.
 */
export async function restoreFollowupCiSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps = {},
): Promise<RestoreSuspensionResult> {
    const log = resolveLog(deps);
    const target = targetOf(record);
    const octokit = await resolveOctokit(deps);
    const attempts = record.attempts + 1;

    const live = await getPullRequestHead(octokit, target);
    if (!live?.open) {
        await deleteSuspension(deps, record);
        return { reason: 'pull_request_closed', restartedRunIds: [], pendingRunIds: [] };
    }
    if (!sameSha(live.sha, record.head_sha)) {
        await deleteSuspension(deps, record);
        log.info({ repository: record.repository, pullRequest: record.pull_request, headSha: live.sha },
            'Released follow-up CI suspension without restarting: the cancelled revision is obsolete');
        return { reason: 'head_replaced', restartedRunIds: [], pendingRunIds: [] };
    }

    const runs = parseCancelledRuns(record);
    const restartedRunIds: number[] = [];
    const deadline = nowMs(deps) + (deps.restoreBudgetMs ?? DEFAULT_RESTORE_BUDGET_MS);
    try {
        for (;;) {
            // Re-read the live runs of the captured head on every pass so validation
            // GitHub already restarted is never duplicated.
            const liveRuns = await listRunsForSha(octokit, target, record.head_sha);
            const activeWorkflowIds = new Set(liveRuns
                .filter(run => PENDING_RUN_STATUSES.has((run.status ?? '').toLowerCase()) && sameSha(run.head_sha, record.head_sha))
                .map(run => run.workflow_id)
                .filter((id): id is number => typeof id === 'number'));
            for (const run of runs.filter(candidate => !candidate.restarted)) {
                const outcome = await restartCancelledRun(run, { target, octokit, liveRuns, activeWorkflowIds });
                if (outcome === 'pending') continue;
                run.restarted = true;
                if (outcome === 'restarted') restartedRunIds.push(run.id);
            }
            const pending = runs.filter(run => !run.restarted);
            if (pending.length === 0) {
                await deleteSuspension(deps, record);
                if (restartedRunIds.length > 0) {
                    log.info({ repository: record.repository, pullRequest: record.pull_request, headSha: record.head_sha, restartedRunIds },
                        'Restarted the pull request validation that the follow-up implementation had cancelled');
                }
                return { reason: 'restarted', restartedRunIds, pendingRunIds: [] };
            }
            if (nowMs(deps) >= deadline) {
                return await deferRestore({ record, runs, pending, restartedRunIds, attempts }, deps);
            }
            await delay(deps, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        }
    } catch (error) {
        await saveCancelledRuns(deps, record, runs, { state: SUSPENSION_RESTORING, attempts }).catch(() => undefined);
        if (!(error instanceof CiActionsPermissionError)) throw error;
        log.error({ repository: record.repository, pullRequest: record.pull_request, error: error.message },
            'Cannot restart cancelled pull request validation: the GitHub App needs Actions "Read and write" access');
        await deleteSuspension(deps, record).catch(() => undefined);
        return { reason: 'permission_denied', restartedRunIds, pendingRunIds: runs.filter(run => !run.restarted).map(run => run.id) };
    }
}

/** Hands the unfinished part of a restart to the next reconciliation pass, or gives up loudly. */
async function deferRestore(
    params: { record: CiSuspensionRecord; runs: CancelledRun[]; pending: CancelledRun[]; restartedRunIds: number[]; attempts: number },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult> {
    const { record, runs, pending, restartedRunIds, attempts } = params;
    const log = resolveLog(deps);
    const pendingRunIds = pending.map(run => run.id);
    const abandoned = attempts >= MAX_RESTORE_ATTEMPTS;
    await (abandoned ? deleteSuspension(deps, record) : saveCancelledRuns(deps, record, runs, { state: SUSPENSION_RESTORING, attempts }));
    if (abandoned) {
        log.error({ repository: record.repository, pullRequest: record.pull_request, pendingRunIds },
            'Gave up restarting cancelled pull request validation after repeated attempts');
    } else {
        log.info({ repository: record.repository, pullRequest: record.pull_request, pendingRunIds, restartedRunIds },
            'Cancelled pull request validation is still finishing; restart continues on the next reconciliation');
    }
    return { reason: abandoned ? 'abandoned' : 'pending', restartedRunIds, pendingRunIds };
}

/**
 * Ends every suspension this task owns. Called when implementation finished,
 * failed or was cancelled; a published replacement keeps its own CI, anything
 * else gets the cancelled validation of the still-current head back.
 */
export async function releaseFollowupCiSuspensionsForTask(
    params: { taskId: string },
    deps: CiSuspensionDeps = {},
): Promise<RestoreSuspensionResult[]> {
    const log = resolveLog(deps);
    const records = await loadSuspensions(deps, { taskId: params.taskId });
    const results: RestoreSuspensionResult[] = [];
    for (const record of records) {
        try {
            results.push(await restoreFollowupCiSuspension(record, deps));
        } catch (error) {
            log.warn({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
                'Failed to release the follow-up CI suspension; reconciliation will retry it');
        }
    }
    return results;
}

export interface CiSuspensionReconciliationSummary {
    scanned: number;
    swept: number;
    restored: number;
    released: number;
    errors: number;
}

async function isOwnerActive(record: CiSuspensionRecord, deps: CiSuspensionDeps): Promise<boolean> {
    const getTaskState = deps.getTaskState ?? (async (taskId: string) => getStateManager().getTaskState(taskId));
    try {
        const state = await getTaskState(record.task_id);
        // A task whose state is gone cannot be implementing any more.
        return !!state && !TERMINAL_TASK_STATES.has(state.state);
    } catch {
        // An unreadable task state must not keep CI suppressed; treat it as finished.
        return false;
    }
}

/** True while the owning implementation may still publish a replacement commit. */
async function keepsSuppressing(record: CiSuspensionRecord, deps: CiSuspensionDeps, enabled: boolean): Promise<boolean> {
    if (!enabled || record.state !== SUSPENSION_ACTIVE) return false;
    if (nowMs(deps) - Number(record.created_at) >= MAX_SUSPENSION_AGE_MS) {
        resolveLog(deps).warn({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id },
            'Releasing follow-up CI suspension that outlived its maximum lifetime');
        return false;
    }
    return isOwnerActive(record, deps);
}

/**
 * Periodic owner of every suspension that outlived its task: it sweeps late runs
 * while implementation is in progress, releases suspensions whose repository
 * option was switched off, and restarts validation after a worker crash.
 */
export async function reconcileFollowupCiSuspensions(
    deps: CiSuspensionDeps = {},
): Promise<CiSuspensionReconciliationSummary> {
    const log = resolveLog(deps);
    const summary: CiSuspensionReconciliationSummary = { scanned: 0, swept: 0, restored: 0, released: 0, errors: 0 };
    const records = await loadSuspensions(deps);
    if (records.length === 0) return summary;
    const isEnabled = deps.isEnabled ?? isCancelCiDuringFollowupEnabledForRepository;
    for (const record of records) {
        summary.scanned += 1;
        const { owner, repo } = splitRepository(record.repository);
        try {
            const enabled = await isEnabled(owner, repo);
            if (!enabled) {
                // Disabling the option mid-task must give the pull request its CI back.
                log.info({ repository: record.repository, pullRequest: record.pull_request },
                    'Releasing follow-up CI suspension: the repository option is disabled');
            }
            if (await keepsSuppressing(record, deps, enabled)) {
                const swept = await sweepFollowupCiSuspension(record, deps);
                if (swept.reason === 'swept') summary.swept += 1; else summary.released += 1;
                continue;
            }
            const restored = await restoreFollowupCiSuspension(record, deps);
            if (restored.reason !== 'pending') summary.released += 1;
            if (restored.restartedRunIds.length > 0) summary.restored += 1;
        } catch (error) {
            summary.errors += 1;
            log.warn({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
                'Failed to reconcile a follow-up CI suspension');
        }
    }
    log.debug(summary as unknown as Record<string, unknown>, 'Reconciled follow-up CI suspensions');
    return summary;
}
