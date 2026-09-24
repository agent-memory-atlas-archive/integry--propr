import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import knex from 'knex';
import { readFile } from 'node:fs/promises';
import { up } from '../packages/core/src/db/migrations/20260923010000_add_pr_ci_suspensions.js';
import { up as createLeases } from '../packages/core/src/db/migrations/20260923020000_add_pr_ci_suspension_leases.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
await createLeases(database);

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        getAuthenticatedOctokit: async () => { throw new Error('the test must inject its own Octokit'); },
        getStateManager: () => ({ getTaskState: async () => null }),
        isCancelCiDuringFollowupEnabledForRepository: async () => true,
        getCancelCiDuringFollowupWorkflowsForRepository: async () => [],
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
    },
});

const {
    beginFollowupCiSuspension,
    createValidationWorkflowPolicy,
    isCancelableValidationRun,
    isEligibleValidationWorkflow,
    loadValidationWorkflowPolicyFromEnv,
    MAX_RESTORE_ATTEMPTS,
    PR_CI_SUSPENSION_LEASES_TABLE,
    PR_CI_SUSPENSIONS_TABLE,
    reconcileFollowupCiSuspensions,
    releaseFollowupCiSuspensionsForTask,
    resolveFollowupCiSuspensionTarget,
    resolveValidationWorkflowPolicy,
    restoreFollowupCiSuspension,
    sweepFollowupCiSuspension,
    VALIDATION_WORKFLOW_ALLOWLIST_ENV,
} = await import('../src/jobs/followupCiSuspension.ts');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TARGET = { owner: 'integry', repo: 'propr', pullRequestNumber: 2485 };
const TASK_ID = 'task-2485';
/** The workflow the operator selected in most tests. Everything else is deliberately not selected. */
const VALIDATION_WORKFLOW = { name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' };
const SELECTED_WORKFLOWS = ['pr-build-check.yml'];

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
    /** Fails the pull request lookup itself, the way a repository the installation lost access to answers 404. */
    prStatus?: number;
    headSha?: string;
    /** Runs returned per page, to exercise pagination. */
    perPage?: number;
    /** Shared, ordered record of what every coordinator asked GitHub, across clients. */
    journal?: Array<{ coordinator: string; route: string; runId?: number }>;
    coordinator?: string;
}

