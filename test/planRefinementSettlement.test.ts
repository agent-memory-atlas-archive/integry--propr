import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A plan issue shows refinement only while follow-up work for its PR is queued
 * or running. These tests drive the real task lifecycle (WorkerStateManager),
 * the real comment tracking handlers and the real plan issue manager against a
 * migrated SQLite database; only Redis and the BullMQ queue are in memory.
 */

const root = await mkdtemp(path.join(tmpdir(), 'plan-refinement-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const redisValues = new Map<string, string>();
const redisLists = new Map<string, string[]>();
function FakeRedis() {
    return {
        on: () => {},
        get: async (key: string) => redisValues.get(key) ?? null,
        setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
        set: async (key: string, value: string, ..._args: unknown[]) => {
            if (redisValues.has(key)) return null;
            redisValues.set(key, value);
            return 'OK';
        },
        // The worker state compare-and-set script: write only when the value is unchanged.
        eval: async (_script: string, _keys: number, key: string, expected: string, _ttl: string, next: string) => {
            if (redisValues.get(key) !== expected) return 0;
            redisValues.set(key, next);
            return 1;
        },
        llen: async (key: string) => redisLists.get(key)?.length ?? 0,
        keys: async () => [],
        del: async (key: string) => { redisValues.delete(key); return 1; },
        quit: async () => 'OK',
        disconnect: () => {},
    };
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis } });

type FakeJob = { id: string; name: string; data: Record<string, unknown>; state: string };
let queueJobs: FakeJob[] = [];
let queueReads = 0;
const fakeQueue = { getJobs: async (states: string[]) => { queueReads++; return queueJobs.filter(job => states.includes(job.state)); } };
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
    GITHUB_ISSUE_QUEUE_NAME: 'test-issues', COMMENT_BATCH_DELAY_MS: 3000, INDEXING_QUEUE_NAME: 'test-indexing',
    getIssueQueue: async () => fakeQueue, getIndexingQueue: async () => fakeQueue,
    issueQueue: fakeQueue, indexingQueue: fakeQueue,
    createWorker: async () => { throw new Error('not used'); }, shutdownQueue: async () => {},
} });

const activity: Array<Record<string, unknown>> = [];
const publisher = {
    publishActivity: async (payload: Record<string, unknown>) => { activity.push(payload); return true; },
    publishTaskUpdate: async () => true,
    publishDraftUpdate: async () => true,
};
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => publisher, closeEventPublisher: async () => {}, publishNotificationUpdateThroughRedis: () => {}, EventPublisher: class {} },
});

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
const { PlanIssueStatus } = await import('../packages/core/src/config/planIssueManager.js');
const { reconcilePlanIssueRefinement } = await import('../packages/core/src/services/taskPlanning/planRefinementSettlement.js');
const { handlePlanPRCommentTracking, handlePlanPRCommentActivity, handlePlanPRUpdate } = await import('../packages/core/src/webhook/planIssueTracking.js');
const { getPendingPrCommentsKey } = await import('../packages/core/src/utils/constants.js');

await runMigrations();
const stateManager = new WorkerStateManager({ keyPrefix: 'test:plan-refinement:' });

after(async () => {
    await stateManager.close();
    await closeConnection();
    await rm(root, { recursive: true, force: true });
});

const OWNER = 'propr-ultrafix';
const REPO = 'propr-desktop-acceptance';
const REPOSITORY = `${OWNER}/${REPO}`;
const DRAFT = 'draft-refinement';
const ISSUE = 9;
const PR = 10;

beforeEach(async () => {
    await db('task_history').delete();
    await db('tasks').delete();
    await db('plan_issues').delete();
    await db('task_drafts').delete();
    redisValues.clear();
    redisLists.clear();
    queueJobs = [];
    activity.length = 0;
    await db('task_drafts').insert({ draft_id: DRAFT, user_id: 'user-1', repository: REPOSITORY, initial_prompt: 'Plan', status: 'pr_created' });
});

async function seedPlanIssue(status: string, followups = 2): Promise<number> {
    const [id] = await db('plan_issues').insert({
        draft_id: DRAFT, repository: REPOSITORY, issue_number: ISSUE, pr_number: PR,
        status, followup_count: followups, task_id: 'issue-task-9',
    });
    return Number(id);
}

async function planIssue() {
    return db('plan_issues').where({ draft_id: DRAFT, issue_number: ISSUE }).first();
}

