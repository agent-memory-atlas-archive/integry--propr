import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
    ensureGitRepository, TaskStates,
    type getAuthenticatedOctokit, type WorkerStateManager, type WorktreeInfo,
    type ClaudeCodeResponse, type CommentJobData, type UnprocessedComment, type JobResult,
} from '@propr/core';
import type { PRJobContext } from './prCommentReviewJob.js';
import { createPRCommentTaskStateIfMissing } from './prCommentCollisionRecovery.js';
import { handlePostExecution, type PublicationCompletion } from './prCommentPostExecution.js';
import { restorePendingComments } from './prPendingComments.js';
import { stopOriginalPRReviewCycle } from './prContinuationReview.js';
import { handleUltrafixContinuation } from './ultrafixJobHelpers.js';
import { PullRequestPublication } from './prPublication.js';
import { findPRContinuation, savePublicationCheckpoint, type Contribution } from './prContinuation.js';

export interface ProcessingState {
    publication?: PullRequestPublication;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    localRepoPath: string | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

export interface ExecuteProcessingParams {
    job: Job<CommentJobData>;
    context: PRJobContext;
    llm: string | null | undefined;
    taskId: string;
    stateManager: WorkerStateManager;
    state: ProcessingState;
    lockKey: string;
    lockToken: string;
}

/** Recover under the shared PR lease, before comment filtering or review routing can skip completion. */
export async function recoverPendingPublication(params: ExecuteProcessingParams, redisClient: Redis): Promise<JobResult | undefined> {
    const { state, context, taskId, job, stateManager, lockKey, lockToken } = params;
    const record = await findPRContinuation(context);
    if (!record?.publication_bundle && !record?.publication_completion) return;
    const savedCompletion = record.publication_completion
        ? JSON.parse(record.publication_completion) as PublicationCompletion : undefined;
    if (savedCompletion && (await stateManager.getTaskState(savedCompletion.taskId))?.state === TaskStates.CANCELLED) {
        // Retire both inputs before any reconciliation or preparation. A later
        // request's prepare() must not restore work the originating user cancelled.
        await savePublicationCheckpoint(record, null, null);
        context.correlatedLogger.info({ taskId: savedCompletion.taskId }, 'Retired cancelled publication checkpoint');
        return;
    }
    const octokit = state.octokit!;
    // Completion alone uses the retained destination and task metadata, even after
    // the continuation is merged and its branch is deleted.
    const source = record.publication_bundle ? (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: context.repoOwner, repo: context.repoName, pull_number: context.pullRequestNumber,
    })).data as Contribution : {
        head: { ref: record.branch_name, sha: record.source_sha, repo: { full_name: record.repository } },
        base: { ref: record.base_branch }, title: record.source_title,
        body: record.source_body, user: { login: record.source_author },
    };
    const publication = state.publication = new PullRequestPublication(octokit, context, source as Contribution);
    publication.continuation = record;
    await publication.reconcilePublication();
    if (publication.continuation.publication_bundle) {
        await ensureGitRepository(context.correlatedLogger);
        const prepared = await publication.prepare(`pr-${context.pullRequestNumber}-publication-${Date.now()}`);
        state.localRepoPath = prepared.localRepoPath;
        state.worktreeInfo = prepared.worktreeInfo;
    } else {
        await publication.announce();
    }
    const completion = publication.pendingCompletion;
    if (!completion) return; // Legacy bundles can be published but have no completion inputs.
    Object.assign(state, {
        claudeResult: completion.claudeResult, authorsText: completion.authorsText,
        unprocessedComments: completion.unprocessedComments, startingWorkComment: completion.startingWorkComment,
    });
    const originalJob = { ...job, id: completion.taskId, data: completion.jobData } as Job<CommentJobData>;
    const originalContext = { ...context, ...completion.jobData, publication };
    const originalState = await stateManager.getTaskState(completion.taskId);
    await createPRCommentTaskStateIfMissing({
        job: originalJob, taskId: completion.taskId, stateManager, preexistingState: originalState,
        modelName: completion.llm ?? null, correlatedLogger: context.correlatedLogger,
    });
    if (originalState?.state === TaskStates.FAILED) await stateManager.updateTaskState(completion.taskId, TaskStates.PROCESSING, {
        reason: 'Retrying publication completion for the originating task', isRetry: true,
    });
    const result = await handlePostExecution({
        state, job: originalJob, taskId: completion.taskId, stateManager, context: originalContext,
        unprocessedReviewComments: completion.unprocessedReviewComments, llm: completion.llm,
        redisClient, prProcessingLockKey: lockKey, prProcessingLockToken: lockToken,
        recoveredCompletion: completion,
    }, completion.taskUrl);
    const stopped = await stopOriginalPRReviewCycle({
        ref: originalContext, continuation: publication.continuation, commandMode: originalJob.data.commandMode,
        ultrafix: Boolean(originalJob.data.ultrafixMeta), redis: redisClient, octokit,
    });
    if (!stopped) await handleUltrafixContinuation('fix', {
        job: originalJob, stateManager, taskId: completion.taskId, redisClient,
        repoOwner: originalContext.repoOwner, repoName: originalContext.repoName,
        pullRequestNumber: originalContext.pullRequestNumber, correlatedLogger: context.correlatedLogger,
        correlationId: originalContext.correlationId,
    });
    const completedIds = new Set(completion.instructionCommentIds);
    context.commentsToProcess = context.commentsToProcess.filter(comment => !completedIds.has(comment.id));
    if (taskId === completion.taskId && context.commentsToProcess.length > 0) {
        // Newly claimed comments need their own task after this retry completes.
        // cleanupJob schedules them from the pending list.
        await restorePendingComments(context.commentsToProcess, { ...context, redisClient });
        context.commentsToProcess = [];
    }
    if (taskId !== completion.taskId && (await stateManager.getTaskState(taskId))?.state === TaskStates.FAILED) {
        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, {
            reason: 'Retrying request after publication recovery', isRetry: true,
        });
    }
    if (context.commentsToProcess.length === 0) {
        if (taskId !== completion.taskId) await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'Recovered publication and completion of the originating task', commitHash: result.commitHash,
            historyMetadata: { recoveryOfTaskId: completion.taskId },
        });
        await publication.finishCompletion();
        return { status: result.partial ? 'partial' : 'complete', commit: result.commitHash,
            pullRequestNumber: context.pullRequestNumber, claudeResult: { success: completion.claudeResult.success } };
    }
    await publication.finishCompletion();
    // A new request continues on the recovered HEAD with only its remaining instructions.
    state.claudeResult = null;
    state.startingWorkComment = null;
    state.unprocessedComments = [];
    state.authorsText = '';
}
