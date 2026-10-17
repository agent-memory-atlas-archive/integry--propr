import type { UnprocessedComment } from '@propr/core';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import type { FollowupHandoffGitOps } from './followupHandoffGitOps.js';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, parseClaimedComments, parseSourceTaskIds,
    HANDOFF_AWAITING_OPERATOR,
    type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';

import { isNonFastForwardPushError } from './followupHandoffGitOps.js';

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
}

export type ResumeOutcome =
    | { outcome: 'published'; commitHash: string | null }
    | { outcome: 'no_changes' }
    | { outcome: 'awaiting_operator'; reason: string }
    | { outcome: 'cleanup_pending' }
    | { outcome: 'ownership_lost' }
    | { outcome: 'superseded' };

export function splitHandoffRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}

export function handoffCommentMarker(record: Pick<FollowupHandoffRecord, 'repository' | 'pull_request' | 'incarnation'>): string {
    return `<!-- propr-followup-handoff:${record.repository}:${record.pull_request}:${record.incarnation} -->`;
}

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
async function cancellationHold(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome | null> {
    if (record.operator_authorized) return ownershipLost(params, record) ? { outcome: 'ownership_lost' } : null;
    const taskState = await params.stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    if (taskState?.state !== params.taskStates.CANCELLED) return null;
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

function recoveryCommitMessage(record: FollowupHandoffRecord): string {
    return `fix(ai): recover interrupted follow-up for PR #${record.pull_request}\n\n`
        + 'The agent produced this work before a worker restart interrupted publication. '
        + 'ProPR adopted the retained worktree and committed it during follow-up handoff recovery.';
}

function recoveredCompletionBody(record: FollowupHandoffRecord): string {
    const comments = filterRealComments(parseClaimedComments(record));
    const ids = comments.map(comment => comment.id);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    return [
        handoffCommentMarker(record),
        `✅ **Recovered and published follow-up changes**${authors ? ` requested by ${authors}` : ''}`,
        'A worker restart interrupted the original attempt after the agent produced work. ProPR adopted the retained worktree and published it.',
        record.commit_hash ? `Commit: \`${record.commit_hash}\`` : '',
        ids.length ? `---\nComment ID${ids.length > 1 ? 's' : ''}: ${ids.map(id => `${id}✓`).join(', ')}` : '',
        buildWorkEvidenceMarker('completed', ids),
    ].filter(Boolean).join('\n\n');
}

function interruptedWithoutChangesBody(record: FollowupHandoffRecord): string {
    const comments = filterRealComments(parseClaimedComments(record));
    const ids = comments.map(comment => comment.id);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    return [
        handoffCommentMarker(record),
        `⚠️ **Follow-up interrupted before any changes were produced**${authors ? ` (requested by ${authors})` : ''}`,
        'A worker restart interrupted the agent run and its worktree holds no unpublished work. The request has been returned to the queue and will be picked up by the next follow-up on this pull request.',
        ids.length ? `Returned comment ID${ids.length > 1 ? 's' : ''}: ${ids.join(', ')}` : '',
        buildWorkEvidenceMarker('failed', ids),
    ].filter(Boolean).join('\n\n');
}

/**
 * Publishes the owed comment exactly once, keyed by the handoff's durable
 * marker. The lease can be lost — and the user can cancel — while any of these
 * GitHub requests is awaited, so both are re-checked immediately before each
 * mutation: the starting-comment PATCH and the fallback POST after pagination
 * (which also covers a PATCH that found its comment deleted).
 */
async function publishOwedComment(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    body: string,
): Promise<{ url: string | null } | { done: ResumeOutcome }> {
    if (record.completion_comment_url) return { url: record.completion_comment_url };
    const { owner, repo } = splitHandoffRepository(record.repository);
    const marker = handoffCommentMarker(record);
    if (record.starting_comment_id) {
        const hold = await cancellationHold(params, record);
        if (hold) return { done: hold };
        try {
            const { data } = await params.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: record.starting_comment_id, body,
            });
            return { url: (data as IssueComment).html_url ?? null };
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }
    const comments = await params.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, per_page: 100,
    }) as IssueComment[];
    const existing = comments.find(comment => comment.body?.includes(marker));
    if (existing) return { url: existing.html_url ?? null };
    const hold = await cancellationHold(params, record);
    if (hold) return { done: hold };
    const { data } = await params.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, body,
    });
    return { url: (data as IssueComment).html_url ?? null };
}

