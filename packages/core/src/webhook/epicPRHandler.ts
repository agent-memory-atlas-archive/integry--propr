import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isEpicBranch, EPIC_BRANCH_PATTERN } from '../services/taskExecutionService.js';
import { createEpicPRWithDraftFallback } from '../services/epicPRService.js';
import { updateEpicMergeProgress } from './epicMergeProgress.js';
import {
    recordEpicProgressRetry, runEpicProgressUpdate, sweepEpicProgressRetries,
    type EpicProgressLease, type EpicProgressRetryRedis, type EpicProgressTarget,
} from './epicMergeProgressRetry.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';
import { db } from '../db/connection.js';
import type { PlanIssue } from '../config/planIssueManager.js';
import type { PullRequestEvent } from '@octokit/webhooks-types';

interface PlanDetails {
    planName: string;
    draftId: string;
    issues: PlanIssue[];
}

interface IssueDetails {
    number: number;
    title: string;
}

/**
 * Extract the first issue ID from an epic branch name.
 * Epic branch format: {id}-epic-{word1}-{word2}-{rand}
 */
function extractFirstIssueId(epicBranchName: string): number | null {
    const match = epicBranchName.match(EPIC_BRANCH_PATTERN);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
}

/**
 * Outcome of a plan lookup. `absent` is confirmed: the epic has no plan.
 * `unavailable` means the plan could not be read, so the expected epic
 * membership is unknown.
 */
type PlanLookup =
    | { status: 'found'; details: PlanDetails }
    | { status: 'absent' }
    | { status: 'unavailable' };

const PLAN_LOOKUP_ATTEMPTS = 3;
const PLAN_LOOKUP_RETRY_DELAY_MS = 500;

/**
 * Get plan details from database using the epic branch name.
 * Extracts the first issue ID from the branch name and finds the associated plan.
 */
async function getPlanDetailsFromBranch(
    epicBranchName: string,
    repository: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<PlanLookup> {
    const firstIssueId = extractFirstIssueId(epicBranchName);
    if (!firstIssueId) {
        log.debug({ epicBranchName }, 'Could not extract issue ID from epic branch name');
        return { status: 'absent' };
    }

    try {
        // Find the plan issue by repository and issue number
        const planIssue = await db('plan_issues')
            .where({ repository, issue_number: firstIssueId })
            .first();

        if (!planIssue) {
            log.debug({ firstIssueId, repository }, 'No plan issue found for this issue');
            return { status: 'absent' };
        }

        // Get the plan name from task_drafts
        const draft = await db('task_drafts')
            .where({ draft_id: planIssue.draft_id })
            .select('name', 'draft_id')
            .first();

        if (!draft) {
            log.debug({ draftId: planIssue.draft_id }, 'No draft found for plan issue');
            return { status: 'absent' };
        }

        // Get all issues in this plan. Queried directly rather than through
        // getPlanIssuesByDraft, which turns read failures into an empty list.
        const issues: PlanIssue[] = await db('plan_issues')
            .where({ draft_id: draft.draft_id })
            .orderBy('created_at', 'asc');
        if (issues.length === 0) {
            // The plan issue found above belongs to this draft, so an empty
            // list cannot be a confirmed absence.
            log.warn({ draftId: draft.draft_id, epicBranchName }, 'Plan issues missing for an existing plan');
            return { status: 'unavailable' };
        }

        return {
            status: 'found',
            details: {
                planName: draft.name || 'Untitled Plan',
                draftId: draft.draft_id,
                issues
            }
        };
    } catch (error) {
        log.warn({ error: (error as Error).message, epicBranchName }, 'Failed to get plan details from database');
        return { status: 'unavailable' };
    }
}

/**
 * Looks up plan details, retrying briefly when the plan could not be read.
 */
async function loadPlanDetails(
    epicBranchName: string,
    repository: string,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<PlanLookup> {
    let lookup = await getPlanDetailsFromBranch(epicBranchName, repository, log);
    for (let attempt = 2; attempt <= PLAN_LOOKUP_ATTEMPTS && lookup.status === 'unavailable'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, PLAN_LOOKUP_RETRY_DELAY_MS * (attempt - 1)));
        lookup = await getPlanDetailsFromBranch(epicBranchName, repository, log);
    }
    return lookup;
}

/**
 * Fetch issue details from GitHub.
 */
async function fetchIssueDetails(
    owner: string,
    repo: string,
    issueNumbers: number[],
    log: ReturnType<typeof logger.withCorrelation>
): Promise<IssueDetails[]> {
    const octokit = await getAuthenticatedOctokit();
    const details: IssueDetails[] = [];

    for (const issueNumber of issueNumbers) {
        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner, repo,
                issue_number: issueNumber
            });
            details.push({ number: issueNumber, title: response.data.title });
        } catch (error) {
            log.debug({ issueNumber, error: (error as Error).message }, 'Failed to fetch issue details');
            // Still include the issue, just without title
            details.push({ number: issueNumber, title: '' });
        }
    }

    return details;
}

