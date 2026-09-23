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
import {
    deleteSuspension, repositoryKey, reserveSuspension, saveCancelledRuns, splitRepository, suspensionKey, targetOf,
    withSuspensionLock, type CancelledRun, type CiSuspensionRecord,
} from './followupCiSuspensionStore.js';

export interface BeginSuspensionResult {
    suspended: boolean;
    reason: 'suspended' | 'disabled' | 'no_destination' | 'head_unavailable' | 'permission_denied' | 'superseded' | 'error';
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
}

export function cancellationState(record: CiSuspensionRecord, runs: CancelledRun[]): CancellationState {
    return { record, runs, cancelledRunIds: [], ownershipLost: false };
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
    const policy = resolvePolicy(deps);
    const target = targetOf(record);
    for (const run of await listRunsForSha(octokit, target, headSha)) {
        if (!isCancelableValidationRun(run, { pullRequestNumber: target.pullRequestNumber, headSha, policy })) continue;
        const known = runs.find(entry => entry.id === run.id);
        if (known) {
            // A run recorded as restored that is pending again is being cancelled anew.
            if (known.restarted !== false) {
                known.restarted = false;
                known.attempt = run.run_attempt ?? known.attempt;
                if (!await persistIntent(state, deps)) return;
            }
        } else {
            runs.push({ id: run.id, name: run.name ?? undefined, workflowId: run.workflow_id, attempt: run.run_attempt, restarted: false });
            if (!await persistIntent(state, deps)) return;
        }
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
    const key = suspensionKey({ repository: repositoryKey(target.owner, target.repo), pull_request: target.pullRequestNumber });
    return withSuspensionLock(key, () => beginSuspension(params, deps));
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
        const octokit = await resolveOctokit(deps);
        const live = await getPullRequestHead(octokit, target);
        if (!live?.open) {
            log.info({ repository, pullRequest: target.pullRequestNumber }, 'Skipping follow-up CI suspension: no open pull request head to suspend');
            return { suspended: false, reason: 'head_unavailable', cancelledRunIds: [] };
        }
        const headSha = live.sha;
        const reserved = await reserveSuspension({ target, headSha, taskId, correlationId }, deps);
        state = cancellationState(reserved.record, reserved.runs);
        await cancelPendingRuns(state, { ...deps, octokit });
        if (state.ownershipLost) return { suspended: false, reason: 'superseded', cancelledRunIds: state.cancelledRunIds };
        log.info({ repository, pullRequest: target.pullRequestNumber, headSha, taskId, cancelledRunIds: state.cancelledRunIds },
            'Suspended pull request validation for the duration of the follow-up implementation');
        return { suspended: true, reason: 'suspended', cancelledRunIds: state.cancelledRunIds };
    } catch (error) {
        const permission = error instanceof CiActionsPermissionError;
        // Every run whose cancellation may have landed has to be restored, so the
        // record stays and reconciliation takes it over. A refused request is the one
        // failure that proves nothing was cancelled: an Actions API this installation
        // cannot use must not leave an obligation behind to retry forever.
        const nothingCancelled = state && state.cancelledRunIds.length === 0 && (permission || state.runs.length === 0);
        if (state && nothingCancelled && !state.ownershipLost) {
            await deleteSuspension(deps, state.record).catch(() => undefined);
        }
        const details = { repository, pullRequest: target.pullRequestNumber, taskId, error: (error as Error).message, pendingRestore: state?.runs.length ?? 0 };
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
