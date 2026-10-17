import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-'));
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
        getAuthenticatedOctokit: async () => { throw new Error('tests must inject their own Octokit'); },
        getStateManager: () => { throw new Error('tests must inject their own state manager'); },
        inspectTaskContainerLivenessForTask: async () => { throw new Error('tests must inject liveness'); },
        commitChanges: async () => { throw new Error('tests must inject git operations'); },
        createHooklessGit: () => { throw new Error('tests must inject git operations'); },
        releaseBranchFromSettledWorktree: async () => { throw new Error('tests must inject git operations'); },
        cleanupWorktree: async () => undefined,
        createWorktreeFromExistingBranch: async () => { throw new Error('unexpected worktree creation'); },
        ensureRepoCloned: async () => { throw new Error('unexpected clone'); },
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async () => { throw new Error('tests must inject git operations'); },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
    },
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, loadFollowupHandoffs,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE,
} = await import('../src/jobs/followupHandoffStore.js');
const {
    adoptPredecessorFollowupHandoff, authorizeCancelledFollowupHandoff, inspectFollowupHandoffs,
    recoverInterruptedFollowupHandoffs, releaseFollowupHandoffRecord,
} = await import('../src/jobs/followupHandoffRecovery.js');
const { adoptPRProcessingLock } = await import('../src/jobs/prProcessingLock.js');

const BRANCH = 'propr/pr-7';
const KEY = { repository: 'acme/widgets', pull_request: 7 };

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixtureIndex = 0;
interface Fixture { dir: string; origin: string; local: string; wt: string }

/** A bare origin, a clone acting as the shared local repo, and a retained worktree holding the branch. */
async function createFixture(): Promise<Fixture> {
    const dir = path.join(root, `fx-${fixtureIndex++}`);
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
    return { dir, origin: path.join(dir, 'origin.git'), local, wt };
}

const originHead = (fx: Fixture) => git(fx.origin, 'rev-parse', `refs/heads/${BRANCH}`);

interface GitCounters { commits: number; pushes: number; released: number; detached: number }

function createGitOps(counters: GitCounters) {
    const clean = (wt: string) => git(wt, 'status', '--porcelain', '--untracked-files=all') === '';
    const unpushed = (wt: string) => {
        git(wt, 'fetch', 'origin', BRANCH);
        return git(wt, 'rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${BRANCH}`) !== '0';
    };
    return {
        async worktreeAttachment(worktreePath: string, branchName: string) {
            if (!existsSync(worktreePath)) return 'missing' as const;
            return git(worktreePath, 'branch', '--show-current') === branchName ? 'attached' as const : 'not_on_branch' as const;
        },
        async hasUncommittedChanges(worktreePath: string) { return !clean(worktreePath); },
        async commitWork(worktreePath: string, message: string) {
            git(worktreePath, 'add', '-A');
            git(worktreePath, 'commit', '-m', message);
            counters.commits += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async hasUnpushedCommits(worktreePath: string) { return unpushed(worktreePath); },
        async head(worktreePath: string) { return git(worktreePath, 'rev-parse', 'HEAD'); },
        async push(worktreePath: string) {
            git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
            counters.pushes += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async releaseSettledWorktree(_localRepoPath: string, _branchName: string, worktreePath: string) {
            if (!existsSync(worktreePath) || !clean(worktreePath) || unpushed(worktreePath)) return false;
            git(worktreePath, 'checkout', '--detach');
            counters.released += 1;
            return true;
        },
        async detachWorktreeHead(worktreePath: string) {
            git(worktreePath, 'checkout', '--detach');
            counters.detached += 1;
        },
    };
}

/** In-memory PR processing lease with the adopt/renew/release script semantics. */
function createFakeLockRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    return {
        store,
        async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
            if (nx === 'NX' && store.has(key)) return null;
            store.set(key, { value, ttl: Number(ttl) });
            return 'OK';
        },
        async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
            const current = store.get(key);
            if (script.includes('ttl')) { // adopt
                const [predecessor, successor, ttlSeconds, floor] = args;
                if (!current) { store.set(key, { value: String(successor), ttl: Number(ttlSeconds) }); return 1; }
                if (current.value !== String(predecessor)) return 0;
                if (current.ttl > Number(floor)) return -1;
                store.set(key, { value: String(successor), ttl: Number(ttlSeconds) });
                return 1;
            }
            if (script.includes('del')) { // release
                if (current?.value === String(args[0])) { store.delete(key); return 1; }
                return 0;
            }
            if (script.includes('expire')) { // renew
                if (current?.value === String(args[0])) { current.ttl = Number(args[1]); return 1; }
                return 0;
            }
            throw new Error('Unknown lock script');
        },
        async quit() { return 'OK'; },
    };
}

