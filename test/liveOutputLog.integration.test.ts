import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
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
