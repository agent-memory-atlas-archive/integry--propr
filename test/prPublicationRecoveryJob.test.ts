import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHooklessGit as realGit } from '../packages/core/src/git/hooklessGit.js';
import { up, down } from '../packages/core/src/db/migrations/20260914000000_add_pr_continuations.js';

import { up as checkpointUp, down as checkpointDown } from '../packages/core/src/db/migrations/20260914010000_add_pr_publication_checkpoint.js';

import { up as completionUp, down as completionDown } from '../packages/core/src/db/migrations/20260914020000_add_pr_publication_completion.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
await checkpointUp(database);
await completionUp(database);
const root = await mkdtemp(path.join(tmpdir(), 'pr-continuation-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Worker', '-c', 'user.email=worker@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// All repositories are disposable fixtures; no workspace Git metadata is modified.
git(root, 'init', '--bare', 'upstream.git');
git(root, 'clone', path.join(root, 'upstream.git'), 'seed');
const seed = path.join(root, 'seed');
await writeFile(path.join(seed, 'base.txt'), 'base\n');
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Base');
git(seed, 'branch', '-M', 'release'); git(seed, 'push', 'origin', 'release');
git(root, 'clone', '--bare', path.join(root, 'upstream.git'), 'fork.git');
git(seed, 'checkout', '-b', 'contribution');
await writeFile(path.join(seed, 'contributor.txt'), 'contribution\n');
git(seed, 'add', '.'); git(seed, 'commit', '--author=Original Contributor <contributor@example.test>', '-m', 'Contributor change');
const sourceSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'push', path.join(root, 'fork.git'), 'contribution');
// GitHub's PR refs make the contribution commit available in the upstream repository.
git(seed, 'push', 'origin', 'HEAD:refs/pull/42/head');

let probeError: Error | undefined;
let finalPushError: Error | undefined;
let continuationPushError: Error | undefined;
let failPRCreate = false;
let calls: Array<{ operation: string; args: unknown }> = [];
let cloneIndex = 0;
const token = 'ghs_worker_installation_token';
const repoPath = (owner: string) => path.join(root, owner === 'upstream' ? 'upstream.git' : 'fork.git');

let events: string[] = [];
let pendingComments: Array<{ id: number; body: string; author: string; type: string }> = [];
let restoredComments: unknown[] = [];
let skipValidation = false;
let prompts: string[] = [];
let produced: string[] = [];
let completionBodies: string[] = [];
let failCompletion = false;
let partialResult = false;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const noOp = async () => {};
const completions: Array<{ taskId: string; metadata: any }> = [];
const taskStates = new Map<string, string>();
const stateManager = {
    getTaskState: async (taskId: string) => taskStates.has(taskId) ? { state: taskStates.get(taskId) } : null, updateHistoryMetadata: noOp,
    updateTaskState: async (taskId: string, state: string, metadata: any) => {
        if (taskStates.get(taskId) === 'failed' && !(state === 'processing' && metadata.isRetry === true)) return;
        taskStates.set(taskId, state);
        if (state === 'completed') { completions.push({ taskId, metadata }); events.push(`complete:${taskId}`); }
    },
};
await database.schema.createTable('tasks', table => { table.string('task_id'); table.string('commit_hash'); });
await mock.module('ioredis', { namedExports: { Redis: class {} } });
await mock.module('@propr/core', { namedExports: {
    db: database, AI_COMMIT_AUTHOR: { name: 'Test Worker', email: 'worker@example.test' },
    logger: { ...log, withCorrelation: () => log },
    getStateManager: () => stateManager,
    hashTaskAttemptToken: () => 'hash',
    retryConfigs: { githubApi: {} }, withRetry: async (fn: () => unknown) => fn(),
    runWithExecutionAbortSignal: async (_signal: unknown, fn: () => unknown) => fn(),
    TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', CLAUDE_EXECUTION: 'claude_execution', FAILED: 'failed' },
    ensureGitRepository: noOp, createLogFiles: noOp, UsageLimitError: class extends Error {},
    recordLLMMetrics: noOp, loadPrimaryProcessingLabels: async () => ['propr'],
    loadRepositoryVisualPreviewSettings: noOp,
    prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
    cleanupPreparedVisualPreviewEvidence: noOp,
    appendVisualPreviewSection: (body: string) => body,
    renderVisualPreviewSection: () => '', renderVisualPreviewUploadFailureSection: () => '',
    resolveAgentTerminationReason: (result: { success: boolean }) => result.success ? undefined : 'timeout', VISUAL_PREVIEW_SLOT: '',
    commitChanges: async (worktree: string, message: string) => {
        git(worktree, 'add', '.');
        git(worktree, 'commit', '-m', message);
        produced.push(git(worktree, 'rev-parse', 'HEAD'));
        return { commitHash: produced.at(-1), commitMessage: message, filesChanged: ['implementation.txt'] };
    },
    getAuthenticatedOctokit: async () => octokit,
    getRepoUrl: ({ repoOwner }: { repoOwner: string }) => repoPath(repoOwner),
    createHooklessGit: (worktree: string) => {
        const actual = realGit(worktree);
        return {
            raw: async (args: string[]) => {
                calls.push({ operation: 'git', args });
                if (args.includes('--dry-run') && probeError) throw probeError;
                if (args[0] === 'push' && args.includes('HEAD:refs/heads/propr/continuation-pr-42') && continuationPushError) throw continuationPushError;
                return actual.raw(args);
            },
            revparse: (args: string[]) => actual.revparse(args),
        };
    },
    ensureRepoCloned: async ({ owner, authToken }: { owner: string; authToken: string }) => {
        assert.equal(authToken, token);
        return repoPath(owner);
    },
    createWorktreeFromExistingBranch: async (repo: string, branchName: string) => {
        const worktreePath = path.join(root, `work-${++cloneIndex}`);
        git(root, 'clone', '--branch', branchName, repo, worktreePath);
        git(worktreePath, 'config', 'user.name', 'Test Worker');
        git(worktreePath, 'config', 'user.email', 'worker@example.test');
        calls.push({ operation: 'worktree', args: { repo, branchName, worktreePath } });
        return { worktreePath, branchName };
    },
    cleanupWorktree: async (_repo: string, worktree: string) => { await rm(worktree, { recursive: true, force: true }); },
    pushBranch: async (worktree: string, branchName: string, options: { repoUrl: string; authToken: string }) => {
        assert.equal(options.authToken, token);
        calls.push({ operation: 'forkPush', args: { worktree, branchName, options } });
        if (finalPushError) throw finalPushError;
        git(worktree, 'push', options.repoUrl, `HEAD:refs/heads/${branchName}`);
        return { rebased: false, commitHash: git(worktree, 'rev-parse', 'HEAD') };
    },
} });

const ref = { repoOwner: 'upstream', repoName: 'project', pullRequestNumber: 42 };
const source = {
    head: { ref: 'contribution', sha: sourceSha, repo: { owner: { login: 'contributor' }, name: 'project' } },
    base: { ref: 'release' }, title: 'Contribution', body: 'Original objective', user: { login: 'contributor' },
};
type FakePR = { number: number; state: string; html_url: string; body: string; base: { ref: string }; head: { ref: string; repo: { full_name: string } } };
let prs: FakePR[] = [];
let comments: Array<{ id: number; body: string; user: { type: string } }> = [];
let loseCreateResponse = false;
let failComment = false;
const octokit = {
    auth: async (options: unknown) => {
        calls.push({ operation: 'auth', args: options });
        assert.deepEqual(options, { type: 'installation' });
        return { token };
    },
    paginate: async (endpoint: string) => endpoint.endsWith('/pulls') ? [...prs] : [...comments],
    request: async (endpoint: string, options: Record<string, any>) => {
        calls.push({ operation: endpoint, args: options });
        if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') {
            try { git(repoPath('upstream'), 'show-ref', '--verify', options.ref); }
            catch { git(repoPath('upstream'), 'update-ref', options.ref, options.sha); return { data: {} }; }
            throw Object.assign(new Error('Reference already exists'), { status: 422 });
        }
        if (endpoint.includes('/compare/')) {
            const tip = git(repoPath('upstream'), 'rev-parse', 'refs/heads/propr/continuation-pr-42');
            return { data: { status: tip === sourceSha ? 'identical' : 'ahead' } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
            if (failPRCreate) throw new Error('PR creation network error');
            if (prs.length) throw Object.assign(new Error('PR already exists'), { status: 422 });
            const pr = { number: 100, state: 'open', html_url: 'https://github.com/upstream/project/pull/100', body: options.body, base: { ref: options.base }, head: { ref: options.head, repo: { full_name: 'upstream/project' } } };
            prs.push(pr);
            if (loseCreateResponse) { loseCreateResponse = false; throw new Error('ECONNRESET after create'); }
            return { data: pr };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: options.pull_number === 42 ? { ...source, labels: [{ name: 'propr' }] } : prs[0] };
        if (endpoint.startsWith('PATCH')) {
            if (failCompletion) throw new Error('Completion comment failed');
            completionBodies.push(options.body);
            return { data: { html_url: `https://github.com/upstream/project/pull/42#issuecomment-${options.comment_id}`, body: options.body } };
        }
        if (endpoint.endsWith('/comments') && endpoint.startsWith('POST')) {
            assert.equal(options.issue_number, 42);
            if (failComment) throw new Error('Comment network error');
            const comment = { id: comments.length + 1, body: options.body, user: { type: 'Bot' } };
            comments.push(comment);
            return { data: comment };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
};
const modules: Record<string, Record<string, unknown>> = {
    prCommentJobHelpers: {
        validateAndFilterComments: async (comments: unknown) => skipValidation ? [] : comments,
        filterUnprocessedComments: (comments: unknown) => comments,
        fetchLinkedIssueContext: async () => ({ context: '' }), buildCommentHistory: () => '',
        updateTaskTitleForPR: noOp, resolvePrReasoningLevelOverride: () => undefined,
    },
    issueJobHelpers: { localizeContentImages: async (body: string) => body },
    prCommentJobUtils: {
        buildCombinedComment: (comments: Array<{ body: string }>) => ({ combinedCommentBody: comments.map(c => c.body).join('\n'), commentAuthors: ['contributor'] }),
        extractModelFromLabels: () => 'model', fetchAllComments: async () => [], buildPrompt: ({ combinedCommentBody }: { combinedCommentBody: string }) => combinedCommentBody,
        handleJobError: async (_error: unknown, job: { id: string }) => { taskStates.set(job.id, 'failed'); },
        cleanupJob: async ({ worktreeInfo }: { worktreeInfo?: { worktreePath: string } }) => { if (worktreeInfo) await rm(worktreeInfo.worktreePath, { recursive: true, force: true }); }, buildCommitMessage: () => 'Implementation', toClaudeResult: noOp, buildStartingWorkCommentBody: () => 'Starting work',
    },
    prPendingComments: {
        restorePendingComments: async (comments: unknown[]) => { restoredComments.push(...comments); },
        pickUpPendingCommentsWithClaim: async (comments: unknown[]) => ({ commentsToProcess: [...comments, ...pendingComments], pickedUpComments: pendingComments }),
        applyPendingCommentCommandContext: noOp,
    },
    prCommentReviewJob: { executeReviewProcessing: async (params: { context: { pullRequestNumber: number } }) => { events.push(`review:${params.context.pullRequestNumber}`); return { status: 'complete' }; } },
    prCommentAgentUtils: { generateSummaryTitle: async () => 'Saved subtitle', resolveAndExecuteAgent: async ({ worktreePath, prompt }: { worktreePath: string; prompt: string }) => { events.push('agent'); prompts.push(prompt); if (produced.length) assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), produced[0]); await writeFile(path.join(worktreePath, 'implementation.txt'), `execution ${prompts.length}\n`); return { claudeResult: { success: !partialResult, summary: 'Saved agent summary', sessionId: 'saved-session', model: 'saved-model' }, agentType: 'test' }; }, resolvePRCommentModelName: async () => 'model' },
    reviewCommentFormatter: { isReviewComment: () => false },
    reviewFindingSelector: { hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }) },
    ultrafixOrchestrationService: { retainOriginalScope: noOp, stopLoop: async () => { events.push('stop'); } },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({}), handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    ultrafixReviewExecutionGate: { shouldDeferUltrafixReview: async () => { events.push('check-gate'); return false; } },
    prCommentNoAuthorizedFindings: { handleNoAuthorizedFindings: noOp },
    prTaskTitleHelpers: Object.fromEntries(['buildDeterministicPrTaskSubtitle', 'buildPrTaskTitle', 'buildPrTaskTitleContext', 'buildPrTaskTitleContextHistoryMetadata', 'getPrTaskWorkflowLabel', 'resolvePrTaskWorkflow'].map(name => [name, noOp])),
    prProcessingLock: {
        acquirePRProcessingLock: async (_redis: unknown, key: string) => { events.push(key); return true; },
        ensurePRProcessingLockToken: async () => 'token', releasePRProcessingLock: noOp,
        startPRProcessingLockHeartbeat: () => noOp,
    },
    prCommentCollisionRecovery: { createPRCommentTaskStateIfMissing: async ({ taskId }: { taskId: string }) => { if (!taskStates.has(taskId)) taskStates.set(taskId, 'processing'); }, evaluatePRCommentPreExecutionRecovery: async () => ({}), handlePRCommentLockContention: noOp },
    prCompletionComment: { buildCompletionComment: async (commit: unknown, comments: unknown, options: unknown, result: unknown) => JSON.stringify({ commit, comments, options, result }) },
    reviewCommentGatherer: { markReviewFindingsProcessed: noOp },
};
for (const [name, namedExports] of Object.entries(modules)) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', { namedExports: {
    isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp,
} });

