import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let ready = false;
let initialized = false;
let resumePoll: (() => void) | undefined;
const prepare = mock.fn(async () => { initialized = true; });
const registry = {
    setImagePreparationOwner: mock.fn(),
    prepareImagesAndRefresh: prepare,
    isInitialized: () => initialized,
    getOperationalStatus: () => ({
        unifiedAgentImage: ready
            ? { status: 'ready' }
            : { status: 'unavailable', error: 'ENOSPC', operatorActionRequired: true },
    }),
    getAllAgents: () => [],
};

await mock.module('@propr/core', {
    namedExports: {
        AgentRegistry: { getInstance: () => registry },
        ensureAgentBundleImage: async () => ({ success: true }),
        logger: { info: () => {}, error: () => {} },
    },
});
await mock.module('node:timers/promises', {
    namedExports: {
        setTimeout: async () => new Promise<void>(resolve => { resumePoll = resolve; }),
    },
});
const { prepareAgentRegistryAtStartup, processAgentImagePreparationJob } = await import('../src/workerAgentPreparation.js');

for (const throws of [false, true]) {
    test(`startup remains alive without task capacity after preparation failure (throws=${throws})`, async () => {
        ready = false;
        initialized = false;
        prepare.mock.resetCalls();
        prepare.mock.mockImplementation(async () => {
            if (throws) throw new Error('ENOSPC');
            initialized = true;
        });
        let taskCapacityStarted = false;
        const startup = prepareAgentRegistryAtStartup().then(() => { taskCapacityStarted = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(taskCapacityStarted, false);
        assert.strictEqual(prepare.mock.callCount(), 1);

        // The startup gate yields while the independent preparation consumer
        // serves requests. Status polling itself must never start more builds.
        resumePoll!();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(taskCapacityStarted, false);
        assert.strictEqual(prepare.mock.callCount(), 1);

        // The preparation processor remains usable while startup is waiting
        // and returns the underlying error to the requesting API registry.
        const request = { data: { imageTag: 'propr/agent:missing' } };
        await assert.rejects(processAgentImagePreparationJob(request as never), /ENOSPC/);
        assert.strictEqual(taskCapacityStarted, false);
        initialized = true;
        ready = true;
        resumePoll!();
        await startup;
        assert.strictEqual(taskCapacityStarted, true);
        assert.strictEqual(registry.setImagePreparationOwner.mock.calls.at(-1)?.arguments[0], true);
    });
}
