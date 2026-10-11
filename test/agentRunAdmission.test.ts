import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync, fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { agentAdmissionKeys, agentAdmissionMetrics, prepareAdmittedAgent, resolveAgentRunAdmission, type AdmissionDocker } from '../packages/core/src/agents/agentRunAdmission.js';

const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;
let root: string, redis: Redis, server: ChildProcess;
const children: ChildProcess[] = [];
const previous = { ...process.env };
async function until(check: () => Promise<boolean>, timeout = 15_000) {
    const end = Date.now() + timeout;
    while (!await check()) { if (Date.now() > end) assert.fail('Timed out'); await delay(20); }
}
async function writeRecord(directory: string, record: { id: string }) {
    const target = path.join(directory, `${record.id}.json`);
    await writeFile(target + '.tmp', JSON.stringify(record));
    await rename(target + '.tmp', target);
}
async function readRecords(directory: string) {
    const values = await Promise.all((await readdir(directory)).filter(f => f.endsWith('.json')).map(async file => {
        try { return JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    return values.filter(Boolean);
}
before(async () => {
    if (!available) return;
    root = await mkdtemp(path.join(tmpdir(), 'agent-admission-'));
    const portServer = createServer();
    await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    server = spawn(binary, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    redis = new Redis({ host: '127.0.0.1', port, retryStrategy: () => 20 });
    redis.on('error', () => {});
    await redis.ping();
    const bin = path.join(root, 'bin'); await mkdir(bin);
    await writeFile(path.join(bin, 'docker'), `#!${process.execPath}\n${await readFile('test/fixtures/agent-admission/docker.mjs', 'utf8')}`);
    await chmod(path.join(bin, 'docker'), 0o755);
    Object.assign(process.env, { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port), PATH: `${bin}:${process.env.PATH}`, PROPR_DEMO_MODE: 'true' });
});
after(async () => {
    for (const child of children) child.kill('SIGKILL');
    redis?.disconnect(); server?.kill('SIGTERM');
    if (root) await rm(root, { force: true, recursive: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});
const integration = { skip: !available && 'redis-server required', timeout: 90_000 };

test('Hosted entitlement is authoritative; self-hosted keeps existing behavior unless opted in', () => {
    assert.equal(resolveAgentRunAdmission({ WORKER_CONCURRENCY: '2', CONFIG_REPO: 'a/b' }), null);
    for (const limit of [2, 6, 12]) {
        assert.deepEqual(resolveAgentRunAdmission({ PROPR_FLEET_CONTROL_SECRET: 'configured', PROPR_INSTANCE_ID: 'fleet', WORKER_CONCURRENCY: String(limit), CONFIG_REPO: 'a/b', PROPR_AGENT_RUN_LIMIT: '100' }), { instance: 'fleet', limit });
    }
    for (const value of [undefined, '', 'bad', '2workers', '0', '-1', '3', '6.5']) {
        assert.throws(() => resolveAgentRunAdmission({ PROPR_FLEET_CONTROL_SECRET: 'configured', PROPR_INSTANCE_ID: 'fleet', WORKER_CONCURRENCY: value }));
    }
    for (const generation of ['', '-1', '1.5', 'NaN', '9007199254740992']) {
        assert.throws(() => resolveAgentRunAdmission({ PROPR_AGENT_RUN_LIMIT: '2', PROPR_INSTANCE_ID: 'self', PROPR_AGENT_RUN_GENERATION: generation }), /GENERATION/);
    }
    assert.deepEqual(resolveAgentRunAdmission({ PROPR_FLEET_CONTROL_SECRET: 'configured', PROPR_INSTANCE_ID: 'fleet', WORKER_CONCURRENCY: '6', PROPR_AGENT_RUN_GENERATION: '1' }), { instance: 'fleet', limit: 6, generation: 1 });
    assert.throws(() => resolveAgentRunAdmission({ PROPR_AGENT_RUN_LIMIT: '2' }), /INSTANCE_ID/);
    assert.deepEqual(resolveAgentRunAdmission({ PROPR_AGENT_RUN_LIMIT: '1', PROPR_INSTANCE_ID: 'self' }), { instance: 'self', limit: 1 });
});

function lifecycle() {
    let count = 0;
    const alive = new Set<string>();
    const removed: string[] = [];
    const runtime: AdmissionDocker = {
        daemon: async () => 'test',
        assertEmpty: async () => {},
        create: async () => { const id = `container-${++count}`; alive.add(id); return id; },
        remove: async id => { alive.delete(id); removed.push(id); },
    };
    return { runtime, alive, removed };
}

test('Redis contention, waiting cancellation, renewal, ownership fencing and instance isolation', integration, async () => {
    const { runtime, alive } = lifecycle();
    const options = { client: redis, docker: runtime, config: { instance: 'unit-contention', limit: 2 }, leaseMs: 300, pollMs: 10 };
    const first = await prepareAdmittedAgent(['run', 'agent'], options);
    const second = await prepareAdmittedAgent(['run', 'agent'], options);
    assert.equal(alive.size, 2);
    const abort = new AbortController();
    const waiter = prepareAdmittedAgent(['run', 'agent'], { ...options, signal: abort.signal });
    const rejected = assert.rejects(waiter, /cancel/);
    await until(async () => (await agentAdmissionMetrics(redis, options.config.instance)).waiting === 1);
    await delay(400); // Multiple renewals; holders must not expire into reusable slots.
    assert.equal(alive.size, 2);
    abort.abort(new Error('cancel')); await rejected;
    assert.equal((await agentAdmissionMetrics(redis, options.config.instance)).waiting, 0);
    await first!.finish();
    const third = await prepareAdmittedAgent(['run', 'agent'], options);
    await first!.finish(); // stale/repeated release cannot release the replacement.
    assert.equal((await agentAdmissionMetrics(redis, options.config.instance)).running, 2);
    const isolated = await prepareAdmittedAgent(['run', 'agent'], { ...options, config: { instance: 'other-instance', limit: 1 } });
    await isolated!.finish(); await second!.finish(); await third!.finish();
    assert.equal(alive.size, 0);
});

test('expired holder is removed before reuse; failed removal retains capacity; stale attach cannot start', integration, async () => {
    const { runtime, alive, removed } = lifecycle();
    const config = { instance: 'crash', limit: 1 };
    const [key] = agentAdmissionKeys(config.instance);
    alive.add('crashed');
    await redis.set(agentAdmissionKeys(config.instance)[1], JSON.stringify({ limit: 1, daemon: 'test' }));
    await redis.hset(key, 'dead-owner', JSON.stringify({ state: 'running', deadline: 0, id: 'crashed' }));
    const failing = { ...runtime, remove: async () => { throw new Error('Docker unavailable'); } };
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: failing, config }), /Docker unavailable/);
    assert.equal(await redis.hlen(key), 1);
    const admitted = await prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: runtime, config });
    assert.equal(removed[0], 'crashed');
    assert.equal(await redis.hexists(key, 'dead-owner'), 0);
    await admitted!.finish();

    let created!: () => void, resume!: () => void;
    const arrived = new Promise<void>(resolve => { created = resolve; });
    const pause = new Promise<void>(resolve => { resume = resolve; });
    const lateCreate = { ...runtime, create: async () => { const id = await runtime.create([]); created(); await pause; return id; } };
    const stale = prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: lateCreate, config, leaseMs: 60_000 });
    const staleRejected = assert.rejects(stale, /lost before container start/);
    await arrived;
    const [[token, record]] = Object.entries(await redis.hgetall(key));
    await redis.hset(key, token, JSON.stringify({ ...JSON.parse(record), deadline: 0 }));
    const replacement = await prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: runtime, config });
    resume(); await staleRejected;
    assert.equal(await redis.hlen(key), 1, 'stale release does not touch replacement');
    await replacement!.finish(); assert.equal(alive.size, 0);
});

