import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { createHooklessGit } from '@propr/core';
import { createFollowupHandoffGitOps } from './followupHandoffGitOps.js';
import type { CommentJobData, JobResult, UnprocessedComment, WorkerStateManager } from '@propr/core';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, loadFollowupHandoff, recordFollowupHandoff,
    HANDOFF_ACTIVE, SETTLEMENT_RETRY_SCHEDULED, SETTLEMENT_RETRY_SCHEDULING, type FollowupHandoffRecord,
} from './followupHandoffStore.js';
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

/**
 * Marks the agent exited so recovery knows execution itself finished, and
 * whether it reported full success — the only evidence that lets a recovered
 * completion comment bind the accepted request bodies.
 */
export async function markExecutionHandoffAgentExited(state: HandoffCarrier, agentCompleted: boolean): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'agent_exited', agent_completed: agentCompleted ? 1 : 0 });
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

/**
 * Durably records that a usage-limit retry is taking over the claimed
 * comments: `scheduling` before the queue add, `scheduled` once the retry job
 * is persisted. A worker death before the handoff settles then never lets
 * recovery return comments the retry job owns to the pending list. Best
 * effort: a failed checkpoint is logged and the retry is scheduled regardless,
 * since withholding it would strand the request.
 */
export async function checkpointExecutionHandoffUsageLimitRetry(
    state: HandoffCarrier,
    stage: 'scheduling' | 'scheduled',
    correlatedLogger: Logger,
): Promise<void> {
    try {
        await advanceExecutionHandoff(state, { settlement: stage === 'scheduled' ? SETTLEMENT_RETRY_SCHEDULED : SETTLEMENT_RETRY_SCHEDULING });
    } catch (error) {
        correlatedLogger.warn({ stage, error: (error as Error).message }, 'Could not checkpoint the usage-limit retry on the follow-up handoff');
    }
}

/**
 * Marks the owed publication fully delivered. The row is retained at
 * cleanup_pending rather than deleted, because the branch stays attached to the
 * worktree until the job's cleanup runs: a worker death in that window leaves a
 * discoverable record whose recovery releases the branch without republishing.
 */
export async function markExecutionHandoffCleanupPending(state: HandoffCarrier, correlatedLogger: Logger): Promise<void> {
    try {
        await advanceExecutionHandoff(state, { phase: 'cleanup_pending' });
    } catch (error) {
        if (!(error instanceof FollowupHandoffOwnershipLostError)) throw error;
        // Publication is already complete; the row moved on to another owner,
        // who now carries the branch-cleanup obligation durably instead.
        correlatedLogger.warn({ error: error.message }, 'Could not record the follow-up handoff cleanup checkpoint after publication');
    }
}

/**
 * Retires the handoff only once the worktree cleanup proved branch release
 * (no Git worktree registration holds the branch any more). A still-held
 * branch — or unreadable registrations — keeps the row at
 * cleanup_pending, blocking successors until recovery releases it durably.
 */
export async function retireExecutionHandoffAfterCleanup(state: HandoffCarrier, correlatedLogger: Logger): Promise<void> {
    const record = state.followupHandoff;
    if (!record) return;
    state.followupHandoff = null;
    try {
        // Re-read: an error settlement may have advanced the row (or held it
        // for an operator) after this writer's copy; only this task's own
        // active cleanup_pending row may retire here.
        const fresh = await loadFollowupHandoff({}, record);
        if (!fresh || fresh.task_id !== record.task_id || fresh.incarnation !== record.incarnation
            || fresh.status !== HANDOFF_ACTIVE || fresh.phase !== 'cleanup_pending') return;
        const git = createFollowupHandoffGitOps(async () => {
            throw new Error('Branch-release evidence needs no push token');
        });
        // The repository's worktree registrations are the release proof: a
        // removed directory whose registration survives still holds the branch.
        const holders = await git.branchWorktreeRegistrations(fresh.local_repo_path, fresh.branch_name);
        if (holders.length > 0) {
            correlatedLogger.warn({ worktreePath: fresh.worktree_path, branchName: fresh.branch_name, holders },
                'The follow-up branch is still registered to a worktree after cleanup; the handoff is retained for recovery to release it');
            return;
        }
        await finalizeFollowupHandoff({}, fresh);
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message },
            'Could not retire the follow-up handoff after cleanup; it stays recoverable');
    }
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
    let adoption: Awaited<ReturnType<typeof adoptPredecessorFollowupHandoff>> = {};
    let blocked: string | undefined;
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
    } catch (error) {
        // Fail closed: an adoption this writer could not verify or finish (for
        // example unavailable remote evidence) leaves the predecessor's
        // obligation standing, so the successor reschedules instead of racing
        // the retained worktree with a fresh one.
        correlatedLogger.warn({ error: (error as Error).message }, 'Predecessor follow-up handoff adoption failed; rescheduling this writer');
        blocked = 'predecessor_recovery_failed';
    } finally {
        await stopHeartbeat();
    }
    blocked ??= predecessorBlockReason(adoption);
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
