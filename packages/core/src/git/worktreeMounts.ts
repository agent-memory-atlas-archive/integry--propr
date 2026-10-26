import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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
export async function runningContainerMountSources(executeDockerCommand: DockerQuery = queryDocker): Promise<string[]> {
    const listed = await executeDockerCommand('docker', ['ps', '-q', '--no-trunc'], { timeout: 15_000 });
    if (listed.exitCode !== 0) throw new Error(`docker ps failed: ${listed.stderr.trim()}`);
    const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await executeDockerCommand('docker', [
        'inspect', '--format', '{{range .Mounts}}{{.Source}}{{"\\n"}}{{end}}', ...ids,
    ], { timeout: 30_000 });
    // A container can exit between ps and inspect; any other failure is unknown liveness.
    if (inspected.exitCode !== 0 && !/No such (object|container)/i.test(inspected.stderr)) {
        throw new Error(`docker inspect failed: ${inspected.stderr.trim()}`);
    }
    return inspected.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

