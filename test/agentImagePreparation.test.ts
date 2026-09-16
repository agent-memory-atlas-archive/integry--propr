import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCliVersionMatrix } from '../packages/core/src/agents/version/versionService.js';

let imageChecks = 0;
let pulls = 0;
let releasePull: (() => void) | undefined;
const pullGate = new Promise<void>(resolve => {
    releasePull = resolve;
});

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        getDockerRootDir: mock.fn(async () => '/docker/storage'),
        executeDockerCommand: mock.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'images') {
                imageChecks += 1;
                return { exitCode: 0, stdout: '', stderr: '', messageTimestamps: new Map() };
            }
            if (args[0] === 'pull') {
                pulls += 1;
                await pullGate;
                return { exitCode: 0, stdout: 'pulled', stderr: '', messageTimestamps: new Map() };
            }
            throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        }),
    },
});

const queue = {
    getJob: mock.fn(async (_jobId: string): Promise<unknown> => undefined),
    add: mock.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    close: async () => {},
};
await mock.module('bullmq', {
    namedExports: {
        Queue: class { constructor() { return queue; } },
        QueueEvents: class {
            async waitUntilReady() {}
            async close() {}
        },
    },
});

const { ensureAgentBundleImage } = await import('../packages/core/src/claude/docker/dockerImageBuilder.js');
const { agentImagePreparationJobId, enqueueAgentImagePreparation, closeAgentImagePreparationQueue } = await import('../packages/core/src/agents/agentImagePreparationQueue.js');

test('concurrent preparation of the same bundle shares one Docker operation', async () => {
    const versions: AgentCliVersionMatrix = {
        claude: '1.0.0',
        codex: '1.0.0',
        antigravity: '1.0.0',
        opencode: '1.0.0',
        vibe: '1.0.0',
    };

    const preparations = Array.from({ length: 8 }, () => ensureAgentBundleImage(versions, 'content'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(imageChecks, 1);
    assert.strictEqual(pulls, 1);

    releasePull?.();
    const results = await Promise.all(preparations);
    assert.ok(results.every(result => result.success));
    assert.strictEqual(new Set(results.map(result => result.imageTag)).size, 1);
});

test('worker-owned image preparation uses one deterministic job identity per image', () => {
    assert.strictEqual(
        agentImagePreparationJobId('propr/runtime-agent:one'),
        agentImagePreparationJobId('propr/runtime-agent:one'),
    );
    assert.notStrictEqual(
        agentImagePreparationJobId('propr/runtime-agent:one'),
        agentImagePreparationJobId('propr/runtime-agent:two'),
    );
});

after(closeAgentImagePreparationQueue);

for (const state of ['completed', 'failed', 'unknown', 'waiting', 'active', 'delayed', 'prioritized', 'waiting-children']) {
    test(`worker-owned preparation handles an existing ${state} job`, async () => {
        const existing = {
            getState: async () => state,
            remove: mock.fn(async () => {}),
            waitUntilFinished: mock.fn(async () => {}),
        };
        const fresh = { waitUntilFinished: mock.fn(async () => {}) };
        queue.getJob.mock.mockImplementation(async () => existing);
        queue.add.mock.resetCalls();
        queue.add.mock.mockImplementation(async () => fresh);
        const imageTag = 'propr/runtime-agent:missing-again';

        await enqueueAgentImagePreparation(imageTag);

        const replace = ['completed', 'failed', 'unknown'].includes(state);
        assert.strictEqual(existing.remove.mock.callCount(), replace ? 1 : 0);
        assert.strictEqual(queue.add.mock.callCount(), replace ? 1 : 0);
        assert.strictEqual(existing.waitUntilFinished.mock.callCount(), replace ? 0 : 1);
        assert.strictEqual(fresh.waitUntilFinished.mock.callCount(), replace ? 1 : 0);
        if (replace) {
            assert.deepStrictEqual(queue.add.mock.calls[0].arguments, [
                'prepare-unified-agent-image',
                { imageTag, requestedAt: (queue.add.mock.calls[0].arguments[1] as { requestedAt: string }).requestedAt },
                { jobId: agentImagePreparationJobId(imageTag) },
            ]);
        }
    });
}


test('explicit version builds coalesce only with requests for the same preparation contract', async () => {
    const imageTag = 'propr/agent:requested-a';
    const versions: AgentCliVersionMatrix = {
        claude: '1.0.0', codex: '1.0.0', antigravity: '1.0.0', opencode: '1.0.0', vibe: '1.0.0',
    };
    const options = { versions, contentHash: 'content-a' };
    const refresh = {
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => {}),
    };
    const explicit = {
        getState: async () => 'waiting',
        waitUntilFinished: mock.fn(async () => {}),
    };
    const jobs = new Map([[agentImagePreparationJobId(imageTag), refresh]]);
    queue.getJob.mock.mockImplementation(async jobId => jobs.get(jobId));
    queue.add.mock.resetCalls();
    queue.add.mock.mockImplementation(async (...args) => {
        jobs.set((args[2] as { jobId: string }).jobId, explicit);
        return explicit;
    });

    // A refresh queued for A may execute current configuration B. The explicit
    // request must retain A's versions in its own job, then share that job.
    await enqueueAgentImagePreparation(imageTag, options);
    await enqueueAgentImagePreparation(imageTag, {
        ...options,
        versions: Object.fromEntries(Object.entries(versions).reverse()) as AgentCliVersionMatrix,
    });

    assert.strictEqual(refresh.waitUntilFinished.mock.callCount(), 0);
    assert.strictEqual(explicit.waitUntilFinished.mock.callCount(), 2);
    assert.strictEqual(queue.add.mock.callCount(), 1);
    assert.deepStrictEqual(queue.add.mock.calls[0].arguments[1], {
        imageTag, ...options,
        requestedAt: (queue.add.mock.calls[0].arguments[1] as { requestedAt: string }).requestedAt,
    });
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag));
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag, {
        ...options, versions: { ...versions, claude: '2.0.0' },
    }));
    assert.notStrictEqual(agentImagePreparationJobId(imageTag, options), agentImagePreparationJobId(imageTag, {
        ...options, contentHash: 'content-b',
    }));
});

