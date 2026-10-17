import type { UnprocessedComment } from '@propr/core';
import type { FollowupHandoffGitOps } from './followupHandoffGitOps.js';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, parseClaimedComments, parseSourceTaskIds,
    HANDOFF_AWAITING_OPERATOR,
    type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';

import { isNonFastForwardPushError } from './followupHandoffGitOps.js';
import { handoffCommentMarker } from './followupHandoffMarker.js';
import {
    deliveredOutcome, failedOutcomes, interruptedWithoutChangesBody, normalDelivery, recoveredCompletionBody, recoveredTaskReasons,
    recoveredTaskRecaps, recoveryCommitMessage, type OwedCommentDelivery, type RecoveredTaskOutcome,
} from './followupHandoffMessages.js';

export { createFollowupHandoffGitOps, type FollowupHandoffGitOps, type WorktreeAttachment } from './followupHandoffGitOps.js';

/**
 * Resumes the exact missing publication phase of an adopted follow-up handoff.
 * Every step is idempotent: committing is skipped when the worktree is clean,
 * pushing an already-published head is up to date, the owed comment is
 * deduplicated by a durable marker, and the task finalizer refuses terminal
 * states — so duplicate recovery passes can never publish twice. The handoff
 * row itself survives until the branch is proven free again (cleanup_pending),
 * so a crash around branch release retries cleanup without republishing.
 */

export interface LoggerLike {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
}

interface IssueComment { id: number; body?: string; html_url?: string }

export interface HandoffOctokit {
    request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
    paginate(route: string, params?: Record<string, unknown>): Promise<unknown[]>;
    auth(options: { type: 'installation' }): Promise<unknown>;
}

export interface HandoffStateManager {
    getTaskState(taskId: string): Promise<{ state: string } | null>;
    updateTaskState(taskId: string, state: string, metadata?: Record<string, unknown>): Promise<unknown>;
    updateHistoryMetadata(taskId: string, historyState: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface HandoffTaskStates {
    COMPLETED: string;
    FAILED: string;
    CANCELLED: string;
}

export interface ResumeFollowupHandoffParams {
    record: FollowupHandoffRecord;
    octokit: HandoffOctokit;
    git: FollowupHandoffGitOps;
    stateManager: HandoffStateManager;
    restoreComments(record: FollowupHandoffRecord, comments: UnprocessedComment[]): Promise<void>;
    store: FollowupHandoffStoreDeps;
    log: LoggerLike;
    taskStates: HandoffTaskStates;
    /** Successor task adopting this handoff, when a new follow-up triggered the recovery. */
    recoveredBy?: string;
    /** Reports a lost PR processing lease; once true no further external mutation runs. */
    isOwnershipLost?: () => boolean;
    /**
     * Guarantees another attempt for claimed comments a no-change recovery
     * returned to the pending list. Standalone recovery passes enqueue a
     * pending-comment follow-up job here; in-line predecessor adoption omits
     * it because the adopting job's own cleanup queues that follow-up.
     */
    scheduleRestoredComments?(record: FollowupHandoffRecord): Promise<void>;
    /**
     * Removes restored claimed comments from the pending list again when the
     * originating task was cancelled while they were being restored, so they
     * cannot trigger automatic execution without an operator decision.
     */
    withdrawRestoredComments?(record: FollowupHandoffRecord, comments: UnprocessedComment[]): Promise<void>;
}

export type ResumeOutcome =
    | { outcome: 'published'; commitHash: string | null }
    /** Interrupted before producing changes; the claimed comments were returned to the queue. */
    | { outcome: 'no_changes' }
    /** The normal path had already delivered its no-change completion or failure; recorded without republishing or requeueing. */
    | { outcome: 'settled' }
    | { outcome: 'awaiting_operator'; reason: string }
    | { outcome: 'cleanup_pending' }
    | { outcome: 'ownership_lost' }
    | { outcome: 'superseded' };

export function splitHandoffRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}

export { handoffCommentMarker } from './followupHandoffMarker.js';

async function holdForOperator(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, reason: string): Promise<ResumeOutcome> {
    const advanced = await advanceFollowupHandoff(params.store, record, {
        status: HANDOFF_AWAITING_OPERATOR, status_reason: reason,
    });
    if (!advanced) return { outcome: 'superseded' };
    await reportHandoffOnTaskTimeline(params, advanced, `awaiting operator: ${reason}`);
    params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, reason, worktreePath: record.worktree_path },
        'Follow-up handoff needs an operator decision; retained work is preserved');
    return { outcome: 'awaiting_operator', reason };
}

