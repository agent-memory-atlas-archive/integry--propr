import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AGENT_IMAGE_BUILD_MIN_FREE_BYTES,
    AGENT_IMAGE_BUILD_MIN_FREE_INODES,
    AgentImageBuildCapacityError,
    assertAgentImageBuildCapacity,
    isAgentImageDiskPressureError,
} from '../packages/core/src/agents/agentImageBuildCapacity.js';

test('agent image preparation accepts capacity above the conservative thresholds', async () => {
    const diskSpace = await assertAgentImageBuildCapacity({
        readDiskSpace: async () => ({
            availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1,
            freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES + 1,
        }),
    });

    assert.strictEqual(diskSpace.availableBytes, AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1);
});

test('agent image preparation fails before Docker work when bytes are low', async () => {
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            readDiskSpace: async () => ({
                availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES - 1,
                freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES + 1,
            }),
        }),
        (error: unknown) => {
            assert.ok(error instanceof AgentImageBuildCapacityError);
            assert.strictEqual(error.code, 'ENOSPC');
            return true;
        },
    );
});

test('agent image preparation fails before Docker work when inodes are low', async () => {
    await assert.rejects(
        () => assertAgentImageBuildCapacity({
            readDiskSpace: async () => ({
                availableBytes: AGENT_IMAGE_BUILD_MIN_FREE_BYTES + 1,
                freeInodes: AGENT_IMAGE_BUILD_MIN_FREE_INODES - 1,
            }),
        }),
        AgentImageBuildCapacityError,
    );
});

test('agent image disk pressure detection recognizes Docker ENOSPC failures', () => {
    assert.strictEqual(isAgentImageDiskPressureError(new Error('write /var/lib/docker: no space left on device')), true);
    assert.strictEqual(isAgentImageDiskPressureError(new Error('temporary registry timeout')), false);
});