test('preparation can wait 18 minutes for the slot and then build for 10 minutes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = {
        getState: async () => 'active',
        waitUntilFinished: mock.fn(async (_events: unknown, timeout: number) => {
            assert.ok(timeout >= 2 * (60 + 20) * 60_000, 'budget covers both lease waits and builds');
            await new Promise<void>((resolve, reject) => {
                const deadline = setTimeout(() => reject(new Error('completion deadline exceeded')), timeout);
                setTimeout(() => { clearTimeout(deadline); resolve(); }, 28 * 60_000);
            });
        }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    let finished = false;
    const preparation = enqueueAgentImagePreparation('propr/agent:serialized')
        .then(() => { finished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(25 * 60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(finished, false);
    t.mock.timers.tick(3 * 60_000);
    await preparation;
    assert.strictEqual(finished, true);
});

for (const state of ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'completed', 'failed', 'unknown']) {
    test(`completion timeout checks the actual ${state} job before reporting a failure`, async () => {
        const timeout = new Error('Job wait prepare-unified-agent-image timed out before finishing, no finish notification arrived');
        const failure = new Error('actual Docker build failure');
        let checks = 0;
        let waits = 0;
        const job = {
            getState: async () => ++checks === 1 ? 'waiting' : state,
            waitUntilFinished: mock.fn(async () => {
                if (++waits === 1) throw timeout;
                if (state === 'failed') throw failure;
            }),
        };
        queue.getJob.mock.mockImplementation(async () => job);
        queue.add.mock.resetCalls();
        const preparation = enqueueAgentImagePreparation('propr/agent:still-pending');
        if (state === 'failed' || state === 'unknown') {
            await assert.rejects(preparation, error => error === (state === 'failed' ? failure : timeout));
        } else {
            await preparation;
        }
        assert.strictEqual(waits, state === 'unknown' ? 1 : 2);
        assert.strictEqual(queue.add.mock.callCount(), 0);
    });
}

test('preparation propagates worker failures without extending the wait', async () => {
    const failure = new Error('Docker build failed: no space left on device');
    const job = {
        getState: mock.fn(async () => 'active'),
        waitUntilFinished: mock.fn(async () => { throw failure; }),
    };
    queue.getJob.mock.mockImplementation(async () => job);
    await assert.rejects(enqueueAgentImagePreparation('propr/agent:failed'), error => error === failure);
    assert.strictEqual(job.waitUntilFinished.mock.callCount(), 1);
});