/** Best-effort recovery status on the originating task's timeline for the UI/API. */
export async function reportHandoffOnTaskTimeline(
    params: Pick<ResumeFollowupHandoffParams, 'stateManager' | 'log' | 'recoveredBy'>,
    record: FollowupHandoffRecord,
    nextAction: string,
): Promise<void> {
    try {
        const current = await params.stateManager.getTaskState(record.task_id);
        if (!current) return;
        // Host filesystem paths stay off the member-visible timeline; the
        // operator-only status API exposes the retained worktree path instead.
        await params.stateManager.updateHistoryMetadata(record.task_id, current.state, {
            followupPublicationHandoff: {
                phase: record.phase, status: record.status, statusReason: record.status_reason,
                branchName: record.branch_name,
                predecessorTaskIds: parseSourceTaskIds(record),
                ...(successorTaskId(params, record) ? { successorTaskId: successorTaskId(params, record) } : {}),
                nextAction,
            },
        });
    } catch (error) {
        params.log.warn({ taskId: record.task_id, error: (error as Error).message }, 'Could not record follow-up handoff status on the task timeline');
    }
}

function successorTaskId(params: Pick<ResumeFollowupHandoffParams, 'recoveredBy'>, record: FollowupHandoffRecord): string | null {
    return params.recoveredBy ?? record.successor_task_id ?? null;
}

/** True (and logged) when the PR processing lease was lost: no further mutation may run. */
function ownershipLost(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): boolean {
    if (!params.isOwnershipLost?.()) return false;
    params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Lost the PR processing lease during follow-up handoff recovery; stopping before further mutations');
    return true;
}

/**
 * User cancellation is authoritative: re-checked before every publication
 * step. The task-state read is itself awaited, so a lease loss it observed is
 * reported too — neither an operator hold nor the caller's mutation may follow.
 */
async function cancellationHold(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    beforeHold?: () => Promise<void>,
): Promise<ResumeOutcome | null> {
    if (record.operator_authorized) return ownershipLost(params, record) ? { outcome: 'ownership_lost' } : null;
    const taskState = await params.stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    if (taskState?.state !== params.taskStates.CANCELLED) return null;
    await beforeHold?.();
    return holdForOperator(params, record, 'cancelled_by_user');
}

/**
 * Revalidates publication authority immediately before the push: the pull
 * request must still have the head/base refs the handoff was bound to, and the
 * remote branch head must be our own baseline or our own earlier push. A
 * retargeted PR or an externally advanced head fails closed and preserves the
 * handoff for an operator.
 */
async function validatePublicationBinding(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome | null> {
    if (record.head_ref || record.base_ref) {
        const { owner, repo } = splitHandoffRepository(record.repository);
        const { data } = await params.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: record.pull_request,
        });
        const pr = data as { head?: { ref?: string }; base?: { ref?: string } };
        if ((record.head_ref && pr.head?.ref !== record.head_ref) || (record.base_ref && pr.base?.ref !== record.base_ref)) {
            return holdForOperator(params, record, 'pr_binding_mismatch');
        }
    }
    const remoteHead = await params.git.remoteBranchHead(record.worktree_path, record.branch_name);
    if (remoteHead && remoteHead !== record.head_sha && !(await params.git.isAncestorOfHead(record.worktree_path, remoteHead))) {
        return holdForOperator(params, record, 'head_advanced_externally');
    }
    return null;
}

