import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import knex from 'knex';
import { readFile } from 'node:fs/promises';
import { up } from '../packages/core/src/db/migrations/20260923010000_add_pr_ci_suspensions.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        getAuthenticatedOctokit: async () => { throw new Error('the test must inject its own Octokit'); },
        getStateManager: () => ({ getTaskState: async () => null }),
        isCancelCiDuringFollowupEnabledForRepository: async () => true,
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
    },
});

const {
    beginFollowupCiSuspension,
    isCancelableValidationRun,
    PR_CI_SUSPENSIONS_TABLE,
    reconcileFollowupCiSuspensions,
    releaseFollowupCiSuspensionsForTask,
    resolveFollowupCiSuspensionTarget,
    sweepFollowupCiSuspension,
} = await import('../src/jobs/followupCiSuspension.ts');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TARGET = { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 };
const TASK_ID = 'task-2485';

interface FakeRun {
    id: number;
    name: string;
    event: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    workflow_id: number;
    pull_requests: Array<{ number: number }>;
}

interface GitHubOptions {
    /** Runs stay `in_progress` after a cancel request, like GitHub's asynchronous cancellation. */
    asyncCancellation?: boolean;
    cancelStatus?: number;
    /** Fails every cancel request after this many successful ones. */
    failCancelAfter?: number;
    rerunStatus?: number;
    prState?: string;
    headSha?: string;
}

function run(overrides: Partial<FakeRun> & { id: number }): FakeRun {
    return {
        name: `check-${overrides.id}`,
        event: 'pull_request',
        status: 'in_progress',
        conclusion: null,
        head_sha: HEAD,
        workflow_id: overrides.id,
        pull_requests: [{ number: TARGET.pullRequestNumber }],
        ...overrides,
    };
}

function createGitHub(runs: FakeRun[], options: GitHubOptions = {}) {
    const calls: Array<{ route: string; runId?: number }> = [];
    let cancels = 0;
    const error = (status: number) => Object.assign(new Error(`status ${status}`), { status });
    const octokit = {
        request: async (route: string, parameters: Record<string, unknown> = {}) => {
            const runId = parameters.run_id as number | undefined;
            calls.push({ route, runId });
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { state: options.prState ?? 'open', head: { sha: options.headSha ?? HEAD } } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
                return { data: { workflow_runs: runs.filter(candidate => candidate.head_sha === parameters.head_sha) } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
                const found = runs.find(candidate => candidate.id === runId);
                if (!found) throw error(404);
                return { data: found };
            }
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel') {
                if (options.cancelStatus) throw error(options.cancelStatus);
                if (options.failCancelAfter !== undefined && cancels++ >= options.failCancelAfter) throw error(500);
                const found = runs.find(candidate => candidate.id === runId)!;
                if (!options.asyncCancellation) {
                    found.status = 'completed';
                    found.conclusion = 'cancelled';
                }
                return { data: {} };
            }
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun') {
                if (options.rerunStatus) throw error(options.rerunStatus);
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                return { data: {} };
            }
            throw new Error(`unexpected route ${route}`);
        },
    };
    return {
        octokit,
        calls,
        cancelled: () => calls.filter(call => call.route.endsWith('/cancel')).map(call => call.runId),
        rerun: () => calls.filter(call => call.route.endsWith('/rerun')).map(call => call.runId),
    };
}

function deps(github: ReturnType<typeof createGitHub>, overrides: Record<string, unknown> = {}) {
    return {
        octokit: github.octokit,
        database,
        isEnabled: async () => true,
        restoreBudgetMs: 0,
        pollIntervalMs: 0,
        sleep: async () => undefined,
        ...overrides,
    } as never;
}

async function records() {
    return database(PR_CI_SUSPENSIONS_TABLE).select('*');
}

beforeEach(async () => {
    await database(PR_CI_SUSPENSIONS_TABLE).delete();
});

after(async () => {
    await database.destroy();
});

