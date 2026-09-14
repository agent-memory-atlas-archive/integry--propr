import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let events: string[] = [];
let continuation: { source_pr: number; continuation_pr: number; branch_name: string } | undefined;
let preparationError: Error | undefined;
let onLockAcquired: (() => void) | undefined;
let blockedLock: string | undefined;
let resolutionError: Error | undefined;
let handledStartingComment: unknown;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const stateManager = { updateTaskState: async () => {}, getTaskState: async () => null };
const octokit = {
    auth: async () => ({ token: 'fixture-token' }),
    request: async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('POST')) {
            events.push(`comment:${params.issue_number}`);
            return { data: { id: 123, html_url: 'https://github.com/upstream/project/issues/42#issuecomment-123' } };
        }
        return { data: { head: { ref: 'fork-branch' }, labels: [{ name: 'propr' }], title: 'Contribution', body: '', user: { login: 'contributor' } } };
    },
};
const noOp = async () => {};
await mock.module('ioredis', { namedExports: { Redis: class {} } });
await mock.module('@propr/core', { namedExports: {
    getAuthenticatedOctokit: async () => octokit,
    hashTaskAttemptToken: () => 'hash', logger: { ...log, withCorrelation: () => log },
    retryConfigs: { githubApi: {} }, withRetry: async (fn: () => unknown) => fn(),
    runWithExecutionAbortSignal: async (_signal: unknown, fn: () => unknown) => fn(),
    getStateManager: () => stateManager, TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed' },
    ensureGitRepository: noOp, createLogFiles: noOp, UsageLimitError: class extends Error {},
    recordLLMMetrics: noOp, loadPrimaryProcessingLabels: async () => ['propr'],
    loadRepositoryVisualPreviewSettings: noOp,
} });
const modules: Record<string, Record<string, unknown>> = {
    prCommentJobHelpers: {
        validateAndFilterComments: async (comments: unknown) => comments,
        filterUnprocessedComments: (comments: unknown) => comments,
        fetchLinkedIssueContext: async () => ({ context: '' }), buildCommentHistory: () => '',
        updateTaskTitleForPR: noOp, resolvePrReasoningLevelOverride: () => undefined,
    },
    issueJobHelpers: { localizeContentImages: noOp },
    prCommentJobUtils: {
        buildCombinedComment: () => ({ combinedCommentBody: 'Implement', commentAuthors: ['contributor'] }),
        extractModelFromLabels: () => 'model', fetchAllComments: async () => [], buildPrompt: () => '',
        handleJobError: async (_error: Error, _job: unknown, context: { startingWorkComment: unknown }) => { handledStartingComment = context.startingWorkComment; },
        cleanupJob: noOp, toClaudeResult: noOp, buildStartingWorkCommentBody: () => 'Starting work',
    },
    prPendingComments: {
        restorePendingComments: noOp,
        pickUpPendingCommentsWithClaim: async (comments: unknown) => ({ commentsToProcess: comments, pickedUpComments: [] }),
        applyPendingCommentCommandContext: noOp,
    },
    prCommentReviewJob: { executeReviewProcessing: async (params: { context: { pullRequestNumber: number } }) => { events.push(`review:${params.context.pullRequestNumber}`); return { status: 'complete' }; } },
    prCommentAgentUtils: { generateSummaryTitle: noOp, resolveAndExecuteAgent: async () => { events.push('agent'); }, resolvePRCommentModelName: async () => 'model' },
    reviewCommentFormatter: { isReviewComment: () => false },
    reviewFindingSelector: { hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }) },
    ultrafixOrchestrationService: { retainOriginalScope: noOp, stopLoop: async () => { events.push('stop'); } },
    ultrafixJobHelpers: { handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    ultrafixReviewExecutionGate: { shouldDeferUltrafixReview: async () => { events.push('check-gate'); return false; } },
    prCommentNoAuthorizedFindings: { handleNoAuthorizedFindings: noOp },
    prCommentPostExecution: { handlePostExecution: noOp },
    prTaskTitleHelpers: Object.fromEntries(['buildDeterministicPrTaskSubtitle', 'buildPrTaskTitle', 'buildPrTaskTitleContext', 'buildPrTaskTitleContextHistoryMetadata', 'getPrTaskWorkflowLabel', 'resolvePrTaskWorkflow'].map(name => [name, noOp])),
    prProcessingLock: {
        acquirePRProcessingLock: async (_redis: unknown, key: string) => { events.push(key); if (key === blockedLock) return false; onLockAcquired?.(); return true; },
        ensurePRProcessingLockToken: async () => 'token', releasePRProcessingLock: async (_redis: unknown, key: string) => { events.push(`release:${key}`); },
        startPRProcessingLockHeartbeat: () => noOp,
    },
    prCommentCollisionRecovery: { createPRCommentTaskStateIfMissing: noOp, evaluatePRCommentPreExecutionRecovery: async () => ({}), handlePRCommentLockContention: async () => ({ status: 'deferred' }) },
    prPublication: { PullRequestPublication: class {
        status = '';
        async prepare() { events.push('prepare'); throw preparationError; }
    } },
    prContinuation: { findPRContinuation: async () => { if (resolutionError) throw resolutionError; return continuation; }, continuationStatus: () => 'Continue at https://github.com/upstream/project/pull/100' },
};
for (const [name, namedExports] of Object.entries(modules)) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const job = (commandMode = 'default', pullRequestNumber = 42) => ({
    id: 'task-1', updateData: noOp,
    data: { repoOwner: 'upstream', repoName: 'project', pullRequestNumber, commandMode, correlationId: 'correlation', commentId: 5, commentBody: 'Implement', commentAuthor: 'contributor' },
});
beforeEach(() => {
    onLockAcquired = undefined; blockedLock = undefined; resolutionError = undefined;
    events = []; continuation = undefined; preparationError = undefined; handledStartingComment = undefined;
});

