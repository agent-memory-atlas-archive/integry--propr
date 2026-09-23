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
    isEligibleValidationWorkflow,
    loadValidationWorkflowPolicy,
    PR_CI_SUSPENSIONS_TABLE,
    reconcileFollowupCiSuspensions,
    releaseFollowupCiSuspensionsForTask,
    resolveFollowupCiSuspensionTarget,
    restoreFollowupCiSuspension,
    sweepFollowupCiSuspension,
    VALIDATION_WORKFLOW_ALLOWLIST_ENV,
} = await import('../src/jobs/followupCiSuspension.ts');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TARGET = { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 };
const TASK_ID = 'task-2485';

interface FakeRun {
    id: number;
    name: string;
    path: string;
    event: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    workflow_id: number;
    run_attempt: number;
    pull_requests: Array<{ number: number }>;
}

interface GitHubOptions {
    /** Runs stay `in_progress` after a cancel request, like GitHub's asynchronous cancellation. */
    asyncCancellation?: boolean;
    cancelStatus?: number;
    /** Fails every cancel request after this many successful ones. */
    failCancelAfter?: number;
    rerunStatus?: number;
    /** Runs after the cancel was applied; throwing here simulates a response lost on the way back. */
    onCancel?: (runId: number) => Promise<void>;
    /** Runs instead of the normal rerun handling; throwing simulates a lost rerun response. */
    onRerun?: (runId: number) => Promise<void>;
    /** Runs before every request, so a test can move the head while an operation waits. */
    onRequest?: (route: string) => Promise<void> | void;
    prState?: string;
    headSha?: string;
    /** Runs returned per page, to exercise pagination. */
    perPage?: number;
}

function run(overrides: Partial<FakeRun> & { id: number }): FakeRun {
    return {
        name: `check-${overrides.id}`,
        path: `.github/workflows/check-${overrides.id}.yml`,
        event: 'pull_request',
        status: 'in_progress',
        conclusion: null,
        head_sha: HEAD,
        workflow_id: overrides.id,
        run_attempt: 1,
        pull_requests: [{ number: TARGET.pullRequestNumber }],
        ...overrides,
    };
}

