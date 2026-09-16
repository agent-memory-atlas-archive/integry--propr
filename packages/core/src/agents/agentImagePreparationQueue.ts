import crypto from 'node:crypto';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS } from './agentImageBuildLock.js';
import type { AgentCliVersionMatrix } from './version/versionService.js';

export const AGENT_IMAGE_PREPARATION_QUEUE_NAME = 'agent-image-preparation';
// A configuration refresh can prepare both a base and a runtime image, each
// with a lease wait and a 20-minute build, plus pulls and inspection overhead.
// This is a status-check interval, not a deadline on time spent in the queue.
const AGENT_IMAGE_PREPARATION_TIMEOUT_MS = 2 * (AGENT_IMAGE_BUILD_LOCK_ACQUIRE_TIMEOUT_MS + 20 * 60_000) + 15 * 60_000;
const PENDING_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];

export interface AgentImagePreparationJobData {
    imageTag: string;
    requestedAt: string;
    versions?: AgentCliVersionMatrix;
    contentHash?: string;
}

const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
};

type PreparationOptions = Pick<AgentImagePreparationJobData, 'versions' | 'contentHash'>;

export function agentImagePreparationJobId(imageTag: string, options: PreparationOptions = {}): string {
    // Explicit builds must not join a refresh that resolves the worker's
    // mutable configuration when it eventually starts executing.
    const identity = options.versions || options.contentHash
        ? JSON.stringify([imageTag, Object.entries(options.versions ?? {}).sort(), options.contentHash])
        : imageTag;
    return `prepare-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function createAgentImagePreparationQueue(): Queue<AgentImagePreparationJobData> {
    return new Queue<AgentImagePreparationJobData>(AGENT_IMAGE_PREPARATION_QUEUE_NAME, {
        connection,
        defaultJobOptions: {
            attempts: 1,
            removeOnComplete: { age: 60 * 60, count: 100 },
            removeOnFail: { age: 60 * 60, count: 100 },
        },
    });
}

let requestQueue: Queue<AgentImagePreparationJobData> | undefined;
let requestEvents: QueueEvents | undefined;

function getRequestQueue(): Queue<AgentImagePreparationJobData> {
    requestQueue ??= createAgentImagePreparationQueue();
    return requestQueue;
}

async function getRequestEvents(): Promise<QueueEvents> {
    requestEvents ??= new QueueEvents(AGENT_IMAGE_PREPARATION_QUEUE_NAME, { connection });
    await requestEvents.waitUntilReady();
    return requestEvents;
}

async function waitForPreparation(job: Job<AgentImagePreparationJobData>): Promise<void> {
    const events = await getRequestEvents();
    while (true) {
        try {
            await job.waitUntilFinished(events, AGENT_IMAGE_PREPARATION_TIMEOUT_MS);
            return;
        } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Job wait ')
                || !error.message.includes('timed out before finishing')) throw error;
            const state = await job.getState();
            // Queue/lease waiting is not a preparation failure. Reattach to
            // live jobs; for a terminal race, read the actual completion result.
            if (!PENDING_STATES.includes(state) && state !== 'completed' && state !== 'failed') throw error;
        }
    }
}

/**
 * Enqueue one worker-owned preparation for an image and await its result.
 * BullMQ's deterministic job ID coalesces concurrent API callers and the
 * worker is the only process that owns the Docker preparation operation.
 */
export async function enqueueAgentImagePreparation(
    imageTag: string,
    options: PreparationOptions = {},
): Promise<void> {
    const queue = getRequestQueue();
    const jobId = agentImagePreparationJobId(imageTag, options);
    const existing = await queue.getJob(jobId);
    let job = existing;
    if (job && !PENDING_STATES.includes(await job.getState())) {
        await job.remove().catch(() => undefined);
        job = undefined;
    }
    job ??= await queue.add('prepare-unified-agent-image', {
        imageTag,
        requestedAt: new Date().toISOString(),
        ...options,
    }, { jobId });
    await waitForPreparation(job);
}

export async function closeAgentImagePreparationQueue(): Promise<void> {
    await requestEvents?.close();
    await requestQueue?.close();
    requestEvents = undefined;
    requestQueue = undefined;
}