for (const error of ['Preflight network error', 'Continuation creation failed']) {
    test(`${error} leaves a starting comment available to the error handler`, async () => {
        preparationError = new Error(error);
        await assert.rejects(processPullRequestCommentJob(job() as never), new RegExp(error));
        assert.ok(events.indexOf('comment:42') < events.indexOf('prepare'));
        assert.deepEqual(handledStartingComment, { data: { id: 123, html_url: 'https://github.com/upstream/project/issues/42#issuecomment-123' } });
        assert.ok(!events.includes('agent'));
    });
}

for (const mode of ['review', 'fix']) {
    test(`${mode} on the original shares the source lock and stops before agent execution`, async () => {
        continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' };
        const result = await processPullRequestCommentJob(job(mode) as never);
        assert.equal(result.reason, 'review_moved_to_continuation');
        assert.ok(events.includes('lock:pr:upstream:project:42'));
        assert.ok(events.includes('stop'));
        assert.ok(events.includes('comment:42'));
        assert.ok(!events.includes('review:42'));
        assert.ok(!events.includes('agent'));
        assert.ok(!events.includes('check-gate'));
    });
}

test('review on the continuation keeps its own PR context and exact-head check gate', async () => {
    continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' };
    await processPullRequestCommentJob(job('review', 100) as never);
    assert.ok(events.includes('lock:pr:upstream:project:42'));
    assert.ok(events.includes('check-gate'));
    assert.ok(events.includes('review:100'));
    assert.ok(!events.includes('stop'));
});

for (const contended of [false, true]) {
    test(`mapping resolved after acquisition reacquires the source lock before processing (contention: ${contended})`, async () => {
        onLockAcquired = () => { continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' }; };
        if (contended) blockedLock = 'lock:pr:upstream:project:42';
        const result = await processPullRequestCommentJob(job('review', 100) as never);
        assert.deepEqual(events.slice(0, 3), ['lock:pr:upstream:project:100', 'release:lock:pr:upstream:project:100', 'lock:pr:upstream:project:42']);
        assert.equal(result.status, contended ? 'deferred' : 'complete');
        assert.equal(events.includes('review:100'), !contended);
        assert.ok(!events.includes('agent'));
    });
}

test('failed mapping revalidation releases the acquired lock without processing', async () => {
    onLockAcquired = () => { resolutionError = new Error('Mapping lookup failed'); };
    await assert.rejects(processPullRequestCommentJob(job('review', 100) as never), /Mapping lookup failed/);
    assert.deepEqual(events, ['lock:pr:upstream:project:100', 'release:lock:pr:upstream:project:100']);
});
