import { executeDockerCommand } from '../../../packages/core/src/claude/docker/dockerExecutor.js';
import { spawnWithNetworkPolicy } from '../../../packages/core/src/claude/docker/dockerNetworkPolicy.js';
import { spawn } from 'node:child_process';
import { runWithExecutionAbortSignal } from '../../../packages/core/src/claude/docker/dockerExecutionOwnership.js';
const controller = new AbortController();
process.on('message', message => { if (message === 'cancel') controller.abort(new Error('fixture cancelled')); });
try {
    await runWithExecutionAbortSignal(controller.signal, async () => {
        if (process.argv[2] === 'native') {
            const child = await spawnWithNetworkPolicy(['run', '--rm', 'fixture-agent'], args => spawn('docker', args));
            await new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
        } else {
            // Nested logical callers and sequential fallback both reach the same
            // physical wrapper. Neither owns another admission slot.
            const nested = () => executeDockerCommand('docker', ['run', '--rm', 'fixture-agent'], { timeout: 60_000 });
            await nested();
            if (process.argv[2] === 'fallback') await nested();
        }
    });
    process.send?.('done');
} catch (error) { process.send?.({ error: String(error) }); }
// Native cleanup is asynchronous and must retain the process until it finishes.
setTimeout(() => process.exit(0), 500);
