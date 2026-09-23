/**
 * Starting a suspension: resolving which pull request head becomes obsolete and
 * cancelling its eligible validation runs, one durable intent at a time.
 */

import { isCancelCiDuringFollowupEnabledForRepository } from '@propr/core';
import type { ContinuationRecord, PullRequestReference } from './prContinuation.js';
import {
    CiActionsPermissionError, cancelRun, getPullRequestHead, isCancelableValidationRun, listRunsForSha,
    type SuspensionTarget,
} from './followupCiSuspensionRuns.js';
import { resolveLog, resolveOctokit, resolvePolicy, type CiSuspensionDeps } from './followupCiSuspensionContext.js';
import { SuspensionLeaseUnavailableError, withSuspensionLease } from './followupCiSuspensionLease.js';
import {
    deleteSuspension, repositoryKey, reserveSuspension, saveCancelledRuns, splitRepository, suspensionKey, targetOf,
    type CancelledRun, type CiSuspensionRecord,
} from './followupCiSuspensionStore.js';

export interface BeginSuspensionResult {
    suspended: boolean;
    reason: 'suspended' | 'disabled' | 'no_workflows_selected' | 'no_destination' | 'head_unavailable'
        | 'permission_denied' | 'superseded' | 'busy' | 'error';
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
 */
export async function cancelPendingRuns(state: CancellationState, deps: CiSuspensionDeps): Promise<void> {
    const { record, runs } = state;
    const octokit = await resolveOctokit(deps);
    const headSha = record.head_sha;
    const target = targetOf(record);
    const policy = await resolvePolicy(deps, target);
    if (policy.selected.size === 0) return;
    for (const run of await listRunsForSha(octokit, target, headSha)) {
        if (!isCancelableValidationRun(run, { pullRequestNumber: target.pullRequestNumber, headSha, policy })) continue;
        const known = runs.find(entry => entry.id === run.id);
        if (known) {
            // Known and pending again — restarted or never cancelled — so this is a
            // fresh obligation on the current attempt either way.
            known.restarted = false;
            known.attempt = run.run_attempt ?? known.attempt;
        } else {
            runs.push({ id: run.id, name: run.name ?? undefined, workflowId: run.workflow_id, attempt: run.run_attempt, restarted: false });
        }
        // Written before every single cancel request, including for a run that is
        // already known: the write is also the ownership check that proves this
        // pass still owns the suspension at the moment it acts on GitHub.
        if (!await persistIntent(state, deps)) return;
        if (await cancelRun(octokit, target, run.id)) state.cancelledRunIds.push(run.id);
    }
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
        return await withSuspensionLease(deps, key, () => beginSuspension(params, deps));
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
        const reserved = await reserveSuspension({ target, headSha, taskId, correlationId }, deps);
        state = cancellationState(reserved.record, reserved.runs);
        await cancelPendingRuns(state, { ...deps, octokit, workflowPolicy: policy });
        if (state.ownershipLost) return { suspended: false, reason: 'superseded', cancelledRunIds: state.cancelledRunIds };
        log.info({ repository, pullRequest: target.pullRequestNumber, headSha, taskId, cancelledRunIds: state.cancelledRunIds },
            'Suspended pull request validation for the duration of the follow-up implementation');
        return { suspended: true, reason: 'suspended', cancelledRunIds: state.cancelledRunIds };
    } catch (error) {
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