async function startFollowUp(taskId: string, jobId: string) {
    queueJobs.push({ id: jobId, name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'active' });
    await stateManager.createTaskStateIfAbsent(taskId, { number: PR, pullRequestNumber: PR, repoOwner: OWNER, repoName: REPO, type: 'pr-comment' }, null, jobId);
    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING);
}

/** The worker returning: BullMQ drops the job once the processor resolves. */
function finishJob(jobId: string) {
    queueJobs = queueJobs.filter(job => job.id !== jobId);
}

function comment(login = 'reviewer', action = 'created') {
    return {
        action,
        repository: { full_name: REPOSITORY },
        issue: { number: PR, pull_request: {} },
        comment: { id: 1, user: { login } },
    } as never;
}

describe('task lifecycle settles plan refinement', () => {
    test('a completed follow-up that made no commit returns the issue to under review', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-a', 'job-a');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'running follow-up stays refining');

        // The task records completion while BullMQ still lists its job as active.
        await stateManager.updateTaskState('pr-comment-10-a', TaskStates.COMPLETED, { reason: 'No changes were needed' });
        finishJob('job-a');

        const issue = await planIssue();
        assert.equal(issue.status, PlanIssueStatus.UNDER_REVIEW);
        assert.equal(issue.pr_number, PR, 'PR link kept');
        assert.equal(issue.followup_count, 2, 'follow-up count kept');
        assert.equal(issue.task_id, 'issue-task-9', 'task link kept');
        assert.equal((await db('task_drafts').where({ draft_id: DRAFT }).first()).status, 'pr_created', 'plan still shows its open PR');
        assert.deepEqual((await db('task_history').where({ task_id: 'pr-comment-10-a' }).orderBy('history_id')).map(row => row.state),
            ['pending', 'processing', 'completed'], 'task history untouched');
        assert.ok(activity.some(event => event.domain === 'plan' && event.repository === REPOSITORY), 'plan activity published');
    });

    test('refinement_processing after a pushed commit settles the same way', async () => {
        await seedPlanIssue(PlanIssueStatus.REFINEMENT_PROCESSING);
        await startFollowUp('pr-comment-10-b', 'job-b');
        await stateManager.updateTaskState('pr-comment-10-b', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('an older run finishing keeps refinement while a newer follow-up is running', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-old', 'job-old');
        await startFollowUp('pr-comment-10-new', 'job-new');

        await stateManager.updateTaskState('pr-comment-10-old', TaskStates.COMPLETED);
        finishJob('job-old');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'newer run still active');

        await stateManager.updateTaskState('pr-comment-10-new', TaskStates.COMPLETED);
        finishJob('job-new');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a queued follow-up or comments waiting behind the run keep refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-c', 'job-c');
        queueJobs.push({ id: 'job-queued', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await stateManager.updateTaskState('pr-comment-10-c', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'delayed job is queued work');

        queueJobs = [];
        await startFollowUp('pr-comment-10-d', 'job-d');
        redisLists.set(getPendingPrCommentsKey(OWNER, REPO, PR), ['{"id":2}']);
        await stateManager.updateTaskState('pr-comment-10-d', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'pending comments are queued work');
    });

    test('failed and cancelled follow-ups stop refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-f', 'job-f');
        await stateManager.markTaskFailed('pr-comment-10-f', new Error('agent crashed'));
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);

        await db('plan_issues').update({ status: PlanIssueStatus.IN_REFINEMENT });
        await startFollowUp('pr-comment-10-x', 'job-x');
        await stateManager.markTaskCancelled('pr-comment-10-x', 'user');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a review-only run settles too', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await stateManager.createTaskStateIfAbsent('review-10', { number: PR, repoOwner: OWNER, repoName: REPO, type: 'review' }, null, 'job-review');
        await stateManager.updateTaskState('review-10', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a late completion never downgrades a merged or closed issue', async () => {
        for (const terminal of [PlanIssueStatus.MERGED, PlanIssueStatus.CLOSED]) {
            await db('plan_issues').delete();
            await seedPlanIssue(terminal);
            await startFollowUp(`pr-comment-10-${terminal}`, `job-${terminal}`);
            await stateManager.updateTaskState(`pr-comment-10-${terminal}`, TaskStates.COMPLETED);
            assert.equal((await planIssue()).status, terminal);
            assert.deepEqual(await reconcilePlanIssueRefinement([await planIssue()]), [await planIssue()]);
        }
    });

    test('a delayed synchronize after settlement does not reopen refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-s', 'job-s');
        await stateManager.updateTaskState('pr-comment-10-s', TaskStates.COMPLETED);
        finishJob('job-s');
        await handlePlanPRUpdate({ action: 'synchronize', repository: { full_name: REPOSITORY }, pull_request: { number: PR, title: 'Fix', body: 'Fixes #9', merged: false } } as never, 'sync');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });
});

