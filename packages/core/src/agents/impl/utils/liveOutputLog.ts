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
 *                             assigned when the log is recreated, `envelopes` how many
 *                             of the execution's JSON records were trimmed (the ordinal
 *                             of the first retained one), `publication:<writer>` the
 *                             last batch each writer committed
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
 * KEYS: data, meta. ARGV: chunk, maximum bytes, ttl seconds, mode, generation
 * candidate, writer, batch sequence, origin offset, origin envelopes, origin
 * head. mode `reset` starts a new execution (new epoch) before appending;
 * `replace` swaps in a whole snapshot of the same execution (providers that
 * cannot stream records), so readers resynchronize without a new epoch. A
 * snapshot whose oldest records were dropped (see {@link LiveOutputOrigin})
 * starts that far into the execution, just like a trimmed log. A writer's
 * batches commit in sequence order, so a batch at or below its last committed
 * sequence is a retry of a write whose reply was lost, and is not applied again.
 */
export const APPEND_LIVE_OUTPUT_SCRIPT = `
local mode = ARGV[4]
local publication = nil
if ARGV[6] and ARGV[6] ~= '' then
    publication = 'publication:' .. ARGV[6]
    if tonumber(redis.call('hget', KEYS[2], publication) or '0') >= tonumber(ARGV[7]) then
        return redis.call('strlen', KEYS[1])
    end
end
-- The counter can restart after expiry. A fresh identity distinguishes that
-- log from all prior generations, even if its offsets and epoch are identical.
if redis.call('exists', KEYS[1]) == 0 or redis.call('hexists', KEYS[2], 'generation') == 0 then
    redis.call('hset', KEYS[2], 'generation', ARGV[5])
end
if mode == 'reset' or mode == 'replace' then
    local previous = redis.call('strlen', KEYS[1])
    local previousStart = tonumber(redis.call('hget', KEYS[2], 'start') or '-1')
    redis.call('del', KEYS[1])
    local base = redis.call('hincrby', KEYS[2], 'base', previous)
    -- A snapshot replaces the same execution's output, so its events keep their IDs.
    if mode == 'reset' then redis.call('hincrby', KEYS[2], 'epoch', 1) end
    -- Records keep their offsets from the execution's start when the snapshot
    -- dropped older ones. The start must still move, or a reader would take
    -- the new snapshot for an append to the one it read.
    local origin = tonumber(ARGV[8] or '0') or 0
    if origin > 0 and base - origin <= previousStart then
        base = redis.call('hincrby', KEYS[2], 'base', previousStart + origin + 1 - base)
    end
    redis.call('hset', KEYS[2], 'start', base - origin)
    redis.call('hdel', KEYS[2], 'head', 'envelopes')
    if origin > 0 then redis.call('hset', KEYS[2], 'head', ARGV[10], 'envelopes', ARGV[9]) end
end
if redis.call('hexists', KEYS[2], 'epoch') == 0 then
    redis.call('hset', KEYS[2], 'epoch', 0)
    redis.call('hsetnx', KEYS[2], 'base', 0)
    redis.call('hsetnx', KEYS[2], 'start', 0)
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
    -- Readers number JSON records to synthesize timestamps; count the trimmed
    -- ones so the retained records keep their ordinals.
    local dropped = redis.call('getrange', KEYS[1], 0, length - string.len(tail) - 1)
    local envelopes = 0
    if string.find(dropped, '^[ \\t\\r]*{') then envelopes = 1 end
    for _ in string.gmatch(dropped, '\\n[ \\t\\r]*{') do envelopes = envelopes + 1 end
    redis.call('hincrby', KEYS[2], 'envelopes', envelopes)
    redis.call('set', KEYS[1], tail)
    redis.call('hincrby', KEYS[2], 'base', length - string.len(tail))
    length = string.len(tail)
end
if publication then redis.call('hset', KEYS[2], publication, ARGV[7]) end
redis.call('expire', KEYS[1], tonumber(ARGV[3]))
redis.call('expire', KEYS[2], tonumber(ARGV[3]))
return length
`;

export type LiveOutputWriteMode = 'append' | 'reset' | 'replace';

/**
 * Where a snapshot begins within its execution's output once its oldest
 * records were dropped: `offset` bytes in, after `envelopes` JSON records, the
 * first of which is `head`. Readers then number its records as if nothing had
 * been dropped, exactly as they do for a log trimmed at the ceiling.
 */
