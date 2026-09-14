import { cleanupWorktree, getAuthenticatedOctokit, logger } from '@propr/core';
import { createPullRequestHeadWorktree, pushPullRequestHeadBranch } from './prGitOperations.js';
import { resolvePullRequestGitTarget } from './prGitTarget.js';
import {
    announceContinuation, continuationStatus, continuationTarget, ensurePRContinuation, findPRContinuation,
    reserveContinuation, savePublicationCheckpoint,
    type ContinuationRecord, type Contribution, type PullRequestReference,
} from './prContinuation.js';
import { checkPullRequestHeadWritable, createPublicationBundle, restorePublicationBundle, isPublicationPermissionDenied, pushContinuationHead } from './prPublicationGit.js';

/** One publication session spans preflight, agent execution and the final push.
 * Discussion/comment identity stays with the request; only the mutable Git target changes.
 */
export class PullRequestPublication {
    continuation?: ContinuationRecord;

    constructor(
        private readonly octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
        private readonly ref: PullRequestReference,
        private readonly source: Contribution,
    ) {}

    get target() { return this.continuation ? continuationTarget(this.continuation) : resolvePullRequestGitTarget(this.source.head, this.ref); }
    get status() { return continuationStatus(this.continuation); }

    private async adopt() {
        this.continuation = await ensurePRContinuation(this.octokit, this.ref, this.source);
    }

    async announce() {
        if (!this.continuation?.continuation_pr) return;
        try {
            await announceContinuation(this.octokit, this.continuation);
        } catch (error) {
            // comment_id remains unset so delivery can be retried independently.
            logger.warn({ error: (error as Error).message, sourcePR: this.continuation.source_pr }, 'Continuation announcement pending retry');
        }
    }

    private async recover(worktreePath: string, token: string) {
        if (this.continuation?.publication_bundle) {
            await restorePublicationBundle(worktreePath, this.continuation.publication_bundle);
            await pushContinuationHead(worktreePath, this.target, token);
            await savePublicationCheckpoint(this.continuation, null);
        }
        await this.announce();
    }

    async prepare(worktreeDirName: string) {
        // Resolve an existing mapping before checking permissions: once adopted,
        // later requests must not silently switch back to the contributor's branch.
        if (await findPRContinuation(this.ref)) await this.adopt();
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        let prepared = await createPullRequestHeadWorktree({ target: this.target, authToken: token, worktreeDirName });
        if (!this.target.isFork) {
            try {
                await this.recover(prepared.worktreeInfo.worktreePath, token);
                return prepared;
            } catch (error) {
                await cleanupWorktree(prepared.localRepoPath, prepared.worktreeInfo.worktreePath, prepared.worktreeInfo.branchName);
                throw error;
            }
        }
        try {
            await checkPullRequestHeadWritable(prepared.worktreeInfo.worktreePath, this.target, token);
            return prepared;
        } catch (error) {
            await cleanupWorktree(prepared.localRepoPath, prepared.worktreeInfo.worktreePath, prepared.worktreeInfo.branchName);
            if (!isPublicationPermissionDenied(error)) throw error;
            await this.adopt();
            await this.announce();
            prepared = await createPullRequestHeadWorktree({ target: this.target, authToken: token, worktreeDirName });
            return prepared;
        }
    }

    async push(worktreePath: string) {
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        if (!this.continuation) {
            try {
                return await pushPullRequestHeadBranch({ worktreePath, target: this.target, authToken: token });
            } catch (error) {
                if (!this.target.isFork || !isPublicationPermissionDenied(error)) throw error;
                // Save the actual Git objects before any fallible adoption API request.
                this.continuation = await findPRContinuation(this.ref) || await reserveContinuation(this.ref, this.source);
                await savePublicationCheckpoint(this.continuation, await createPublicationBundle(worktreePath, this.continuation.source_sha));
                await this.adopt();
            }
        }
        // Publish the existing HEAD directly. No checkout, reset, cherry-pick or agent rerun.
        // Checkpoint continuation implementations too, including failed remote pushes.
        await savePublicationCheckpoint(this.continuation!, await createPublicationBundle(worktreePath, this.continuation!.source_sha));
        const result = await pushContinuationHead(worktreePath, this.target, token);
        await savePublicationCheckpoint(this.continuation!, null);
        await this.announce();
        return result;
    }
}
