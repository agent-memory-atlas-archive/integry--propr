/**
 * Starting a suspension: resolving which pull request head becomes obsolete and
 * cancelling its eligible validation runs, one durable intent at a time.
 */

import { isCancelCiDuringFollowupEnabledForRepository } from '@propr/core';
import type { ContinuationRecord, PullRequestReference } from './prContinuation.js';
import {
    CiActionsPermissionError, cancelRun, getPullRequestHead, getRun, isCancelableValidationRun, listRunsForSha,
    locateCancelledAttempt, type SuspensionTarget,
} from './followupCiSuspensionRuns.js';
import { resolveLog, resolveOctokit, resolvePolicy, type CiSuspensionDeps } from './followupCiSuspensionContext.js';
import {
    SuspensionLeaseLostError, SuspensionLeaseUnavailableError, withSuspensionLease, type SuspensionLease,
} from './followupCiSuspensionLease.js';
import {
    deleteSuspension, repositoryKey, reserveSuspension, saveCancelledRuns, splitRepository, suspensionKey, targetOf,
    type CancelledRun, type CiSuspensionRecord,
} from './followupCiSuspensionStore.js';

export interface BeginSuspensionResult {
    suspended: boolean;
    reason: 'suspended' | 'disabled' | 'no_workflows_selected' | 'selection_unreadable' | 'no_destination'
        | 'head_unavailable' | 'permission_denied' | 'superseded' | 'busy' | 'error';
    cancelledRunIds: number[];
}

/** The record a cancellation pass works on, carried at the generation of its last successful write. */
export interface CancellationState {
    record: CiSuspensionRecord;
    runs: CancelledRun[];
    /** Runs GitHub confirmed it cancelled during this pass. */
    cancelledRunIds: number[];
    /** Set when a newer owner took the row over; this pass must stop touching CI it no longer owns. */
    ownershipLost: boolean;
    /**
     * Runs a previous invocation recorded and nobody has resolved yet. Their
     * cancel requests may well have landed, so no outcome of *this* invocation
     * can prove they need no restart.
     */
    inheritedObligations: number[];
}

