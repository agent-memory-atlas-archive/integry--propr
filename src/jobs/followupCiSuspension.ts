import { getStateManager, isCancelCiDuringFollowupEnabledForRepository, TaskStates } from '@propr/core';
import {
    CiActionsPermissionError, getPullRequestHead, getRun, isReplacementValidationRun, listRunsForSha, rerunRun, sameSha,
    type CiSuspensionOctokit, type SuspensionTarget, type WorkflowRunSummary,
} from './followupCiSuspensionRuns.js';
import { delay, resolveLog, resolveOctokit, type CiSuspensionDeps } from './followupCiSuspensionContext.js';
import { cancellationState, cancelPendingRuns } from './followupCiSuspensionCancel.js';
import {
    deleteSuspension, loadSuspension, loadSuspensions, nowMs, parseCancelledRuns, saveCancelledRuns, splitRepository,
    SUSPENSION_ACTIVE, SUSPENSION_BLOCKED, SUSPENSION_RESTORING, suspensionKey, targetOf,
    type CancelledRun, type CiSuspensionRecord,
} from './followupCiSuspensionStore.js';
import { SuspensionLeaseLostError, SuspensionLeaseUnavailableError, withSuspensionLease } from './followupCiSuspensionLease.js';

/**
 * Cancels the GitHub Actions validation of a pull request head that a follow-up
 * implementation is about to replace, and owns the obligation to bring that
 * validation back when no replacement commit is published.
 *
 * Opt-in per repository ("Cancel CI while follow-up implementation is in
 * progress") and strictly scoped: only queued/in-progress runs that GitHub
 * itself associates with the captured pull request and captured head SHA, and
 * whose workflow the repository's operator explicitly selected, are touched.
 * Workflows nobody selected — preview and deployment workflows among them, and
 * any workflow whose name merely sounds like validation — are never cancelled,
 * and neither are manual, branch and other-pull-request runs, other revisions
 * or non-Actions checks.
 *
 * Every step of one pull request's suspension — begin, sweep, restore, release —
 * runs while holding the same shared lease and writes with the generation it
 * read, so the job finalizer of one worker and the periodic recovery pass of
 * another can never fight over it.
 */

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

/** Absolute lifetime of a suspension. Reached only when its owner never reported a terminal state; CI is never suppressed beyond it. */
export const MAX_SUSPENSION_AGE_MS = 6 * 60 * 60 * 1000;
/** Restoration attempts before the obligation is dropped with an error log rather than retried forever. */
export const MAX_RESTORE_ATTEMPTS = 60;
const DEFAULT_RESTORE_BUDGET_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface SweepSuspensionResult {
    reason: 'swept' | 'head_replaced' | 'pull_request_closed' | 'superseded' | 'busy';
    cancelledRunIds: number[];
}

export interface RestoreSuspensionResult {
    reason: 'restarted' | 'head_replaced' | 'pull_request_closed' | 'pending' | 'permission_denied' | 'superseded'
        | 'abandoned' | 'busy';
    restartedRunIds: number[];
    pendingRunIds: number[];
}

export { CiActionsPermissionError, isCancelableValidationRun } from './followupCiSuspensionRuns.js';
export {
    createValidationWorkflowPolicy, isEligibleValidationWorkflow, loadValidationWorkflowPolicyFromEnv,
    NO_VALIDATION_WORKFLOWS_SELECTED, parseWorkflowSelection, resolveValidationWorkflowPolicy,
    VALIDATION_WORKFLOW_ALLOWLIST_ENV,
} from './followupCiSuspensionPolicy.js';
export { PR_CI_SUSPENSION_LEASES_TABLE, SuspensionLeaseUnavailableError } from './followupCiSuspensionLease.js';
export type { ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';
export {
    beginFollowupCiSuspension, resolveFollowupCiSuspensionTarget, suspendObsoleteValidationForImplementation,
} from './followupCiSuspensionCancel.js';
export {
    PR_CI_SUSPENSIONS_TABLE, SUSPENSION_ACTIVE, SUSPENSION_BLOCKED, SUSPENSION_RESTORING,
} from './followupCiSuspensionStore.js';
export type { BeginSuspensionResult } from './followupCiSuspensionCancel.js';
export type { CiSuspensionDeps } from './followupCiSuspensionContext.js';
export type { SuspensionTarget } from './followupCiSuspensionRuns.js';
export type { CancelledRun, CiSuspensionRecord } from './followupCiSuspensionStore.js';

/**
 * Cancels runs that GitHub queued after the suspension started. Runs of a newly
 * published head carry a different SHA and are never matched here, and a
 * suspension that is already restoring is left alone so a sweep can never
 * re-cancel validation that is being brought back.
 */
export async function sweepFollowupCiSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps = {},
): Promise<SweepSuspensionResult> {
    try {
        return await withSuspensionLease(deps, suspensionKey(record), () => sweepSuspension(record, deps));
    } catch (error) {
        if (!(error instanceof SuspensionLeaseUnavailableError)) throw error;
        // Whoever holds the lease is already deciding what this pull request
        // needs; sweeping next to them could cancel what they are restoring.
        return { reason: 'busy', cancelledRunIds: [] };
    }
}

