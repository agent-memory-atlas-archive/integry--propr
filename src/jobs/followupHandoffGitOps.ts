import { access } from 'node:fs/promises';
import { commitChanges, createHooklessGit, releaseBranchFromSettledWorktree } from '@propr/core';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { pushPullRequestHeadBranch } from './prGitOperations.js';

/**
 * Git evidence and publication operations over a retained follow-up worktree.
 * Everything here is non-destructive to the worktree's files and commits.
 */

export type WorktreeAttachment = 'missing' | 'not_on_branch' | 'attached';

export interface FollowupHandoffGitOps {
    worktreeAttachment(worktreePath: string, branchName: string): Promise<WorktreeAttachment>;
    hasUncommittedChanges(worktreePath: string): Promise<boolean>;
    commitWork(worktreePath: string, message: string, pullRequestNumber: number): Promise<{ commitHash: string } | null>;
    hasUnpushedCommits(worktreePath: string, branchName: string): Promise<boolean>;
    head(worktreePath: string): Promise<string>;
    /** Last known remote head of the branch (fetched when reachable), or null when the remote ref is unknown. */
    remoteBranchHead(worktreePath: string, branchName: string): Promise<string | null>;
    /** Whether the given commit is the worktree HEAD or one of its ancestors. */
    isAncestorOfHead(worktreePath: string, sha: string): Promise<boolean>;
    push(worktreePath: string, target: { repoOwner: string; repoName: string; branchName: string }): Promise<{ commitHash?: string } | void>;
    /** Frees the branch from a settled retained worktree; keeps the worktree itself. */
    releaseSettledWorktree(localRepoPath: string, branchName: string, worktreePath: string): Promise<boolean>;
    /** Detaches the worktree HEAD in place: commits and working-tree files all stay. */
    detachWorktreeHead(worktreePath: string): Promise<void>;
}

async function fetchRemoteBranch(worktreePath: string, branchName: string): Promise<void> {
    try {
        await createHooklessGit(worktreePath).raw(['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
    } catch {
        // Offline comparison against the last known remote ref is still safe:
        // it can only overestimate the unpushed work, and the push is idempotent.
    }
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
            await fetchRemoteBranch(worktreePath, branchName);
            try {
                const unpushed = await createHooklessGit(worktreePath).raw(['rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`]);
                return unpushed.trim() !== '0';
            } catch {
                // No remote ref yet: everything on the branch is unpublished.
                return true;
            }
        },
        async head(worktreePath) {
            return (await createHooklessGit(worktreePath).raw(['rev-parse', 'HEAD'])).trim();
        },
        async remoteBranchHead(worktreePath, branchName) {
            await fetchRemoteBranch(worktreePath, branchName);
            try {
                return (await createHooklessGit(worktreePath).raw(['rev-parse', `refs/remotes/origin/${branchName}`])).trim();
            } catch {
                return null;
            }
        },
        async isAncestorOfHead(worktreePath, sha) {
            try {
                await createHooklessGit(worktreePath).raw(['merge-base', '--is-ancestor', sha, 'HEAD']);
                return true;
            } catch {
                return false;
            }
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
