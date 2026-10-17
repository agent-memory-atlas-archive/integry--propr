import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Worker-restart qualification: a follow-up records its durable handoff, holds
 * the PR lease, and its agent edits the retained worktree — then the worker
 * dies with nothing committed. A restarted worker's task-state recovery loop
 * (the real `startWorkerTaskStateRecovery` wiring) must discover the handoff,
 * take over the stale lease, adopt the retained worktree, and publish the work
 * exactly once; a second restart must publish nothing more.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'handoff-restart-'));
after(async () => { await database.destroy(); await rm(root, { recursive: true, force: true }); });

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: silentLog,
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
        AI_COMMIT_AUTHOR: { name: 'ProPR Test', email: 'propr@example.test' },
        getAuthenticatedOctokit: async () => { throw new Error('the qualification injects its own Octokit'); },
        getStateManager: () => { throw new Error('the qualification injects its own state manager'); },
        getEventPublisher: () => ({ publishTaskUpdate: () => undefined }),
        getIssueQueue: async () => ({ getJob: async () => null }),
        inspectTaskContainerLivenessForTask: async () => { throw new Error('the qualification injects liveness'); },
        commitChanges: async () => { throw new Error('the qualification injects git operations'); },
        createHooklessGit: () => { throw new Error('the qualification injects git operations'); },
        releaseBranchFromSettledWorktree: async () => { throw new Error('the qualification injects git operations'); },
        cleanupWorktree: async () => undefined,
        createWorktreeFromExistingBranch: async () => { throw new Error('unexpected worktree creation'); },
        ensureRepoCloned: async () => { throw new Error('unexpected clone'); },
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async () => { throw new Error('the qualification injects git operations'); },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
    },
});
await mock.module('../src/taskStateReconciler.js', {
    namedExports: {
        DEFAULT_RECONCILIATION_STALE_MS: 15 * 60 * 1000,
        DEFAULT_RECONCILIATION_ORPHAN_GRACE_MS: 60 * 1000,
        DEFAULT_RECONCILIATION_TIME_BUDGET_MS: 30 * 1000,
        reconcileStaleTaskStates: async () => ({
            nextCursor: '0', backlog: [],
            summary: { scanned: 0, stale: 0, live: 0, suspected: 0, recovered: 0, skipped: 0, errors: 0 },
        }),
    },
});

const { recordFollowupHandoff, loadFollowupHandoff } = await import('../src/jobs/followupHandoffStore.js');
const { recoverInterruptedFollowupHandoffs } = await import('../src/jobs/followupHandoffRecovery.js');
const { startWorkerTaskStateRecovery } = await import('../src/workerTaskStateRecovery.js');