const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const { findPRContinuation } = await import('../src/jobs/prContinuation.js');
const job = (id = 'task-1', commentId = 5, body = 'Original instructions') => ({
    id, updateData: noOp,
    data: { ...ref, commandMode: 'default', correlationId: 'correlation', commentId, commentBody: body, commentAuthor: 'contributor' },
});
const run = (request = job()) => processPullRequestCommentJob(request as never);
const denial = () => new Error('remote: Write access to repository not granted. fatal: HTTP 403');
beforeEach(async () => {
    taskStates.clear(); pendingComments = []; restoredComments = []; skipValidation = false;
    await database('pr_continuations').delete();
    await database('tasks').delete();
    await database('tasks').insert({ task_id: 'task-1' });
    git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
    calls = []; prs = []; comments = []; prompts = []; events = []; produced = []; completionBodies = []; completions.length = 0;
    probeError = undefined; finalPushError = denial(); continuationPushError = undefined;
    failPRCreate = false; failComment = false; loseCreateResponse = false; failCompletion = false; partialResult = false;
});
after(async () => {
    await completionDown(database); await checkpointDown(database); await down(database);
    await database.destroy(); await rm(root, { recursive: true, force: true });
});

async function assertSavedCheckpoint() {
    const record = (await findPRContinuation(ref))!;
    assert.ok(record.publication_bundle);
    const completion = JSON.parse(record.publication_completion!);
    assert.equal(completion.taskId, 'task-1');
    assert.deepEqual(completion.instructionCommentIds, [5]);
    assert.equal(completion.claudeResult.summary, 'Saved agent summary');
    assert.equal(completion.jobData.subtitle, 'Saved subtitle');
    assert.equal(completion.commitResult.commitHash, produced[0]);
    for (const call of calls.filter(c => c.operation === 'worktree')) {
        await assert.rejects(import('node:fs/promises').then(fs => fs.access((call.args as any).worktreePath)), { code: 'ENOENT' });
    }
}