async function sweepSuspension(record: CiSuspensionRecord, deps: CiSuspensionDeps): Promise<SweepSuspensionResult> {
    const current = await loadSuspension(deps, record);
    // The row may already belong to a newer implementation of the same pull
    // request, or its restoring transition may have taken it out of suppression.
    if (!current || current.task_id !== record.task_id || !sameSha(current.head_sha, record.head_sha)) {
        return { reason: 'superseded', cancelledRunIds: [] };
    }
    if (current.state !== SUSPENSION_ACTIVE) return { reason: 'superseded', cancelledRunIds: [] };
    const target = targetOf(current);
    const octokit = await resolveOctokit(deps);
    const live = await getPullRequestHead(octokit, target);
    if (!live?.open) {
        await deleteSuspension(deps, current);
        return { reason: 'pull_request_closed', cancelledRunIds: [] };
    }
    if (!sameSha(live.sha, current.head_sha)) {
        // A replacement commit is published: its validation must run normally and
        // the superseded revision is never restarted.
        await deleteSuspension(deps, current);
        resolveLog(deps).info({ repository: current.repository, pullRequest: current.pull_request, headSha: live.sha },
            'Released follow-up CI suspension: a replacement commit was published');
        return { reason: 'head_replaced', cancelledRunIds: [] };
    }
    const state = cancellationState(current, parseCancelledRuns(current));
    await cancelPendingRuns(state, { ...deps, octokit });
    return { reason: state.ownershipLost ? 'superseded' : 'swept', cancelledRunIds: state.cancelledRunIds };
}

/**
 * Decides what one cancelled run still needs. Runs that are still finishing stay
 * pending; runs that produced their own result, disappeared, or already have a
 * fresh run of the same workflow validating the same pull request head need no
 * restart. A rerun whose response was lost counts as restarted only when the run
 * itself proves it.
 */
async function restartCancelledRun(
    run: CancelledRun,
    context: { target: SuspensionTarget; octokit: CiSuspensionOctokit; liveRuns: WorkflowRunSummary[]; activeWorkflowIds: Set<number> },
): Promise<'pending' | 'settled' | 'restarted' | 'unconfirmed'> {
    const { target, octokit, liveRuns, activeWorkflowIds } = context;
    const liveRun = liveRuns.find(candidate => candidate.id === run.id) ?? await getRun(octokit, target, run.id);
    if (!liveRun) return 'settled';
    if ((liveRun.status ?? '').toLowerCase() !== 'completed') return 'pending';
    if ((liveRun.conclusion ?? '').toLowerCase() !== 'cancelled') return 'settled';
    if (run.workflowId !== undefined && activeWorkflowIds.has(run.workflowId)) return 'settled';
    // A run GitHub restarted in the meantime reports a conflict; its validation exists either way.
    const outcome = await rerunRun(octokit, target, run.id, { attempt: run.attempt ?? liveRun.run_attempt });
    if (outcome === 'unconfirmed') return 'unconfirmed';
    return outcome === 'restarted' ? 'restarted' : 'settled';
}

