import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getBotUsername } from '../daemon/configLoader.js';
import { PlanIssueStatus, type PlanIssue } from '../config/planIssueManager.js';
import logger from '../utils/logger.js';

export const EPIC_PROGRESS_MARKER = '<!-- propr:epic-merge-progress -->';
export const EPIC_FINAL_MERGE_MARKER = '<!-- propr:epic-final-merge -->';
export const EPIC_COMPLETE_MARKER = '<!-- propr:epic-merge-complete -->';

export interface EpicChildPullRequest {
    number: number;
    merged: boolean;
    mergedAt?: string;
    /** Closed without being merged; such PRs are not counted towards the epic. */
    abandoned: boolean;
}

export interface EpicMergeProgress {
    merged: number;
    total: number;
    /** Plan issues that were closed without a merge and are excluded from the total. */
    excluded: number;
    mergedPullRequests: number[];
}

export interface EpicMergeProgressRequest {
    owner: string;
    repo: string;
    epicBranch: string;
    epicPrNumber: number;
    /** The child PR whose merge triggered this update; null for the epic PR merge. */
    mergedChildPrNumber: number | null;
    planName?: string;
    /** Plan issues of the epic; planned work without a child PR yet counts as unmerged. */
    planIssues?: PlanIssue[];
}

interface EpicProgressOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export interface EpicMergeProgressDependencies {
    getOctokit?: () => Promise<EpicProgressOctokit>;
    /**
     * Confirms the caller still holds the epic's update lease; throws if not.
     * Runs after the reads and before each comment write.
     */
    assertOwned?: () => Promise<void>;
}

export interface EpicMergeProgressResult {
    progress: EpicMergeProgress;
    trackingComment: 'created' | 'updated' | 'unchanged';
    completionPosted: boolean;
}

/**
 * Counts merged children of an epic. Every non-abandoned child PR targeting
 * the epic branch counts once; plan issues add a placeholder for planned work
 * that has no such PR yet, so the total covers both unstarted plan issues and
 * child PRs outside the plan. The triggering PR is always merged, even if
 * GitHub's list has not caught up with the merge yet.
 */
export function computeEpicMergeProgress(
    childPullRequests: EpicChildPullRequest[],
    mergedChildPrNumber: number | null,
    planIssues: PlanIssue[] = [],
): EpicMergeProgress {
    const mergedNumbers = new Set(childPullRequests.filter(pr => pr.merged).map(pr => pr.number));
    if (mergedChildPrNumber !== null) mergedNumbers.add(mergedChildPrNumber);
    const childNumbers = new Set(childPullRequests.filter(pr => !pr.abandoned).map(pr => pr.number));
    if (mergedChildPrNumber !== null) childNumbers.add(mergedChildPrNumber);

    let merged = [...childNumbers].filter(number => mergedNumbers.has(number)).length;
    let total = childNumbers.size;
    let excluded = 0;
    const placeholderPrNumbers = new Set<number>();
    for (const issue of planIssues) {
        if (issue.pr_number != null && (childNumbers.has(issue.pr_number) || placeholderPrNumbers.has(issue.pr_number))) continue;
        const issueMerged = issue.status === PlanIssueStatus.MERGED;
        if (!issueMerged && issue.status === PlanIssueStatus.CLOSED) {
            excluded++;
            continue;
        }
        if (issue.pr_number != null) placeholderPrNumbers.add(issue.pr_number);
        total++;
        if (issueMerged) merged++;
    }

    return {
        merged,
        total,
        excluded,
        mergedPullRequests: [...mergedNumbers].sort((a, b) => a - b),
    };
}

export function isEpicMergeComplete(progress: EpicMergeProgress): boolean {
    return progress.total > 0 && progress.merged >= progress.total;
}