/**
 * Publishes the owed comment exactly once, keyed by the handoff's durable
 * marker. Delivered evidence is reconciled first: the normal path publishes
 * its completion (carrying the same marker) before checkpointing the URL, so a
 * worker death in that window leaves a delivered comment this recovery must
 * checkpoint unchanged, never overwrite through the starting comment or
 * duplicate. The lease can be lost — and the user can cancel — while any of
 * these GitHub requests is awaited, so both are re-checked immediately before
 * each mutation: the starting-comment PATCH and the fallback POST (which also
 * covers a PATCH that found its comment deleted).
 *
 * A found normal failure notice is delivered evidence for a no-change
 * outcome, but not for publishing recovered work: with `supersedeFailure` it
 * is overwritten in place by the recovered completion, exactly as the failure
 * settlement's later recovery would have overwritten the starting comment.
 */
async function publishOwedComment(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    body: string,
    { supersedeFailure = false }: { supersedeFailure?: boolean } = {},
): Promise<OwedCommentDelivery | { done: ResumeOutcome }> {
    if (record.completion_comment_url) return { url: record.completion_comment_url, delivery: 'recovery' };
    const { owner, repo } = splitHandoffRepository(record.repository);
    const marker = handoffCommentMarker(record);
    const comments = await params.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, per_page: 100,
    }) as IssueComment[];
    const existing = comments.find(comment => comment.body?.includes(marker));
    const existingDelivery = existing && normalDelivery(existing.body);
    if (existing && !(supersedeFailure && existingDelivery === 'normal_failure')) {
        return { url: existing.html_url ?? null, delivery: existingDelivery ?? 'recovery' };
    }
    const patchTarget = existing?.id ?? record.starting_comment_id;
    if (patchTarget) {
        const hold = await cancellationHold(params, record);
        if (hold) return { done: hold };
        try {
            const { data } = await params.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: patchTarget, body,
            });
            return { url: (data as IssueComment).html_url ?? null, delivery: 'recovery' };
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }
    const hold = await cancellationHold(params, record);
    if (hold) return { done: hold };
    const { data } = await params.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, body,
    });
    return { url: (data as IssueComment).html_url ?? null, delivery: 'recovery' };
}

const terminalStates = (taskStates: HandoffTaskStates): Set<string> =>
    new Set([taskStates.COMPLETED, taskStates.FAILED, taskStates.CANCELLED]);

/**
 * Settles the originating task. Reports 'ownership_lost', without touching
 * the task, when the lease was lost during the state read. For a no-change
 * outcome — whose claimed comments were just returned to the queue — a
 * cancellation found here (the last read before cleanup) reports 'cancelled'
 * so the caller withdraws them, instead of treating the cancelled task as
 * already final and letting the queued follow-up execute them.
 */
async function finalizeRecoveredTask(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    outcome: RecoveredTaskOutcome,
): Promise<'finalized' | 'ownership_lost' | 'cancelled'> {
    const { stateManager, taskStates } = params;
    const current = await stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return 'ownership_lost';
    if (outcome === 'no_changes' && current?.state === taskStates.CANCELLED && !record.operator_authorized) return 'cancelled';
    const historyMetadata = {
        followupPublicationHandoff: {
            recovered: true, phase: record.phase, branchName: record.branch_name,
            predecessorTaskIds: parseSourceTaskIds(record),
            ...(successorTaskId(params, record) ? { successorTaskId: successorTaskId(params, record) } : {}),
        },
        notificationRecap: recoveredTaskRecaps[outcome],
    };
    if (current && terminalStates(taskStates).has(current.state)) {
        await reportHandoffOnTaskTimeline(params, record, 'publication recovered; task already final');
        return 'finalized';
    }
    await stateManager.updateTaskState(record.task_id, failedOutcomes.has(outcome) ? taskStates.FAILED : taskStates.COMPLETED, {
        reason: recoveredTaskReasons[outcome],
        ...(outcome === 'published' && record.commit_hash ? { commitHash: record.commit_hash } : {}),
        historyMetadata,
    });
    return 'finalized';
}

