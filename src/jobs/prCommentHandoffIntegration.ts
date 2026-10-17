import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { createHooklessGit } from '@propr/core';
import type { CommentJobData, JobResult, UnprocessedComment, WorkerStateManager } from '@propr/core';
import { advanceFollowupHandoff, finalizeFollowupHandoff, loadFollowupHandoff, recordFollowupHandoff, HANDOFF_ACTIVE, type FollowupHandoffRecord } from './followupHandoffStore.js';
import { adoptPredecessorFollowupHandoff, settleFollowupHandoffAfterFailure } from './followupHandoffRecovery.js';
import { schedulePRCommentRecovery } from './prCommentCollisionRecovery.js';
import { releasePRProcessingLock, startPRProcessingLockHeartbeat } from './prProcessingLock.js';
import type { ProcessingState } from './prPublicationRecovery.js';
import type { PullRequestPublication } from './prPublication.js';

/**
 * Durable follow-up publication handoff hooks for the PR comment job. The
 * handoff is written before the agent launches — bound to the PR's head/base
 * and the worktree baseline — advanced through every publication phase the
 * normal path completes (agent exit, commit, push, completion comment), and
 * retired only once the owed publication is proven delivered. A worker restart
 * at any point leaves a record that names its exact missing phase.
 */

/** The slice of processing state these hooks read and advance. */
export interface HandoffCarrier { followupHandoff?: FollowupHandoffRecord | null }

interface HandoffRef { repoOwner: string; repoName: string; pullRequestNumber: number }

export interface RecordExecutionHandoffParams {
    state: ProcessingState;
    job: Job<CommentJobData>;
    ref: HandoffRef;
    taskId: string;
    correlationId: string;
    publication: PullRequestPublication;
    llm: string | null | undefined;
    lockKey: string;
    lockToken: string;
    /** PR head/base refs at launch; recovery revalidates them before pushing. */
    binding: { headRef?: string | null; baseRef?: string | null };
    correlatedLogger: Logger;
}

async function worktreeHeadSha(worktreePath: string): Promise<string | null> {
    try {
        return (await createHooklessGit(worktreePath).raw(['rev-parse', 'HEAD'])).trim() || null;
    } catch {
        return null;
    }
}

/** Persists the handoff right before the agent launches. */
export async function recordExecutionHandoff(params: RecordExecutionHandoffParams): Promise<void> {
    const { state, job, ref } = params;
    const worktreeInfo = state.worktreeInfo!;
    state.followupHandoff = await recordFollowupHandoff({
        ref, taskId: params.taskId,
        sourceTaskIds: [...(job.data.containerCollisionTaskIds ?? []), ...(job.data.containerCollisionTaskId ? [job.data.containerCollisionTaskId] : [])],
        correlationId: params.correlationId, target: params.publication.target,
        worktreePath: worktreeInfo.worktreePath, localRepoPath: state.localRepoPath!,
        claimedComments: state.unprocessedComments, jobData: job.data, llm: params.llm,
        lockKey: params.lockKey, lockToken: params.lockToken,
        startingCommentId: state.startingWorkComment?.data.id,
        binding: { ...params.binding, headSha: await worktreeHeadSha(worktreeInfo.worktreePath) },
    });
    if (!state.followupHandoff) {
        // An unresolved different-task row still owns the publication
        // obligation for this pull request; launching an untracked agent on
        // top of it would recreate the unrecoverable-restart failure.
        throw new Error(`Follow-up publication handoff for PR #${ref.pullRequestNumber} could not be recorded because an unresolved previous attempt still owns it; the agent launch is refused`);
    }
}

/** Thrown when the durable handoff moved on without this writer; continuing untracked would let recovery republish or restore already-addressed work. */
export class FollowupHandoffOwnershipLostError extends Error {
    constructor(reason: string) {
        super(`Follow-up publication handoff ownership was lost (${reason}); stopping before further publication`);
        this.name = 'FollowupHandoffOwnershipLostError';
    }
}

async function advanceExecutionHandoff(state: HandoffCarrier, changes: Parameters<typeof advanceFollowupHandoff>[2]): Promise<void> {
    if (!state.followupHandoff) return;
    const record = state.followupHandoff;
    const advanced = await advanceFollowupHandoff({}, record, changes);
    if (advanced) {
        state.followupHandoff = advanced;
        return;
    }
    // A bare generation conflict can come from a benign concurrent write; it is
    // retried once from a re-read that proves this writer still owns the row.
    // Anything else is lost ownership, and the publication fails closed rather
    // than continuing without durable tracking.
    const fresh = await loadFollowupHandoff({}, record);
    if (fresh && fresh.task_id === record.task_id && fresh.incarnation === record.incarnation
        && fresh.status === HANDOFF_ACTIVE && fresh.lock_token === record.lock_token) {
        const retried = await advanceFollowupHandoff({}, fresh, changes);
        if (retried) {
            state.followupHandoff = retried;
            return;
        }
    }
    state.followupHandoff = null;
    throw new FollowupHandoffOwnershipLostError(fresh ? 'handoff_record_changed' : 'handoff_record_missing');
}

/** Binds the launched agent container's immutable identity to the handoff. */
export async function markExecutionHandoffContainer(state: HandoffCarrier, containerId: string): Promise<void> {
    await advanceExecutionHandoff(state, { container_id: containerId });
}

/** Marks the agent exited so recovery knows execution itself finished. */
export async function markExecutionHandoffAgentExited(state: HandoffCarrier): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'agent_exited' });
}

