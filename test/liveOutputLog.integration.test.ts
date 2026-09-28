import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { LiveAgentOutput } from '../packages/core/src/agents/impl/utils/liveAgentOutput.js';
import { LiveOutputLog, liveOutputKey, liveOutputMetaKey, writeLiveOutput } from '../packages/core/src/agents/impl/utils/liveOutputLog.js';

async function connect(t: { skip: (message: string) => void }): Promise<Redis | null> {
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
        connectTimeout: 250, enableReadyCheck: false, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
        return redis;
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for live output integration testing');
        return null;
    }
}

const taskId = (name: string) => `live-output-log-${name}-${process.pid}-${Date.now()}`;

test('streams complete records once, transformed whole, and flushes the last partial record on close', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('stream');
    try {
        await redis.set(liveOutputKey(id), 'left by an earlier execution\n');
        const log = new LiveOutputLog(id, { reset: true, redis, flushIntervalMs: 5, transformRecord: record => record.replace(/\u001b\[[0-9;]*m/g, '') });
        log.append('\u001b[32mfirst');
        log.append(' record\u001b[0m\nsecond');
        await log.flush();
        assert.equal(await redis.get(liveOutputKey(id)), 'first record\n', 'a new execution replaces earlier output; partial records wait');
        log.append(' record\nthird');
        await log.close();
        assert.equal(await redis.get(liveOutputKey(id)), 'first record\nsecond record\nthird\n');
        const meta = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(meta.head, 'first record');
        assert.equal(Number(meta.base), Number(meta.start), 'nothing of this execution was trimmed');
        assert.equal(await redis.ttl(liveOutputKey(id)) > 0, true);
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('trims the oldest records at a record boundary past the ceiling and never moves offsets backwards', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('trim');
    try {
        await writeLiveOutput(redis, id, 'init record\n', { mode: 'reset', maximumBytes: 400 });
        let previousBase = 0;
        for (let index = 0; index < 60; index += 1) {
            await writeLiveOutput(redis, id, `record ${String(index).padStart(3, '0')} ${'x'.repeat(20)}\n`, { mode: 'append', maximumBytes: 400 });
            const base = Number(await redis.hget(liveOutputMetaKey(id), 'base'));
            assert.ok(base >= previousBase);
            previousBase = base;
        }
        const data = await redis.get(liveOutputKey(id));
        assert.ok(data && data.length <= 400);
        assert.match(data!, /^record \d{3} /, 'retained output starts at a record boundary');
        assert.ok(data!.endsWith('record 059 xxxxxxxxxxxxxxxxxxxx\n'));
        const meta = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(meta.head, 'init record', 'the first record survives trimming');
        assert.ok(Number(meta.base) > Number(meta.start));

        await writeLiveOutput(redis, id, 'next execution\n', { mode: 'reset', maximumBytes: 400 });
        const next = await redis.hgetall(liveOutputMetaKey(id));
        assert.equal(Number(next.epoch), Number(meta.epoch) + 1);
        assert.equal(Number(next.start), Number(next.base));
        assert.ok(Number(next.base) > Number(meta.base), 'a new execution continues the absolute offsets');
        assert.equal(next.head, 'next execution');
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('snapshot publication consumes reset once and close retains the final snapshot', async () => {
    const writes: Array<{ text: string; mode: string }> = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
            writes.push({ text, mode });
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('snapshots', { reset: true, redis });
    log.replace('first snapshot');
    await log.flush();
    log.replace('final snapshot');
    await log.close();
    await log.close();
    assert.deepEqual(writes, [
        { text: 'first snapshot', mode: 'reset' },
        { text: 'final snapshot', mode: 'replace' },
    ]);
});

test('snapshot close retains output and increments the epoch only at execution start', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('snapshot');
    try {
        await writeLiveOutput(redis, id, 'earlier execution', { mode: 'reset' });
        const oldEpoch = Number(await redis.hget(liveOutputMetaKey(id), 'epoch'));
        const log = new LiveOutputLog(id, { reset: true, redis });
        log.replace('first snapshot');
        await log.flush();
        assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), oldEpoch + 1);
        log.replace('final snapshot');
        await log.close();
        assert.equal(await redis.get(liveOutputKey(id)), 'final snapshot');
        assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), oldEpoch + 1);
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

for (const reset of [false, true]) {
    test(`failed append batches retain their mode and order across overlapping flushes (reset=${reset})`, async () => {
        const entered = deferred();
        const release = deferred();
        const attempts: Array<{ text: string; mode: string }> = [];
        const redis = {
            eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
                attempts.push({ text, mode });
                if (attempts.length === 1) {
                    entered.resolve();
                    await release.promise;
                    throw new Error('temporary outage');
                }
                return text.length;
            },
        } as unknown as Redis;
        const log = new LiveOutputLog('retry-append', { reset, redis });
        log.append('first\n');
        const first = log.flush();
        await entered.promise;
        log.append('second\n');
        const second = log.flush();
        release.resolve();
        await Promise.all([first, second]);
        await log.close();
        assert.deepEqual(attempts, [
            { text: 'first\n', mode: reset ? 'reset' : 'append' },
            { text: 'first\n', mode: reset ? 'reset' : 'append' },
            { text: 'second\n', mode: 'append' },
        ]);
    });
}

for (const initialFailure of [true, false]) {
    test(`failed snapshots retry before later snapshots (initial failure=${initialFailure})`, async () => {
        const attempts: Array<{ text: string; mode: string }> = [];
        let failing = false;
        const redis = {
            eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
                attempts.push({ text, mode });
                if (failing) throw new Error('temporary outage');
                return text.length;
            },
        } as unknown as Redis;
        const log = new LiveOutputLog('retry-snapshot', { reset: true, redis });
        if (!initialFailure) {
            log.replace('initial');
            await log.flush();
        }
        failing = true;
        log.replace('failed');
        await log.flush();
        const failures = attempts.filter(write => write.text === 'failed');
        assert.ok(failures.length > 0);
        assert.ok(failures.every(write => write.mode === (initialFailure ? 'reset' : 'replace')));
        failing = false;
        const recoveredAt = attempts.length;
        log.replace('later');
        await log.close();
        assert.deepEqual(attempts.slice(recoveredAt), [
            { text: 'failed', mode: initialFailure ? 'reset' : 'replace' },
            { text: 'later', mode: 'replace' },
        ]);
    });
}

test('failed empty reset is retried before output, and a failed close remains retryable', async () => {
    let failing = true;
    const attempts: Array<{ text: string; mode: string }> = [];
    const redis = {
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string, _max: string, _ttl: string, mode: string) => {
            attempts.push({ text, mode });
            if (failing) throw new Error('temporary outage');
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('retry-close', { reset: true, redis });
    await log.flush();
    log.append('final partial');
    await assert.rejects(log.close(), /unpublished/);
    failing = false;
    const recoveredAt = attempts.length;
    await log.close();
    await log.close();
    assert.deepEqual(attempts.slice(recoveredAt), [
        { text: '', mode: 'reset' },
        { text: 'final partial\n', mode: 'append' },
    ]);
});

test('an unchanged snapshot is retried by the timer without another publication', async () => {
    let attempts = 0;
    const published = deferred();
    const redis = {
        eval: async () => {
            if (++attempts === 1) throw new Error('temporary outage');
            published.resolve();
            return 1;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('timer-retry', { reset: true, redis, flushIntervalMs: 1 });
    // Keep the test alive while the writer's intentionally unreferenced timer runs.
    const timeout = setTimeout(() => published.resolve(), 1000);
    try {
        log.replace('unchanged');
        await published.promise;
        assert.equal(attempts, 2);
    } finally {
        clearTimeout(timeout);
        await log.close();
    }
});

for (const failingSink of ['redis', 'durable']) {
    test(`goal output retains failed ${failingSink} writes and waits for both acknowledgements`, async () => {
        const entered = deferred();
        const release = deferred();
        const published: string[] = [];
        const persisted: string[] = [];
        const attempts = { redis: 0, durable: 0 };
        const write = async (sink: 'redis' | 'durable', text: string) => {
            attempts[sink] += 1;
            if (attempts[sink] === 1) {
                if (sink === failingSink) throw new Error('temporary outage');
                entered.resolve();
                await release.promise;
            }
            (sink === 'redis' ? published : persisted).push(text);
            return text.length;
        };
        const redis = { eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => write('redis', text) } as unknown as Redis;
        const output = new LiveAgentOutput('goal-retry', async records => { await write('durable', `${records.join('\n')}\n`); }, 'test', redis);
        output.append('first\n');
        const first = output.flush();
        await entered.promise;
        output.append('second\n');
        const second = output.flush();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(attempts, { redis: 1, durable: 1 }, 'a rejection cannot release the still-running sibling write');
        release.resolve();
        await Promise.all([first, second]);
        await output.close();
        assert.deepEqual(published, ['first\n', 'second\n']);
        assert.deepEqual(persisted, published, 'successful sinks are not replayed when the other sink fails');
        assert.equal(attempts[failingSink], 3);
        assert.equal(attempts[failingSink === 'redis' ? 'durable' : 'redis'], 2);
    });
}

test('goal output close retains unacknowledged durable records for retry', async () => {
    let failing = true;
    let publications = 0;
    const persisted: string[] = [];
    const redis = { eval: async () => ++publications } as unknown as Redis;
    const output = new LiveAgentOutput('goal-close', async records => {
        if (failing) throw new Error('temporary outage');
        persisted.push(...records);
    }, 'test', redis);
    output.append('final\n');
    await assert.rejects(output.close(), /unacknowledged/);
    failing = false;
    await output.close();
    await output.close();
    assert.equal(publications, 1);
    assert.deepEqual(persisted, ['final']);
});

for (const kind of ['process', 'goal']) {
    test(`concurrent ${kind} closes share the failed attempt and remain retryable`, async () => {
        const entered = deferred();
        const release = deferred();
        let attempts = 0;
        const redis = {
            eval: async () => {
                if (++attempts === 1) {
                    entered.resolve();
                    await release.promise;
                    throw new Error('temporary outage');
                }
                return 1;
            },
        } as unknown as Redis;
        const output = kind === 'process'
            ? new LiveOutputLog('concurrent-close', { reset: true, redis })
            : new LiveAgentOutput('concurrent-close', undefined, 'test', redis);
        output.append('final\n');
        const first = output.close();
        await entered.promise;
        const second = output.close();
        release.resolve();
        const results = await Promise.allSettled([first, second]);
        assert.ok(results.every(result => result.status === 'rejected'));
        assert.equal(attempts, 1, 'concurrent shutdown cannot start or disconnect a sibling retry');
        await output.close();
        assert.equal(attempts, 2);
    });
}

/** Commits each script, then loses the replies of the first `losses` calls, as a connection reset after execution does. */
function losingReplies(redis: Redis, losses: number): Redis {
    let calls = 0;
    return {
        on: () => undefined,
        eval: async (...args: Parameters<Redis['eval']>) => {
            const result = await redis.eval(...args);
            if (++calls <= losses) throw new Error('connection reset before the reply');
            return result;
        },
    } as unknown as Redis;
}

for (const kind of ['process-reset', 'process-append', 'process-snapshot', 'goal'] as const) {
    test(`a committed ${kind} batch whose reply was lost is not applied again on retry`, async t => {
        const redis = await connect(t);
        if (!redis) return;
        const id = taskId(`lost-reply-${kind}`);
        try {
            await writeLiveOutput(redis, id, 'earlier execution\n', { mode: 'reset' });
            const before = await redis.hgetall(liveOutputMetaKey(id));
            const lossy = losingReplies(redis, 1);
            const output = kind === 'goal'
                ? new LiveAgentOutput(id, undefined, 'test', lossy)
                : new LiveOutputLog(id, { reset: kind !== 'process-append', redis: lossy });
            const publish = (text: string) => (output instanceof LiveOutputLog && kind === 'process-snapshot' ? output.replace(text) : output.append(text));
            publish('first\n');
            await output.flush();
            assert.equal(Number(await redis.hget(liveOutputMetaKey(id), 'epoch')), Number(before.epoch) + (kind === 'process-reset' || kind === 'process-snapshot' ? 1 : 0));
            // The writer saw a rejection, so it retries the same batch before later output.
            publish(kind === 'process-snapshot' ? 'first\nsecond\n' : 'second\n');
            await output.close();
            const expected = kind === 'process-append' || kind === 'goal' ? 'earlier execution\nfirst\nsecond\n' : 'first\nsecond\n';
            assert.equal(await redis.get(liveOutputKey(id)), expected, 'every record is published once');
            const after = await redis.hgetall(liveOutputMetaKey(id));
            assert.equal(after.epoch, String(Number(before.epoch) + (kind === 'process-reset' || kind === 'process-snapshot' ? 1 : 0)), 'a retried reset starts one execution');
            assert.equal(after.generation, before.generation);
            if (kind === 'process-reset') assert.equal(after.base, after.start, 'the retried reset did not move the execution start');
        } finally {
            await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
            redis.disconnect();
        }
    });
}

test('publications of different writers are deduplicated independently', async t => {
    const redis = await connect(t);
    if (!redis) return;
    const id = taskId('writers');
    try {
        await writeLiveOutput(redis, id, 'a1\n', { mode: 'reset', publication: { writer: 'a', sequence: 1 } });
        await writeLiveOutput(redis, id, 'b1\n', { publication: { writer: 'b', sequence: 1 } });
        // A's retry of a committed batch arrives after B's write.
        await writeLiveOutput(redis, id, 'a1\n', { mode: 'reset', publication: { writer: 'a', sequence: 1 } });
        await writeLiveOutput(redis, id, 'a2\n', { publication: { writer: 'a', sequence: 2 } });
        await writeLiveOutput(redis, id, 'unidentified\n');
        await writeLiveOutput(redis, id, 'unidentified\n');
        assert.equal(await redis.get(liveOutputKey(id)), 'a1\nb1\na2\nunidentified\nunidentified\n');
    } finally {
        await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
        redis.disconnect();
    }
});

test('stdout and stderr are framed separately, so a diagnostic never splits a record', async () => {
    const writes: string[] = [];
    const redis = {
        on: () => undefined,
        eval: async (_script: string, _keys: number, _data: string, _meta: string, text: string) => {
            writes.push(text);
            return text.length;
        },
    } as unknown as Redis;
    const log = new LiveOutputLog('sources', { reset: true, redis });
    log.append('{"type":"assistant","message":', 'stdout');
    log.append('warning: slow network\n', 'stderr');
    log.append('{"content":[]}}\n{"type":"res', 'stdout');
    log.append('retrying', 'stderr');
    await log.close();
    assert.deepEqual(writes.join('').split('\n'), [
        'warning: slow network',
        '{"type":"assistant","message":{"content":[]}}',
        // Each source's partial record is flushed on its own at close.
        '{"type":"res',
        'retrying',
        '',
    ]);
});
