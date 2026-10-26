import path from 'node:path';
import { db, executeDockerCommand, logger, sweepIdleWorktrees, type WorktreeSweepResult } from '@propr/core';
import { HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE } from '../jobs/followupHandoffStore.js';

/** Terminal goals cannot resume: both goal routes and recovery fence continuation
 * with result_state IS NULL. Unreconciled terminal results still need their checkout.
 * Tasks do not consistently persist an exact checkout path before host-side work;
 * protect their repository subtree until the latest durable state is terminal.
 */
export async function referencedWorktreePaths(database = db): Promise<string[]> {
    const goals = await database('goals').whereNotNull('worktree_path')
        .where(query => query.whereNull('result_state').orWhereNull('task_reconciled_at'))
        .pluck('worktree_path') as string[];
    const handoffs = await database(PR_FOLLOWUP_HANDOFFS_TABLE).whereNot('status', HANDOFF_RELEASED)
        .pluck('worktree_path') as string[];
    const tasks = await database('tasks as task')
        .leftJoin('task_history as latest', function () {
            this.on('latest.task_id', '=', 'task.task_id').andOn('latest.history_id', '=', database.raw(
                '(select max(history_id) from task_history where task_id = task.task_id)',
            ));
        })
        .where(query => query.whereNull('latest.state').orWhereNotIn('latest.state', ['completed', 'failed', 'cancelled']))
        .distinct('task.repository') as Array<{ repository: string }>;
    const taskRoots = tasks.map(({ repository }) => {
        // Unknown task authority must fail closed, including malformed paths.
        if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(repository)
            || ['.', '..'].includes(repository.split('/')[1])) throw new Error('Invalid active task repository');
        return path.resolve(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees', repository);
    });
    return [...goals, ...handoffs, ...taskRoots].filter(Boolean);
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
            minIdleHours: sweepSetting('WORKTREE_RETENTION_HOURS', 24, Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000)),
            protectedPaths: () => referencedWorktreePaths(),
            mountedPaths: runningContainerMountSources,
        });
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Skipped idle worktree sweep: could not confirm which worktrees are in use');
        return null;
    }
}

/** Reject malformed settings rather than weakening age or creating a 1ms timer. */
function sweepSetting(name: string, fallback: number, maximum: number): number {
    const raw = process.env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
    }
    return value;
}

/** Runs once at startup (in the background) and then every WORKTREE_SWEEP_INTERVAL_MS (default 1 hour). */
export function scheduleWorktreeSweep(): NodeJS.Timeout | null {
    try {
        const intervalMs = sweepSetting('WORKTREE_SWEEP_INTERVAL_MS', 60 * 60 * 1000, 2_147_483_647);
        sweepSetting('WORKTREE_RETENTION_HOURS', 24, Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000));
        void sweepWorktrees();
        return setInterval(() => { void sweepWorktrees(); }, intervalMs);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Idle worktree sweep disabled: invalid configuration');
        return null;
    }
}