/** Status reason marking a no-change recovery that returned the claimed comments to the queue. */
const RETURNED_TO_QUEUE = 'returned_to_queue';

/**
 * What a retired handoff reports: published work, an interrupted request
 * this recovery returned to the queue, or a completion/failure the normal
 * path had already delivered (settled without republishing or requeueing).
 */
function retiredOutcome(record: FollowupHandoffRecord): ResumeOutcome {
    if (record.commit_hash) return { outcome: 'published', commitHash: record.commit_hash };
    return record.status_reason === RETURNED_TO_QUEUE ? { outcome: 'no_changes' } : { outcome: 'settled' };
}

/**
 * Retires the handoff only once the branch is proven free of the retained
 * worktree. A failed or interrupted release keeps the row at cleanup_pending,
 * so a later pass retries cleanup without republishing anything.
 */
async function attemptHandoffCleanup(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    let released = false;
    try {
        const attachment = await params.git.worktreeAttachment(record.worktree_path, record.branch_name);
        // The lease can be lost while the attachment is inspected; the branch
        // release then belongs to the successor that now owns the handoff.
        if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
        if (attachment !== 'attached'
            || await params.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path)) {
            // Release proof is the repository's own worktree registrations, not
            // the directory: a worktree removed (or detached) by normal cleanup
            // is free, but a removed directory whose registration survives
            // still holds the branch, and the row must stay discoverable.
            released = (await params.git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name)).length === 0;
        }
    } catch (error) {
        params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Branch release from the settled worktree failed; the handoff is retained to retry cleanup');
    }
    if (!released) {
        await reportHandoffOnTaskTimeline(params, record, 'publication complete; branch release pending retry');
        return { outcome: 'cleanup_pending' };
    }
    // A loss observed during the release leaves the row for the successor,
    // whose cleanup pass proves the free branch and retires it.
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    await finalizeFollowupHandoff(params.store, record);
    const retired = retiredOutcome(record);
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, commitHash: record.commit_hash, outcome: retired.outcome },
        retired.outcome === 'published'
            ? 'Recovered and published an interrupted follow-up exactly once'
            : retired.outcome === 'no_changes'
                ? 'Interrupted follow-up produced no changes; its branch is free again'
                : 'Follow-up outcome was already delivered; its branch is free again');
    return retired;
}

/**
 * Best effort by necessity: the operator hold that follows is the durable
 * obligation, and a withdrawal failure is logged rather than letting it skip
 * that hold. A crash before the hold leaves the row active, and the next pass
 * holds it on its initial cancellation check.
 */
