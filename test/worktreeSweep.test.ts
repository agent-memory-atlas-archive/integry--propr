import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import path from 'node:path';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('goals', table => {
    table.string('worktree_path'); table.string('result_state'); table.timestamp('task_reconciled_at');
});
await database.schema.createTable('pr_followup_handoffs', table => {
    table.string('worktree_path'); table.string('status');
});
await database.schema.createTable('tasks', table => { table.string('task_id'); table.string('repository'); });
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state');
});
let sweeps = 0;
const warnings: string[] = [];
const dockerCalls: string[][] = [];
let dockerResponse = { exitCode: 0, stdout: '', stderr: '' };
await mock.module('@propr/core', { namedExports: {
    db: database,
    logger: { warn: (_context: unknown, message: string) => { warnings.push(message); } },
    sweepIdleWorktrees: async () => { sweeps++; return { removed: [], kept: 0, skipped: 0 }; },
    executeDockerCommand: async (_command: string, args: string[]) => { dockerCalls.push(args); return dockerResponse; },
} });
const { referencedWorktreePaths, scheduleWorktreeSweep, sweepWorktrees, runningContainerMountSources } = await import('../src/daemon/worktreeSweep.js');
const previousHours = process.env.WORKTREE_RETENTION_HOURS;
const previousInterval = process.env.WORKTREE_SWEEP_INTERVAL_MS;
after(async () => {
    if (previousHours === undefined) delete process.env.WORKTREE_RETENTION_HOURS; else process.env.WORKTREE_RETENTION_HOURS = previousHours;
    if (previousInterval === undefined) delete process.env.WORKTREE_SWEEP_INTERVAL_MS; else process.env.WORKTREE_SWEEP_INTERVAL_MS = previousInterval;
    await database.destroy();
});
beforeEach(async () => {
    delete process.env.WORKTREE_RETENTION_HOURS;
    delete process.env.WORKTREE_SWEEP_INTERVAL_MS;
    sweeps = 0; warnings.length = 0; dockerCalls.length = 0;
    dockerResponse = { exitCode: 0, stdout: '', stderr: '' };
    for (const table of ['goals', 'pr_followup_handoffs', 'tasks', 'task_history']) await database(table).delete();
});

test('invalid retention and timer settings disable sweeping instead of bypassing age or spinning', async () => {
    for (const value of ['abc', '', '0', '-1', '1.5', '2hours', 'Infinity', '9007199254740991']) {
        process.env.WORKTREE_RETENTION_HOURS = value;
        assert.equal(await sweepWorktrees(), null, value);
        assert.equal(scheduleWorktreeSweep(), null, value);
    }
    delete process.env.WORKTREE_RETENTION_HOURS;
    for (const value of ['abc', '', '0', '-1', '1.5', '20ms', 'Infinity', '2147483648']) {
        process.env.WORKTREE_SWEEP_INTERVAL_MS = value;
        assert.equal(scheduleWorktreeSweep(), null, value);
    }
    assert.equal(sweeps, 0);
    assert.ok(warnings.length > 0);
    assert.equal(dockerCalls.length, 0);
});

test('default and valid settings run once immediately and schedule the requested interval', () => {
    const defaults = scheduleWorktreeSweep();
    assert.ok(defaults);
    clearInterval(defaults);
    process.env.WORKTREE_RETENTION_HOURS = '2';
    process.env.WORKTREE_SWEEP_INTERVAL_MS = '60000';
    const configured = scheduleWorktreeSweep();
    assert.ok(configured);
    clearInterval(configured);
    assert.equal(sweeps, 2);
});

test('durable references protect paused/unreconciled goals, handoffs, and host-side nonterminal task repositories', async () => {
    await database('goals').insert([
        { worktree_path: '/paused-goal', result_state: null, task_reconciled_at: 1 },
        { worktree_path: '/unreconciled-goal', result_state: 'completed', task_reconciled_at: null },
        { worktree_path: '/terminal-goal', result_state: 'completed', task_reconciled_at: 1 },
    ]);
    await database('pr_followup_handoffs').insert([
        { worktree_path: '/cleanup-pending', status: 'active' },
        { worktree_path: '/released', status: 'released' },
    ]);
    await database('tasks').insert([
        { task_id: 'issue', repository: 'owner/issue' },
        { task_id: 'agent', repository: 'owner/agent' },
        { task_id: 'ultrafix-ci', repository: 'owner/ultrafix' },
        { task_id: 'unknown', repository: 'owner/unknown' },
        { task_id: 'dot-repo', repository: 'owner/.github' },
        { task_id: 'finished', repository: 'owner/finished' },
        { task_id: 'retry', repository: 'owner/retry' },
    ]);
    await database('task_history').insert([
        { task_id: 'issue', state: 'post_processing' },
        { task_id: 'agent', state: 'processing' },
        { task_id: 'ultrafix-ci', state: 'post_processing' },
        { task_id: 'finished', state: 'processing' },
        { task_id: 'finished', state: 'completed' },
        { task_id: 'retry', state: 'failed' },
        { task_id: 'retry', state: 'processing' },
    ]);
    const refs = await referencedWorktreePaths();
    for (const expected of ['/paused-goal', '/unreconciled-goal', '/cleanup-pending']) assert.ok(refs.includes(expected));
    for (const repo of ['issue', 'agent', 'ultrafix', 'unknown', 'retry', '.github']) {
        assert.ok(refs.includes(path.resolve(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees', 'owner', repo)));
    }
    assert.ok(!refs.includes('/terminal-goal'));
    assert.ok(!refs.includes('/released'));
    assert.ok(!refs.some(ref => ref.endsWith('/finished')));
});

test('unknown task authority and Docker errors fail closed', async () => {
    await database('tasks').insert({ task_id: 'bad', repository: '../escape' });
    await assert.rejects(referencedWorktreePaths(), /Invalid active task repository/);
    dockerResponse = { exitCode: 1, stdout: '', stderr: 'permission denied' };
    await assert.rejects(runningContainerMountSources(), /docker ps failed/);
});