for (const failure of ['PR creation', 'continuation push']) {
    for (const retryTaskId of ['task-1', 'replacement-task']) {
        test(`${failure}: retry ${retryTaskId} recovers and completes after worktree deletion with exactly one agent execution`, async () => {
            if (failure === 'PR creation') failPRCreate = true;
            else continuationPushError = new Error('Connection timed out');
            await assert.rejects(run(), /network error|Connection timed out/);
            await assertSavedCheckpoint();
            assert.equal(completions.length, 0);
            failPRCreate = false; continuationPushError = undefined;
            const result = await run(job(retryTaskId));
            assert.equal(result.status, 'complete');
            assert.equal(result.commit, produced[0]);
            assert.equal(prompts.length, 1);
            assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced[0]);
            assert.ok(completions.some(c => c.taskId === 'task-1'));
            assert.equal(taskStates.get('task-1'), 'completed');
            assert.equal(taskStates.get(retryTaskId), 'completed');
            assert.equal((await database('tasks').first()).commit_hash, produced[0]);
            assert.match(completionBodies[0], /Saved agent summary/);
            assert.match(completionBodies[0], /saved-session/);
            const record = (await findPRContinuation(ref))!;
            assert.equal(record.publication_bundle, null);
            assert.equal(record.publication_completion, null);
        });
    }
}

