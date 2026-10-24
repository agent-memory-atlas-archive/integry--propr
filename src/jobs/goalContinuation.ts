import fs from 'node:fs';
import path from 'node:path';
import {
    createWorktreeFromExistingBranch,
    cleanupWorktree,
    ensureGitRepository,
    ensureRepoCloned,
    getAuthenticatedOctokit,
    getRepoUrl,
    logger,
    type GoalJobData,
} from '@propr/core';
import { fencedGoal, fencedGoalUpdate, type GoalRow } from './goalAttemptState.js';

export interface GoalPullRequestState {
    state: string;
    merged: boolean;
    draft: boolean;
    nodeId: string;
}

type SavedGoalWorktree = GoalRow & { worktree_path: string; branch_name: string };

function hasSavedWorktree(goal: GoalRow): goal is SavedGoalWorktree {
    return Boolean(goal.worktree_path && goal.branch_name);
}

/** GitHub and Git operations a continued goal needs; injectable for tests. */
export interface GoalContinuationOperations {
    readPullRequest(repository: string, number: number): Promise<GoalPullRequestState | null>;
    convertToDraft(nodeId: string, assertCurrent: () => Promise<void>): Promise<void>;
    /** Returns null only when the remote branch is confirmed absent; other failures throw. */
    rebuildWorktree(goal: SavedGoalWorktree, assertCurrent: () => Promise<void>): Promise<string | null>;
    cleanupWorktree(goal: SavedGoalWorktree, assertCurrent: () => Promise<void>): Promise<void>;
}

function isDirectory(target: string): boolean {
    try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

const FRESH_BRANCH = {
    worktree_path: null, branch_name: null, final_pr_number: null, final_pr_url: null,
} as const;

/**
 * Brings the branch, worktree and pull request of a continued terminal goal
 * back to a state an attempt can publish to. Between the goal stopping and
 * the operator continuing it, the PR may have been merged, closed or marked
 * ready, and the worktree may have expired.
 *
 * - Merged PR: start a fresh branch from the base. A squash-merged branch would
 *   otherwise bring its already merged commits back in the next PR.
 * - Closed PR: keep the branch; the attempt opens a new draft PR.
 * - Ready PR: convert it back to a draft, which goal publication requires.
 * - Missing worktree: rebuild it from the remote branch, or start a fresh
 *   branch when that branch was deleted.
 */
export async function prepareContinuedGoal(
    job: GoalJobData,
    goal: GoalRow,
    operations: GoalContinuationOperations = defaultContinuationOperations,
): Promise<GoalRow> {
    if (!goal.continue_requested) return goal;
    const assertCurrent = async () => {
        if (!await fencedGoal(job)) throw new Error('Continued goal preparation lost its attempt claim');
    };
    const updates: Record<string, unknown> = {};
    if (goal.final_pr_number) {
        const pull = await operations.readPullRequest(goal.repository, goal.final_pr_number);
        if (pull?.merged) {
            Object.assign(updates, FRESH_BRANCH);
        } else if (!pull || pull.state !== 'open') {
            Object.assign(updates, { final_pr_number: null, final_pr_url: null });
        } else if (!pull.draft) {
            await assertCurrent();
            await operations.convertToDraft(pull.nodeId, assertCurrent);
        }
    }
    await assertCurrent();
    const keepsBranch = !('branch_name' in updates);
    if (keepsBranch && hasSavedWorktree(goal) && !isDirectory(goal.worktree_path)) {
        const rebuilt = await operations.rebuildWorktree({
            ...goal, worktree_path: goal.worktree_path, branch_name: goal.branch_name,
        }, assertCurrent);
        if (rebuilt === null) Object.assign(updates, FRESH_BRANCH);
        else if (rebuilt !== goal.worktree_path) updates.worktree_path = rebuilt;
    }
    if ('branch_name' in updates && hasSavedWorktree(goal) && isDirectory(goal.worktree_path)) {
        // Recheck authority after remote reads, before mutating the saved checkout.
        await assertCurrent();
        await operations.cleanupWorktree({ ...goal, worktree_path: goal.worktree_path, branch_name: goal.branch_name }, assertCurrent);
    }
    if (Object.keys(updates).length === 0) return goal;
    if (!await fencedGoalUpdate(job, updates)) throw new Error('Continued goal preparation lost its attempt claim');
    const updated = await fencedGoal(job);
    if (!updated) throw new Error('Continued goal preparation lost its attempt claim');
    return updated;
}

const defaultContinuationOperations: GoalContinuationOperations = {
    async readPullRequest(repository, number) {
        const [owner, repo] = repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: number,
            });
            return {
                state: data.state,
                merged: Boolean(data.merged || data.merged_at),
                draft: Boolean(data.draft),
                nodeId: data.node_id,
            };
        } catch (error) {
            if ((error as { status?: number }).status === 404) return null;
            throw error;
        }
    },
    async convertToDraft(nodeId, assertCurrent) {
        const octokit = await getAuthenticatedOctokit();
        await assertCurrent();
        await octokit.graphql(
            'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
            { id: nodeId },
        );
    },
    async cleanupWorktree(goal, assertCurrent) {
        // Use the shared storage policy: unique local work must remain recoverable.
        const [owner, repoName] = goal.repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        const token = await octokit.auth({ type: 'installation' }) as { token: string };
        await assertCurrent();
        const localRepoPath = await ensureRepoCloned({
            repoUrl: getRepoUrl({ repoOwner: owner, repoName }), owner, repoName,
            authToken: token.token, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
        });
        await assertCurrent();
        await cleanupWorktree(localRepoPath, goal.worktree_path, goal.branch_name);
    },
    async rebuildWorktree(goal, assertCurrent) {
        const [owner, repoName] = goal.repository.split('/');
        const octokit = await getAuthenticatedOctokit();
        try {
            await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
                owner, repo: repoName, ref: `heads/${goal.branch_name}`,
            });
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
            // An inaccessible repository also returns 404. Confirm access before
            // treating the missing ref as evidence that published work is gone.
            await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName });
            return null;
        }
        const token = await octokit.auth({ type: 'installation' }) as { token: string };
        await ensureGitRepository(logger as never);
        await assertCurrent();
        const localRepoPath = await ensureRepoCloned({
            repoUrl: getRepoUrl({ repoOwner: owner, repoName }), owner, repoName,
            authToken: token.token, ...(goal.base_branch ? { baseBranch: goal.base_branch } : {}),
        });
        await assertCurrent();
        const worktree = await createWorktreeFromExistingBranch(localRepoPath, goal.branch_name, {
            worktreeDirName: path.basename(goal.worktree_path), owner, repoName,
        });
        return worktree.worktreePath;
    },
};