function renderProgressBar(merged: number, total: number, width = 10): string {
    const filled = total > 0 ? Math.min(width, Math.round((merged / total) * width)) : 0;
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function buildEpicProgressComment(progress: EpicMergeProgress, planName?: string): string {
    const complete = isEpicMergeComplete(progress);
    const percent = progress.total > 0 ? Math.round((progress.merged / progress.total) * 100) : 0;
    const lines = [
        `### Epic progress${planName ? `: ${planName}` : ''}`,
        '',
        `**${progress.merged} out of ${progress.total} PRs merged** ${complete ? '✅' : '⏳'}`,
        '',
        `\`${renderProgressBar(progress.merged, progress.total)}\` ${percent}%`,
    ];
    if (progress.mergedPullRequests.length > 0) {
        lines.push('', `Merged child PRs: ${progress.mergedPullRequests.map(n => `#${n}`).join(', ')}`);
    }
    if (progress.excluded > 0) {
        lines.push('', `_${progress.excluded} planned issue${progress.excluded === 1 ? ' was' : 's were'} closed without a merge and ${progress.excluded === 1 ? 'is' : 'are'} not counted._`);
    }
    lines.push('', '---', '*This comment is updated automatically by ProPR as child PRs merge.*', EPIC_PROGRESS_MARKER);
    return lines.join('\n');
}

export function buildEpicCompleteComment(progress: EpicMergeProgress, planName?: string): string {
    return [
        `### ✅ Epic ready for final merge${planName ? `: ${planName}` : ''}`,
        '',
        `All ${progress.total} child PR${progress.total === 1 ? ' has' : 's have'} been merged into this epic branch. This epic PR is ready for final review and merge.`,
        '',
        '---',
        '*Posted automatically by ProPR*',
        EPIC_COMPLETE_MARKER,
    ].join('\n');
}

export function buildEpicFinalMergeComment(
    progress: EpicMergeProgress,
    { epicPrNumber, baseBranch, planName }: { epicPrNumber: number; baseBranch: string; planName?: string },
): string {
    return [
        `### ✅ Epic merged${planName ? `: ${planName}` : ''}`,
        '',
        `Epic PR #${epicPrNumber} has been merged into ${baseBranch}.`,
        '',
        `**${progress.merged} out of ${progress.total} PRs merged** into ${baseBranch} through this epic PR.`,
        ...(isEpicMergeComplete(progress) ? ['', 'All planned epic work is now merged.'] : []),
        '', '*Posted automatically by ProPR*', EPIC_FINAL_MERGE_MARKER,
    ].join('\n');
}

interface IssueComment {
    id: number;
    body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function listBotComments(octokit: EpicProgressOctokit, owner: string, repo: string, issueNumber: number): Promise<IssueComment[]> {
    const parameters = { owner, repo, issue_number: issueNumber, per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', parameters)).data;
    const botUsernames = new Set([getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]'].filter(Boolean));
    return (Array.isArray(data) ? data : []).flatMap(comment => {
        if (!isRecord(comment) || typeof comment.id !== 'number' || typeof comment.body !== 'string') return [];
        const login = isRecord(comment.user) && typeof comment.user.login === 'string' ? comment.user.login : '';
        return botUsernames.has(login) ? [{ id: comment.id, body: comment.body }] : [];
    });
}

async function listChildPullRequests(octokit: EpicProgressOctokit, owner: string, repo: string, epicBranch: string): Promise<EpicChildPullRequest[]> {
    const parameters = { owner, repo, base: epicBranch, state: 'all', per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/pulls', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/pulls', parameters)).data;
    return (Array.isArray(data) ? data : []).flatMap(pr => {
        if (!isRecord(pr) || typeof pr.number !== 'number') return [];
        const merged = typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
        return [{ number: pr.number, merged, mergedAt: merged ? pr.merged_at as string : undefined, abandoned: pr.state === 'closed' && !merged }];
    });
}

/** Only confirmed earlier merges establish work shipped by a predecessor. */
async function listShippedChildren(
    octokit: EpicProgressOctokit,
    request: EpicMergeProgressRequest,
    children: EpicChildPullRequest[],
    baseBranch: string,
    mergedAt = Infinity,
): Promise<Set<number>> {
    const { owner, repo, epicBranch, epicPrNumber } = request;
    const parameters = { owner, repo, head: `${owner}:${epicBranch}`, base: baseBranch, state: 'closed', per_page: 100 };
    const data = octokit.paginate
        ? await octokit.paginate('GET /repos/{owner}/{repo}/pulls', parameters)
        : (await octokit.request('GET /repos/{owner}/{repo}/pulls', parameters)).data;
    const predecessorTimes = (Array.isArray(data) ? data : []).flatMap(pr =>
        isRecord(pr) && typeof pr.number === 'number' && pr.number < epicPrNumber && typeof pr.merged_at === 'string'
            ? [Date.parse(pr.merged_at)] : []);
    const cutoff = Math.max(...predecessorTimes.filter(time => Number.isFinite(time) && time < mergedAt));
    // Equal timestamps cannot prove inclusion (the same rule as canCarryChild).
    return new Set(children.filter(pr => pr.mergedAt && Date.parse(pr.mergedAt) < cutoff).map(pr => pr.number));
}

async function readEpicMergeState(octokit: EpicProgressOctokit, request: EpicMergeProgressRequest) {
    const { owner, repo, epicPrNumber } = request;
    const comments = await listBotComments(octokit, owner, repo, epicPrNumber);
    const finalComment = comments.find(comment => comment.body.includes(EPIC_FINAL_MERGE_MARKER));
    // A confirmation proves the merge happened, but cannot establish which
    // children it included. Always read the immutable aggregate merge time.
    const epic = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: epicPrNumber,
    })).data;
    const epicMerged = !!finalComment || request.mergedChildPrNumber === null || (isRecord(epic) && epic.merged === true);
    const baseBranch = isRecord(epic) && isRecord(epic.base) && typeof epic.base.ref === 'string'
        ? epic.base.ref : undefined;
    const mergedAt = isRecord(epic) && typeof epic.merged_at === 'string' ? Date.parse(epic.merged_at) : NaN;
    if (epicMerged && !Number.isFinite(mergedAt)) throw new Error('Epic merge boundary unavailable');
    if (epicMerged && request.mergedChildPrNumber !== null) {
        const repository = (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data;
        if (!baseBranch || !isRecord(repository) || baseBranch !== repository.default_branch) {
            throw new Error('Merged epic does not target the default branch');
        }
    }
    return { comments, epicMerged, baseBranch, mergedAt };
}

/**
 * Keeps a single "x out of y PRs merged" tracking comment on the epic PR up to
 * date, posts a readiness notice once every child PR has merged, and
 * confirms completion separately when the aggregate epic PR merges.
 * Progress, readiness, and final-merge comments each have a hidden marker,
 * so webhook redeliveries update in place without posting duplicates.
 * Ownership is re-checked before every write to reject a lost lease.
 */
export async function updateEpicMergeProgress(
    request: EpicMergeProgressRequest,
    correlationId: string,
    dependencies: EpicMergeProgressDependencies = {},
): Promise<EpicMergeProgressResult> {
    const log = logger.withCorrelation(correlationId);
    const getOctokit = dependencies.getOctokit
        ?? (async () => await getAuthenticatedOctokit() as unknown as EpicProgressOctokit);
    const octokit = await getOctokit();
    const assertOwned = dependencies.assertOwned ?? (async () => {});
    const { owner, repo, epicPrNumber } = request;

    const children = await listChildPullRequests(octokit, owner, repo, request.epicBranch);
    const { comments, epicMerged, baseBranch, mergedAt } = await readEpicMergeState(octokit, request);
    if (epicMerged && request.mergedChildPrNumber !== null
        && !children.some(pr => pr.number === request.mergedChildPrNumber)) {
        // The child list can lag a delivered merge. Read its timestamp rather
        // than allowing the event alone to bypass the aggregate boundary.
        const child = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: request.mergedChildPrNumber,
        })).data;
        const childMergedAt = isRecord(child) && typeof child.merged_at === 'string' ? child.merged_at : undefined;
        children.push({ number: request.mergedChildPrNumber, merged: !!childMergedAt, mergedAt: childMergedAt, abandoned: false });
    }
    const shipped = baseBranch ? await listShippedChildren(octokit, request, children, baseBranch, epicMerged ? mergedAt : Infinity) : new Set<number>();
    // For a final report, neither current plan status nor the triggering event
    // proves inclusion. Keep later/unknown children outstanding for this PR.
    const included = new Set(children.filter(pr => pr.mergedAt && Date.parse(pr.mergedAt) < mergedAt).map(pr => pr.number));
    const displayBase = baseBranch ?? 'the target branch';
    const progress = computeEpicMergeProgress(
        children.filter(pr => !shipped.has(pr.number)).map(pr => epicMerged ? { ...pr, merged: included.has(pr.number) } : pr),
        epicMerged || (request.mergedChildPrNumber !== null && shipped.has(request.mergedChildPrNumber)) ? null : request.mergedChildPrNumber,
        request.planIssues?.filter(issue => issue.pr_number == null || !shipped.has(issue.pr_number))
            .map(issue => epicMerged && issue.status === PlanIssueStatus.MERGED
                ? { ...issue, status: PlanIssueStatus.UNDER_REVIEW } : issue),
    );

    const body = buildEpicProgressComment(progress, request.planName)
        + (epicMerged ? '\n\n✅ This epic PR has been merged into ' + displayBase + '.' : '');
    const existing = comments.find(comment => comment.body.includes(EPIC_PROGRESS_MARKER));
    let trackingComment: EpicMergeProgressResult['trackingComment'];
    if (!existing) {
        await assertOwned();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: epicPrNumber, body,
        });
        trackingComment = 'created';
    } else if (existing.body !== body) {
        await assertOwned();
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner, repo, comment_id: existing.id, body,
        });
        trackingComment = 'updated';
    } else {
        trackingComment = 'unchanged';
    }

    let completionPosted = false;
    const completionMarker = epicMerged ? EPIC_FINAL_MERGE_MARKER : EPIC_COMPLETE_MARKER;
    const completion = comments.find(comment => comment.body.includes(completionMarker));
    if (epicMerged || isEpicMergeComplete(progress)) {
        const completionBody = epicMerged
            ? buildEpicFinalMergeComment(progress, { epicPrNumber, baseBranch: displayBase, planName: request.planName })
            : buildEpicCompleteComment(progress, request.planName);
        if (!completion) {
            await assertOwned();
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner, repo, issue_number: epicPrNumber, body: completionBody,
            });
            completionPosted = true;
        } else if (epicMerged && completion.body !== completionBody) {
            await assertOwned();
            await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: completion.id, body: completionBody,
            });
        }
    }

    log.info({
        owner, repo, epicPrNumber,
        merged: progress.merged, total: progress.total,
        trackingComment, completionPosted,
    }, 'Updated epic merge progress');
    return { progress, trackingComment, completionPosted };
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

