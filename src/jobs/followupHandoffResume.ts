import { access } from 'node:fs/promises';
import { commitChanges, createHooklessGit, releaseBranchFromSettledWorktree } from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { pushPullRequestHeadBranch } from './prGitOperations.js';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, parseClaimedComments, parseSourceTaskIds,
    HANDOFF_AWAITING_OPERATOR,
    type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';

/**
 * Resumes the exact missing publication phase of an adopted follow-up handoff.
 * Every step is idempotent: committing is skipped when the worktree is clean,
 * pushing an already-published head is up to date, the owed comment is
 * deduplicated by a durable marker, and the task finalizer refuses terminal
 * states — so duplicate recovery passes can never publish twice.
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

export type WorktreeAttachment = 'missing' | 'not_on_branch' | 'attached';

export interface FollowupHandoffGitOps {
    worktreeAttachment(worktreePath: string, branchName: string): Promise<WorktreeAttachment>;
    hasUncommittedChanges(worktreePath: string): Promise<boolean>;
    commitWork(worktreePath: string, message: string, pullRequestNumber: number): Promise<{ commitHash: string } | null>;
    hasUnpushedCommits(worktreePath: string, branchName: string): Promise<boolean>;
    head(worktreePath: string): Promise<string>;
    push(worktreePath: string, target: { repoOwner: string; repoName: string; branchName: string }): Promise<{ commitHash?: string } | void>;
    /** Frees the branch from a settled retained worktree; keeps the worktree itself. */
    releaseSettledWorktree(localRepoPath: string, branchName: string, worktreePath: string): Promise<boolean>;
    /** Detaches the worktree HEAD in place: commits and working-tree files all stay. */
    detachWorktreeHead(worktreePath: string): Promise<void>;
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
}

export type ResumeOutcome =
    | { outcome: 'published'; commitHash: string | null }
    | { outcome: 'no_changes' }
    | { outcome: 'awaiting_operator'; reason: string }
    | { outcome: 'superseded' };

export function splitHandoffRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}

export function handoffCommentMarker(record: Pick<FollowupHandoffRecord, 'repository' | 'pull_request' | 'incarnation'>): string {
    return `<!-- propr-followup-handoff:${record.repository}:${record.pull_request}:${record.incarnation} -->`;
}

/** Default Git evidence and publication operations over the retained worktree. */
export function createFollowupHandoffGitOps(getToken: () => Promise<string>): FollowupHandoffGitOps {
    return {
        async worktreeAttachment(worktreePath, branchName) {
            try {
                await access(worktreePath);
            } catch {
                return 'missing';
            }
            const current = (await createHooklessGit(worktreePath).raw(['branch', '--show-current'])).trim();
            return current === branchName ? 'attached' : 'not_on_branch';
        },
        async hasUncommittedChanges(worktreePath) {
            const status = await createHooklessGit(worktreePath).raw(['status', '--porcelain', '--untracked-files=all']);
            return status.trim().length > 0;
        },
        async commitWork(worktreePath, message, pullRequestNumber) {
            return commitChanges(worktreePath, message, AI_COMMIT_AUTHOR, { issueNumber: pullRequestNumber, issueTitle: 'Recovered follow-up changes' });
        },
        async hasUnpushedCommits(worktreePath, branchName) {
            const git = createHooklessGit(worktreePath);
            try {
                await git.raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
            } catch {
                // Offline comparison against the last known remote ref is still safe:
                // it can only overestimate the unpushed work, and the push is idempotent.
            }
            try {
                const unpushed = await git.raw(['rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`]);
                return unpushed.trim() !== '0';
            } catch {
                // No remote ref yet: everything on the branch is unpublished.
                return true;
            }
        },
        async head(worktreePath) {
            return (await createHooklessGit(worktreePath).raw(['rev-parse', 'HEAD'])).trim();
        },
        async push(worktreePath, target) {
            return pushPullRequestHeadBranch({
                worktreePath,
                target: { ...target, isFork: false },
                authToken: await getToken(),
            }) as Promise<{ commitHash?: string } | void>;
        },
        async releaseSettledWorktree(localRepoPath, branchName, worktreePath) {
            return releaseBranchFromSettledWorktree(createHooklessGit(localRepoPath), branchName, worktreePath);
        },
        async detachWorktreeHead(worktreePath) {
            await createHooklessGit(worktreePath).raw(['checkout', '--detach']);
        },
    };
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
        await params.stateManager.updateHistoryMetadata(record.task_id, current.state, {
            followupPublicationHandoff: {
                phase: record.phase, status: record.status, statusReason: record.status_reason,
                worktreePath: record.worktree_path, branchName: record.branch_name,
                predecessorTaskIds: parseSourceTaskIds(record),
                ...(params.recoveredBy ? { successorTaskId: params.recoveredBy } : {}),
                nextAction,
            },
        });
    } catch (error) {
        params.log.warn({ taskId: record.task_id, error: (error as Error).message }, 'Could not record follow-up handoff status on the task timeline');
    }
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

/** Publishes the owed comment exactly once, keyed by the handoff's durable marker. */
async function publishOwedComment(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, body: string): Promise<string | null> {
    if (record.completion_comment_url) return record.completion_comment_url;
    const { owner, repo } = splitHandoffRepository(record.repository);
    const marker = handoffCommentMarker(record);
    if (record.starting_comment_id) {
        try {
            const { data } = await params.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: record.starting_comment_id, body,
            });
            return (data as IssueComment).html_url ?? null;
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }
    const comments = await params.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, per_page: 100,
    }) as IssueComment[];
    const existing = comments.find(comment => comment.body?.includes(marker));
    if (existing) return existing.html_url ?? null;
    const { data } = await params.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, body,
    });
    return (data as IssueComment).html_url ?? null;
}

