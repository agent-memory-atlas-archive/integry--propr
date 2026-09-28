import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { boundedProviderOutput, MAX_PROVIDER_OUTPUT_BYTES } from './boundedProviderOutput.js';
import { LiveOutputBacklog, writeLiveOutput } from './liveOutputLog.js';

/**
 * Bounded provider JSONL kept in memory and appended to the task's live Redis
 * output log (and optional durable goal records) in small batched flushes.
 * Records neither sink has acknowledged are bounded (see {@link LiveOutputBacklog}).
 */
export class LiveAgentOutput {
    private readonly redis: Redis;
    private readonly ownsRedis: boolean;
    private readonly writes: Array<{ chunk: string; bytes: number; sequence: number; published: boolean; persisted: boolean }> = [];
    private readonly backlog: LiveOutputBacklog;
    private readonly writer = randomUUID();
    private sequence = 0;
    private closed = false;
    private finished = false;
    private closePromise: Promise<void> | null = null;
    private output = '';
    private pendingOutput = '';
    /** Reserved for `pendingOutput`; bounding it may leave this higher than its size. */
    private pendingBytes = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly taskId: string | undefined,
        private readonly persistOutput?: (records: string[]) => Promise<void>,
        private readonly label = 'agent',
        { redis, maximumQueuedBytes, onOverflow }: {
            redis?: Redis;
            maximumQueuedBytes?: number;
            /** Called once when unacknowledged output passes the maximum; later output is refused. */
            onOverflow?: (error: Error) => void;
        } = {},
    ) {
        this.backlog = new LiveOutputBacklog(maximumQueuedBytes, onOverflow, { taskId, label });
        this.ownsRedis = !redis;
        this.redis = redis ?? new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
    }

    get raw(): string { return this.output; }

    append(value: string): void {
        if (this.closed) return;
        this.output = boundedProviderOutput(this.output + value, MAX_PROVIDER_OUTPUT_BYTES);
        if (!this.taskId) return;
        const bytes = Buffer.byteLength(value);
        if (!this.backlog.reserve(bytes)) return;
        this.pendingOutput = boundedProviderOutput(this.pendingOutput + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.pendingBytes += bytes;
        this.scheduleFlush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.taskId) return this.flushPromise;
        if (this.pendingOutput) {
            const bytes = Buffer.byteLength(this.pendingOutput);
            this.backlog.release(this.pendingBytes - bytes);
            this.writes.push({ chunk: this.pendingOutput, bytes, sequence: ++this.sequence, published: false, persisted: !this.persistOutput });
            this.pendingOutput = '';
            this.pendingBytes = 0;
        }
        this.flushPromise = this.flushPromise.then(async () => {
            while (this.writes.length > 0) {
                const write = this.writes[0];
                // A fast rejection must not allow another drain to retry a sink
                // whose write is still in flight. Acknowledge the sinks separately.
                const results = await Promise.allSettled([
                    (async () => {
                        if (write.published) return;
                        if (this.ownsRedis && this.redis.status === 'end') await this.redis.connect();
                        await writeLiveOutput(this.redis, this.taskId!, write.chunk, { publication: { writer: this.writer, sequence: write.sequence } });
                        write.published = true;
                    })(),
                    (async () => {
                        if (write.persisted) return;
                        await this.persistOutput!(write.chunk.split('\n').filter(Boolean));
                        write.persisted = true;
                    })(),
                ]);
                const failure = results.find(result => result.status === 'rejected');
                if (failure?.status === 'rejected') {
                    logger.debug({ error: (failure.reason as Error).message, label: this.label }, 'Failed to persist live agent output');
                    this.scheduleFlush();
                    return;
                }
                this.backlog.release(write.bytes);
                this.writes.shift();
            }
        });
        return this.flushPromise;
    }

    private scheduleFlush(): void {
        if (this.closed || !this.taskId || this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 200);
    }

    async close(): Promise<void> {
        if (this.finished) {
            if (this.backlog.overflow) throw this.backlog.overflow;
            return;
        }
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.finishClose();
        try { await this.closePromise; }
        finally { this.closePromise = null; }
    }

    private async finishClose(): Promise<void> {
        this.closed = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        await this.flush();
        if (this.writes.length > 0) {
            if (this.ownsRedis) this.redis.disconnect();
            throw new Error('Live agent output still has unacknowledged writes');
        }
        if (this.ownsRedis) await this.redis.quit().catch(() => undefined);
        this.finished = true;
        // Everything accepted was acknowledged, but the output refused after the overflow was not.
        if (this.backlog.overflow) throw this.backlog.overflow;
    }
}