/** Records the normal path's commit so restart recovery resumes from the push, not from scratch. */
export async function markExecutionHandoffCommitted(state: HandoffCarrier, commitHash: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'committed', commit_hash: commitHash ?? null });
}

/** Records the normal path's completed push; recovery after this never reports missing work. */
export async function markExecutionHandoffPushed(state: HandoffCarrier, commitHash: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'pushed', commit_hash: commitHash ?? null });
}

/** Records the delivered completion comment so recovery never overwrites it with a failure notice. */
export async function markExecutionHandoffCommentPublished(state: HandoffCarrier, commentUrl: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'comment_published', completion_comment_url: commentUrl ?? null });
}

/** Retires the handoff once commit, push and the completion comment are published. */
export async function finalizeExecutionHandoff(state: HandoffCarrier): Promise<void> {
    if (!state.followupHandoff) return;
    await finalizeFollowupHandoff({}, state.followupHandoff);
    state.followupHandoff = null;
}

export interface PredecessorHandoffGateParams {
    job: Job<CommentJobData>;
    ref: HandoffRef;
    taskId: string;
    stateManager: WorkerStateManager;
    redisClient: Redis;
    pickedUpComments: UnprocessedComment[];
    lockKey: string;
    lockToken: string;
    correlatedLogger: Logger;
}

function predecessorBlockReason(adoption: Awaited<ReturnType<typeof adoptPredecessorFollowupHandoff>>): string | undefined {
    if ('blocked' in adoption && adoption.blocked) return adoption.blocked;
    // An operator hold produced by the inline resume itself (or a lost lease)
    // equally blocks this writer: the unresolved obligation must not be raced
    // or overwritten by a fresh worktree and handoff. A cleanup_pending outcome
    // blocks too — publication settled but the branch is still attached to the
    // retained worktree, so preparing another worktree on it would fail. An
    // unresolved superseded outcome (the row kept moving under re-reads) is
    // equally unsafe to race.
    if ('resumed' in adoption && adoption.resumed
        && (adoption.resumed.outcome === 'awaiting_operator' || adoption.resumed.outcome === 'ownership_lost'
            || adoption.resumed.outcome === 'cleanup_pending' || adoption.resumed.outcome === 'superseded')) {
        return `predecessor_${adoption.resumed.outcome}`;
    }
    return undefined;
}

/**
 * Runs under the caller's PR processing lease, before any new worktree is
 * prepared: a recoverable predecessor is adopted and finished in-line — with
 * the lease kept renewed for the duration — while a still-live, unverifiable,
 * or operator-held predecessor reschedules this writer instead of letting it
 * race the retained worktree.
 */
export async function gatePredecessorHandoff(params: PredecessorHandoffGateParams): Promise<JobResult | undefined> {
    const { job, ref, taskId, stateManager, redisClient, correlatedLogger } = params;
    let leaseLost = false;
    const stopHeartbeat = startPRProcessingLockHeartbeat({
        redisClient, lockKey: params.lockKey, lockToken: params.lockToken,
        onLockLost: () => { leaseLost = true; },
        onError: error => correlatedLogger.warn({ lockKey: params.lockKey, error: (error as Error).message }, 'Failed to renew PR processing lock during predecessor handoff adoption'),
    });
    let adoption: Awaited<ReturnType<typeof adoptPredecessorFollowupHandoff>>;
    try {
        // A superseded outcome means the row moved on mid-adoption; re-read and
        // resolve it before admitting this writer instead of racing an unknown
        // state. Persistent supersession falls through as a blocking reason.
        for (let attempt = 0; ; attempt += 1) {
            adoption = await adoptPredecessorFollowupHandoff(
                { ...ref, currentTaskId: taskId, log: correlatedLogger, isOwnershipLost: () => leaseLost },
                { redis: redisClient, stateManager },
            );
            if (attempt >= 2 || !('resumed' in adoption) || adoption.resumed?.outcome !== 'superseded') break;
        }
    } finally {
        await stopHeartbeat();
    }
    const blocked = predecessorBlockReason(adoption);
    if (!blocked) return undefined;
    const replacementTaskId = await schedulePRCommentRecovery({
        job, taskId, stateManager, redisClient, pickedUpComments: params.pickedUpComments,
        delay: 60_000, reason: blocked, correlatedLogger,
    });
    await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
    return { status: 'rescheduled', reason: blocked, replacementTaskId };
}

export interface HandoffErrorSettlementParams {
    ref: HandoffRef;
    taskId: string;
    error: Error;
    cancelledState: { state: string } | null;
    cancelledStateName: string;
    correlatedLogger: Logger;
}

/**
 * Settles the handoff after the in-process error handler delivered the owed
 * failure comment and terminal state. Retained unpublished work keeps the
 * record recoverable, and a user cancellation holds it for an explicit
 * operator decision.
 */
export async function settleExecutionHandoffAfterError(params: HandoffErrorSettlementParams): Promise<void> {
    const { ref, taskId, error, cancelledState, correlatedLogger } = params;
    try {
        await settleFollowupHandoffAfterFailure({
            ...ref, taskId,
            cancelled: cancelledState?.state === params.cancelledStateName || Boolean(error.message?.includes('aborted by user')),
        });
    } catch (settleError) {
        correlatedLogger.warn({ error: (settleError as Error).message }, 'Could not settle the follow-up publication handoff after a failure');
    }
}
