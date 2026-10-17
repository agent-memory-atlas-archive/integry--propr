import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { CommentJobData, JobResult, UnprocessedComment, WorkerStateManager } from '@propr/core';
import { advanceFollowupHandoff, finalizeFollowupHandoff, recordFollowupHandoff } from './followupHandoffStore.js';
import { adoptPredecessorFollowupHandoff, settleFollowupHandoffAfterFailure } from './followupHandoffRecovery.js';
import { schedulePRCommentRecovery } from './prCommentCollisionRecovery.js';
import { releasePRProcessingLock } from './prProcessingLock.js';
import type { ProcessingState } from './prPublicationRecovery.js';
import type { PullRequestPublication } from './prPublication.js';

/**
 * Durable follow-up publication handoff hooks for the PR comment job. The
 * handoff is written before the agent launches, advanced when it exits, and
 * retired only once the owed publication (or its handled failure) is proven
 * delivered — so a worker restart at any point leaves a recoverable record.
 */

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
    correlatedLogger: Logger;
}

/** Persists the handoff right before the agent launches. */
export async function recordExecutionHandoff(params: RecordExecutionHandoffParams): Promise<void> {
    const { state, job, ref, correlatedLogger } = params;
    const worktreeInfo = state.worktreeInfo!;
    state.followupHandoff = await recordFollowupHandoff({
        ref, taskId: params.taskId,
        sourceTaskIds: [...(job.data.containerCollisionTaskIds ?? []), ...(job.data.containerCollisionTaskId ? [job.data.containerCollisionTaskId] : [])],
        correlationId: params.correlationId, target: params.publication.target,
        worktreePath: worktreeInfo.worktreePath, localRepoPath: state.localRepoPath!,
        claimedComments: state.unprocessedComments, jobData: job.data, llm: params.llm,
        lockKey: params.lockKey, lockToken: params.lockToken,
        startingCommentId: state.startingWorkComment?.data.id,
    });
    if (!state.followupHandoff) {
        correlatedLogger.warn({ pullRequestNumber: ref.pullRequestNumber }, 'Could not record the follow-up publication handoff; restart recovery is unavailable for this attempt');
    }
}

/** Marks the agent exited so recovery knows execution itself finished. */
export async function markExecutionHandoffAgentExited(state: ProcessingState): Promise<void> {
    if (!state.followupHandoff) return;
    state.followupHandoff = await advanceFollowupHandoff({}, state.followupHandoff, { phase: 'agent_exited' });
}

/** Retires the handoff once commit, push and the completion comment are published. */
export async function finalizeExecutionHandoff(state: ProcessingState): Promise<void> {
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

/**
 * Runs under the caller's PR processing lease, before any new worktree is
 * prepared: a recoverable predecessor is adopted and finished in-line, while a
 * still-live or unverifiable predecessor reschedules this writer instead of
 * letting it race the retained worktree.
 */
export async function gatePredecessorHandoff(params: PredecessorHandoffGateParams): Promise<JobResult | undefined> {
    const { job, ref, taskId, stateManager, redisClient, correlatedLogger } = params;
    const adoption = await adoptPredecessorFollowupHandoff(
        { ...ref, currentTaskId: taskId, log: correlatedLogger },
        { redis: redisClient, stateManager },
    );
    if (!('blocked' in adoption) || !adoption.blocked) return undefined;
    const replacementTaskId = await schedulePRCommentRecovery({
        job, taskId, stateManager, redisClient, pickedUpComments: params.pickedUpComments,
        delay: 60_000, reason: adoption.blocked, correlatedLogger,
    });
    await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
    return { status: 'rescheduled', reason: adoption.blocked, replacementTaskId };
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
 * failure comment and terminal state; a user cancellation instead holds the
 * record and its retained work for an explicit operator decision.
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
