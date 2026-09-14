import { cleanupWorktree, getAuthenticatedOctokit, logger } from '@propr/core';
import { createPullRequestHeadWorktree, pushPullRequestHeadBranch } from './prGitOperations.js';
import type { PublicationCompletion } from './prCommentPostExecution.js';
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

    get pendingCompletion(): PublicationCompletion | undefined {
        return this.continuation?.publication_completion
            ? JSON.parse(this.continuation.publication_completion) as PublicationCompletion : undefined;
    }

    async finishCompletion() {
        if (this.continuation) await savePublicationCheckpoint(this.continuation, null, null);
    }

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
            const result = await pushContinuationHead(worktreePath, this.target, token);
            await this.markPublished(result.commitHash);
        }
        await this.announce();
    }

    /** A push can succeed without its acknowledgement/checkpoint update. GitHub
     * retains the PR head even after merge and branch deletion; compare against
     * that commit before requiring an open PR or preparing a branch worktree.
     */
    async reconcilePublication(): Promise<void> {
        const record = this.continuation;
        if (!record?.publication_bundle) return;
        // createPublicationBundle stores HEAD in the bundle header. Restrict the
        // lookup to that header, never the binary pack or completion metadata.
        const header = Buffer.from(record.publication_bundle, 'base64').toString('latin1').split('\n\n', 1)[0];
        const checkpointHead = /^([a-f0-9]{40}) HEAD$/m.exec(header)?.[1];
        if (!checkpointHead) throw new Error('Publication checkpoint has no valid HEAD');
        const { repoOwner: owner, repoName: repo } = continuationTarget(record);
        const pr = record.continuation_pr
            ? (await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: record.continuation_pr })).data
            : (await this.octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
                owner, repo, head: `${owner}:${record.branch_name}`, state: 'all', per_page: 100,
            })).find(pr => pr.body?.includes(`<!-- propr-continuation:${record.source_pr}:${record.source_sha} -->`));
        if (!pr) return;
        if (pr.head.ref !== record.branch_name || pr.base.ref !== record.base_branch || pr.head.repo?.full_name.toLowerCase() !== record.repository) {
            throw new Error(`Continuation PR #${pr.number} has an unexpected Git target`);
        }
        if (!pr.head.sha || !/^[a-f0-9]{40}$/i.test(pr.head.sha)) throw new Error('Continuation PR has no valid head SHA');
        const comparison = await this.octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${checkpointHead}...${pr.head.sha}`,
        }).then(response => response.data).catch(error => {
            // An unpublished checkpoint commit may not exist remotely yet.
            if ((error as { status?: number }).status === 404) return undefined;
            throw error;
        });
        if (!comparison) return;
        if (comparison.status !== 'ahead' && comparison.status !== 'identical') return;
        // Recover the mapping too when PR creation's acknowledgement was lost.
        this.continuation = await findPRContinuation({ repoOwner: owner, repoName: repo, pullRequestNumber: pr.number }, this.octokit);
        if (!this.continuation) throw new Error('Cannot resolve published continuation');
        await this.markPublished(pr.head.sha);
    }

    async prepare(worktreeDirName: string) {
        // Resolve an existing mapping before checking permissions: once adopted,
        // later requests must not silently switch back to the contributor's branch.
        if (await findPRContinuation(this.ref)) await this.adopt();
        const checkpointBaseline = this.continuation?.source_sha ?? (this.target.isFork ? this.source.head.sha : undefined);
        if (this.target.isFork && (!checkpointBaseline || !/^[a-f0-9]{40}$/i.test(checkpointBaseline))) throw new Error('Cannot prepare fork publication without its exact head SHA');
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        let prepared = await createPullRequestHeadWorktree({ target: this.target, authToken: token, worktreeDirName, checkpointBaseline });
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
            prepared = await createPullRequestHeadWorktree({ target: this.target, authToken: token, worktreeDirName, checkpointBaseline });
            return prepared;
        }
    }

    private async markPublished(commitHash: string) {
        const completion = this.pendingCompletion;
        if (completion?.commitResult) completion.commitResult.commitHash = commitHash;
        await savePublicationCheckpoint(this.continuation!, null, completion ? JSON.stringify(completion) : undefined);
    }

    async push(worktreePath: string, completion?: PublicationCompletion) {
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        if (!this.continuation) {
            try {
                return await pushPullRequestHeadBranch({ worktreePath, target: this.target, authToken: token });
            } catch (error) {
                if (!this.target.isFork || !isPublicationPermissionDenied(error)) throw error;
                // Save the actual Git objects before any fallible adoption API request.
                this.continuation = await findPRContinuation(this.ref) || await reserveContinuation(this.ref, this.source);
                await savePublicationCheckpoint(this.continuation, await createPublicationBundle(worktreePath, this.continuation.source_sha), completion ? JSON.stringify(completion) : undefined);
                await this.adopt();
            }
        }
        // Publish the existing HEAD directly. No checkout, reset, cherry-pick or agent rerun.
        // Checkpoint continuation implementations too, including failed remote pushes.
        await savePublicationCheckpoint(this.continuation!, await createPublicationBundle(worktreePath, this.continuation!.source_sha), completion ? JSON.stringify(completion) : undefined);
        const result = await pushContinuationHead(worktreePath, this.target, token);
        await this.markPublished(result.commitHash);
        await this.announce();
        return result;
    }
}
