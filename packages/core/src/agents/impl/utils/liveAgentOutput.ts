import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { boundedProviderOutput, MAX_PROVIDER_OUTPUT_BYTES } from './boundedProviderOutput.js';
import { writeLiveOutput } from './liveOutputLog.js';

/**
 * Bounded provider JSONL kept in memory and appended to the task's live Redis
 * output log (and optional durable goal records) in small batched flushes.
 */
export class LiveAgentOutput {
    private readonly redis: Redis;
    private readonly ownsRedis: boolean;
    private readonly writes: Array<{ chunk: string; published: boolean; persisted: boolean }> = [];
    private closed = false;
    private finished = false;
    private closePromise: Promise<void> | null = null;
    private output = '';
    private pendingOutput = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly taskId: string | undefined,
        private readonly persistOutput?: (records: string[]) => Promise<void>,
        private readonly label = 'agent',
        redis?: Redis,
    ) {
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
        this.pendingOutput = boundedProviderOutput(this.pendingOutput + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.scheduleFlush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.taskId) return this.flushPromise;
        if (this.pendingOutput) {
            this.writes.push({ chunk: this.pendingOutput, published: false, persisted: !this.persistOutput });
            this.pendingOutput = '';
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
                        await writeLiveOutput(this.redis, this.taskId!, write.chunk);
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
        if (this.finished) return;
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
    }
}