async function withdrawCancelledClaims(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, claimed: UnprocessedComment[]): Promise<void> {
    if (!params.withdrawRestoredComments) return;
    try {
        await params.withdrawRestoredComments(record, claimed);
    } catch (error) {
        params.log.error({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Could not withdraw restored comments of a cancelled follow-up from the pending list');
    }
}

/**
 * The normal error path reported the failure (with this handoff's marker) and
 * died before settling the handoff. Its failure settlement would have retired
 * a worktree without publishable work, so recovery reconciles to the same
 * end: the delivered notice is recorded unchanged, the task stays failed and
 * the answered request is never requeued. Every step is repeatable.
 */
async function finishDeliveredFailure(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, url: string | null): Promise<ResumeOutcome> {
    const finalized = await finalizeRecoveredTask(params, record, 'failure_delivered');
    if (finalized !== 'finalized') return { outcome: 'ownership_lost' };
    const advanced = await advanceFollowupHandoff(params.store, record, {
        phase: 'cleanup_pending', completion_comment_url: url, status_reason: 'failure_delivered',
    });
    if (!advanced) return { outcome: 'superseded' };
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Recorded the follow-up failure the normal path delivered before a worker restart; nothing was requeued');
    return attemptHandoffCleanup(params, advanced);
}

async function finishWithoutChanges(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    // Cancellation or lease loss may land while the Git evidence or the notice
    // request is awaited: publication re-checks both before its mutation, and
    // they are re-checked again before restoring the claimed comments, or a
    // cancelled request would be requeued (or a successor's raced).
    const notice = await publishOwedComment(params, record, interruptedWithoutChangesBody(record));
    if ('done' in notice) return notice.done;
    if (notice.delivery === 'normal_completion') {
        // The normal path already delivered its (no-change) completion and the
        // claimed comments were answered: record it, never requeue them.
        const delivered = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: notice.url });
        return delivered ? finishPublishedComment(params, delivered) : { outcome: 'superseded' };
    }
    if (notice.delivery === 'normal_failure') return finishDeliveredFailure(params, record, notice.url);
    const hold = await cancellationHold(params, record);
    if (hold) return hold;
    const claimed = parseClaimedComments(record);
    await params.restoreComments(record, claimed);
    // A successor that adopts this phase restores (deduplicated) and schedules
    // again. A cancellation that landed while the restoration was awaited must
    // not schedule replacement work: the restored claims are withdrawn from
    // the pending list (so no follow-up job picks them up) before the handoff
    // is held for an explicit operator decision.
    const lateHold = await cancellationHold(params, record, () => withdrawCancelledClaims(params, record, claimed));
    if (lateHold) return lateHold;
    await params.scheduleRestoredComments?.(record);
    // The user can cancel while the follow-up job is being queued, too. The
    // finalizer's state read is the last one before cleanup: a cancellation it
    // finds withdraws the restored claims and holds the handoff, so the job
    // already queued finds neither the claims nor a free admission gate.
    const finalized = await finalizeRecoveredTask(params, record, 'no_changes');
    if (finalized === 'ownership_lost') return { outcome: 'ownership_lost' };
    if (finalized === 'cancelled') {
        await withdrawCancelledClaims(params, record, claimed);
        return holdForOperator(params, record, 'cancelled_by_user');
    }
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'cleanup_pending', status_reason: RETURNED_TO_QUEUE });
    if (!advanced) return { outcome: 'superseded' };
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Interrupted follow-up produced no changes; claimed comments were returned to the queue');
    return attemptHandoffCleanup(params, advanced);
}

/**
 * Collects the exited agent's output from the retained worktree: commits any
 * uncommitted work, or recognizes already-committed-but-unpushed work, or
 * settles the handoff as producing no changes at all.
 */
async function collectAgentOutput(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
): Promise<{ record: FollowupHandoffRecord } | { done: ResumeOutcome }> {
    const { git } = params;
    const attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    if (attachment === 'missing') return { done: await holdForOperator(params, record, 'worktree_missing') };
    if (attachment === 'not_on_branch') return { done: await holdForOperator(params, record, 'worktree_not_on_branch') };
    let commitHash: string | null;
    if (await git.hasUncommittedChanges(record.worktree_path)) {
        // Cancellation or lease loss during the worktree inspection stops the
        // commit; the later push check alone would leave a cancelled commit.
        const hold = await cancellationHold(params, record);
        if (hold) return { done: hold };
        const commit = await git.commitWork(record.worktree_path, recoveryCommitMessage(record), record.pull_request);
        commitHash = commit?.commitHash ?? null;
    } else {
        commitHash = null;
    }
    // A dirty worktree can still hold nothing publishable: committing unstages
    // generated runtime output and then creates no commit. Only a verified
    // commit hash may reach the committed phase; otherwise already committed
    // but unpushed work is recognized, or the run produced no changes.
    if (!commitHash && await git.hasUnpushedCommits(record.worktree_path, record.branch_name)) {
        commitHash = await git.head(record.worktree_path);
    }
    if (!commitHash) return { done: await finishWithoutChanges(params, record) };
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'committed', commit_hash: commitHash });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

type ResumeStep = { record: FollowupHandoffRecord } | { done: ResumeOutcome };