describe('PR comments refine only when they admit work', () => {
    test('an ordinary comment that admitted no work counts as a follow-up but never refines', async () => {
        await seedPlanIssue(PlanIssueStatus.UNDER_REVIEW, 0);
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c1');
        // The comment handler admitted nothing: no job, no task, no pending comments.
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c1');
        const issue = await planIssue();
        assert.equal(issue.status, PlanIssueStatus.UNDER_REVIEW);
        assert.equal(issue.followup_count, 1);
    });

    test('a comment that queued a follow-up job marks the plan refining until the run ends', async () => {
        await seedPlanIssue(PlanIssueStatus.UNDER_REVIEW, 0);
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c2');
        queueJobs.push({ id: 'job-admitted', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c2');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);

        queueJobs = [];
        await startFollowUp('pr-comment-10-admitted', 'job-admitted');
        await stateManager.updateTaskState('pr-comment-10-admitted', TaskStates.COMPLETED);
        finishJob('job-admitted');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('an ignored comment while a follow-up runs keeps refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-busy', 'job-busy');
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c3');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });

    test('bot comments and comments on merged or closed PRs change nothing', async () => {
        await seedPlanIssue(PlanIssueStatus.MERGED, 0);
        queueJobs.push({ id: 'job-late', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c4');
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c4');
        assert.deepEqual([(await planIssue()).status, (await planIssue()).followup_count], [PlanIssueStatus.MERGED, 0]);

        await db('plan_issues').update({ status: PlanIssueStatus.UNDER_REVIEW });
        await handlePlanPRCommentTracking(comment('propr-dev[bot]'), 'issue_comment', 'c5');
        await handlePlanPRCommentActivity(comment('propr-dev[bot]'), 'issue_comment', 'c5');
        assert.deepEqual([(await planIssue()).status, (await planIssue()).followup_count], [PlanIssueStatus.UNDER_REVIEW, 0]);
    });
});

describe('read-path recovery of stale refinement', () => {
    test('an issue left refining with only finished tasks is settled when read, once', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        // Historical records: the issue task and a completed PR comment task, written before this fix.
        await db('tasks').insert([
            { task_id: 'issue-task-9', repository: REPOSITORY, issue_number: ISSUE, pr_number: PR, task_type: 'issue' },
            { task_id: 'pr-comment-10-old', repository: REPOSITORY, issue_number: PR, task_type: 'issue' },
        ]);
        await db('task_history').insert([
            { task_id: 'issue-task-9', state: 'completed', reason: 'done' },
            { task_id: 'pr-comment-10-old', state: 'completed', reason: 'done' },
        ]);

        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }));
        assert.equal(read.status, PlanIssueStatus.UNDER_REVIEW);
        const stored = await planIssue();
        assert.deepEqual([stored.status, stored.pr_number, stored.followup_count], [PlanIssueStatus.UNDER_REVIEW, PR, 2]);
        assert.equal(await db('task_history').count({ count: '*' }).first().then(row => Number(row?.count)), 2, 'history untouched');

        // Once settled the issue is no longer a candidate: the next read does no work.
        queueReads = 0;
        await reconcilePlanIssueRefinement([stored]);
        assert.equal(queueReads, 0);
    });

    test('an issue whose historical PR task is still running stays refining', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await db('tasks').insert({ task_id: 'pr-comment-10-live', repository: REPOSITORY, issue_number: PR, task_type: 'issue' });
        await db('task_history').insert({ task_id: 'pr-comment-10-live', state: 'claude_execution', reason: 'running' });
        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }));
        assert.equal(read.status, PlanIssueStatus.IN_REFINEMENT);
    });

    test('an unreadable queue keeps the current status rather than guessing', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }), {
            listQueuedJobs: async () => { throw new Error('redis down'); },
        });
        assert.equal(read.status, PlanIssueStatus.IN_REFINEMENT);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });
});