function createStateManager(initial: Record<string, string> = {}) {
    const states = new Map(Object.entries(initial));
    const updates: Array<{ taskId: string; state?: string; metadata?: Record<string, unknown> }> = [];
    return {
        states, updates,
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string, metadata?: Record<string, unknown>) {
            states.set(taskId, state);
            updates.push({ taskId, state, metadata });
        },
        async updateHistoryMetadata(taskId: string, _historyState: string, metadata?: Record<string, unknown>) {
            updates.push({ taskId, metadata });
        },
    };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit(seedComments: FakeComment[] = []) {
    const comments = [...seedComments];
    let nextId = 1000;
    return {
        comments,
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('PATCH ')) {
                const found = comments.find(comment => comment.id === params?.comment_id);
                if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
                found.body = String(params?.body ?? '');
                return { data: found };
            }
            if (route.startsWith('POST ')) {
                const created = { id: nextId++, body: String(params?.body ?? ''), html_url: `https://example.test/comment/${nextId}` };
                comments.push(created);
                return { data: created };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
        async paginate() { return [...comments]; },
        async auth() { return { token: 'installation-token' }; },
    };
}

interface Harness {
    fx: Fixture;
    counters: GitCounters;
    gitOps: ReturnType<typeof createGitOps>;
    redis: ReturnType<typeof createFakeLockRedis>;
    stateManager: ReturnType<typeof createStateManager>;
    octokit: ReturnType<typeof createOctokit>;
    restored: Array<{ id: number }>;
    deps: Record<string, unknown>;
}

async function createHarness(options: { taskStates?: Record<string, string>; liveness?: string; comments?: FakeComment[] } = {}): Promise<Harness> {
    const fx = await createFixture();
    const counters: GitCounters = { commits: 0, pushes: 0, released: 0, detached: 0 };
    const gitOps = createGitOps(counters);
    const redis = createFakeLockRedis();
    const stateManager = createStateManager(options.taskStates ?? { 'task-1': 'processing' });
    const octokit = createOctokit(options.comments);
    const restored: Array<{ id: number }> = [];
    const deps = {
        store: { database }, redis, log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: options.liveness ?? 'not_found' }),
        git: gitOps,
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed); },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { fx, counters, gitOps, redis, stateManager, octokit, restored, deps };
}

async function seedHandoff(h: Harness, overrides: { taskId?: string; startingCommentId?: number; lockToken?: string } = {}) {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: overrides.taskId ?? 'task-1',
        sourceTaskIds: [],
        correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude',
        lockKey: 'lock:pr:acme:widgets:7',
        lockToken: overrides.lockToken ?? 'dead-worker-token',
        startingCommentId: overrides.startingCommentId,
    }, { database });
    assert.ok(record, 'handoff must be recorded');
    return record!;
}

const agentEdit = async (h: Harness) => {
    await writeFile(path.join(h.fx.wt, 'feature.txt'), 'agent work\n');
};

const publishedComments = (h: Harness) => h.octokit.comments.filter(comment => comment.body.includes('Recovered and published follow-up changes'));

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
});

test('restart while the agent container is live leaves the handoff and worktree untouched', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    await agentEdit(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.skippedLiveAgent, 1);
    assert.equal(summary.published, 0);
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    assert.equal(h.octokit.comments.length, 0);
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.phase, 'agent_running');
    assert.equal(record?.status, HANDOFF_ACTIVE);
});

test('agent exited before commit: edits are committed, pushed and announced exactly once', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { startingCommentId: 500 });
    h.octokit.comments.push({ id: 500, body: 'Starting work', html_url: 'https://example.test/comment/500' });
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited' });
    await agentEdit(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 1);
    assert.equal(h.counters.pushes, 1);
    assert.notEqual(originHead(h.fx), before);
    // The owed comment lands on the retained starting-work comment, not a duplicate.
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /Recovered and published follow-up changes/);
    assert.match(h.octokit.comments[0].body, /11✓/);
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    // The worktree is preserved with a detached HEAD so the branch is free again.
    assert.equal(h.counters.released, 1);
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')));
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '');
});

test('committed before push: the existing commit is pushed without re-committing', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const head = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: head });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 0);
    assert.equal(h.counters.pushes, 1);
    assert.equal(originHead(h.fx), head);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('evidence alone recovers committed-but-unpushed work when the phase write was lost', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const head = git(h.fx.wt, 'rev-parse', 'HEAD');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 0, 'no duplicate commit on top of the agent commit');
    assert.equal(originHead(h.fx), head);
});

test('pushed before comment publication: only the owed comment is published', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const head = originHead(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'pushed', commit_hash: head });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    assert.equal(originHead(h.fx), head);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
});

test('comment published before task finalization: finalizes without another comment', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await advanceFollowupHandoff({ database }, record, {
        phase: 'comment_published', commit_hash: originHead(h.fx), completion_comment_url: 'https://example.test/comment/1',
    });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.octokit.comments.length, 0, 'the owed comment was already delivered');
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('no changes: owed notice is posted, claimed comments are returned, and the task fails', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.equal(summary.published, 0);
    assert.equal(originHead(h.fx), before);
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /interrupted before any changes/);
    assert.ok(!h.octokit.comments[0].body.includes('11✓'), 'returned comments are not acknowledged as processed');
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(h.stateManager.states.get('task-1'), 'failed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(h.counters.released, 1);
});

