import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorktreeMount = string | { source: string; service: boolean };
type DockerQuery = (command: string, args: string[], options: { timeout: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

// Keep mount inspection independent of agent execution, queues and their timers.
const queryDocker: DockerQuery = async (command, args, options) => {
    try {
        const result = await execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
        return { ...result, exitCode: 0 };
    } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code !== 'number') throw error;
        return { exitCode: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message };
    }
};

/** Host paths mounted into running containers. Throws when Docker can't be read. */
export async function runningContainerMountSources(executeDockerCommand: DockerQuery = queryDocker): Promise<WorktreeMount[]> {
    const listed = await executeDockerCommand('docker', ['ps', '-q', '--no-trunc'], { timeout: 15_000 });
    if (listed.exitCode !== 0) throw new Error(`docker ps failed: ${listed.stderr.trim()}`);
    const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await executeDockerCommand('docker', [
        'inspect', '--format', '{{json .Config.Cmd}}\t{{json .Config.Labels}}\t{{json .Mounts}}', ...ids,
    ], { timeout: 30_000 });
    // A container can exit between ps and inspect; any other failure is unknown liveness.
    if (inspected.exitCode !== 0 && !/No such (object|container)/i.test(inspected.stderr)) {
        throw new Error(`docker inspect failed: ${inspected.stderr.trim()}`);
    }
    return inspected.stdout.split('\n').filter(line => line.trim()).flatMap(line => {
        const [commandJson, labelsJson, mountsJson] = line.split('\t');
        const command: unknown = JSON.parse(commandJson);
        const labels = JSON.parse(labelsJson) as Record<string, string> | null;
        const mounts = JSON.parse(mountsJson) as Array<{ Source: string }>;
        // Recognize the shipped Compose commands and packaged launcher's app
        // entrypoints. Arbitrary task containers mounting shared storage still
        // protect it; an ancestor path alone is never service identity.
        const service = Array.isArray(command) && (
            (command.length === 3 && command[0] === 'npm' && command[1] === 'run'
                && ['daemon', 'worker', 'indexing-worker', 'api'].includes(command[2])
                && labels?.['com.docker.compose.service'] === command[2])
            || (command.length === 2 && command[0] === 'node'
                && ({ 'dist/src/daemon.js': 'daemon', 'dist/src/worker.js': 'worker',
                    'dist/src/indexing_worker.js': 'indexing-worker', 'dist/packages/api/server.js': 'api' } as Record<string, string>)[command[1]] === labels?.['propr.service']
                && typeof labels?.['propr.service'] === 'string')
        );
        return mounts.map(mount => {
            if (typeof mount.Source !== 'string') throw new Error('Invalid Docker mount source');
            return { source: mount.Source, service };
        });
    });
}