export interface LiveOutputOrigin {
    offset: number;
    envelopes: number;
    head: string;
}

/** Longest first record kept as `head`; the append script reads the same window. */
const MAX_HEAD_BYTES = 65535;
/** A JSON record; the append script counts trimmed ones by the same rule. */
const ENVELOPE = /^[ \t\r]*\{/;

/** The origin of a snapshot whose records before it, `discarded`, were dropped. */
export function liveOutputOrigin(discarded: string): LiveOutputOrigin | undefined {
    if (!discarded) return undefined;
    const lines = discarded.split('\n');
    const head = lines.length > 1 && Buffer.byteLength(lines[0]) <= MAX_HEAD_BYTES ? lines[0] : '';
    return { offset: Buffer.byteLength(discarded), envelopes: lines.filter(line => ENVELOPE.test(line)).length, head };
}

/** A queued batch's identity, kept across retries: `sequence` grows by one per batch of `writer`. */
export interface LiveOutputPublication {
    writer: string;
    sequence: number;
}

export async function writeLiveOutput(
    redis: Pick<Redis, 'eval'>,
    taskId: string,
    chunk: string,
    { mode = 'append', maximumBytes = LIVE_OUTPUT_MAX_BYTES, publication, origin }: {
        mode?: LiveOutputWriteMode;
        maximumBytes?: number;
        /** Makes a retry of a committed batch (whose reply was lost) a no-op. */
        publication?: LiveOutputPublication;
        /** `reset` and `replace` only: where the chunk begins within the execution. */
        origin?: LiveOutputOrigin;
    } = {},
): Promise<number> {
    return Number(await redis.eval(
        APPEND_LIVE_OUTPUT_SCRIPT, 2, liveOutputKey(taskId), liveOutputMetaKey(taskId),
        chunk, String(maximumBytes), String(LIVE_OUTPUT_TTL_SECONDS), mode, randomUUID(),
        publication?.writer ?? '', String(publication?.sequence ?? 0),
        String(origin?.offset ?? 0), String(origin?.envelopes ?? 0), origin?.head ?? '',
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
 * at a time. Partial records wait for their newline (or for close()). Each
 * source (stdout, stderr) is framed on its own, so a record of one is never
 * completed by a newline of the other.
 */
export class LiveOutputLog {
    private readonly redis: Redis;
    private readonly ownsRedis: boolean;
    private readonly partials = new Map<string, string>();
    private pending = '';
    private readonly writes: Array<{ chunk: string; mode: 'append' | 'replace'; sequence: number; origin?: LiveOutputOrigin }> = [];
    private readonly writer = randomUUID();
    private sequence = 0;
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

    append(chunk: string, source = 'stdout'): void {
        if (this.closed || !chunk) return;
        const text = (this.partials.get(source) ?? '') + chunk;
        const boundary = text.lastIndexOf('\n');
        if (boundary < 0) {
            this.partials.set(source, text);
            return;
        }
        this.partials.set(source, text.slice(boundary + 1));
        this.queue(text.slice(0, boundary + 1));
    }

    /**
     * Publishes a whole snapshot in place of the previous one (providers that
     * cannot stream records). `discarded` is the output before the snapshot
     * that it no longer holds, so its records keep their offsets.
     */
    replace(snapshot: string, { discarded = '' }: { discarded?: string } = {}): void {
        if (this.closed) return;
        this.enqueuePending();
        const origin = liveOutputOrigin(this.transform(discarded));
        this.writes.push({ chunk: this.transform(snapshot), mode: 'replace', sequence: ++this.sequence, ...(origin ? { origin } : {}) });
        void this.flush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.enqueuePending();
        if (this.resetPending && this.writes.length === 0) this.writes.push({ chunk: '', mode: 'append', sequence: ++this.sequence });
        this.flushPromise = this.flushPromise.then(async () => {
            while (this.writes.length > 0) {
                const write = this.writes[0];
                try {
                    if (this.ownsRedis && this.redis.status === 'end') await this.redis.connect();
                    await writeLiveOutput(this.redis, this.taskId, write.chunk, {
                        mode: this.resetPending ? 'reset' : write.mode,
                        publication: { writer: this.writer, sequence: write.sequence },
                        origin: write.origin,
                    });
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
        for (const partial of this.partials.values()) if (partial) this.queue(`${partial}\n`);
        this.partials.clear();
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
        this.writes.push({ chunk: this.pending, mode: 'append', sequence: ++this.sequence });
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
