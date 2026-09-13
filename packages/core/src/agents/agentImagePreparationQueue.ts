import crypto from 'node:crypto';
import { Job, Queue, QueueEvents } from 'bullmq';

export const AGENT_IMAGE_PREPARATION_QUEUE_NAME = 'agent-image-preparation';
const AGENT_IMAGE_PREPARATION_TIMEOUT_MS = 25 * 60 * 1000;

export interface AgentImagePreparationJobData {
    imageTag: string;
    requestedAt: string;
}

const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
};

export function agentImagePreparationJobId(imageTag: string): string {
    return `prepare-${crypto.createHash('sha256').update(imageTag).digest('hex').slice(0, 32)}`;
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

async function findOrCreateJob(
    queue: Queue<AgentImagePreparationJobData>,
    imageTag: string,
): Promise<Job<AgentImagePreparationJobData>> {
    const jobId = agentImagePreparationJobId(imageTag);
    const existing = await queue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (state !== 'failed') return existing;
        await existing.remove().catch(() => undefined);
    }
    return queue.add('prepare-unified-agent-image', {
        imageTag,
        requestedAt: new Date().toISOString(),
    }, { jobId });
}

/**
 * Enqueue one worker-owned preparation for an image and await its result.
 * BullMQ's deterministic job ID coalesces concurrent API callers and the
 * worker is the only process that owns the Docker preparation operation.
 */
export async function enqueueAgentImagePreparation(imageTag: string): Promise<void> {
    const job = await findOrCreateJob(getRequestQueue(), imageTag);
    await job.waitUntilFinished(await getRequestEvents(), AGENT_IMAGE_PREPARATION_TIMEOUT_MS);
}

export async function closeAgentImagePreparationQueue(): Promise<void> {
    await requestEvents?.close();
    await requestQueue?.close();
    requestEvents = undefined;
    requestQueue = undefined;
}