/** A merged epic can only carry a child that merged before it. */
export async function canCarryChild(
    octokit: Octokit,
    { owner, repo, mergedChildPrNumber }: Pick<EpicMergeProgressRequest, 'owner' | 'repo' | 'mergedChildPrNumber'>,
    pr: { state: string; merged_at: string | null; base?: { ref: string } },
    evidence?: { defaultBranch: string; childMergedAt: string | null },
): Promise<boolean> {
    if (pr.state === 'open') return true;
    if (!pr.merged_at || mergedChildPrNumber === null) return false;
    const defaultBranch = evidence?.defaultBranch ?? (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    if (pr.base?.ref !== defaultBranch) return false;
    const childMergedAt = evidence ? evidence.childMergedAt : (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: mergedChildPrNumber,
    })).data.merged_at;
    // Missing, invalid, or equal timestamps do not establish that the child
    // was included. Fall back to creating a PR for the remaining commits.
    return !!childMergedAt && Date.parse(childMergedAt) < Date.parse(pr.merged_at);
}

/** Prefer an open Epic PR; reuse a merged one only for an included child. */
export async function findEpicPRNumber(
    octokit: Octokit, context: Pick<EpicMergeProgressRequest, 'owner' | 'repo' | 'epicBranch' | 'mergedChildPrNumber'>,
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
    const defaultBranch = (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    const childMergedAt = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: context.mergedChildPrNumber,
    })).data.merged_at;
    for (const pr of candidates) {
        if (await canCarryChild(octokit, context, pr, { defaultBranch, childMergedAt })) return pr.number;
    }
    return null;
}