/**
 * Build the Epic PR body with issue links and descriptions.
 */
function buildEpicPRBody(
    planName: string,
    issueDetails: IssueDetails[]
): string {
    const issueList = issueDetails
        .map(issue => issue.title
            ? `- #${issue.number}: ${issue.title}`
            : `- #${issue.number}`)
        .join('\n');

    const fixesLine = issueDetails
        .map(issue => `Fixes #${issue.number}`)
        .join('\n');

    return `## ${planName}

This Epic PR aggregates all changes for the plan: **${planName}**

### Issues in this Epic
${issueList}

### Auto-close
When this PR is merged, the following issues will be automatically closed:

${fixesLine}

---
*Created automatically by ProPR*`;
}

/**
 * Ensures Epic PR exists when a child PR is merged to an epic branch.
 * When the epic branch was first created, there were no commits so the PR couldn't be created.
 * Now that a child PR has merged, we can create the Epic PR with proper details.
 * Also reports the aggregate epic PR's final merge. All progress updates
 * share the per-epic lease and retry sweep.
 */
export async function handleEpicPRCreationOnMerge(
    payload: PullRequestEvent,
    correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    // The aggregate epic PR merges out of the epic branch, rather than into it.
    // Reuse the same lease and durable retry sweep as child progress updates.
    const headBranch = payload.pull_request.head?.ref;
    if (headBranch && isEpicBranch(headBranch)) {
        const [owner, repo] = payload.repository.full_name.split('/');
        const target: EpicProgressTarget = {
            owner, repo, epicBranch: headBranch,
            epicPrNumber: payload.pull_request.number, mergedChildPrNumber: null,
        };
        await runEpicProgressUpdate(target, {
            redis: getUltrafixStateRedis(),
            update: lease => applyEpicMergeProgress(target, { lease, correlationId, correlatedLogger }),
            log: correlatedLogger,
        });
    }

    const baseBranch = payload.pull_request.base.ref;

    // Check if the base branch is an Epic branch (child PR merged to epic branch)
    if (!isEpicBranch(baseBranch)) {
        return;
    }

    const repository = payload.repository.full_name;
    const [owner, repo] = repository.split('/');

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        baseBranch, owner, repo
    }, 'Child PR merged to epic branch, ensuring Epic PR exists');

    let epicPrNumber: number | null = null;
    try {
        epicPrNumber = await ensureEpicPR({ owner, repo, repository, baseBranch, mergedChildPrNumber: payload.pull_request.number }, correlatedLogger);
    } catch (error) {
        const err = error as Error & { status?: number };
        correlatedLogger.warn({
            error: err.message,
            baseBranch, owner, repo
        }, 'Failed to create Epic PR after child merge');
    }

    const target: EpicProgressTarget = { owner, repo, epicBranch: baseBranch, epicPrNumber, mergedChildPrNumber: payload.pull_request.number };
    if (epicPrNumber === null) {
        // The epic PR could not be located or created; keep the obligation so
        // the retry sweep finds or creates the epic PR and refreshes its progress.
        try {
            await recordEpicProgressRetry(getUltrafixStateRedis(), target);
        } catch (error) {
            correlatedLogger.error({ ...target, error: (error as Error).message }, 'Failed to record Epic PR merge progress retry');
        }
        return;
    }

    await runEpicProgressUpdate(target, {
        redis: getUltrafixStateRedis(),
        update: lease => applyEpicMergeProgress(target, { lease, correlationId, correlatedLogger }),
        log: correlatedLogger,
    });
}

interface EpicBranchContext {
    owner: string;
    repo: string;
    repository: string;
    baseBranch: string;
    mergedChildPrNumber: number | null;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

/** A merged epic can only carry a child that merged before it. */
async function canCarryChild(
    octokit: Octokit,
    { owner, repo, mergedChildPrNumber }: Pick<EpicProgressTarget, 'owner' | 'repo' | 'mergedChildPrNumber'>,
    pr: { state: string; merged_at: string | null },
): Promise<boolean> {
    if (pr.state === 'open') return true;
    if (!pr.merged_at || mergedChildPrNumber === null) return false;
    const child = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: mergedChildPrNumber,
    });
    // Missing, invalid, or equal timestamps do not establish that the child
    // was included. Fall back to creating a PR for the remaining commits.
    return !!child.data.merged_at && Date.parse(child.data.merged_at) < Date.parse(pr.merged_at);
}