describe('follow-up CI suspension targeting', () => {
    test('cancels only the validation GitHub associates with the captured pull request and head', async () => {
        const runs = [
            run({ id: 1 }),
            run({ id: 2, status: 'queued' }),
            run({ id: 3, event: 'push', pull_requests: [] }),
            run({ id: 4, event: 'release', pull_requests: [] }),
            run({ id: 5, event: 'workflow_dispatch', pull_requests: [] }),
            run({ id: 6, event: 'deployment', pull_requests: [] }),
            run({ id: 7, pull_requests: [{ number: 9999 }] }),
            run({ id: 8, pull_requests: [] }),
            run({ id: 9, head_sha: NEW_HEAD }),
            run({ id: 10, status: 'completed', conclusion: 'success' }),
            run({ id: 11, event: 'pull_request_target', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.suspended, true);
        assert.deepEqual(result.cancelledRunIds.sort((a, b) => a - b), [1, 2, 11]);
        assert.deepEqual(github.cancelled().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 11]);
        const [record] = await records();
        assert.equal(record.repository, 'integry/propr');
        assert.equal(record.pull_request, TARGET.pullRequestNumber);
        assert.equal(record.head_sha, HEAD);
        assert.equal(record.task_id, TASK_ID);
        assert.deepEqual(JSON.parse(record.cancelled_runs).map((entry: { id: number }) => entry.id), [1, 2, 11]);
    });

    test('never qualifies a run by branch name alone', () => {
        const branchOnly = {
            id: 1, event: 'pull_request', status: 'queued', head_sha: HEAD, pull_requests: [],
        };
        assert.equal(isCancelableValidationRun(branchOnly, { pullRequestNumber: 2485, headSha: HEAD }), false);
        assert.equal(
            isCancelableValidationRun({ ...branchOnly, pull_requests: [{ number: 2485 }] }, { pullRequestNumber: 2485, headSha: HEAD }),
            true,
        );
    });

    test('routes a continuation to its own pull request and skips a reservation without one', () => {
        const ref = { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 2485 };
        assert.deepEqual(resolveFollowupCiSuspensionTarget(ref), { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 });
        assert.deepEqual(
            resolveFollowupCiSuspensionTarget(ref, { repository: 'integry/propr', continuation_pr: 2500 }),
            { owner: 'integry', repo: 'propr', pullRequestNumber: 2500 },
        );
        assert.equal(resolveFollowupCiSuspensionTarget(ref, { repository: 'integry/propr', continuation_pr: null }), null);
    });

    test('does not touch GitHub when the repository opted out', async () => {
        const github = createGitHub([run({ id: 1 })]);

        const result = await beginFollowupCiSuspension(
            { target: TARGET, taskId: TASK_ID },
            deps(github, { isEnabled: async () => false }),
        );

        assert.deepEqual(result, { suspended: false, reason: 'disabled', cancelledRunIds: [] });
        assert.equal(github.calls.length, 0);
        assert.deepEqual(await records(), []);
    });

    test('keeps implementation running and records nothing when Actions write access is missing', async () => {
        const github = createGitHub([run({ id: 1 })], { cancelStatus: 403 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'permission_denied');
        assert.equal(result.suspended, false);
        assert.deepEqual(await records(), []);
    });

    test('keeps the restore obligation for runs cancelled before a failure', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs, { failCancelAfter: 1 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'error');
        const [record] = await records();
        assert.deepEqual(JSON.parse(record.cancelled_runs).map((entry: { id: number }) => entry.id), [1]);

        // Reconciliation owns the interrupted suspension and restarts what was cancelled.
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('does not suspend a pull request that is no longer open', async () => {
        const github = createGitHub([run({ id: 1 })], { prState: 'closed' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'head_unavailable');
        assert.deepEqual(github.cancelled(), []);
        assert.deepEqual(await records(), []);
    });
});

describe('follow-up CI suspension while implementation runs', () => {
    test('cancels a run that GitHub queued after the suspension started', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs.push(run({ id: 2, status: 'queued' }));
        const [record] = await records();
        const swept = await sweepFollowupCiSuspension(record, deps(github));

        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, [2]);
        const [updated] = await records();
        assert.deepEqual(JSON.parse(updated.cancelled_runs).map((entry: { id: number }) => entry.id), [1, 2]);
    });

    test('releases the suspension and leaves the new head validated once a replacement is published', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const published = createGitHub(runs, { headSha: NEW_HEAD });
        const [record] = await records();
        const swept = await sweepFollowupCiSuspension(record, deps(published));

        assert.equal(swept.reason, 'head_replaced');
        assert.deepEqual(published.cancelled(), []);
        assert.deepEqual(await records(), []);
        assert.equal(runs.find(candidate => candidate.id === 2)!.status, 'queued');
    });
});

describe('restoring cancelled validation', () => {
    test('restarts the cancelled runs when implementation produced no replacement commit', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds.sort((a, b) => a - b), [1, 2]);
        assert.deepEqual(await records(), []);
        assert.deepEqual(runs.map(candidate => candidate.status), ['queued', 'queued']);
    });

    test('does not restart an obsolete revision', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const published = createGitHub(runs, { headSha: NEW_HEAD });
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(published));

        assert.equal(result.reason, 'head_replaced');
        assert.deepEqual(published.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('waits for asynchronous cancellation and finishes the restart on a later reconciliation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [pending] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(pending.reason, 'pending');
        assert.deepEqual(github.rerun(), []);
        const [stored] = await records();
        assert.equal(stored.state, 'restoring');
        assert.equal(stored.attempts, 1);

        // GitHub finishes the cancellation; the owning task is gone after a restart.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('never restarts a run that produced its own result before the cancellation landed', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs[0].status = 'completed';
        runs[0].conclusion = 'failure';
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('does not duplicate validation that GitHub already restarted', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // The run completed as cancelled, and a fresh run of the same workflow is queued.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        runs.push(run({ id: 99, workflow_id: 1, status: 'queued' }));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
    });
});

