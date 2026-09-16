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
