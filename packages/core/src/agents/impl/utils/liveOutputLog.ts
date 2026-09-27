import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';

/**
 * A task's live agent output in Redis is an append-only log, so writers send
 * only new records and readers fetch only the bytes they have not seen yet.
 *
 *   agent:output:<task>       the retained output (a byte string)
 *   agent:output:<task>:meta  hash: `base` absolute offset of the first retained
 *                             byte, `epoch` bumped whenever an execution starts
 *                             over, `start` that execution's absolute offset,
 *                             `head` its first record, `generation` a unique identity
 *                             assigned when the log is recreated
 *
 * Within a generation offsets only grow: a reader that remembers one can tell
 * whether its next bytes are still retained. When the output passes the ceiling
 * the oldest records are dropped at a record boundary (the first record, which
 * identifies the provider format, is kept in `head`).
 */
export const LIVE_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const LIVE_OUTPUT_TTL_SECONDS = 3600;

export const liveOutputKey = (taskId: string): string => `agent:output:${taskId}`;
export const liveOutputMetaKey = (taskId: string): string => `agent:output:${taskId}:meta`;

/**
 * KEYS: data, meta. ARGV: chunk, maximum bytes, ttl seconds, mode, generation candidate.
 * mode `reset` starts a new execution (new epoch) before appending; `replace`
 * swaps in a whole snapshot of the same execution (providers that cannot stream
 * records), so readers resynchronize without a new epoch.
 */
export const APPEND_LIVE_OUTPUT_SCRIPT = `
local mode = ARGV[4]
-- The counter can restart after expiry. A fresh identity distinguishes that
-- log from all prior generations, even if its offsets and epoch are identical.
if redis.call('exists', KEYS[1]) == 0 or redis.call('hexists', KEYS[2], 'generation') == 0 then
    redis.call('hset', KEYS[2], 'generation', ARGV[5])
end
if mode == 'reset' or mode == 'replace' then
    local previous = redis.call('strlen', KEYS[1])
    redis.call('del', KEYS[1])
    local base = redis.call('hincrby', KEYS[2], 'base', previous)
    -- A snapshot replaces the same execution's output, so its events keep their IDs.
    if mode == 'reset' then redis.call('hincrby', KEYS[2], 'epoch', 1) end
    redis.call('hset', KEYS[2], 'start', base)
    redis.call('hdel', KEYS[2], 'head')
end
if redis.call('hexists', KEYS[2], 'epoch') == 0 then
    redis.call('hset', KEYS[2], 'epoch', 0, 'base', 0, 'start', 0)
end
local length = redis.call('append', KEYS[1], ARGV[1])
if redis.call('hexists', KEYS[2], 'head') == 0 then
    local first = redis.call('getrange', KEYS[1], 0, 65535)
    local boundary = string.find(first, '\\n', 1, true)
    if boundary then
        redis.call('hset', KEYS[2], 'head', string.sub(first, 1, boundary - 1))
    elseif length > 65536 then
        redis.call('hset', KEYS[2], 'head', '')
    end
end
local maximum = tonumber(ARGV[2])
if length > maximum then
    local keep = math.floor(maximum * 3 / 4)
    local tail = redis.call('getrange', KEYS[1], length - keep, -1)
    local boundary = string.find(tail, '\\n', 1, true)
    if boundary then tail = string.sub(tail, boundary + 1) end
    redis.call('set', KEYS[1], tail)
    redis.call('hincrby', KEYS[2], 'base', length - string.len(tail))
    length = string.len(tail)
end
redis.call('expire', KEYS[1], tonumber(ARGV[3]))
redis.call('expire', KEYS[2], tonumber(ARGV[3]))
return length
`;

export type LiveOutputWriteMode = 'append' | 'reset' | 'replace';

export async function writeLiveOutput(
    redis: Pick<Redis, 'eval'>,
    taskId: string,
    chunk: string,
    { mode = 'append', maximumBytes = LIVE_OUTPUT_MAX_BYTES }: { mode?: LiveOutputWriteMode; maximumBytes?: number } = {},
): Promise<number> {
    return Number(await redis.eval(
        APPEND_LIVE_OUTPUT_SCRIPT, 2, liveOutputKey(taskId), liveOutputMetaKey(taskId),
        chunk, String(maximumBytes), String(LIVE_OUTPUT_TTL_SECONDS), mode, randomUUID(),
    ));
}