/** One pass over everything still owed a restart; `progressed` means the record has to be written before the next wait. */
async function restartPass(
    runs: CancelledRun[],
    context: { target: SuspensionTarget; octokit: CiSuspensionOctokit; headSha: string; restartedRunIds: number[] },
): Promise<boolean> {
    const { target, octokit, headSha, restartedRunIds } = context;
    // Re-read the live runs of the captured head on every pass so validation
    // GitHub already restarted is never duplicated. Only a run that validates
    // *this* pull request head on the pull request's own event counts as that
    // replacement: an unrelated push or another pull request's run of the same
    // commit never settles the obligation to restart what ProPR cancelled.
    const liveRuns = await listRunsForSha(octokit, target, headSha);
    const activeWorkflowIds = new Set(liveRuns
        .filter(run => isReplacementValidationRun(run, { pullRequestNumber: target.pullRequestNumber, headSha }))
        .map(run => run.workflow_id)
        .filter((id): id is number => typeof id === 'number'));
    let progressed = false;
    for (const run of runs.filter(candidate => !candidate.restarted)) {
        const outcome = await restartCancelledRun(run, { target, octokit, liveRuns, activeWorkflowIds });
        if (outcome === 'pending' || outcome === 'unconfirmed') continue;
        run.restarted = true;
        progressed = true;
        if (outcome === 'restarted') restartedRunIds.push(run.id);
    }
    return progressed;
}

/**
 * Drops the obligation when the head it was taken on is gone: a closed pull
 * request or a published replacement commit means the cancelled revision is
 * obsolete and must never be restarted. Returns null while the head is current.
 */
async function releaseObsoleteHead(
    context: { record: CiSuspensionRecord; octokit: CiSuspensionOctokit; restartedRunIds: number[]; pendingRunIds: number[] },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult | null> {
    const { record, octokit, restartedRunIds, pendingRunIds } = context;
    const live = await getPullRequestHead(octokit, targetOf(record));
    if (!live?.open) {
        await deleteSuspension(deps, record);
        return { reason: 'pull_request_closed', restartedRunIds, pendingRunIds };
    }
    if (sameSha(live.sha, record.head_sha)) return null;
    await deleteSuspension(deps, record);
    resolveLog(deps).info({ repository: record.repository, pullRequest: record.pull_request, headSha: live.sha },
        'Released follow-up CI suspension without restarting the rest: the cancelled revision is obsolete');
    return { reason: 'head_replaced', restartedRunIds, pendingRunIds };
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
    try {
        return await withSuspensionLease(deps, suspensionKey(record), lease => restoreSuspension(record, deps, lease));
    } catch (error) {
        // Either another worker holds the lease, or this one waited for a
        // cancellation long enough to lose it. Both leave the obligation
        // recorded for whoever holds the lease next.
        if (!(error instanceof SuspensionLeaseUnavailableError) && !(error instanceof SuspensionLeaseLostError)) throw error;
        resolveLog(deps).info({ repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Another worker holds this pull request suspension; its restart continues on the next reconciliation');
        return { reason: 'busy', restartedRunIds: [], pendingRunIds: parseCancelledRuns(record).filter(run => !run.restarted).map(run => run.id) };
    }
}

const SUPERSEDED: RestoreSuspensionResult = { reason: 'superseded', restartedRunIds: [], pendingRunIds: [] };

async function restoreSuspension(
    record: CiSuspensionRecord,
    deps: CiSuspensionDeps,
    lease?: { assertHeld: () => Promise<void> },
): Promise<RestoreSuspensionResult> {
    const log = resolveLog(deps);
    // Work from the row as it is now: what the caller was handed may already
    // belong to a newer implementation of the same pull request.
    const loaded = await loadSuspension(deps, record);
    if (!loaded || loaded.task_id !== record.task_id || !sameSha(loaded.head_sha, record.head_sha)) return SUPERSEDED;
    let current = loaded;
    // A refused attempt never reached GitHub, so it must not consume the budget
    // of attempts that eventually gives up on a run that keeps finishing.
    const attemptsBeforeRestore = loaded.attempts;
    const target = targetOf(current);
    const octokit = await resolveOctokit(deps);
    const attempts = current.attempts + 1;
    const restartedRunIds: number[] = [];

    const obsolete = await releaseObsoleteHead({ record: current, octokit, restartedRunIds, pendingRunIds: [] }, deps);
    if (obsolete) return obsolete;

    const runs = parseCancelledRuns(current);
    if (current.state !== SUSPENSION_RESTORING) {
        // One-way transition, persisted before the first rerun: from here on a
        // sweep leaves this suspension alone instead of re-cancelling what is
        // being restarted, and a crash resumes restoration rather than suppression.
        const restoring = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts });
        if (!restoring) return SUPERSEDED;
        current = restoring;
    }

    const deadline = nowMs(deps) + (deps.restoreBudgetMs ?? DEFAULT_RESTORE_BUDGET_MS);
    try {
        for (;;) {
            const progressed = await restartPass(runs, { target, octokit, headSha: current.head_sha, restartedRunIds });
            if (progressed) {
                const saved = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts });
                if (!saved) return { ...SUPERSEDED, restartedRunIds };
                current = saved;
            }
            const pending = runs.filter(run => !run.restarted);
            if (pending.length === 0) {
                await deleteSuspension(deps, current);
                if (restartedRunIds.length > 0) {
                    log.info({ repository: current.repository, pullRequest: current.pull_request, headSha: current.head_sha, restartedRunIds },
                        'Restarted the pull request validation that the follow-up implementation had cancelled');
                }
                return { reason: 'restarted', restartedRunIds, pendingRunIds: [] };
            }
            if (nowMs(deps) >= deadline) {
                return await deferRestore({ record: current, runs, pending, restartedRunIds, attempts }, deps);
            }
            await delay(deps, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
            // Waiting is where a lease expires. Renew it and prove it is still
            // this worker's before requesting another rerun, so a restart that
            // somebody else took over is never duplicated from here.
            await lease?.assertHeld();
            // The head can be replaced while this pass waits for cancellations to
            // finish, so it is read again before any further rerun.
            const replaced = await releaseObsoleteHead(
                { record: current, octokit, restartedRunIds, pendingRunIds: pending.map(run => run.id) }, deps);
            if (replaced) return replaced;
        }
    } catch (error) {
        if (!(error instanceof CiActionsPermissionError)) {
            const saved = await saveCancelledRuns(deps, current, runs, { state: SUSPENSION_RESTORING, attempts }).catch(() => null);
            if (saved) current = saved;
            throw error;
        }
        return await blockRestore(
            { record: current, runs, restartedRunIds, attempts: attemptsBeforeRestore, error }, deps);
    }
}