test('renewal loss stops physical container and fails closed when Redis is unavailable', integration, async () => {
    const { runtime, alive } = lifecycle();
    const config = { instance: 'loss', limit: 1 };
    const connection = new Redis({ host: '127.0.0.1', port: Number(process.env.REDIS_PORT), retryStrategy: () => null });
    const admitted = await prepareAdmittedAgent(['run', 'agent'], { client: connection, docker: runtime, config, leaseMs: 120 });
    connection.disconnect();
    await until(async () => admitted!.signal.aborted && alive.size === 0);
    await assert.rejects(admitted!.finish());
    assert.equal(await redis.hlen(agentAdmissionKeys(config.instance)[0]), 1, 'failure cannot silently free a slot');
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: connection, docker: runtime, config }));
    await delay(150);
    const replacement = await prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: runtime, config });
    await replacement!.finish();
});

for (const limit of [2, 6, 12]) test(`physical Docker wrappers saturate ${limit} across processes and standard/native entrypoints`, integration, async () => {
    const directory = path.join(root, `docker-${limit}`); await mkdir(directory);
    const instance = `wrappers-${limit}`;
    const env = { ...process.env, PROPR_INSTANCE_ID: instance, PROPR_FLEET_CONTROL_SECRET: 'test-only-activation', WORKER_CONCURRENCY: String(limit), PROPR_TEST_ADMISSION_DOCKER: directory };
    const records = () => readRecords(directory);
    const startWorker = (kind: string) => {
        const child = fork(path.resolve('test/fixtures/agent-admission/worker.ts'), [kind], { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
        const done = new Promise<void>((resolve, reject) => {
            child.on('message', message => { if (typeof message === 'object') reject(new Error(JSON.stringify(message))); });
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fixture exit ${code}: ${stderr}`)));
        });
        void done.catch(() => {});
        children.push(child); return { child, done };
    };
    // Main tasks, planner/chat, indexing/relevance and background analysis all
    // converge on executeDockerCommand; native goal sessions use the second wrapper.
    const workers = Array.from({ length: limit }, (_, i) => startWorker(i % 3 === 0 ? 'native' : 'standard'));
    await until(async () => (await records()).filter(r => r.state === 'running').length === limit, 40_000);
    const waiter = startWorker('standard');
    await until(async () => (await agentAdmissionMetrics(redis, instance)).waiting === 1, 40_000);
    assert.equal((await records()).length, limit, 'N+1 cannot even create its container');
    const first = (await records())[0]; first.stop = true;
    await writeRecord(directory, first);
    await until(async () => (await readFile(path.join(directory, 'starts'), 'utf8')).trim().split('\n').length === limit + 1);
    assert.equal((await records()).filter(r => r.state === 'running').length, limit);
    for (const record of await records()) { record.stop = true; await writeRecord(directory, record); }
    await Promise.all([...workers, waiter].map(w => w.done));
    await until(async () => await redis.hlen(agentAdmissionKeys(instance)[0]) === 0);
});

test('release waits for confirmed physical exit, including cancellation cleanup', integration, async () => {
    const { runtime } = lifecycle();
    let removing!: () => void, allowRemoval!: () => void;
    const reached = new Promise<void>(resolve => { removing = resolve; });
    const paused = new Promise<void>(resolve => { allowRemoval = resolve; });
    let stopBlocked = true;
    const guarded = { ...runtime, remove: async (id: string) => { if (stopBlocked) { removing(); await paused; } await runtime.remove(id); } };
    const config = { instance: 'exit-confirmation', limit: 1 };
    const holder = await prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: guarded, config });
    const releasing = holder!.finish(); await reached;
    let started = false;
    const waiter = prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: guarded, config, pollMs: 10 }).then(value => { started = true; return value; });
    await delay(100); assert.equal(started, false);
    stopBlocked = false; allowRemoval(); await releasing;
    await (await waiter)!.finish();
});

test('physical wrappers handle waiting/running cancellation, fallback and holder process crash', integration, async () => {
    const directory = path.join(root, 'docker-lifecycle'); await mkdir(directory);
    const instance = 'wrapper-lifecycle';
    const env = { ...process.env, PROPR_INSTANCE_ID: instance, PROPR_AGENT_RUN_LIMIT: '1', PROPR_TEST_ADMISSION_DOCKER: directory };
    delete env.PROPR_FLEET_CONTROL_SECRET;
    const records = () => readRecords(directory);
    const launch = (kind = 'standard') => {
        const child = fork(path.resolve('test/fixtures/agent-admission/worker.ts'), [kind], { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const messages: unknown[] = []; child.on('message', m => messages.push(m));
        const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
        children.push(child); return { child, messages, exit };
    };
    const holder = launch();
    await until(async () => (await records()).some(r => r.state === 'running'));
    const waiter = launch();
    await until(async () => (await agentAdmissionMetrics(redis, instance)).waiting === 1);
    waiter.child.send('cancel'); await waiter.exit;
    assert.match(JSON.stringify(waiter.messages), /cancel/);
    assert.equal((await records()).length, 1);
    holder.child.send('cancel'); await holder.exit;
    assert.match(JSON.stringify(holder.messages), /cancel/);
    assert.equal((await records()).length, 0);
    assert.equal(await redis.hlen(agentAdmissionKeys(instance)[0]), 0);

    const fallback = launch('fallback');
    for (let attempt = 0; attempt < 2; attempt++) {
        await until(async () => (await records()).some(r => r.state === 'running'));
        const [record] = await records(); record.stop = true;
        await writeRecord(directory, record);
        await until(async () => !(await records()).some(r => r.id === record.id));
    }
    await fallback.exit; assert.deepEqual(fallback.messages, ['done']);
    assert.equal(await redis.hlen(agentAdmissionKeys(instance)[0]), 0);

    const crashed = launch();
    await until(async () => (await records()).some(r => r.state === 'running'));
    const [old] = await records();
    crashed.child.kill('SIGKILL'); await crashed.exit;
    assert.equal((await records()).length, 1, 'Docker work survives its owner');
    const key = agentAdmissionKeys(instance)[0];
    const [[token, value]] = Object.entries(await redis.hgetall(key));
    // Advance only the persisted deadline to avoid a 30-second test sleep.
    await redis.hset(key, token, JSON.stringify({ ...JSON.parse(value), deadline: 0 }));
    const recovery = launch();
    await until(async () => (await records()).some(r => r.id !== old.id && r.state === 'running'));
    assert.equal((await records()).some(r => r.id === old.id), false);
    recovery.child.send('cancel'); await recovery.exit;
    assert.equal(await redis.hlen(key), 0);
});

test('conflicting entitlement/daemon configuration and Redis state loss fail closed', integration, async () => {
    const { runtime, alive } = lifecycle();
    const config = { instance: 'configuration-conflict', limit: 2 };
    const holder = await prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: runtime, config });
    const [[owner, record]] = Object.entries(await redis.hgetall(agentAdmissionKeys(config.instance)[0]));
    await redis.hset(agentAdmissionKeys(config.instance)[0], owner, JSON.stringify({ ...JSON.parse(record), deadline: 0 }));
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: runtime, config: { ...config, limit: 12 } }), /mismatch/);
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: { ...runtime, daemon: async () => 'other-daemon' }, config }), /mismatch/);
    assert.equal(alive.size, 1, 'mismatched processes cannot reap even expired holders');
    await holder!.finish();
    await redis.del(...agentAdmissionKeys(config.instance));
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { client: redis, docker: { ...runtime, assertEmpty: async () => { throw new Error('surviving Docker work'); } }, config }), /surviving Docker/);
});

test('durable worker/planner cancellation is checked while waiting, without consuming its marker', integration, async () => {
    const { runWithPlannerAbortContext, buildPlannerAbortSignalKey } = await import('../packages/core/src/claude/docker/dockerAbortController.js');
    const { runtime } = lifecycle();
    const config = { instance: 'durable-cancel', limit: 1 };
    const options = { client: redis, docker: runtime, config, pollMs: 10 };
    const holder = await prepareAdmittedAgent(['run', 'agent'], options);
    for (const kind of ['worker', 'planner']) {
        const key = kind === 'worker' ? 'worker:abort:waiting-task' : buildPlannerAbortSignalKey('draft', 'run');
        const waiting = runWithPlannerAbortContext('draft', 'run', () => prepareAdmittedAgent(['run', 'agent'], { ...options, taskId: 'waiting-task' }));
        const rejected = assert.rejects(waiting, /aborted/);
        await until(async () => (await agentAdmissionMetrics(redis, config.instance)).waiting === 1);
        await redis.set(key, '1'); await rejected;
        assert.equal(await redis.get(key), '1'); await redis.del(key);
    }
    await holder!.finish();
});

test('Docker create errors cannot expose credential-bearing arguments', integration, async () => {
    const directory = path.join(root, 'docker-create-failure'); await mkdir(directory);
    process.env.PROPR_TEST_ADMISSION_DOCKER = directory;
    const config = { instance: 'create-failure', limit: 1 };
    await assert.rejects(prepareAdmittedAgent(['run', '-e', 'GITHUB_TOKEN=fixture-secret-value', 'fixture-fail-create'], { client: redis, config }), error => {
        assert.match(String(error), /could not create/);
        assert.ok(!String(error).includes('fixture-secret-value'));
        assert.equal((error as Error).cause, undefined);
        return true;
    });
    assert.equal(await redis.hlen(agentAdmissionKeys(config.instance)[0]), 0);
    delete process.env.PROPR_TEST_ADMISSION_DOCKER;
});

for (const [from, to] of [[2, 6], [6, 2]]) test(`generation transition ${from} -> ${to} drains and rejects stale launchers`, integration, async () => {
    const { runtime, alive } = lifecycle();
    const instance = `resize-${from}-${to}`;
    const oldConfig = { instance, limit: from };
    const nextConfig = { instance, limit: to, generation: 1 };
    const options = { client: redis, docker: runtime, leaseMs: 60_000 };
    // Legacy generation-zero records migrate without operator Redis edits.
    const completed = await prepareAdmittedAgent(['run', 'agent'], { ...options, config: oldConfig });
    await completed!.finish();
    const next = await prepareAdmittedAgent(['run', 'agent'], { ...options, config: nextConfig });
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: oldConfig }), /mismatch/);
    await next!.finish();
    // A repeated tier must never make the old generation valid again (ABA).
    const currentConfig = { instance, limit: from, generation: 2 };
    const active = await prepareAdmittedAgent(['run', 'agent'], { ...options, config: currentConfig });
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: oldConfig }), /mismatch/, 'returning to the same tier does not revive generation zero');
    let created!: () => void, resume!: () => void;
    const reached = new Promise<void>(resolve => { created = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const suspended = prepareAdmittedAgent(['run', 'agent'], { ...options, config: currentConfig, docker: { ...runtime, create: async (...args) => {
        const id = await runtime.create(...args); created(); await paused; return id;
    } } });
    const rejected = assert.rejects(suspended, /lost before container start/);
    await reached;
    let blockRemoval = true;
    const guarded = { ...runtime, remove: async (id: string) => { if (blockRemoval) throw new Error('removal blocked'); await runtime.remove(id); } };
    const latest = { instance, limit: to, generation: 3 };
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, docker: guarded, config: latest }), /removal blocked/);
    assert.ok(Object.values(await redis.hgetall(agentAdmissionKeys(instance)[0])).some(value => JSON.parse(value).id === active!.id), 'failed removal retains the physical holder');
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: currentConfig }), /mismatch/);
    blockRemoval = false;
    const replacement = await prepareAdmittedAgent(['run', 'agent'], { ...options, config: latest });
    resume(); await rejected;
    await active!.finish();
    assert.equal(alive.size, 1, 'stale cleanup cannot remove the replacement');
    const holders = [replacement!];
    for (let i = 1; i < to; i++) holders.push((await prepareAdmittedAgent(['run', 'agent'], { ...options, config: latest }))!);
    const controller = new AbortController();
    const waiter = prepareAdmittedAgent(['run', 'agent'], { ...options, config: latest, signal: controller.signal, pollMs: 10 });
    const cancelled = assert.rejects(waiter);
    await until(async () => (await agentAdmissionMetrics(redis, instance)).waiting === 1);
    assert.equal(alive.size, to, 'new entitlement is enforced after the drain');
    controller.abort(); await cancelled;
    await Promise.all(holders.map(holder => holder.finish()));
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: oldConfig }), /mismatch/);
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: nextConfig }), /mismatch/, 'same limit with a retired generation stays rejected');
    await assert.rejects(prepareAdmittedAgent(['run', 'agent'], { ...options, config: latest, docker: { ...runtime, daemon: async () => 'different' } }), /mismatch/);
});

test('caller Docker host/context and PATH apply to identity, create, start, readback and removal', integration, async () => {
    const directory = path.join(root, 'docker-context'); await mkdir(directory);
    const env = { ...process.env, PROPR_INSTANCE_ID: 'docker-context', PROPR_FLEET_CONTROL_SECRET: 'fixture', WORKER_CONCURRENCY: '2',
        PATH: '/fixture-parent-path-must-not-be-used', DOCKER_HOST: 'invalid-parent-host', DOCKER_CONTEXT: 'invalid-parent-context',
        PROPR_TEST_EXTRA_ENV: JSON.stringify({ PATH: process.env.PATH, DOCKER_HOST: 'fixture-host', DOCKER_CONTEXT: 'fixture-context',
            PROPR_TEST_ADMISSION_DOCKER: directory, PROPR_TEST_EXPECT_HOST: 'fixture-host', PROPR_TEST_EXPECT_CONTEXT: 'fixture-context' }) };
    const child = fork(path.resolve('test/fixtures/agent-admission/worker.ts'), ['standard'], { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let error: unknown;
    child.on('message', message => { if (typeof message === 'object') error = message; });
    const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
    await until(async () => { if (error) assert.fail(JSON.stringify(error)); return (await readdir(directory)).some(f => f.endsWith('.json')); }, 40_000);
    await until(async () => { try { return (await readFile(path.join(directory, 'starts'), 'utf8')).length > 0; } catch { return false; } });
    child.send('cancel'); await done;
    const commands = (await readFile(path.join(directory, 'commands'), 'utf8')).trim().split('\n');
    for (const command of ['info', 'create', 'start', 'ps', 'rm']) assert.ok(commands.includes(command), command);
    assert.equal(await redis.hlen(agentAdmissionKeys('docker-context')[0]), 0);
    assert.equal((await readdir(directory)).filter(f => f.endsWith('.json')).length, 0);
});