test('a new instruction first finishes the outstanding task and then runs only the new instructions', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    await assertSavedCheckpoint();
    failPRCreate = false;
    const result = await run(job('task-2', 6, 'New instructions'));
    assert.equal(result.status, 'complete');
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes('New instructions'));
    assert.ok(!prompts[1].includes('Original instructions'));
    assert.ok(events.indexOf('complete:task-1') < events.lastIndexOf('agent'));
    assert.deepEqual(completions.map(c => c.taskId), ['task-1', 'task-2']);
    git(repoPath('upstream'), 'merge-base', '--is-ancestor', produced[0], produced[1]);
});

test('repeated publication and completion failures retain the inputs without rerunning the agent', async () => {
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(run(), /Connection timed out/);
    await assertSavedCheckpoint();
    await assert.rejects(run(), /Connection timed out/);
    await assertSavedCheckpoint();
    continuationPushError = undefined;
    failCompletion = true;
    await assert.rejects(run(), /Completion comment failed/);
    const published = (await findPRContinuation(ref))!;
    assert.equal(published.publication_bundle, null);
    assert.ok(published.publication_completion);
    failCompletion = false;
    assert.equal((await run()).status, 'complete');
    assert.equal(prompts.length, 1);
    assert.equal((await findPRContinuation(ref))!.publication_completion, null);
});