/**
 * Keeps the obligation alive when GitHub refuses the rerun. A refusal can be
 * temporary and Actions access can be granted back, so everything ProPR
 * cancelled stays recorded in the durable blocked state that every later
 * reconciliation retries: only a confirmed restart, a closed pull request or a
 * replaced head may clear it. Dropping the record here would leave the current
 * head's checks cancelled with nothing left to restore them.
 */
async function blockRestore(
    params: { record: CiSuspensionRecord; runs: CancelledRun[]; restartedRunIds: number[]; attempts: number; error: Error },
    deps: CiSuspensionDeps,
): Promise<RestoreSuspensionResult> {
    const { record, runs, restartedRunIds, attempts, error } = params;
    const pendingRunIds = runs.filter(run => !run.restarted).map(run => run.id);
    const retained = await saveCancelledRuns(deps, record, runs, { state: SUSPENSION_BLOCKED, attempts }).catch(() => null);
    resolveLog(deps).error(
        {
            repository: record.repository, pullRequest: record.pull_request, headSha: record.head_sha,
            pendingRunIds, error: error.message, retained: retained !== null,
        },
        'Cannot restart cancelled pull request validation: the GitHub App needs Actions "Read and write" access. '
        + 'The cancelled runs stay recorded and every reconciliation retries them until access is restored or the head is replaced');
    return { reason: 'permission_denied', restartedRunIds, pendingRunIds };
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
                if (swept.reason === 'swept') summary.swept += 1;
                else if (swept.reason !== 'superseded' && swept.reason !== 'busy') summary.released += 1;
                continue;
            }
            const restored = await restoreFollowupCiSuspension(record, deps);
            // A denied restore released nothing: its obligation is still recorded.
            if (!['pending', 'permission_denied', 'superseded', 'busy'].includes(restored.reason)) summary.released += 1;
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
