import {
    createWorktreeFromExistingBranch,
    ensureRepoCloned,
    getRepoUrl,
    pushBranch,
} from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import type { PullRequestGitTarget } from './prGitTarget.js';
export { resolvePullRequestGitTarget } from './prGitTarget.js';
export type { PullRequestGitTarget, PullRequestHead } from './prGitTarget.js';

interface CreatePullRequestHeadWorktreeOptions {
    target: PullRequestGitTarget;
    authToken: string;
    worktreeDirName: string;
}

export async function createPullRequestHeadWorktree(
    options: CreatePullRequestHeadWorktreeOptions,
): Promise<{ localRepoPath: string; worktreeInfo: WorktreeInfo }> {
    const { target, authToken, worktreeDirName } = options;
    const repoUrl = getRepoUrl({ repoOwner: target.repoOwner, repoName: target.repoName });
    const localRepoPath = await ensureRepoCloned({
        repoUrl,
        owner: target.repoOwner,
        repoName: target.repoName,
        authToken,
    });
    const worktreeInfo = await createWorktreeFromExistingBranch(localRepoPath, target.branchName, {
        worktreeDirName,
        owner: target.repoOwner,
        repoName: target.repoName,
    });
    return { localRepoPath, worktreeInfo };
}

interface PushPullRequestHeadBranchOptions {
    worktreePath: string;
    target: PullRequestGitTarget;
    authToken: string;
}

export async function pushPullRequestHeadBranch(options: PushPullRequestHeadBranchOptions) {
    const { worktreePath, target, authToken } = options;
    const repoUrl = getRepoUrl({ repoOwner: target.repoOwner, repoName: target.repoName });
    return pushBranch(worktreePath, target.branchName, {
        repoUrl,
        authToken,
        rebaseOnNonFastForward: true,
    });
}