test('recovery preserves partial execution disposition and original instruction IDs', async () => {
    partialResult = true; failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    const result = await run();
    assert.equal(result.status, 'partial');
    assert.equal(prompts.length, 1);
    assert.deepEqual(completions[0].metadata.historyMetadata.incompleteExecution, { reason: 'timeout' });
    assert.deepEqual(JSON.parse(completionBodies[0].split('\n\n').at(-1)!).comments.map((c: any) => c.id), [5]);
});

test('completion recovery runs even when the instruction comments would now be filtered out', async () => {
    failCompletion = true;
    await assert.rejects(run(), /Completion comment failed/);
    assert.equal((await findPRContinuation(ref))!.publication_bundle, null);
    failCompletion = false; skipValidation = true;
    assert.equal((await run()).status, 'complete');
    assert.equal(taskStates.get('task-1'), 'completed');
    assert.equal(prompts.length, 1);
});

test('a retry returns newly claimed instructions for a separate task without rerunning the original agent', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    pendingComments = [{ id: 6, body: 'New instructions', author: 'contributor', type: 'issue' }];
    assert.equal((await run()).status, 'complete');
    assert.deepEqual(restoredComments, pendingComments);
    assert.equal(prompts.length, 1);
});

test('a new batch containing recovered instruction IDs executes only the remaining instructions', async () => {
    failPRCreate = true;
    await assert.rejects(run(), /network error/);
    failPRCreate = false;
    const request = { ...job('task-2'), data: { ...job('task-2').data, comments: [
        { id: 5, body: 'Original instructions', author: 'contributor', type: 'issue' },
        { id: 6, body: 'New instructions', author: 'contributor', type: 'issue' },
    ] } };
    assert.equal((await run(request)).status, 'complete');
    assert.equal(prompts.length, 2);
    assert.ok(!prompts[1].includes('Original instructions'));
    assert.ok(prompts[1].includes('New instructions'));
});

test('a replacement request can finish after its own recovery attempt failed', async () => {
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(run(), /Connection timed out/);
    await assert.rejects(run(job('replacement-task')), /Connection timed out/);
    continuationPushError = undefined;
    assert.equal((await run(job('replacement-task'))).status, 'complete');
    assert.equal(taskStates.get('task-1'), 'completed');
    assert.equal(taskStates.get('replacement-task'), 'completed');
    assert.equal(prompts.length, 1);
});