function createGitHub(runs: FakeRun[], options: GitHubOptions = {}) {
    const calls: Array<{ route: string; runId?: number }> = [];
    let cancels = 0;
    const head = { sha: options.headSha ?? HEAD, state: options.prState ?? 'open' };
    const error = (status: number) => Object.assign(new Error(`status ${status}`), { status });
    const octokit = {
        request: async (route: string, parameters: Record<string, unknown> = {}) => {
            const runId = parameters.run_id as number | undefined;
            calls.push({ route, runId });
            await options.onRequest?.(route);
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { state: head.state, head: { sha: head.sha } } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
                const matching = runs.filter(candidate => candidate.head_sha === parameters.head_sha);
                const perPage = options.perPage ?? (parameters.per_page as number);
                const page = (parameters.page as number) ?? 1;
                return {
                    data: {
                        total_count: matching.length,
                        workflow_runs: matching.slice((page - 1) * perPage, page * perPage),
                    },
                };
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
                await options.onCancel?.(runId!);
                return { data: {} };
            }
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun') {
                if (options.rerunStatus) throw error(options.rerunStatus);
                if (options.onRerun) await options.onRerun(runId!);
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                return { data: {} };
            }
            throw new Error(`unexpected route ${route}`);
        },
    };
    return {
        octokit,
        calls,
        head,
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

async function storedRunIds(): Promise<number[]> {
    const [record] = await records();
    return record ? JSON.parse(record.cancelled_runs).map((entry: { id: number }) => entry.id) : [];
}

beforeEach(async () => {
    await database(PR_CI_SUSPENSIONS_TABLE).delete();
});

after(async () => {
    await database.destroy();
});

describe('follow-up CI suspension targeting', () => {
    test('cancels only the eligible validation GitHub associates with the captured pull request and head', async () => {
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
            // A pull request event on a workflow that deploys is not validation.
            run({ id: 11, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
            run({ id: 12, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.suspended, true);
        assert.deepEqual(result.cancelledRunIds.sort((a, b) => a - b), [1, 2, 12]);
        assert.deepEqual(github.cancelled().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 12]);
        const [record] = await records();
        assert.equal(record.repository, 'integry/propr');
        assert.equal(record.pull_request, TARGET.pullRequestNumber);
        assert.equal(record.head_sha, HEAD);
        assert.equal(record.task_id, TASK_ID);
        assert.deepEqual(await storedRunIds(), [1, 2, 12]);
    });

    test('never qualifies a run by branch name alone', () => {
        const branchOnly = {
            id: 1, name: 'Build & Lint Check', event: 'pull_request', status: 'queued', head_sha: HEAD, pull_requests: [],
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
        // Run 1 was cancelled; run 2's cancel failed ambiguously, so its intent is
        // kept too and the run's own outcome decides what it needs.
        assert.deepEqual(await storedRunIds(), [1, 2]);

        // Run 2 was never actually cancelled and finishes on its own.
        runs[1].status = 'completed';
        runs[1].conclusion = 'failure';
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('stores the run before GitHub receives its cancellation, so a lost response cannot lose it', async () => {
        const runs = [run({ id: 1 })];
        const seenWhenGitHubCancelled: number[][] = [];
        const github = createGitHub(runs, {
            onCancel: async runId => {
                // GitHub accepted the cancellation; whatever the worker does next, the
                // obligation must already be durable at this exact moment.
                seenWhenGitHubCancelled.push(await storedRunIds());
                // ...and then the response never makes it back, followed by a crash.
                throw Object.assign(new Error(`socket hang up while cancelling ${runId}`), { code: 'ECONNRESET' });
            },
        });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'error');
        assert.deepEqual(seenWhenGitHubCancelled, [[1]], 'the run id was stored before GitHub received the cancel request');
        assert.deepEqual(await storedRunIds(), [1]);

        // After the restart, reconciliation finds the cancelled run and restores it.
        const afterRestart = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(afterRestart, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(afterRestart.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('discovers runs beyond the first page of the Actions API', async () => {
        const runs = Array.from({ length: 105 }, (_, index) => run({ id: index + 1, status: 'queued' }));
        const github = createGitHub(runs, { perPage: 100 });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.cancelledRunIds.length, 105);
        assert.equal(github.cancelled().length, 105);
        assert.equal((await storedRunIds()).length, 105);
    });

    test('does not suspend a pull request that is no longer open', async () => {
        const github = createGitHub([run({ id: 1 })], { prState: 'closed' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'head_unavailable');
        assert.deepEqual(github.cancelled(), []);
        assert.deepEqual(await records(), []);
    });
});

describe('eligible validation workflows', () => {
    const eligible = (workflow: { name: string; path: string; event?: string }, policy?: unknown) =>
        isEligibleValidationWorkflow({ event: 'pull_request', ...workflow }, policy as never);

    test('accepts this repository\'s pull request validation workflows', () => {
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }), true);
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }), true);
        assert.equal(eligible({ name: 'CodeQL', path: '.github/workflows/codeql.yml' }), true);
        assert.equal(eligible({ name: 'Dependency Review', path: '.github/workflows/dependency-review.yml' }), true);
        assert.equal(eligible({ name: 'CLI Node Compatibility', path: '.github/workflows/cli-node-compatibility.yml' }), true);
        assert.equal(eligible({ name: 'Desktop Package and Release', path: '.github/workflows/desktop-release-guard.yml' }), true);
    });

    test('never accepts a preview or deployment workflow, whichever pull request event it uses', () => {
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target' }), false);
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }), false);
        assert.equal(eligible({ name: 'Deploy to Staging', path: '.github/workflows/deploy-staging.yml' }), false);
        assert.equal(eligible({ name: 'Publish Preview Images', path: '.github/workflows/preview-runtime-images.yml' }), false);
        // A `pull_request_target` workflow is never qualified by its event alone.
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', event: 'pull_request_target' }), false);
        // Neither is a workflow that says nothing about validating the revision.
        assert.equal(eligible({ name: 'Label Sync', path: '.github/workflows/label-sync.yml' }), false);
    });

    test('an explicit allowlist decides on its own, by name, path or file name', () => {
        const policy = loadValidationWorkflowPolicy({
            [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'Label Sync, pr-preview.yml , .github/workflows/pr-test-on-label.yml',
        });
        assert.equal(eligible({ name: 'Label Sync', path: '.github/workflows/label-sync.yml' }, policy), true);
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }, policy), true);
        // Listed deliberately, including its `pull_request_target` event.
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target' }, policy), true);
        // Everything the operator did not list stays out, defaults included.
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, policy), false);
    });

    test('cancels exactly the allowlisted workflow of a pull request head', async () => {
        const runs = [
            run({ id: 1, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', status: 'queued' }),
            run({ id: 2, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
        ];
        const github = createGitHub(runs);
        const policy = loadValidationWorkflowPolicy({ [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'pr-preview.yml' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, { workflowPolicy: policy }));

        assert.deepEqual(result.cancelledRunIds, [2]);
        assert.deepEqual(await storedRunIds(), [2]);
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
        assert.deepEqual(await storedRunIds(), [1, 2]);
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

    test('does not restart a revision that was replaced while the restart waited for cancellation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        // The implementation publishes its replacement commit while the cancelled
        // run is still finishing, between two polls of the restore.
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github, {
            restoreBudgetMs: 60_000,
            sleep: async () => { github.head.sha = NEW_HEAD; },
        }));

        assert.equal(result.reason, 'head_replaced');
        assert.deepEqual(github.rerun(), []);
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

    test('a rerun whose response was lost is not requested again once the run proves it restarted', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, {
            asyncCancellation: true,
            // GitHub queues the run again and the response is lost on the way back.
            onRerun: async runId => {
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'the lost response is reconciled from the run itself, not retried blindly');
        assert.deepEqual(await records(), []);
    });

    test('keeps the obligation when a failed rerun left no evidence that it landed', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pending');
        assert.deepEqual(result.pendingRunIds, [1]);
        const [stored] = await records();
        assert.equal(stored.state, 'restoring');
        assert.deepEqual(JSON.parse(stored.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false]);
    });
});

describe('concurrent owners of one pull request suspension', () => {
    test('a sweep never re-cancels validation that is already being restored', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();

        // The finalizer starts the release; the cancellation is still finishing, so
        // the suspension stays behind in the one-way restoring state.
        const [pending] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(pending.reason, 'pending');

        // The recovery pass still holds the record as it read it before the release.
        runs.push(run({ id: 2, status: 'queued' }));
        const swept = await sweepFollowupCiSuspension(active, deps(github));

        assert.equal(swept.reason, 'superseded');
        assert.deepEqual(swept.cancelledRunIds, []);
        assert.deepEqual(github.cancelled(), [1], 'the late run is left alone while the suspension is being released');
        assert.deepEqual(await storedRunIds(), [1]);
    });

    test('interleaved sweep and release of the same pull request never cancel after restarting', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        const [swept, released] = await Promise.all([
            sweepFollowupCiSuspension(active, deps(github)),
            releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github)),
        ]);

        assert.equal(swept.reason, 'swept');
        assert.equal(released[0].reason, 'restarted');
        const lastCancel = github.calls.map(call => call.route).lastIndexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel');
        const firstRerun = github.calls.map(call => call.route).indexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun');
        assert.ok(lastCancel < firstRerun, 'the two operations ran one after the other, not interleaved');
        assert.deepEqual(github.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2], 'everything the sweep cancelled was restarted');
        assert.deepEqual(await records(), []);
    });

    test('a stale record can neither overwrite nor delete the suspension of a new owner', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [stale] = await records();

        // A replacement commit is published and a second follow-up takes the pull request over.
        runs.push(run({ id: 2, head_sha: NEW_HEAD, status: 'queued' }));
        const next = createGitHub(runs, { headSha: NEW_HEAD });
        await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' }, deps(next));

        // The first task's finalizer and the recovery pass arrive late with what they read.
        const late = createGitHub(runs, { headSha: NEW_HEAD });
        const swept = await sweepFollowupCiSuspension(stale, deps(late));
        const restored = await restoreFollowupCiSuspension(stale, deps(late));

        assert.equal(swept.reason, 'superseded');
        assert.equal(restored.reason, 'superseded');
        assert.deepEqual(late.rerun(), []);
        assert.deepEqual(late.cancelled(), []);
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.equal(current.state, 'active');
        assert.deepEqual(await storedRunIds(), [2]);
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
        assert.deepEqual(await storedRunIds(), [2]);
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
