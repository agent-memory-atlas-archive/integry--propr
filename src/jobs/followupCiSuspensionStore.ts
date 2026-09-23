import type { Knex } from 'knex';
import { db } from '@propr/core';
import { sameSha, type SuspensionTarget } from './followupCiSuspensionRuns.js';

/**
 * Durable ownership of the pull request validation ProPR cancelled for a
 * follow-up implementation. The row survives worker retries and crashes, so the
 * obligation to restart or drop that validation is never lost.
 */

export const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
export const SUSPENSION_ACTIVE = 'active';
export const SUSPENSION_RESTORING = 'restoring';

export interface CiSuspensionRecord {
    repository: string;
    pull_request: number;
    head_sha: string;
    task_id: string;
    correlation_id: string | null;
    state: string;
    cancelled_runs: string;
    attempts: number;
    created_at: number;
    updated_at: number;
}

/** One cancelled run and whether its validation has already been brought back. */
export interface CancelledRun {
    id: number;
    name?: string;
    workflowId?: number;
    restarted?: boolean;
}

export interface CiSuspensionStoreDeps {
    database?: Knex;
    now?: () => number;
}

export function resolveDatabase(deps: CiSuspensionStoreDeps): Knex {
    return deps.database ?? (db as unknown as Knex);
}

export function nowMs(deps: CiSuspensionStoreDeps): number {
    return (deps.now ?? Date.now)();
}

export function repositoryKey(owner: string, repo: string): string {
    return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

export function splitRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}

export function targetOf(record: CiSuspensionRecord): SuspensionTarget {
    return { ...splitRepository(record.repository), pullRequestNumber: record.pull_request };
}

export function parseCancelledRuns(record: Pick<CiSuspensionRecord, 'cancelled_runs'>): CancelledRun[] {
    try {
        const parsed = JSON.parse(record.cancelled_runs) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is CancelledRun =>
            !!entry && typeof entry === 'object' && Number.isInteger((entry as CancelledRun).id));
    } catch {
        return [];
    }
}

export async function loadSuspensions(deps: CiSuspensionStoreDeps, filter?: { taskId: string }): Promise<CiSuspensionRecord[]> {
    const query = resolveDatabase(deps)<CiSuspensionRecord>(PR_CI_SUSPENSIONS_TABLE);
    return filter ? query.where({ task_id: filter.taskId }) : query.select('*');
}

export async function deleteSuspension(
    deps: CiSuspensionStoreDeps,
    record: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>,
): Promise<void> {
    await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository: record.repository, pull_request: record.pull_request })
        .delete();
}

export async function saveCancelledRuns(
    deps: CiSuspensionStoreDeps,
    record: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>,
    runs: CancelledRun[],
    changes: Partial<Pick<CiSuspensionRecord, 'state' | 'attempts'>> = {},
): Promise<void> {
    await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository: record.repository, pull_request: record.pull_request })
        .update({ cancelled_runs: JSON.stringify(runs), updated_at: nowMs(deps), ...changes });
}

/**
 * Persists ownership before the first cancellation, so a crash can never lose
 * it. Runs recorded for another head belong to an obsolete revision and must
 * not be restarted; only the same head's cancellations carry over across
 * worker retries of the same implementation.
 */
export async function reserveSuspension(
    params: { target: SuspensionTarget; headSha: string; taskId: string; correlationId?: string },
    deps: CiSuspensionStoreDeps,
): Promise<CancelledRun[]> {
    const { target, headSha, taskId, correlationId } = params;
    const repository = repositoryKey(target.owner, target.repo);
    const existing = await resolveDatabase(deps)<CiSuspensionRecord>(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository, pull_request: target.pullRequestNumber })
        .first();
    const timestamp = nowMs(deps);
    const inherited = existing && sameSha(existing.head_sha, headSha) ? parseCancelledRuns(existing) : [];
    await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .insert({
            repository,
            pull_request: target.pullRequestNumber,
            head_sha: headSha,
            task_id: taskId,
            correlation_id: correlationId ?? null,
            state: SUSPENSION_ACTIVE,
            cancelled_runs: JSON.stringify(inherited),
            attempts: 0,
            created_at: existing?.created_at ?? timestamp,
            updated_at: timestamp,
        })
        .onConflict(['repository', 'pull_request'])
        .merge(['head_sha', 'task_id', 'correlation_id', 'state', 'cancelled_runs', 'attempts', 'updated_at']);
    return inherited;
}