export function cancellationState(record: CiSuspensionRecord, runs: CancelledRun[]): CancellationState {
    return {
        record,
        runs,
        cancelledRunIds: [],
        ownershipLost: false,
        inheritedObligations: runs.filter(run => run.restarted !== true).map(run => run.id),
    };
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
 * Cancels every eligible queued/in-progress validation run of the captured head.
 *
 * The run is written to the durable record *before* its cancel request leaves
 * the worker, so a crash, a lost response or an ambiguous failure can never
 * leave CI cancelled without a recorded obligation to restore it. Whether the
 * request actually landed is not assumed either way: reconciliation reads the
 * run's real outcome later and restarts only what GitHub really cancelled.
 *
 * Which attempt that request affects is not known until it lands either. The
 * listing discovery produced is a snapshot, and it ages while the runs before
 * a given one are cancelled and read back: an operator who cancels that run
 * and reruns it in the meantime leaves it on a newer attempt, with the older
 * one ended cancelled by their hand. Cancelling on the listed evidence would
 * then take their cancelled attempt for ProPR's and the attempt ProPR really
 * cancelled for their rerun, settling the obligation while the head's checks
 * stay cancelled. Each run is therefore read again immediately before its
 * intent is written, its eligibility judged on that fresh state, and the
 * attempt it is on at that moment recorded: the request that follows cannot
 * affect an earlier one. Even that is only a lower bound. A rerun can still
 * land between the read and the request, and the opposite mistake is just as
 * wrong: a rerun somebody starts right after the cancellation landed shows the
 * run on a newer attempt too, and adopting that attempt as the cancelled one
 * would have ProPR "restore" it on their behalf should they cancel it later,
 * although their rerun already met the obligation. The attempt the request
 * affected is established once GitHub accepted it from the run's own attempts
 * (see {@link locateCancelledAttempt}). An intent whose attempt could not be
 * confirmed is settled by the run's real outcome alone, with the same evidence.
 *
 * Two answers definitively reject the request, and both take back the intent
 * this request introduced while keeping whatever an earlier cancellation left
 * behind, because that obligation is not this request's to settle. A conflict
 * means the run was already terminal, so ProPR cancelled nothing, and a run
 * somebody else cancelled must never be restarted on ProPR's behalf. A refused
 * request never reached the run either: an intent left behind would let a
 * later cancellation by somebody else pass for ProPR's and authorize a rerun
 * nobody asked for. The rollback is persisted before the refusal propagates.
 *
 * Discovery and the intent write are awaited calls, which is where a stalled
 * worker outlives its lease. The lease is therefore proven to be still this
 * worker's before every write and, again, immediately before every cancel
 * request: the write only proves ownership at the moment it lands, and the
 * worker that takes the lease over while the write's response is on its way
 * back may restore the run and drop the suspension before this pass resumes.
 * Once the lease is lost, the pass stops with {@link SuspensionLeaseLostError}
 * and leaves the pull request to the worker that holds the lease now.
 */
export async function cancelPendingRuns(
    state: CancellationState,
    deps: CiSuspensionDeps,
    lease?: SuspensionLease,
): Promise<void> {
    const { record, runs } = state;
    const octokit = await resolveOctokit(deps);
    const headSha = record.head_sha;
    const target = targetOf(record);
    const policy = await resolvePolicy(deps, target);
    if (policy.selected.size === 0) return;
    const eligible = { pullRequestNumber: target.pullRequestNumber, headSha, policy };
    for (const listed of await listRunsForSha(octokit, target, headSha)) {
        if (!isCancelableValidationRun(listed, eligible)) continue;
        await lease?.assertHeld();
        // The listing is stale by now for every run but the first: this run is
        // read again, and only what it is right now decides whether it is still
        // cancellable and which attempt the intent records. A run that vanished
        // or finished meanwhile is left alone.
        const run = await getRun(octokit, target, listed.id);
        if (!run || !isCancelableValidationRun(run, eligible)) continue;
        const index = runs.findIndex(entry => entry.id === run.id);
        // What the record said before this request, to fall back on if the request is rejected.
        const previous = index >= 0 ? { ...runs[index] } : undefined;
        const intent: CancelledRun = {
            id: run.id, name: run.name ?? undefined, workflowId: run.workflow_id,
            observedAttempt: typeof run.run_attempt === 'number' ? run.run_attempt : undefined, restarted: false,
        };
        if (index >= 0) {
            // Known and pending again — restarted or never cancelled — so this is a
            // fresh obligation on whatever attempt the request lands on.
            runs[index] = intent;
        } else {
            runs.push(intent);
        }
        // Written before every single cancel request, including for a run that is
        // already known: the write is also the ownership check that proves this
        // pass still owned the suspension at the moment the write landed.
        if (!await persistIntent(state, deps)) return;
        // That moment has passed by the time the write's response is back. The
        // lease is proven once more right before the request leaves the worker,
        // so a worker that lost it meanwhile cancels nothing another worker may
        // already have restored.
        await lease?.assertHeld();
        let accepted: boolean;
        try {
            accepted = await cancelRun(octokit, target, run.id);
        } catch (error) {
            // A refused request provably cancelled nothing, so the intent it
            // introduced is taken back before the refusal surfaces. Any other
            // failure is ambiguous and keeps the intent for reconciliation.
            if (error instanceof CiActionsPermissionError) {
                withdrawIntent(runs, intent, previous);
                await persistIntent(state, deps);
            }
            throw error;
        }
        if (!accepted) {
            withdrawIntent(runs, intent, previous);
            if (!await persistIntent(state, deps)) return;
            continue;
        }
        state.cancelledRunIds.push(run.id);
        const affected = await getRun(octokit, target, run.id).catch(() => undefined);
        if (!affected) continue;
        // The attempt the run shows now is not adopted: it is only evidence,
        // together with the attempts the run left behind, of which attempt the
        // accepted request affected. An intervening rerun is recognized here as
        // having met the obligation rather than as the attempt to restore.
        const cancelledAttempt = await locateCancelledAttempt(octokit, target, run.id, { observedAttempt: intent.observedAttempt, live: affected })
            .catch(() => undefined);
        if (cancelledAttempt === undefined) continue;
        intent.attempt = cancelledAttempt;
        if (!await persistIntent(state, deps)) return;
    }
}

/** Takes a rejected request's intent back: the run is recorded as it was before, or not at all. */
function withdrawIntent(runs: CancelledRun[], intent: CancelledRun, previous: CancelledRun | undefined): void {
    const index = runs.indexOf(intent);
    if (index < 0) return;
    if (previous) runs[index] = previous;
    else runs.splice(index, 1);
}

/** Writes the intent and keeps the caller on the generation it just produced; false once a newer owner holds the row. */
async function persistIntent(state: CancellationState, deps: CiSuspensionDeps): Promise<boolean> {
    const saved = await saveCancelledRuns(deps, state.record, state.runs);
    if (!saved) {
        state.ownershipLost = true;
        resolveLog(deps).info({ repository: state.record.repository, pullRequest: state.record.pull_request, taskId: state.record.task_id },
            'Stopping follow-up CI cancellation: another task owns this pull request suspension now');
        return false;
    }
    state.record = saved;
    return true;
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
    const { target } = params;
    const repository = repositoryKey(target.owner, target.repo);
    const key = suspensionKey({ repository, pull_request: target.pullRequestNumber });
    try {
        return await withSuspensionLease(deps, key, lease => beginSuspension(params, deps, lease));
    } catch (error) {
        // Only the lease itself can fail out here; beginSuspension handles its own
        // failures. Another worker sweeping, restoring or releasing this pull
        // request right now — or a lease that cannot be taken at all — leaves CI
        // untouched, because cancelling next to that worker could cancel what it
        // is bringing back. The implementation keeps running either way.
        const busy = error instanceof SuspensionLeaseUnavailableError;
        resolveLog(deps).warn({ repository, pullRequest: target.pullRequestNumber, taskId: params.taskId, error: (error as Error).message },
            busy
                ? 'Skipping follow-up CI suspension: another worker holds this pull request suspension'
                : 'Skipping follow-up CI suspension: its lease could not be taken. Implementation continues with CI untouched');
        return { suspended: false, reason: busy ? 'busy' : 'error', cancelledRunIds: [] };
    }
}

async function beginSuspension(
    params: { target: SuspensionTarget; taskId: string; correlationId?: string },
    deps: CiSuspensionDeps,
    lease: SuspensionLease,
): Promise<BeginSuspensionResult> {
    const { target, taskId, correlationId } = params;
    const log = resolveLog(deps);
    const repository = repositoryKey(target.owner, target.repo);
    let state: CancellationState | undefined;
    try {
        const isEnabled = deps.isEnabled ?? isCancelCiDuringFollowupEnabledForRepository;
        if (!await isEnabled(target.owner, target.repo)) {
            return { suspended: false, reason: 'disabled', cancelledRunIds: [] };
        }
        const policy = await resolvePolicy(deps, target);
        if (policy.source === 'unreadable') {
            // The repository's own selection may name workflows the environment
            // fallback does not, so an unreadable configuration cancels nothing.
            log.warn({ repository, pullRequest: target.pullRequestNumber, taskId },
                'Skipping follow-up CI cancellation: the repository workflow selection could not be read. '
                + 'CI is left untouched until the configuration is readable again');
            return { suspended: false, reason: 'selection_unreadable', cancelledRunIds: [] };
        }
        if (policy.selected.size === 0) {
            log.info({ repository, pullRequest: target.pullRequestNumber, taskId },
                'Skipping follow-up CI cancellation: no validation workflows are selected for this repository. '
                + 'Select the workflows to cancel next to the repository option, or set CANCEL_CI_FOLLOWUP_WORKFLOWS');
            return { suspended: false, reason: 'no_workflows_selected', cancelledRunIds: [] };
        }
        const octokit = await resolveOctokit(deps);
        const live = await getPullRequestHead(octokit, target);
        if (!live?.open) {
            log.info({ repository, pullRequest: target.pullRequestNumber }, 'Skipping follow-up CI suspension: no open pull request head to suspend');
            return { suspended: false, reason: 'head_unavailable', cancelledRunIds: [] };
        }
        const headSha = live.sha;
        // The lookup above is where a stalled worker outlives its lease. Another
        // worker may have taken the lease over meanwhile and reserved this pull
        // request for a newer head; reserving on top of that would replace its
        // ownership and discard the restart obligations of the current head.
        await lease.assertHeld();
        // The reservation itself reads and then writes, and the lease can be
        // lost between the two as well. The write only takes the row over as
        // it was read, so a reservation that lands on somebody else's row is
        // refused rather than overwriting their ownership and cancelled runs.
        const reserved = await reserveSuspension({ target, headSha, taskId, correlationId }, deps);
        if (!reserved) {
            log.warn({ repository, pullRequest: target.pullRequestNumber, taskId, headSha },
                'Stopping follow-up CI suspension: another task reserved this pull request suspension while it was being started');
            return { suspended: false, reason: 'superseded', cancelledRunIds: [] };
        }
        state = cancellationState(reserved.record, reserved.runs);
        await cancelPendingRuns(state, { ...deps, octokit, workflowPolicy: policy }, lease);
        if (state.ownershipLost) return { suspended: false, reason: 'superseded', cancelledRunIds: state.cancelledRunIds };
        log.info({ repository, pullRequest: target.pullRequestNumber, headSha, taskId, cancelledRunIds: state.cancelledRunIds },
            'Suspended pull request validation for the duration of the follow-up implementation');
        return { suspended: true, reason: 'suspended', cancelledRunIds: state.cancelledRunIds };
    } catch (error) {
        return await settleFailedStart({ error, state, target, taskId }, deps);
    }
}

/**
 * What a start that did not get through leaves behind. A lease taken over by
 * another worker hands them the pull request as it is: anything this pass
 * already cancelled is recorded and stays theirs to restore. Every other
 * failure keeps the reservation unless it provably cancelled nothing.
 */
async function settleFailedStart(
    params: { error: unknown; state: CancellationState | undefined; target: SuspensionTarget; taskId: string },
    deps: CiSuspensionDeps,
): Promise<BeginSuspensionResult> {
    const { error, state, target, taskId } = params;
    const log = resolveLog(deps);
    const repository = repositoryKey(target.owner, target.repo);
    if (error instanceof SuspensionLeaseLostError) {
        const cancelledRunIds = state?.cancelledRunIds ?? [];
        log.warn({ repository, pullRequest: target.pullRequestNumber, taskId, cancelledRunIds },
            'Stopping follow-up CI suspension: another worker took over this pull request suspension while it was being started');
        return { suspended: false, reason: 'busy', cancelledRunIds };
    }
    const permission = error instanceof CiActionsPermissionError;
    if (state && leavesNothingToRestore(state, permission)) {
        await deleteSuspension(deps, state.record).catch(() => undefined);
    }
    const details = {
        repository, pullRequest: target.pullRequestNumber, taskId, error: (error as Error).message,
        pendingRestore: state?.runs.filter(run => run.restarted !== true).length ?? 0,
        inheritedRestore: state?.inheritedObligations.length ?? 0,
    };
    if (permission) {
        log.error(details, 'Cannot cancel pull request validation: the GitHub App needs Actions "Read and write" access. Implementation continues with CI untouched');
    } else {
        log.warn(details, 'Failed to suspend pull request validation; implementation continues with CI untouched');
    }
    return { suspended: false, reason: permission ? 'permission_denied' : 'error', cancelledRunIds: [] };
}

/**
 * Whether a failed start can drop its reservation instead of leaving an
 * obligation behind. Every run whose cancellation may have landed has to be
 * restored, so the record normally stays and reconciliation takes it over. A
 * refused request is the one failure that proves *this* invocation cancelled
 * nothing: an Actions API this installation cannot use must not leave an
 * obligation to retry forever. It proves nothing about the requests a previous
 * invocation already sent, so an inherited obligation always survives it.
 */
function leavesNothingToRestore(state: CancellationState, permission: boolean): boolean {
    if (state.ownershipLost || state.cancelledRunIds.length > 0) return false;
    if (state.inheritedObligations.length > 0) return false;
    return permission || state.runs.length === 0;
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