/** Prefer an open Epic PR; reuse a merged one only for an included child. */
async function findEpicPRNumber(
    octokit: Octokit, context: EpicBranchContext,
): Promise<number | null> {
    const { owner, repo, baseBranch } = context;
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner, repo,
        head: `${owner}:${baseBranch}`,
        state: 'all'
    });
    const open = response.data.find(pr => pr.state === 'open');
    if (open) return open.number;
    for (const pr of response.data) {
        if (await canCarryChild(octokit, context, pr)) return pr.number;
    }
    return null;
}

/**
 * Finds an Epic PR that can carry this child's changes, refreshing its body
 * with the plan's issues, or creates a new Epic PR. Throws when
 * the PR could neither be found nor created, so the caller keeps a retry
 * obligation instead of treating a missing epic PR as done.
 */
async function ensureEpicPR(
    context: EpicBranchContext,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
    lease?: EpicProgressLease,
): Promise<number> {
    const { owner, repo, baseBranch } = context;
    const octokit = await getAuthenticatedOctokit();
    const existingPrNumber = await findEpicPRNumber(octokit, context);
    if (existingPrNumber === null) {
        return await createEpicPR(octokit, context, correlatedLogger, lease);
    }

    correlatedLogger.debug({ prNumber: existingPrNumber, baseBranch }, 'Epic PR already exists, updating body');
    try {
        await updateEpicPRBody(octokit, context, { epicPrNumber: existingPrNumber, lease }, correlatedLogger);
    } catch (error) {
        // The epic PR is known, so its progress is still tracked.
        correlatedLogger.warn({
            error: (error as Error).message,
            prNumber: existingPrNumber,
            baseBranch, owner, repo
        }, 'Failed to update Epic PR body after child merge');
    }
    return existingPrNumber;
}

/** Rewrites an existing Epic PR's body to include every issue of its plan. */
async function updateEpicPRBody(
    octokit: Octokit,
    { owner, repo, repository, baseBranch }: EpicBranchContext,
    { epicPrNumber, lease }: { epicPrNumber: number; lease?: EpicProgressLease },
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
): Promise<void> {
    const planLookup = await loadPlanDetails(baseBranch, repository, correlatedLogger);
    if (planLookup.status !== 'found') return;

    const planDetails = planLookup.details;
    const issueNumbers = planDetails.issues.map(i => i.issue_number);
    const issueDetails = await fetchIssueDetails(owner, repo, issueNumbers, correlatedLogger);
    const newBody = buildEpicPRBody(planDetails.planName, issueDetails);

    await lease?.assertOwned();
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo,
        pull_number: epicPrNumber,
        body: newBody
    });

    correlatedLogger.info({ prNumber: epicPrNumber, issueCount: issueDetails.length }, 'Updated Epic PR body with latest issues');
}

/**
 * Refreshes the epic's merge progress comments. Returns false when the plan
 * could not be read, so the caller keeps a retry obligation. A target whose
 * epic PR was not located yet is found or created first; if that fails the
 * error propagates and the obligation is kept.
 *
 * The plan is read here, under the lease, rather than reusing a snapshot
 * taken before it: a snapshot captured while this update waited on GitHub
 * can predate a child PR that was linked and merged meanwhile, and would
 * overwrite that merge's correct progress with a stale count.
 */
async function applyEpicMergeProgress(
    target: EpicProgressTarget,
    { lease, correlationId, correlatedLogger }: {
        lease: EpicProgressLease;
        correlationId: string;
        correlatedLogger: ReturnType<typeof logger.withCorrelation>;
    }
): Promise<boolean> {
    const { owner, repo, epicBranch } = target;
    const repository = `${owner}/${repo}`;
    let epicPrNumber = target.epicPrNumber
        ?? await ensureEpicPR({ owner, repo, repository, baseBranch: epicBranch, mergedChildPrNumber: target.mergedChildPrNumber }, correlatedLogger, lease);
    let planLookup = await loadPlanDetails(epicBranch, repository, correlatedLogger);
    if (planLookup.status === 'unavailable') {
        // Without the plan, unstarted planned work is invisible and progress
        // could falsely read as complete. Leave the tracking comment as is
        // until a retry can read the plan.
        correlatedLogger.warn({ epicPrNumber, baseBranch: epicBranch }, 'Plan details unavailable, deferring Epic PR merge progress update');
        return false;
    }
    // A saved retry target (or a lookup before the awaited plan/body reads)
    // may now identify an epic merged before this child. Revalidate it before
    // reporting progress and allowing the durable obligation to be released.
    if (target.mergedChildPrNumber !== null) {
        const octokit = await getAuthenticatedOctokit();
        const epic = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: epicPrNumber,
        });
        if (!await canCarryChild(octokit, target, epic.data)) {
            epicPrNumber = await ensureEpicPR({
                owner, repo, repository, baseBranch: epicBranch, mergedChildPrNumber: target.mergedChildPrNumber,
            }, correlatedLogger, lease);
            // Resolving the successor can await issue/body reads; refresh the
            // plan again so those waits cannot hide newly linked child PRs.
            planLookup = await loadPlanDetails(epicBranch, repository, correlatedLogger);
            if (planLookup.status === 'unavailable') return false;
        }
    }
    const planDetails = planLookup.status === 'found' ? planLookup.details : null;
    await updateEpicMergeProgress({
        ...target,
        epicPrNumber,
        planName: planDetails?.planName,
        planIssues: planDetails?.issues
    }, correlationId, { assertOwned: lease.assertOwned });
    return true;
}

