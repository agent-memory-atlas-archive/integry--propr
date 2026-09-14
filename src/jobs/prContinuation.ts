import { db, getAuthenticatedOctokit } from '@propr/core';
import type { PullRequestGitTarget, PullRequestHead } from './prGitTarget.js';

export interface ContinuationRecord {
    repository: string;
    source_pr: number;
    source_sha: string;
    base_branch: string;
    branch_name: string;
    source_title: string;
    source_body: string;
    source_author: string;
    continuation_pr: number | null;
    continuation_url: string | null;
    comment_id: number | null;
}

export interface Contribution {
    head: PullRequestHead;
    base: { ref: string };
    title: string;
    body: string | null;
    user: { login: string };
}

export interface PullRequestReference {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
const repositoryKey = (ref: PullRequestReference) => `${ref.repoOwner}/${ref.repoName}`.toLowerCase();

export async function findPRContinuation(ref: PullRequestReference): Promise<ContinuationRecord | undefined> {
    return db<ContinuationRecord>('pr_continuations').where({ repository: repositoryKey(ref) })
        .andWhere(builder => builder.where({ source_pr: ref.pullRequestNumber }).orWhere({ continuation_pr: ref.pullRequestNumber })).first();
}

export function continuationTarget(record: ContinuationRecord): PullRequestGitTarget {
    const [repoOwner, repoName] = record.repository.split('/');
    return { repoOwner, repoName, branchName: record.branch_name, isFork: false };
}

export function continuationStatus(record?: ContinuationRecord): string {
    return record?.continuation_url
        ? `Implementation destination: [continuation PR #${record.continuation_pr}](${record.continuation_url}). Original discussion: https://github.com/${record.repository}/pull/${record.source_pr}.`
        : '';
}

async function reserveContinuation(ref: PullRequestReference, source: Contribution): Promise<ContinuationRecord> {
    if (!source.head.sha || !/^[a-f0-9]{40}$/i.test(source.head.sha)) throw new Error('Cannot continue contribution without its exact head SHA');
    const repository = repositoryKey(ref);
    await db('pr_continuations').insert({
        repository, source_pr: ref.pullRequestNumber, source_sha: source.head.sha,
        base_branch: source.base.ref, branch_name: `propr/continuation-pr-${ref.pullRequestNumber}`,
        source_title: source.title, source_body: source.body || '', source_author: source.user.login,
    }).onConflict(['repository', 'source_pr']).ignore();
    return (await findPRContinuation(ref))!;
}

async function ensureBranch(octokit: Octokit, record: ContinuationRecord): Promise<void> {
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    try {
        await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner, repo, ref: `refs/heads/${record.branch_name}`, sha: record.source_sha,
        });
    } catch (error) {
        if ((error as { status?: number }).status !== 422) throw error;
        // An earlier attempt may already have created/advanced the branch. Never reset it.
        const { data: comparison } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${record.source_sha}...${record.branch_name}`,
        });
        if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
            throw new Error(`Continuation branch ${record.branch_name} does not contain source commit ${record.source_sha}`);
        }
    }
}

async function ensurePullRequest(octokit: Octokit, record: ContinuationRecord): Promise<ContinuationRecord> {
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    const marker = `<!-- propr-continuation:${record.source_pr}:${record.source_sha} -->`;
    const findExisting = async () => {
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
            owner, repo, head: `${owner}:${record.branch_name}`, state: 'all', per_page: 100,
        });
        const pr = prs.find(pr => pr.body?.includes(marker));
        if (prs.length && !pr) throw new Error(`Continuation branch ${record.branch_name} is already used by an unrelated PR`);
        return pr;
    };
    let pr = record.continuation_pr
        ? (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: record.continuation_pr })).data
        : await findExisting();
    if (!pr) {
        await ensureBranch(octokit, record);
        const sourceUrl = `https://github.com/${record.repository}/pull/${record.source_pr}`;
        try {
            pr = (await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                owner, repo, head: record.branch_name, base: record.base_branch,
                title: `Continue #${record.source_pr}: ${record.source_title}`.slice(0, 256),
                body: `${marker}\nContinuation of ${sourceUrl}, contributed by @${record.source_author}.\n\nSource SHA: \`${record.source_sha}\`\n\nProPR cannot push to the contributor's branch. Implementation will continue here. Contributor commits and attribution are preserved; the original PR remains open and its discussion remains available.\n\nOriginal objective:\n${record.source_body}`,
            })).data;
        } catch (error) {
            // Covers competing creates and a lost response after successful publication.
            // GitHub enforces one open PR for this head. A lookup never creates a second PR.
            pr = await findExisting();
            if (!pr) throw error;
        }
    }
    if (pr.base.ref !== record.base_branch || pr.head.ref !== record.branch_name || pr.head.repo?.full_name.toLowerCase() !== record.repository) {
        throw new Error(`Continuation PR #${pr.number} has an unexpected Git target`);
    }
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr }).update({ continuation_pr: pr.number, continuation_url: pr.html_url });
    record = { ...record, continuation_pr: pr.number, continuation_url: pr.html_url };
    if (pr.state !== 'open') throw new Error(`Continuation PR is closed: ${pr.html_url}. Reopen it to continue implementation.`);
    return record;
}

async function announceContinuation(octokit: Octokit, record: ContinuationRecord): Promise<void> {
    if (record.comment_id) return;
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    const marker = `<!-- propr-continuation-link:${record.source_pr}:${record.continuation_pr} -->`;
    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.source_pr, per_page: 100,
    });
    const existing = comments.find(comment => comment.body?.includes(marker) && comment.user?.type === 'Bot');
    const comment = existing || (await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.source_pr,
        body: `${marker}\nProPR does not have permission to publish to this contribution's branch. ${continuationStatus(record)}\n\nImplementation will continue there, preserving the contributor's commits from source SHA \`${record.source_sha}\`. This PR will remain open. Later implementation requests here will be routed to the continuation.`,
    })).data;
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr }).update({ comment_id: comment.id });
    record.comment_id = comment.id;
}

/** The caller holds the source PR processing lease. The durable reservation, stable
 * branch and GitHub's head uniqueness also recover partial creates and races.
 */
export async function ensurePRContinuation(octokit: Octokit, ref: PullRequestReference, source: Contribution): Promise<ContinuationRecord> {
    const record = await findPRContinuation(ref) || await reserveContinuation(ref, source);
    const ready = await ensurePullRequest(octokit, record);
    await announceContinuation(octokit, ready);
    return ready;
}