const terminalStates = (taskStates: HandoffTaskStates): Set<string> =>
    new Set([taskStates.COMPLETED, taskStates.FAILED, taskStates.CANCELLED]);

async function finalizeRecoveredTask(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, published: boolean): Promise<void> {
    const { stateManager, taskStates } = params;
    const current = await stateManager.getTaskState(record.task_id);
    const historyMetadata = {
        followupPublicationHandoff: {
            recovered: true, phase: record.phase, worktreePath: record.worktree_path,
            predecessorTaskIds: parseSourceTaskIds(record),
            ...(params.recoveredBy ? { successorTaskId: params.recoveredBy } : {}),
        },
        notificationRecap: published
            ? 'Recovered and published the interrupted follow-up after a worker restart.'
            : 'A worker restart interrupted the follow-up before it produced changes; the request was returned to the queue.',
    };
    if (current && terminalStates(taskStates).has(current.state)) {
        await reportHandoffOnTaskTimeline(params, record, 'publication recovered; task already final');
        return;
    }
    await stateManager.updateTaskState(record.task_id, published ? taskStates.COMPLETED : taskStates.FAILED, {
        reason: published
            ? 'Recovered interrupted follow-up publication after a worker restart'
            : 'Worker restart interrupted the follow-up before it produced changes',
        ...(published && record.commit_hash ? { commitHash: record.commit_hash } : {}),
        historyMetadata,
    });
}

async function finishWithoutChanges(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    await publishOwedComment(params, record, interruptedWithoutChangesBody(record));
    await params.restoreComments(record, parseClaimedComments(record));
    await finalizeRecoveredTask(params, record, false);
    await finalizeFollowupHandoff(params.store, record);
    await params.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path);
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Interrupted follow-up produced no changes; claimed comments were returned to the queue');
    return { outcome: 'no_changes' };
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

/**
 * Called under the pull request's processing lease with a record whose agent
 * is proven exited/lost. Adopts the existing retained worktree in place; it
 * never checks out the already-attached branch anywhere else.
 */
export async function resumeFollowupHandoff(params: ResumeFollowupHandoffParams): Promise<ResumeOutcome> {
    let record = params.record;
    const { git, taskStates } = params;
    // User cancellation is authoritative: never publish without explicit operator authorization.
    const taskState = await params.stateManager.getTaskState(record.task_id);
    if (taskState?.state === taskStates.CANCELLED && !record.operator_authorized) {
        return holdForOperator(params, record, 'cancelled_by_user');
    }
    if (record.is_fork) return holdForOperator(params, record, 'fork_publication_unsupported');

    if (record.phase === 'agent_running' || record.phase === 'agent_exited') {
        const collected = await collectAgentOutput(params, record);
        if ('done' in collected) return collected.done;
        record = collected.record;
    }
    if (record.phase === 'committed') {
        const { owner, repo } = splitHandoffRepository(record.target_repository);
        const pushed = await git.push(record.worktree_path, { repoOwner: owner, repoName: repo, branchName: record.branch_name });
        const commitHash = (pushed && typeof pushed === 'object' && pushed.commitHash) || await git.head(record.worktree_path);
        const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'pushed', commit_hash: commitHash });
        if (!advanced) return { outcome: 'superseded' };
        record = advanced;
    }
    if (record.phase === 'pushed') {
        const commentUrl = await publishOwedComment(params, record, recoveredCompletionBody(record));
        const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: commentUrl });
        if (!advanced) return { outcome: 'superseded' };
        record = advanced;
    }
    if (record.phase !== 'comment_published') return { outcome: 'superseded' };
    await finalizeRecoveredTask(params, record, true);
    await finalizeFollowupHandoff(params.store, record);
    // The push proved the branch settled; free it for later follow-ups while keeping the worktree.
    await params.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path);
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, commitHash: record.commit_hash },
        'Recovered and published an interrupted follow-up exactly once');
    return { outcome: 'published', commitHash: record.commit_hash };
}