const BRANCH = 'propr/pr-42';
const LOCK_KEY = 'lock:pr:acme:widgets:42';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('a worker restart recovers the persisted handoff and publishes the retained work exactly once', async () => {
    // --- Worker 1: the follow-up job prepares its worktree and records the handoff.
    const dir = path.join(root, 'fixture');
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '--bare', 'origin.git');
    git(dir, 'clone', 'origin.git', 'local');
    const local = path.join(dir, 'local');
    await writeFile(path.join(local, 'base.txt'), 'base\n');
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'Base');
    git(local, 'branch', '-M', BRANCH);
    git(local, 'push', '-u', 'origin', BRANCH);
    git(local, 'checkout', '--detach');
    const wt = path.join(dir, 'wt');
    git(local, 'worktree', 'add', wt, BRANCH);
    const baseHead = git(path.join(dir, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`);

    const recorded = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 42 },
        taskId: 'task-restart-1',
        sourceTaskIds: [],
        correlationId: 'corr-restart',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: wt, localRepoPath: local,
        claimedComments: [{ id: 21, body: 'please adjust', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 42, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-restart' } as never,
        llm: 'claude', lockKey: LOCK_KEY, lockToken: 'worker-1-token',
    }, { database });
    assert.ok(recorded);

    // The agent produced edits; then the worker process died. The lease it held
    // stopped being renewed, so its TTL has decayed below the freshness floor.
    await writeFile(path.join(wt, 'feature.txt'), 'useful uncommitted implementation\n');
    const lockStore = new Map<string, { value: string; ttl: number }>([[LOCK_KEY, { value: 'worker-1-token', ttl: 42 }]]);
    const redis = {
        async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
            if (nx === 'NX' && lockStore.has(key)) return null;
            lockStore.set(key, { value, ttl: Number(ttl) });
            return 'OK';
        },
        async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
            const current = lockStore.get(key);
            if (script.includes('ttl')) {
                const [predecessor, successor, ttlSeconds, floor] = args;
                if (!current) { lockStore.set(key, { value: String(successor), ttl: Number(ttlSeconds) }); return 1; }
                if (current.value !== String(predecessor)) return 0;
                if (current.ttl > Number(floor)) return -1;
                lockStore.set(key, { value: String(successor), ttl: Number(ttlSeconds) });
                return 1;
            }
            if (script.includes('del')) {
                if (current?.value === String(args[0])) { lockStore.delete(key); return 1; }
                return 0;
            }
            if (current?.value === String(args[0])) { current.ttl = Number(args[1]); return 1; }
            return 0;
        },
        async quit() { return 'OK'; },
    };

    // --- Worker 2: restart. Real git evidence, fake GitHub/container runtime.
    const comments: Array<{ id: number; body: string; html_url: string }> = [];
    let nextCommentId = 1;
    const octokit = {
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('POST ')) {
                const created = { id: nextCommentId++, body: String(params?.body ?? ''), html_url: `https://example.test/c/${nextCommentId}` };
                comments.push(created);
                return { data: created };
            }
            throw Object.assign(new Error('Not Found'), { status: 404 });
        },
        async paginate() { return [...comments]; },
        async auth() { return { token: 'installation-token' }; },
    };
    const states = new Map<string, string>([['task-restart-1', 'processing']]);
    const stateManager = {
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string) { states.set(taskId, state); },
        async updateHistoryMetadata() { return undefined; },
    };
    let pushes = 0;
    const gitOps = {
        async worktreeAttachment(worktreePath: string, branchName: string) {
            if (!existsSync(worktreePath)) return 'missing' as const;
            return git(worktreePath, 'branch', '--show-current') === branchName ? 'attached' as const : 'not_on_branch' as const;
        },
        async hasUncommittedChanges(worktreePath: string) {
            return git(worktreePath, 'status', '--porcelain', '--untracked-files=all') !== '';
        },
        async commitWork(worktreePath: string, message: string) {
            git(worktreePath, 'add', '-A');
            git(worktreePath, 'commit', '-m', message);
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async hasUnpushedCommits(worktreePath: string, branchName: string) {
            git(worktreePath, 'fetch', 'origin', branchName);
            return git(worktreePath, 'rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`) !== '0';
        },
        async head(worktreePath: string) { return git(worktreePath, 'rev-parse', 'HEAD'); },
        async push(worktreePath: string) {
            git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
            pushes += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async releaseSettledWorktree(_localRepoPath: string, branchName: string, worktreePath: string) {
            if (git(worktreePath, 'status', '--porcelain', '--untracked-files=all') !== '') return false;
            if (git(worktreePath, 'rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`) !== '0') return false;
            git(worktreePath, 'checkout', '--detach');
            return true;
        },
        async detachWorktreeHead(worktreePath: string) { git(worktreePath, 'checkout', '--detach'); },
    };
    const recoveryDeps = {
        store: { database }, redis, log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: gitOps,
        restoreComments: async () => undefined,
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    const summaries: Array<Record<string, number>> = [];
    const startRestartedWorkerRecovery = () => startWorkerTaskStateRecovery({
        queue: { getJob: async () => null } as never,
        stateManager: stateManager as never,
        store: {
            scanNonTerminalTasks: async () => ({ tasks: [], nextCursor: '0' }),
            recordMissing: async () => undefined, clearMissing: async () => undefined,
            ownsJobAssignment: async () => false, finalizeIfCurrent: async () => false,
        } as never,
        redis: { set: async () => 'OK', eval: async () => 1 },
        intervalMs: 60_000,
        recoverFollowupHandoffs: async () => {
            const summary = await recoverInterruptedFollowupHandoffs(recoveryDeps);
            summaries.push(summary as unknown as Record<string, number>);
            return summary;
        },
    });

    const restarted = await startRestartedWorkerRecovery();
    await restarted.runOnce();
    await restarted.close();

    // The handoff was recovered and published exactly once.
    assert.equal(summaries.at(-1)?.published, 1);
    const publishedHead = git(path.join(dir, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`);
    assert.notEqual(publishedHead, baseHead, 'the retained edits reached the remote branch');
    assert.equal(pushes, 1);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Recovered and published follow-up changes/);
    assert.match(comments[0].body, /21✓/);
    assert.equal(states.get('task-restart-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, { repository: 'acme/widgets', pull_request: 42 }), undefined);
    assert.equal(lockStore.has(LOCK_KEY), false, 'the successor lease converged to release');
    // Non-destructive: the retained worktree and its files survive with a detached HEAD.
    assert.ok(existsSync(path.join(wt, 'feature.txt')));
    assert.equal(git(wt, 'branch', '--show-current'), '');

    // --- Worker 3: another restart finds nothing owed and publishes nothing more.
    const again = await startRestartedWorkerRecovery();
    await again.runOnce();
    await again.close();
    assert.equal(summaries.at(-1)?.inspected, 0);
    assert.equal(pushes, 1);
    assert.equal(comments.length, 1);
});