function run(overrides: Partial<FakeRun> & { id: number }): FakeRun {
    return {
        name: VALIDATION_WORKFLOW.name,
        path: VALIDATION_WORKFLOW.path,
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
            options.journal?.push({ coordinator: options.coordinator ?? 'default', route, runId });
            await options.onRequest?.(route);
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                if (options.prStatus) throw error(options.prStatus);
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
        loadSelectedWorkflows: async () => SELECTED_WORKFLOWS,
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
    await database(PR_CI_SUSPENSION_LEASES_TABLE).delete();
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
            // Nobody selected these two, whatever their names suggest they do.
            run({ id: 11, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
            run({ id: 12, name: 'CI', path: '.github/workflows/ci.yml', status: 'queued' }),
            run({ id: 13, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => ['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml'],
        }));

        assert.equal(result.suspended, true);
        assert.deepEqual(result.cancelledRunIds.sort((a, b) => a - b), [1, 2, 13]);
        assert.deepEqual(github.cancelled().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 13]);
        const [record] = await records();
        assert.equal(record.repository, 'integry/propr');
        assert.equal(record.pull_request, TARGET.pullRequestNumber);
        assert.equal(record.head_sha, HEAD);
        assert.equal(record.task_id, TASK_ID);
        assert.deepEqual(await storedRunIds(), [1, 2, 13]);
    });

    test('never qualifies a run by branch name alone', () => {
        const policy = createValidationWorkflowPolicy(['build & lint check'], 'repository');
        const branchOnly = {
            id: 1, name: 'Build & Lint Check', event: 'pull_request', status: 'queued', head_sha: HEAD, pull_requests: [],
        };
        assert.equal(isCancelableValidationRun(branchOnly, { pullRequestNumber: 2485, headSha: HEAD, policy }), false);
        assert.equal(
            isCancelableValidationRun({ ...branchOnly, pull_requests: [{ number: 2485 }] }, { pullRequestNumber: 2485, headSha: HEAD, policy }),
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

    test('a refused retry keeps the restart obligations its previous attempt left behind', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        // GitHub accepts both cancellations; cancelling is asynchronous, so the
        // runs are still finishing when the job is redelivered.
        const first = createGitHub(runs, { asyncCancellation: true });
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(first));
        assert.deepEqual(begun.cancelledRunIds, [1, 2]);

        // The retry runs after the installation lost Actions write access.
        const retried = createGitHub(runs, { asyncCancellation: true, cancelStatus: 403 });
        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(retried));

        assert.equal(result.reason, 'permission_denied');
        // The refusal proves this attempt cancelled nothing. It proves nothing
        // about the two cancellations GitHub already accepted.
        assert.deepEqual(await storedRunIds(), [1, 2]);
        const [stored] = await records();
        assert.deepEqual(JSON.parse(stored.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);

        // GitHub finishes both cancellations; the obligation is still there to honour.
        runs.forEach(candidate => { candidate.status = 'completed'; candidate.conclusion = 'cancelled'; });
        const recovery = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovery, { getTaskState: async () => null }));
        assert.equal(summary.restored, 1);
        assert.deepEqual(recovery.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
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

describe('selected validation workflows', () => {
    const eligible = (workflow: { name: string; path: string; event?: string; workflow_id?: number }, policy?: unknown) =>
        isEligibleValidationWorkflow({ event: 'pull_request', ...workflow }, policy as never);

    test('accepts only the workflows an operator selected, by name, path, file name or ID', () => {
        const policy = createValidationWorkflowPolicy(
            ['Full Test Suite', ' PR-BUILD-CHECK.YML ', '.github/workflows/codeql.yml', 'dependency-review', '425'],
            'repository',
        );
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }, policy), true);
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, policy), true);
        assert.equal(eligible({ name: 'CodeQL', path: '.github/workflows/codeql.yml' }, policy), true);
        assert.equal(eligible({ name: 'Dependency Review', path: '.github/workflows/dependency-review.yml' }, policy), true);
        assert.equal(eligible({ name: 'Nightly', path: '.github/workflows/nightly.yml', workflow_id: 425 }, policy), true);
        // A selected workflow stays selected on the event its operator chose it for.
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', event: 'pull_request_target' }, policy), true);
        // ...but never outside a pull request.
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', event: 'push' }, policy), false);
    });

    test('never infers permission to cancel a workflow from its name', () => {
        const policy = createValidationWorkflowPolicy(['pr-build-check.yml'], 'repository');
        // A `Build`/`CI` workflow is free to deploy; only an operator knows.
        assert.equal(eligible({ name: 'CI', path: '.github/workflows/ci.yml' }, policy), false);
        assert.equal(eligible({ name: 'Build', path: '.github/workflows/build.yml' }, policy), false);
        assert.equal(eligible({ name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml' }, policy), false);
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target' }, policy), false);
        // Substrings are not identities: selecting one workflow selects exactly it.
        assert.equal(eligible({ name: 'PR Build Check (matrix)', path: '.github/workflows/pr-build-check-matrix.yml' }, policy), false);
    });

    test('selects nothing at all while nothing was selected', () => {
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }), false);
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, resolveValidationWorkflowPolicy([], {})), false);
        assert.equal(resolveValidationWorkflowPolicy(undefined, {}).source, 'none');
        assert.equal(resolveValidationWorkflowPolicy(['  ', ''], {}).selected.size, 0);
    });

    test('the repository selection wins over the documented environment fallback', () => {
        const env = { [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'pr-preview.yml' };
        const repository = resolveValidationWorkflowPolicy(['pr-build-check.yml'], env);
        assert.equal(repository.source, 'repository');
        assert.equal(eligible({ name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml' }, repository), true);
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }, repository), false);

        const fallback = resolveValidationWorkflowPolicy([], env);
        assert.equal(fallback.source, 'environment');
        assert.equal(eligible({ name: 'PR Preview', path: '.github/workflows/pr-preview.yml' }, fallback), true);
        assert.equal(loadValidationWorkflowPolicyFromEnv({}).selected.size, 0);
    });

    test('an unselected CI workflow that deploys keeps running while the selected validation is cancelled', async () => {
        const runs = [
            // Named like validation, deploys in reality, and nobody selected it.
            run({ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'queued' }),
            run({ id: 2, name: 'Build', path: '.github/workflows/build-and-deploy.yml', status: 'queued' }),
            run({ id: 3, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
            run({ id: 4, name: 'Full Test Suite', path: '.github/workflows/pr-test-on-label.yml', status: 'queued' }),
        ];
        const github = createGitHub(runs);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => ['pr-test-on-label.yml'],
        }));

        assert.deepEqual(result.cancelledRunIds, [4], 'only the selected validation workflow was cancelled');
        assert.deepEqual(github.cancelled(), [4]);
        assert.deepEqual(await storedRunIds(), [4]);
        assert.deepEqual(runs.filter(candidate => candidate.id !== 4).map(candidate => candidate.status), ['queued', 'queued', 'queued']);
    });

    test('cancels nothing and records nothing while the repository selected no workflows', async () => {
        const github = createGitHub([run({ id: 1 })]);

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, {
            loadSelectedWorkflows: async () => [],
        }));

        assert.equal(result.reason, 'no_workflows_selected');
        assert.equal(result.suspended, false);
        assert.deepEqual(github.calls, [], 'an empty selection never even asks GitHub for the runs');
        assert.deepEqual(await records(), []);
    });

    test('falls back to the documented environment selection when the repository selected nothing', async () => {
        const runs = [
            run({ id: 1, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', status: 'queued' }),
            run({ id: 2, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' }),
        ];
        const github = createGitHub(runs);
        const policy = resolveValidationWorkflowPolicy([], { [VALIDATION_WORKFLOW_ALLOWLIST_ENV]: 'pr-preview.yml' });

        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github, { workflowPolicy: policy }));

        assert.deepEqual(result.cancelledRunIds, [2]);
        assert.deepEqual(await storedRunIds(), [2]);
    });

    test('an unreadable repository selection cancels nothing, and never falls back to the environment', async () => {
        const previous = process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV];
        process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] = 'pr-preview.yml';
        try {
            const runs = [run({ id: 1, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', event: 'pull_request_target', status: 'queued' })];
            const unreadable = createGitHub(runs);

            // The stored selection could not be read: the repository may well have
            // selected workflows other than the fallback's, so nothing is cancelled.
            const skipped = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(unreadable, {
                loadSelectedWorkflows: async () => null,
            }));

            assert.equal(skipped.suspended, false);
            assert.equal(skipped.reason, 'selection_unreadable');
            assert.deepEqual(unreadable.cancelled(), []);
            assert.deepEqual(unreadable.calls, [], 'an unreadable selection never even asks GitHub for the runs');
            assert.deepEqual(await records(), []);
            assert.equal(runs[0].status, 'queued');

            // A selection that was read and is genuinely empty still uses the fallback.
            const readable = createGitHub(runs);
            const fallback = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(readable, {
                loadSelectedWorkflows: async () => [],
            }));

            assert.deepEqual(fallback.cancelledRunIds, [1]);
            assert.deepEqual(await storedRunIds(), [1]);
        } finally {
            if (previous === undefined) delete process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV];
            else process.env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] = previous;
        }
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

    test('a run of another event or another pull request never stands in for the cancelled validation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        // Same workflow and same commit, but neither run validates this pull
        // request: the push run skips everything the pull request event checks.
        runs.push(run({ id: 98, workflow_id: 1, status: 'queued', event: 'push', pull_requests: [] }));
        runs.push(run({ id: 97, workflow_id: 1, status: 'queued', pull_requests: [{ number: 9999 }] }));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(result.restartedRunIds, [1]);
        assert.deepEqual(github.rerun(), [1], 'the cancelled pull request validation was brought back itself');
        assert.deepEqual(await records(), []);
    });

    test('a refused rerun keeps the obligation and restores the checks once access is granted back', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const denied = createGitHub(runs, { rerunStatus: 403 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(denied));

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(denied));

        assert.equal(result.reason, 'permission_denied');
        assert.deepEqual(result.pendingRunIds, [1, 2]);
        // The checks ProPR cancelled are still cancelled, so the obligation to
        // bring them back must survive the refusal.
        const [blocked] = await records();
        assert.equal(blocked.state, 'blocked');
        assert.deepEqual(await storedRunIds(), [1, 2]);
        assert.deepEqual(JSON.parse(blocked.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);
        // A refusal never reached GitHub, so it must not spend the restart budget.
        assert.equal(blocked.attempts, 0);

        // Actions access is granted back; the next reconciliation honours the obligation.
        const restored = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(restored, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(restored.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
        assert.deepEqual(await records(), []);
    });

    test('a refused rerun releases its obligation once the cancelled head is obsolete', async () => {
        const runs = [run({ id: 1 })];
        const denied = createGitHub(runs, { rerunStatus: 403 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(denied));
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(denied));
        assert.equal(result.reason, 'permission_denied');
        assert.equal((await records())[0].state, 'blocked');

        // A replacement commit is published: the cancelled revision is obsolete.
        const replaced = createGitHub(runs, { headSha: NEW_HEAD, rerunStatus: 403 });
        const summary = await reconcileFollowupCiSuspensions(deps(replaced, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.deepEqual(replaced.rerun(), []);
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

    test('an attempt a crashed pass already restarted is never rerun again, even once its newer attempt was cancelled', async () => {
        const runs = [run({ id: 1 })];
        let workerDied = false;
        const github = createGitHub(runs, {
            onRerun: async runId => {
                // GitHub accepts the rerun and starts attempt 2. The worker dies right
                // there: neither the response nor any evidence reaches it, so the
                // record still says attempt 1 was cancelled and never restarted.
                const found = runs.find(candidate => candidate.id === runId)!;
                found.status = 'queued';
                found.conclusion = null;
                found.run_attempt += 1;
                workerDied = true;
                throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            },
            onRequest: async route => {
                if (workerDied && route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') throw Object.assign(new Error('worker died'), { status: 500 });
            },
        });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [crashed] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));
        assert.equal(crashed.reason, 'pending');
        const [stored] = await records();
        assert.deepEqual(
            JSON.parse(stored.cancelled_runs).map((entry: { attempt: number; restarted: boolean }) => [entry.attempt, entry.restarted]),
            [[1, false]], 'the crash left the original obligation recorded against attempt 1');
        assert.equal(runs[0].run_attempt, 2);
        workerDied = false;

        // Somebody at GitHub cancels the restarted attempt. That is theirs, not
        // ProPR's: the attempt ProPR cancelled was already brought back.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const summary = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.equal(summary.restored, 0);
        assert.deepEqual(github.rerun(), [1], 'the only rerun is the one the crashed pass sent');
        assert.equal(runs[0].run_attempt, 2, 'the cancelled newer attempt is left as it is');
        assert.deepEqual(await records(), [], 'the stored attempt is the proof that the obligation was met');
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

    test('keeps an unresolved obligation after the attempt budget is spent and honours it once GitHub recovers', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const failing = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(failing));
        // Every earlier attempt already failed to reach GitHub's rerun API.
        await database(PR_CI_SUSPENSIONS_TABLE).update({ attempts: MAX_RESTORE_ATTEMPTS - 1 });

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(failing));

        assert.equal(result.reason, 'blocked');
        assert.deepEqual(result.pendingRunIds, [1, 2]);
        // The head is still current and its checks are still cancelled, so the
        // obligation to bring them back must outlive the attempt budget.
        const [retained] = await records();
        assert.equal(retained.state, 'blocked');
        assert.deepEqual(await storedRunIds(), [1, 2]);
        assert.deepEqual(JSON.parse(retained.cancelled_runs).map((entry: { restarted: boolean }) => entry.restarted), [false, false]);

        // GitHub recovers; the retained record is what restores the validation.
        const recovered = createGitHub(runs);
        const summary = await reconcileFollowupCiSuspensions(deps(recovered, { getTaskState: async () => null }));

        assert.equal(summary.restored, 1);
        assert.deepEqual(recovered.rerun().sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2]);
        assert.deepEqual(await records(), []);
    });

    test('a spent attempt budget releases its obligation once the cancelled head is obsolete', async () => {
        const runs = [run({ id: 1 })];
        const failing = createGitHub(runs, { rerunStatus: 500 });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(failing));
        await database(PR_CI_SUSPENSIONS_TABLE).update({ attempts: MAX_RESTORE_ATTEMPTS });
        const [blockedResult] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(failing));
        assert.equal(blockedResult.reason, 'blocked');
        assert.equal((await records())[0].state, 'blocked');

        // A replacement commit is published: the cancelled revision is obsolete,
        // which is the evidence that nothing is owed any more.
        const replaced = createGitHub(runs, { headSha: NEW_HEAD, rerunStatus: 500 });
        const summary = await reconcileFollowupCiSuspensions(deps(replaced, { getTaskState: async () => null }));

        assert.equal(summary.released, 1);
        assert.deepEqual(replaced.rerun(), []);
        assert.deepEqual(await records(), []);
    });

    test('keeps the obligation while the pull request cannot be read, and honours it once it can be again', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();

        // The installation lost access to the private repository: the pull request
        // answers 404 although it is still open, on the very same head.
        const inaccessible = createGitHub(runs, { prStatus: 404 });
        const summary = await reconcileFollowupCiSuspensions(deps(inaccessible, { getTaskState: async () => null }));

        assert.equal(summary.released, 0);
        assert.equal(summary.errors, 0);
        assert.deepEqual(inaccessible.rerun(), []);
        assert.equal((await records()).length, 1, 'a pull request that cannot be seen is not a closed one');
        assert.deepEqual(await storedRunIds(), [1]);

        // Nor does a sweep, while the owner is still implementing, decide anything about a head it cannot see.
        const swept = await sweepFollowupCiSuspension(active, deps(inaccessible));
        assert.equal(swept.reason, 'head_unavailable');
        assert.deepEqual(inaccessible.cancelled(), []);
        assert.equal((await records()).length, 1);

        // Access is granted back and the head is unchanged: the cancelled checks come back.
        const restored = await reconcileFollowupCiSuspensions(deps(github, { getTaskState: async () => null }));

        assert.equal(restored.restored, 1);
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await records(), []);
    });

    test('a pull request that is confirmed closed still releases its obligation', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));

        github.head.state = 'closed';
        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github));

        assert.equal(result.reason, 'pull_request_closed');
        assert.deepEqual(github.rerun(), []);
        assert.deepEqual(await records(), []);
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