test('missing worktree holds the handoff for an operator instead of failing or fabricating work', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(record?.status_reason, 'worktree_missing');
    assert.equal(h.octokit.comments.length, 0);
});

test('unavailable container liveness fails closed and a later healthy pass recovers', async () => {
    const h = await createHarness({ liveness: 'unavailable' });
    await seedHandoff(h);
    await agentEdit(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.failedClosed, 1);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_ACTIVE);
    assert.equal(held?.status_reason, 'liveness_unavailable');
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    // Liveness comes back and reports the container gone: the same record publishes.
    const healthy = { ...h.deps, inspectLiveness: async () => ({ liveness: 'not_found' }) };
    const second = await recoverInterruptedFollowupHandoffs(healthy);
    assert.equal(second.published, 1);
    assert.equal(publishedComments(h).length, 1);
});

test('user cancellation is authoritative: nothing publishes without explicit operator authorization', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'cancelled' } });
    await seedHandoff(h);
    await agentEdit(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(originHead(h.fx), before);
    assert.equal(h.octokit.comments.length, 0);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'cancelled work is preserved');

    // Explicit operator authorization publishes the preserved work exactly once.
    const authorized = await authorizeCancelledFollowupHandoff(KEY, { store: { database } });
    assert.equal(authorized?.status, HANDOFF_ACTIVE);
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.published, 1);
    assert.notEqual(originHead(h.fx), before);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the cancelled terminal state is never overwritten');
});

test('a redelivered follow-up adopts the recoverable predecessor under the shared lease', async () => {
    const h = await createHarness();
    await seedHandoff(h, { taskId: 'task-1' });
    await agentEdit(h);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog },
        h.deps,
    );
    assert.ok('resumed' in adoption && adoption.resumed?.outcome === 'published');
    assert.equal(publishedComments(h).length, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    // Nothing left to adopt: the new follow-up proceeds to prepare its own worktree.
    const again = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog },
        h.deps,
    );
    assert.ok(!('blocked' in again) || !again.blocked);
});

test('a live predecessor blocks a new follow-up instead of racing its retained worktree', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog },
        h.deps,
    );
    assert.ok('blocked' in adoption && adoption.blocked === 'predecessor_agent_still_running');
    const unavailable = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog },
        { ...h.deps, inspectLiveness: async () => ({ liveness: 'unavailable' }) },
    );
    assert.ok('blocked' in unavailable && unavailable.blocked === 'predecessor_liveness_unavailable');
});

test('a second recovery pass after success publishes nothing more', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.published, 1);
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.inspected, 0);
    assert.equal(h.counters.commits, 1);
    assert.equal(h.counters.pushes, 1);
    assert.equal(publishedComments(h).length, 1);
});

test('a lease still renewed by its recorded owner refuses takeover; a stale one converges', async () => {
    const h = await createHarness();
    await seedHandoff(h, { lockToken: 'owner-token' });
    await agentEdit(h);
    // Freshly renewed lease: the recorded owner is alive somewhere.
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'owner-token', ttl: 3600 });
    const blocked = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(blocked.lockedByOtherWriter, 1);
    assert.equal(h.counters.pushes, 0);
    // The same lease without renewals is a dead owner's: successor ownership is taken.
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'owner-token', ttl: 100 });
    const recovered = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(recovered.published, 1);
    assert.equal(h.redis.store.has('lock:pr:acme:widgets:7'), false, 'the successor lease is released after recovery');
});

test('a different live owner\'s lease is never taken over', async () => {
    const h = await createHarness();
    await seedHandoff(h, { lockToken: 'owner-token' });
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'someone-else', ttl: 10 });
    const result = await adoptPRProcessingLock(h.redis, 'lock:pr:acme:widgets:7', { predecessorToken: 'owner-token', successorToken: 'succ' });
    assert.equal(result, 'other_owner');
    assert.equal(h.redis.store.get('lock:pr:acme:widgets:7')?.value, 'someone-else');
});

test('release refuses to free a branch holding unpublished work unless forced, and never deletes files', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    const refused = await releaseFollowupHandoffRecord(KEY, {}, h.deps);
    assert.equal(refused.released, false);
    assert.equal(refused.reason, 'worktree_holds_unpublished_work');
    const forced = await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps);
    assert.equal(forced.released, true);
    assert.equal(h.counters.detached, 1);
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'files survive a forced release');
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.status, HANDOFF_RELEASED);
    // Released handoffs are skipped by recovery and reported as needing nothing.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.inspected, 0);
    const [status] = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'not_found' }) }, KEY);
    assert.equal(status.nextAction, 'none');
});

test('status inspection names the retained worktree and the next action', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    const statuses = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'running' }) });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].record.worktree_path, h.fx.wt);
    assert.equal(statuses[0].liveness, 'running');
    assert.match(statuses[0].nextAction, /wait for the live agent/);
    assert.equal((await loadFollowupHandoffs({ database }, { status: HANDOFF_ACTIVE })).length, 1);
});