/**
 * Retries epic merge progress updates whose earlier attempt failed. Run
 * periodically by the daemon, so the final child merge is confirmed without
 * waiting for another merge or a webhook redelivery.
 */
export async function retryPendingEpicMergeProgress(
    redis: EpicProgressRetryRedis = getUltrafixStateRedis(),
    correlationId = generateCorrelationId()
): Promise<number> {
    const correlatedLogger = logger.withCorrelation(correlationId);
    return await sweepEpicProgressRetries({
        redis,
        log: correlatedLogger,
        retry: target => runEpicProgressUpdate(target, {
            redis,
            log: correlatedLogger,
            update: lease => applyEpicMergeProgress(target, { lease, correlationId, correlatedLogger }),
        }),
    });
}

/**
 * Creates the Epic PR for an epic branch that does not have one yet.
 */
async function createEpicPR(
    octokit: Octokit,
    { owner, repo, repository, baseBranch }: EpicBranchContext,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
    lease?: EpicProgressLease,
): Promise<number> {
    // Get the default branch to use as base
    const repoResponse = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const defaultBranch = repoResponse.data.default_branch;

    // Get plan details for the Epic PR
    const planLookup = await loadPlanDetails(baseBranch, repository, correlatedLogger);
    const planDetails = planLookup.status === 'found' ? planLookup.details : null;

    let title: string;
    let body: string;

    if (planDetails) {
        const issueNumbers = planDetails.issues.map(i => i.issue_number);
        const issueDetails = await fetchIssueDetails(owner, repo, issueNumbers, correlatedLogger);

        title = `[Epic] ${planDetails.planName}`;
        body = buildEpicPRBody(planDetails.planName, issueDetails);
    } else {
        // Fallback if plan details not found
        title = `[Epic] ${baseBranch}`;
        body = `## Epic PR\n\nThis PR aggregates all changes from child PRs merged to the \`${baseBranch}\` branch.\n\n---\n*Created automatically by ProPR*`;
    }

    // Create the Epic PR
    await lease?.assertOwned();
    const prResponse = await createEpicPRWithDraftFallback(octokit, {
        owner, repo,
        title,
        head: baseBranch,
        base: defaultBranch,
        body
    });

    correlatedLogger.info({
        prNumber: prResponse.data.number,
        prUrl: prResponse.data.html_url,
        baseBranch,
        planName: planDetails?.planName
    }, 'Epic PR created after child PR merge');

    return prResponse.data.number;
}

/**
 * Handles Epic PR label cleanup when an Epic PR is merged.
 * When a PR with an Epic branch name pattern is closed and merged,
 * this function automatically deletes the corresponding `base-{branchName}` label
 * from the repository.
 */
export async function handleEpicPRLabelCleanup(
    payload: PullRequestEvent,
    _correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    // Only process closed PRs that were merged
    if (payload.action !== 'closed' || !payload.pull_request.merged) {
        return;
    }

    const branchName = payload.pull_request.head.ref;

    // Check if this is an Epic branch
    if (!isEpicBranch(branchName)) {
        return;
    }

    const [owner, repo] = payload.repository.full_name.split('/');
    const labelName = `base-${branchName}`;

    correlatedLogger.info({
        prNumber: payload.pull_request.number,
        branchName, labelName, owner, repo
    }, 'Epic PR merged, cleaning up base label');

    try {
        const octokit = await getAuthenticatedOctokit();

        // Delete the label from the repository
        await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
            owner, repo,
            name: labelName
        });

        correlatedLogger.info({ labelName, owner, repo }, 'Epic label deleted successfully');
    } catch (error) {
        const err = error as Error & { status?: number };
        if (err.status === 404) {
            correlatedLogger.debug({ labelName, owner, repo }, 'Epic label not found, may have already been deleted');
        } else {
            correlatedLogger.warn({
                error: err.message,
                labelName, owner, repo
            }, 'Failed to delete Epic label');
        }
    }
}
