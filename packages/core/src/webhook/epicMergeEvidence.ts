import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

/**
 * Evidence about which epic PR carries a merged child: merge timestamps,
 * and merge-commit containment when two merges share a second.
 */

export interface EpicProgressOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export interface RepositoryContext {
    owner: string;
    repo: string;
}

interface ChildContext extends RepositoryContext {
    /** Null for the aggregate epic PR merge. */
    mergedChildPrNumber: number | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Timestamps have one-second resolution, so a child merged in the same
 * second as an epic cannot be ordered by time. GitHub's compare API settles
 * it when the epic was merged with a merge commit: the child's merge commit
 * is then an ancestor of the epic's. Squash and rebase merges rewrite
 * history, so they keep the conservative "not contained" answer.
 */
export async function isMergeContained(
    octokit: EpicProgressOctokit,
    { owner, repo }: RepositoryContext,
    childMergeCommitSha: string | null | undefined,
    epicMergeCommitSha: string | null | undefined,
): Promise<boolean> {
    if (!childMergeCommitSha || !epicMergeCommitSha) return false;
    try {
        const comparison = (await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${epicMergeCommitSha}...${childMergeCommitSha}`,
        })).data;
        return isRecord(comparison) && comparison.ahead_by === 0;
    } catch (error) {
        if ((error as { status?: number }).status === 404) return false;
        throw error;
    }
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

/** Immutable once the child has merged; read once per update and reused. */
export interface ChildMergeEvidence {
    defaultBranch: string;
    childMergedAt: string | null;
    childMergeCommitSha: string | null;
}

export type ChildMergeEvidenceSource = ChildMergeEvidence | (() => Promise<ChildMergeEvidence>);

export async function readChildMergeEvidence(
    octokit: Octokit, { owner, repo }: RepositoryContext, childPrNumber: number,
): Promise<ChildMergeEvidence> {
    const defaultBranch = (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    const child = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: childPrNumber,
    })).data;
    return { defaultBranch, childMergedAt: child.merged_at, childMergeCommitSha: child.merge_commit_sha ?? null };
}

/** A merged epic can only carry a child that merged before it. */
export async function canCarryChild(
    octokit: Octokit,
    context: ChildContext,
    pr: { state: string; merged_at: string | null; base?: { ref: string }; merge_commit_sha?: string | null },
    evidence?: ChildMergeEvidenceSource,
): Promise<boolean> {
    if (pr.state === 'open') return true;
    if (!pr.merged_at || context.mergedChildPrNumber === null) return false;
    const { defaultBranch, childMergedAt, childMergeCommitSha } = typeof evidence === 'function' ? await evidence()
        : evidence ?? await readChildMergeEvidence(octokit, context, context.mergedChildPrNumber);
    if (pr.base?.ref !== defaultBranch || !childMergedAt) return false;
    // Missing, invalid, or later timestamps do not establish that the child
    // was included; an equal one needs the merge commits to settle it.
    const childTime = Date.parse(childMergedAt);
    const epicTime = Date.parse(pr.merged_at);
    if (childTime < epicTime) return true;
    return childTime === epicTime
        && await isMergeContained(octokit as unknown as EpicProgressOctokit, context, childMergeCommitSha, pr.merge_commit_sha);
}

/** Prefer an open Epic PR; reuse a merged one only for an included child. */
export async function findEpicPRNumber(
    octokit: Octokit, context: ChildContext & { epicBranch: string },
    evidence?: ChildMergeEvidenceSource,
): Promise<number | null> {
    const { owner, repo, epicBranch } = context;
    const pulls = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner, repo,
        head: `${owner}:${epicBranch}`,
        state: 'all',
        per_page: 100,
    });
    const open = pulls.find(pr => pr.state === 'open');
    if (open) return open.number;
    const candidates = pulls.filter(pr => pr.merged_at && Number.isFinite(Date.parse(pr.merged_at)))
        .sort((a, b) => Date.parse(a.merged_at!) - Date.parse(b.merged_at!));
    if (candidates.length === 0 || context.mergedChildPrNumber === null) return null;
    const loaded = typeof evidence === 'function' ? await evidence()
        : evidence ?? await readChildMergeEvidence(octokit, context, context.mergedChildPrNumber);
    for (const pr of candidates) {
        if (await canCarryChild(octokit, context, pr, loaded)) return pr.number;
    }
    return null;
}