export interface LiveOutputLogOptions {
    /** Start a new execution: the first write replaces whatever an earlier one left. */
    reset?: boolean;
    /** Applied to whole records only, so escape sequences are never split. */
    transformRecord?: (record: string) => string;
    flushIntervalMs?: number;
    redis?: Redis;
}

/**
 * Streams one process's output into the task's live log, one complete record
 * at a time. Partial records wait for their newline (or for close()).
 */
export class LiveOutputLog {
    private readonly redis: Redis;
    private readonly ownsRedis: boolean;
    private partial = '';
    private pending = '';
    private readonly writes: Array<{ chunk: string; mode: 'append' | 'replace' }> = [];
    private resetPending: boolean;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();
    private closed = false;
    private finished = false;
    private closePromise: Promise<void> | null = null;

    constructor(private readonly taskId: string, private readonly options: LiveOutputLogOptions = {}) {
        this.resetPending = options.reset === true;
        this.ownsRedis = !options.redis;
        this.redis = options.redis ?? new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
        this.redis.on?.('error', error => logger.debug({ error: error.message }, 'Live output Redis connection error'));
    }

    append(chunk: string): void {
        if (this.closed || !chunk) return;
        const text = this.partial + chunk;
        const boundary = text.lastIndexOf('\n');
        if (boundary < 0) {
            this.partial = text;
            return;
        }
        this.partial = text.slice(boundary + 1);
        this.queue(text.slice(0, boundary + 1));
    }

    /** Publishes a whole snapshot in place of the previous one (providers that cannot stream records). */
    replace(snapshot: string): void {
        if (this.closed) return;
        this.enqueuePending();
        this.writes.push({ chunk: this.transform(snapshot), mode: 'replace' });
        void this.flush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.enqueuePending();
        if (this.resetPending && this.writes.length === 0) this.writes.push({ chunk: '', mode: 'append' });
        this.flushPromise = this.flushPromise.then(async () => {
            while (this.writes.length > 0) {
                const write = this.writes[0];
                try {
                    if (this.ownsRedis && this.redis.status === 'end') await this.redis.connect();
                    await writeLiveOutput(this.redis, this.taskId, write.chunk, { mode: this.resetPending ? 'reset' : write.mode });
                } catch (error) {
                    this.warn(error);
                    this.scheduleFlush();
                    return;
                }
                // Only this serialized drain may acknowledge the head, after success.
                this.resetPending = false;
                this.writes.shift();
            }
        });
        return this.flushPromise;
    }

    async close(): Promise<void> {
        if (this.finished) return;
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.finishClose();
        try { await this.closePromise; }
        finally { this.closePromise = null; }
    }

    private async finishClose(): Promise<void> {
        if (this.partial) this.queue(`${this.partial}\n`);
        this.partial = '';
        this.closed = true;
        await this.flush();
        // Retain failed work for a later close/flush, without leaking an owned connection.
        if (this.writes.length > 0) {
            if (this.ownsRedis) this.redis.disconnect();
            throw new Error('Live output still has unpublished writes');
        }
        if (this.ownsRedis) await this.redis.quit().catch(() => undefined);
        this.finished = true;
    }

    private enqueuePending(): void {
        if (!this.pending) return;
        this.writes.push({ chunk: this.pending, mode: 'append' });
        this.pending = '';
    }

    private queue(records: string): void {
        this.pending += this.options.transformRecord
            ? records.split('\n').map((record, index, all) => (index === all.length - 1 ? record : this.transform(record))).join('\n')
            : records;
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (!this.closed && !this.flushTimer) {
            this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, this.options.flushIntervalMs ?? 500);
            this.flushTimer.unref?.();
        }
    }

    private transform(value: string): string {
        return this.options.transformRecord ? this.options.transformRecord(value) : value;
    }

    private warn(error: unknown): void {
        logger.debug({ error: (error as Error).message, taskId: this.taskId }, 'Failed to stream live output to Redis');
    }
}
