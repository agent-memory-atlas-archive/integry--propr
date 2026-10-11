// Enforce simulator isolation before importing either production wrapper. Pretend
// an absolute Docker binary is installed, so the former resolver fails this test
// on every host. The guard refuses it before any process can contact a daemon.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
const access = fs.accessSync;
fs.existsSync = ((file) => file === '/usr/bin/docker' || exists(file)) as typeof fs.existsSync;
fs.accessSync = ((file, mode) => { if (file !== '/usr/bin/docker') access(file, mode); }) as typeof fs.accessSync;
const originalSpawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] !== 'docker') throw new Error(`Fixture refused non-PATH executable: ${args[0]}`);
    return originalSpawn(...args);
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
const { executeDockerCommand } = await import('../../../packages/core/src/claude/docker/dockerExecutor.js');
const { spawnWithNetworkPolicy } = await import('../../../packages/core/src/claude/docker/dockerNetworkPolicy.js');
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
            const nested = () => executeDockerCommand('docker', ['run', '--rm', 'fixture-agent'], { timeout: 60_000, extraEnvVars: process.env.PROPR_TEST_EXTRA_ENV ? JSON.parse(process.env.PROPR_TEST_EXTRA_ENV) : undefined });
            await nested();
            if (process.argv[2] === 'fallback') await nested();
        }
    });
    process.send?.('done');
} catch (error) { process.send?.({ error: String(error) }); }
// Native cleanup is asynchronous and must retain the process until it finishes.
setTimeout(() => process.exit(0), 500);