describe('coordinators in separate worker processes', () => {
    const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 10); });

    test('a sweep and a release that share only the database never interleave, and nothing is cancelled after a restart', async () => {
        const journal: Array<{ coordinator: string; route: string; runId?: number }> = [];
        const runs = [run({ id: 1 })];
        const setup = createGitHub(runs, { journal, coordinator: 'setup' });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(setup, { leaseHolder: 'worker-a' }));
        // What worker A's reconciliation pass read before it started sweeping.
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        let reachedCancel!: () => void;
        const sweepIsInsideItsCancel = new Promise<void>(resolve => { reachedCancel = resolve; });
        let letSweepFinish!: () => void;
        const sweepMayContinue = new Promise<void>(resolve => { letSweepFinish = resolve; });
        let paused = false;
        const workerA = createGitHub(runs, {
            journal,
            coordinator: 'worker-a',
            onRequest: async route => {
                if (paused || !route.endsWith('/cancel')) return;
                paused = true;
                reachedCancel();
                await sweepMayContinue;
            },
        });
        const workerB = createGitHub(runs, { journal, coordinator: 'worker-b' });

        // Worker A is inside the cancel request for the late run when worker B's
        // job finalizer starts releasing the very same pull request.
        const sweep = sweepFollowupCiSuspension(active, deps(workerA, { leaseHolder: 'worker-a' }));
        await sweepIsInsideItsCancel;
        const release = releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(workerB, { leaseHolder: 'worker-b' }));

        // Nothing but the database is shared, and it is what holds worker B back.
        await tick();
        assert.deepEqual(workerB.calls, [], 'worker B does not touch GitHub while worker A holds the lease');
        const lease = await database(PR_CI_SUSPENSION_LEASES_TABLE).first();
        assert.equal(lease.holder, 'worker-a');
        assert.equal(lease.lease_key, 'integry/propr#2485');

        letSweepFinish();
        const [swept, released] = await Promise.all([sweep, release]);

        assert.equal(swept.reason, 'swept');
        assert.deepEqual(swept.cancelledRunIds, [2]);
        assert.equal(released[0].reason, 'restarted');
        assert.deepEqual(released[0].restartedRunIds.sort((a, b) => a - b), [1, 2], 'everything the sweep cancelled was restarted');

        // Worker A's reconciliation arrives once more with the state it read before
        // any of this: it must not cancel the validation worker B just restarted.
        const late = createGitHub(runs, { journal, coordinator: 'worker-a-late' });
        const lateSweep = await sweepFollowupCiSuspension(active, deps(late, { leaseHolder: 'worker-a' }));

        assert.equal(lateSweep.reason, 'superseded');
        assert.deepEqual(late.cancelled(), []);
        const lastCancel = journal.map(entry => entry.route).lastIndexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel');
        const firstRerun = journal.map(entry => entry.route).indexOf('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun');
        assert.ok(firstRerun > 0 && lastCancel < firstRerun, 'no run was cancelled after a restart had started');
        assert.deepEqual(await records(), []);
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'every holder released its lease');
    });

    test('leaves a pull request alone while another worker holds its lease', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        const [active] = await records();
        runs.push(run({ id: 2, status: 'queued' }));

        // Another worker is in the middle of its own pass over this pull request.
        await database(PR_CI_SUSPENSION_LEASES_TABLE).insert({
            lease_key: 'integry/propr#2485', token: 'other-worker', holder: 'worker-b',
            acquired_at: Date.now(), expires_at: Date.now() + 60_000,
        });

        const busyDeps = deps(github, { leaseAcquireTimeoutMs: 0 });
        const swept = await sweepFollowupCiSuspension(active, busyDeps);
        const restored = await restoreFollowupCiSuspension(active, busyDeps);
        const begun = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, busyDeps);

        assert.equal(swept.reason, 'busy');
        assert.equal(restored.reason, 'busy');
        assert.deepEqual(restored.pendingRunIds, [1], 'the obligation stays with the record for the next pass');
        assert.equal(begun.reason, 'busy');
        assert.deepEqual(github.cancelled(), [1], 'only the original suspension cancelled anything');
        assert.deepEqual(github.rerun(), []);
        // The other worker's lease is untouched, and the record is still there.
        const [lease] = await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*');
        assert.equal(lease.token, 'other-worker');
        assert.equal((await records()).length, 1);
    });

    test('a restore that loses its lease while waiting stops instead of restarting anything else', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, status: 'queued' })];
        const github = createGitHub(runs, { asyncCancellation: true });
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        // The first cancellation finished; the second run is still finishing, so
        // the restore has to wait for it.
        runs[0].status = 'completed';
        runs[0].conclusion = 'cancelled';
        const [record] = await records();

        const result = await restoreFollowupCiSuspension(record, deps(github, {
            restoreBudgetMs: 60_000,
            // While this restore waits, its lease expires and another worker takes it.
            sleep: async () => {
                await database(PR_CI_SUSPENSION_LEASES_TABLE)
                    .update({ token: 'other-worker', holder: 'worker-b', expires_at: Date.now() + 60_000 });
            },
        }));

        assert.equal(result.reason, 'busy');
        assert.deepEqual(github.rerun(), [1], 'nothing was restarted after the lease was gone');
        assert.equal((await records()).length, 1, 'the obligation waits for whoever holds the lease now');
        const [lease] = await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*');
        assert.equal(lease.token, 'other-worker', 'a lost lease is never released by its previous holder');
    });

    test('a worker that lost its lease while reading the pull request never reserves the suspension over its new owner', async () => {
        const runs = [run({ id: 1 }), run({ id: 2, head_sha: NEW_HEAD, status: 'queued' })];
        let reachedLookup!: () => void;
        const lookupIsPaused = new Promise<void>(resolve => { reachedLookup = resolve; });
        let letLookupFinish!: () => void;
        const lookupMayContinue = new Promise<void>(resolve => { letLookupFinish = resolve; });
        let paused = false;
        const workerA = createGitHub(runs, {
            onRequest: async route => {
                if (paused || route !== 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return;
                paused = true;
                reachedLookup();
                await lookupMayContinue;
            },
        });

        // Worker A takes the lease and stalls inside its pull request lookup for
        // longer than the lease lives.
        const begunA = beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(workerA, { leaseHolder: 'worker-a' }));
        await lookupIsPaused;
        await database(PR_CI_SUSPENSION_LEASES_TABLE).update({ expires_at: Date.now() - 1 });

        // A replacement commit was published meanwhile; a second follow-up takes
        // the expired lease over and suspends the validation of the new head.
        const workerB = createGitHub(runs, { headSha: NEW_HEAD });
        const begunB = await beginFollowupCiSuspension({ target: TARGET, taskId: 'task-next' },
            deps(workerB, { leaseHolder: 'worker-b', leaseAcquireTimeoutMs: 0 }));
        assert.equal(begunB.reason, 'suspended');
        assert.deepEqual(begunB.cancelledRunIds, [2]);

        // Worker A's lookup finally returns, with the old head.
        letLookupFinish();
        const resultA = await begunA;

        assert.equal(resultA.reason, 'busy');
        assert.deepEqual(workerA.cancelled(), [], 'nothing is cancelled on a lease that belongs to somebody else');
        const [current] = await records();
        assert.equal(current.task_id, 'task-next');
        assert.equal(current.head_sha, NEW_HEAD);
        assert.deepEqual(await storedRunIds(), [2], "the new owner's restart obligation survived the stale worker");
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), [], 'the stale worker released nothing that was not its own');
    });

    test('leaves CI untouched and the implementation running when the lease cannot be taken at all', async () => {
        const github = createGitHub([run({ id: 1 })]);

        // Every query fails, the way a database outage looks.
        const unavailableDatabase = () => { throw new Error('database is down'); };
        const result = await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID },
            deps(github, { database: unavailableDatabase as never, leaseAcquireTimeoutMs: 0 }));

        assert.equal(result.suspended, false);
        assert.equal(result.reason, 'error');
        assert.deepEqual(github.cancelled(), []);
        assert.deepEqual(await records(), []);
    });

    test('takes over the lease of a worker that died holding it', async () => {
        const runs = [run({ id: 1 })];
        const github = createGitHub(runs);
        await beginFollowupCiSuspension({ target: TARGET, taskId: TASK_ID }, deps(github));
        await database(PR_CI_SUSPENSION_LEASES_TABLE).insert({
            lease_key: 'integry/propr#2485', token: 'dead-worker', holder: 'worker-b',
            acquired_at: Date.now() - 600_000, expires_at: Date.now() - 300_000,
        });

        const [result] = await releaseFollowupCiSuspensionsForTask({ taskId: TASK_ID }, deps(github, { leaseAcquireTimeoutMs: 0 }));

        assert.equal(result.reason, 'restarted');
        assert.deepEqual(github.rerun(), [1]);
        assert.deepEqual(await database(PR_CI_SUSPENSION_LEASES_TABLE).select('*'), []);
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