describe('follow-up CI suspension reconciliation', () => {
    test('sweeps while the owning task is still implementing', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs.push(run({ id: 2, status: 'queued' }));

        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'claude_execution' }) }));

        assert.equal(summary.swept, 1);
        assert.deepEqual(github.cancelled(), [1, 2]);
        assert.equal((await records()).length, 1);
    });

    test('restores the suspension of a task that never reported a terminal state', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // A crashed worker leaves no task state behind.
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('restores the suspension when the repository option is disabled mid-task', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const summary = await reconcileFollowupCiSuspensions(deps(github, {
            isEnabled: async () => false,
            getTaskState: async () => ({ state: 'claude_execution' }),
        }));

        assert.equal(summary.released, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('a repeated reconciliation pass restarts nothing twice', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'completed' }) }));
        const second = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => ({ state: 'completed' }) }));

        assert.equal(second.scanned, 0);
        assert.deepEqual(github.rerun(), [1]);
    });

    test('replaces an obsolete suspension of the same pull request instead of restarting it', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // A second follow-up starts after a replacement commit was published.
        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const next = createGitHub(runs, { headSha: NEW_HEAD });
        await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' }, deps(next));

        const stored = await records();
        assert.equal(stored.length, 1);
        assert.equal(stored[0].head_sha, NEW_HEAD);
        assert.equal(stored[0].task_id, 'task-next');
        assert.deepEqual(JSON.parse(stored[0].cancelled_runs).map((entry: { id: number }) => entry.id), [2]);
        assert.deepEqual(next.rerun(), []);
    });
});

describe('follow-up CI suspension lifecycle wiring', () => {
    test('only the authorized implementation path suspends validation, and every exit releases it', async () => {
        const job = await readFile(new URL('../src/jobs/processPullRequestCommentJob.ts', import.meta.url), 'utf8');
        const reviewJob = await readFile(new URL('../src/jobs/prCommentReviewJob.ts', import.meta.url), 'utf8');
        const cleanup = await readFile(new URL('../src/jobs/prCommentJobUtils.ts', import.meta.url), 'utf8');

        assert.equal(reviewJob.includes('FollowupCiSuspension'), false, 'review processing must never cancel checks');
        const labelGate = job.indexOf("reason: 'missing_required_label'");
        const authorizedFindings = job.indexOf("reason: 'no_authorized_review_findings'");
        const begin = job.indexOf('await suspendObsoleteValidationForImplementation(');
        assert.ok(labelGate > 0, 'the label authorization gate is still in place');
        assert.ok(authorizedFindings > 0, 'the /fix authorization gate is still in place');
        assert.ok(begin > authorizedFindings, 'suspension must follow instruction filtering and authorization');
        // cleanupJob runs in the job's finally for success, failure and cancellation.
        assert.ok(cleanup.includes('releaseFollowupCiSuspensionsForTask'), 'job cleanup releases the suspension');
        assert.ok(job.includes('await cleanupJob({ stateManager, lockKey, lockToken, taskId'), 'cleanup receives the owning task');
    });
});
