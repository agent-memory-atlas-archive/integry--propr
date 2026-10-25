import { db, executeDockerCommand, logger, sweepIdleWorktrees, type WorktreeSweepResult } from '@propr/core';
import { HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE } from '../jobs/followupHandoffStore.js';

/** Worktrees that live work still points at: unfinished goals and unreleased follow-up handoffs. */
export async function referencedWorktreePaths(database = db): Promise<string[]> {
    const goals = await database('goals').whereNotNull('worktree_path')
        .where(query => query.whereNull('result_state').orWhereNull('task_reconciled_at'))
        .pluck('worktree_path') as string[];
    const handoffs = await database(PR_FOLLOWUP_HANDOFFS_TABLE).whereNot('status', HANDOFF_RELEASED)
        .pluck('worktree_path') as string[];
    return [...goals, ...handoffs].filter(Boolean);
}

/** Host paths mounted into running containers. Throws when Docker can't be read. */
export async function runningContainerMountSources(): Promise<string[]> {
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

export async function sweepWorktrees(): Promise<WorktreeSweepResult | null> {
    try {
        return await sweepIdleWorktrees({
            minIdleHours: parseInt(process.env.WORKTREE_RETENTION_HOURS || '24', 10),
            protectedPaths: () => referencedWorktreePaths(),
            mountedPaths: runningContainerMountSources,
        });
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Skipped idle worktree sweep: could not confirm which worktrees are in use');
        return null;
    }
}

/** Runs once at startup (in the background) and then every WORKTREE_SWEEP_INTERVAL_MS (default 1 hour). */
export function scheduleWorktreeSweep(): NodeJS.Timeout {
    const intervalMs = parseInt(process.env.WORKTREE_SWEEP_INTERVAL_MS || `${60 * 60 * 1000}`, 10);
    void sweepWorktrees();
    return setInterval(() => { void sweepWorktrees(); }, intervalMs);
}