const terminalStates = (taskStates: HandoffTaskStates): Set<string> =>
    new Set([taskStates.COMPLETED, taskStates.FAILED, taskStates.CANCELLED]);

/** Returns false, without touching the task, when the lease was lost during the state read. */
async function finalizeRecoveredTask(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, published: boolean): Promise<boolean> {
    const { stateManager, taskStates } = params;
    const current = await stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return false;
    const historyMetadata = {
        followupPublicationHandoff: {
            recovered: true, phase: record.phase, branchName: record.branch_name,
            predecessorTaskIds: parseSourceTaskIds(record),
            ...(successorTaskId(params, record) ? { successorTaskId: successorTaskId(params, record) } : {}),
        },
        notificationRecap: published
            ? 'Recovered and published the interrupted follow-up after a worker restart.'
            : 'A worker restart interrupted the follow-up before it produced changes; the request was returned to the queue.',
    };
    if (current && terminalStates(taskStates).has(current.state)) {
        await reportHandoffOnTaskTimeline(params, record, 'publication recovered; task already final');
        return true;
    }
    await stateManager.updateTaskState(record.task_id, published ? taskStates.COMPLETED : taskStates.FAILED, {
        reason: published
            ? 'Recovered interrupted follow-up publication after a worker restart'
            : 'Worker restart interrupted the follow-up before it produced changes',
        ...(published && record.commit_hash ? { commitHash: record.commit_hash } : {}),
        historyMetadata,
    });
    return true;
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
        // A worktree that normal cleanup already removed or detached before the
        // row could retire no longer holds the branch — that is the release
        // proof this phase owes, so the row must not stay pending forever.
        const attachment = await params.git.worktreeAttachment(record.worktree_path, record.branch_name);
        // The lease can be lost while the attachment is inspected; the branch
        // release then belongs to the successor that now owns the handoff.
        if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
        released = attachment !== 'attached'
            || await params.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path);
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
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, commitHash: record.commit_hash },
        record.commit_hash
            ? 'Recovered and published an interrupted follow-up exactly once'
            : 'Interrupted follow-up produced no changes; its branch is free again');
    return record.commit_hash ? { outcome: 'published', commitHash: record.commit_hash } : { outcome: 'no_changes' };
}

async function finishWithoutChanges(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    // Cancellation or lease loss may land while the Git evidence or the notice
    // request is awaited: publication re-checks both before its mutation, and
    // they are re-checked again before restoring the claimed comments, or a
    // cancelled request would be requeued (or a successor's raced).
    const notice = await publishOwedComment(params, record, interruptedWithoutChangesBody(record));
    if ('done' in notice) return notice.done;
    const hold = await cancellationHold(params, record);
    if (hold) return hold;
    await params.restoreComments(record, parseClaimedComments(record));
    // A successor that adopts this phase restores (deduplicated) and schedules again.
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    await params.scheduleRestoredComments?.(record);
    if (!await finalizeRecoveredTask(params, record, false)) return { outcome: 'ownership_lost' };
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'cleanup_pending' });
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
    } else if (await git.hasUnpushedCommits(record.worktree_path, record.branch_name)) {
        commitHash = await git.head(record.worktree_path);
    } else {
        return { done: await finishWithoutChanges(params, record) };
    }
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
    const published = await publishOwedComment(params, record, recoveredCompletionBody(record));
    if ('done' in published) return published;
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: published.url });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
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
    if (record.phase === 'comment_published') {
        if (!await finalizeRecoveredTask(params, record, Boolean(record.commit_hash))) return { outcome: 'ownership_lost' };
        const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'cleanup_pending' });
        if (!advanced) return { outcome: 'superseded' };
        record = advanced;
    }
    if (record.phase !== 'cleanup_pending') return { outcome: 'superseded' };
    // The push proved the branch settled; free it for later follow-ups while keeping the worktree.
    return attemptHandoffCleanup(params, record);
}
