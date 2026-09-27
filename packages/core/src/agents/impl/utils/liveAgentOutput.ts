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
    private output = '';
    private pendingOutput = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly taskId: string | undefined,
        private readonly persistOutput?: (records: string[]) => Promise<void>,
        private readonly label = 'agent',
    ) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
    }

    get raw(): string { return this.output; }

    append(value: string): void {
        this.output = boundedProviderOutput(this.output + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.pendingOutput = boundedProviderOutput(this.pendingOutput + value, MAX_PROVIDER_OUTPUT_BYTES);
        this.scheduleFlush();
    }

    flush(): Promise<void> {
        if (!this.taskId || !this.pendingOutput) return this.flushPromise;
        const chunk = this.pendingOutput;
        this.pendingOutput = '';
        this.flushPromise = this.flushPromise.then(async () => {
            await Promise.all([
                // Appended, never rewritten: output continues across resumes of the same task.
                writeLiveOutput(this.redis, this.taskId!, chunk),
                this.persistOutput?.(chunk.split('\n').filter(Boolean)),
            ]);
        }).catch(error => {
            logger.debug({ error: (error as Error).message, label: this.label }, 'Failed to persist live agent output');
        });
        return this.flushPromise;
    }

    private scheduleFlush(): void {
        if (!this.taskId || this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, 200);
    }

    async close(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        await this.flush();
        await this.redis.quit().catch(() => undefined);
    }
}