/** Pushes the committed work after revalidating cancellation, binding, worktree identity and lease ownership. */
async function pushCommittedWork(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeStep> {
    const { git } = params;
    const hold = await cancellationHold(params, record) ?? await validatePublicationBinding(params, record);
    if (hold) return { done: hold };
    // A committed handoff publishes exactly the recorded worktree, branch and
    // commit. A detached/switched worktree or a replaced HEAD (for example
    // during manual recovery) is held for an operator, never pushed.
    const attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    if (attachment !== 'attached') {
        return { done: await holdForOperator(params, record, attachment === 'missing' ? 'worktree_missing' : 'worktree_not_on_branch') };
    }
    if (!record.commit_hash || await git.head(record.worktree_path) !== record.commit_hash) {
        return { done: await holdForOperator(params, record, 'recorded_commit_mismatch') };
    }
    // Binding validation and the worktree evidence above are lengthy awaits; a
    // cancellation or lease loss that landed during them must stop the push.
    const lateHold = await cancellationHold(params, record);
    if (lateHold) return { done: lateHold };
    const { owner, repo } = splitHandoffRepository(record.target_repository);
    let pushed: Awaited<ReturnType<typeof git.push>>;
    try {
        pushed = await git.push(record.worktree_path, { repoOwner: owner, repoName: repo, branchName: record.branch_name });
    } catch (error) {
        // An externally advanced head rejects the stale push; fail closed for
        // an operator instead of rebasing over the other actor's work.
        if (isNonFastForwardPushError(error)) {
            return { done: await holdForOperator(params, record, 'head_advanced_externally') };
        }
        throw error;
    }
    const commitHash = (pushed && typeof pushed === 'object' && pushed.commitHash) || record.commit_hash;
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'pushed', commit_hash: commitHash });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

/** Publishes the owed completion comment; cancellation and lease ownership are re-checked before each comment mutation. */
async function publishPushedCompletion(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeStep> {
    const published = await publishOwedComment(params, record, recoveredCompletionBody(record), { supersedeFailure: true });
    if ('done' in published) return published;
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: published.url });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

/** Finalizes the task for a recorded completion comment, then frees the branch while keeping the worktree. */
async function finishPublishedComment(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    let current = record;
    if (current.phase === 'comment_published') {
        if (await finalizeRecoveredTask(params, current, deliveredOutcome(current)) !== 'finalized') return { outcome: 'ownership_lost' };
        const advanced = await advanceFollowupHandoff(params.store, current, { phase: 'cleanup_pending' });
        if (!advanced) return { outcome: 'superseded' };
        current = advanced;
    }
    return attemptHandoffCleanup(params, current);
}

/**
 * Called under the pull request's processing lease with a record whose agent
 * is proven exited/lost. Adopts the existing retained worktree in place; it
 * never checks out the already-attached branch anywhere else.
 */
export async function resumeFollowupHandoff(params: ResumeFollowupHandoffParams): Promise<ResumeOutcome> {
    let record = params.record;
    if (record.phase !== 'cleanup_pending') {
        // User cancellation is authoritative: never publish without explicit operator authorization.
        const hold = await cancellationHold(params, record);
        if (hold) return hold;
        if (record.is_fork) return holdForOperator(params, record, 'fork_publication_unsupported');
    }

    if (record.phase === 'agent_running' || record.phase === 'agent_exited') {
        const collected = await collectAgentOutput(params, record);
        if ('done' in collected) return collected.done;
        record = collected.record;
    }
    if (record.phase === 'committed') {
        const step = await pushCommittedWork(params, record);
        if ('done' in step) return step.done;
        record = step.record;
    }
    if (record.phase === 'pushed') {
        const step = await publishPushedCompletion(params, record);
        if ('done' in step) return step.done;
        record = step.record;
    }
    if (record.phase === 'comment_published' || record.phase === 'cleanup_pending') return finishPublishedComment(params, record);
    return { outcome: 'superseded' };
}
