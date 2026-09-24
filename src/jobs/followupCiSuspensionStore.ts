import type { Knex } from 'knex';
import { db } from '@propr/core';
import { sameSha, type SuspensionTarget } from './followupCiSuspensionRuns.js';

/**
 * Durable ownership of the pull request validation ProPR cancelled for a
 * follow-up implementation. The row survives worker retries and crashes, so the
 * obligation to restart or drop that validation is never lost.
 *
 * Every write carries the generation it was read at and the task that owns it,
 * so a slow operation working from a stale read can neither overwrite nor
 * delete the state of a newer owner: its update simply matches no row. Across
 * workers the operations of a single pull request are additionally serialized
 * by the shared lease in `followupCiSuspensionLease.ts`, which is what keeps
 * their external cancel and rerun requests from interleaving.
 */

export const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
export const SUSPENSION_ACTIVE = 'active';
export const SUSPENSION_RESTORING = 'restoring';
/** Restoration was refused by GitHub. The obligation stays recorded and every reconciliation retries it. */
export const SUSPENSION_BLOCKED = 'blocked';

export interface CiSuspensionRecord {
    repository: string;
    pull_request: number;
    head_sha: string;
    task_id: string;
    correlation_id: string | null;
    state: string;
    cancelled_runs: string;
    attempts: number;
    /** Incremented by every successful write; the optimistic-concurrency token of this row. */
    generation: number;
    created_at: number;
    updated_at: number;
}

/** One cancelled run and whether its validation has already been brought back. */
export interface CancelledRun {
    id: number;
    name?: string;
    workflowId?: number;
    /**
     * The attempt GitHub confirmed the cancellation affected; a higher one later
     * proves a rerun landed. Absent while that is unconfirmed — the request was
     * never answered, or the worker died before reading the run back — in which
     * case only the run's own outcome can settle the obligation.
     */
    attempt?: number;
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

export function suspensionKey(record: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>): string {
    return `${record.repository}#${record.pull_request}`;
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

/** Reads the row as it is right now; every operation starts from this inside the lock rather than from what it was handed. */
export async function loadSuspension(
    deps: CiSuspensionStoreDeps,
    key: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>,
): Promise<CiSuspensionRecord | undefined> {
    return resolveDatabase(deps)<CiSuspensionRecord>(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository: key.repository, pull_request: key.pull_request })
        .first();
}

/**
 * Deletes the suspension only while it is still the one the caller read.
 * Returns false when another owner or a newer generation took the row over, so
 * a stale finalizer can never drop a newer task's obligation.
 */
export async function deleteSuspension(
    deps: CiSuspensionStoreDeps,
    record: Pick<CiSuspensionRecord, 'repository' | 'pull_request' | 'task_id' | 'generation'>,
): Promise<boolean> {
    const deleted = await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
        })
        .delete();
    return deleted > 0;
}

/**
 * Writes the cancelled runs and any state change of the record the caller read,
 * returning the record at its new generation, or null when the row moved on
 * without this caller. Callers must continue with the returned record.
 */
export async function saveCancelledRuns(
    deps: CiSuspensionStoreDeps,
    record: CiSuspensionRecord,
    runs: CancelledRun[],
    changes: Partial<Pick<CiSuspensionRecord, 'state' | 'attempts'>> = {},
): Promise<CiSuspensionRecord | null> {
    const next: CiSuspensionRecord = {
        ...record,
        ...changes,
        cancelled_runs: JSON.stringify(runs),
        updated_at: nowMs(deps),
        generation: record.generation + 1,
    };
    const updated = await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
        })
        .update({
            cancelled_runs: next.cancelled_runs,
            updated_at: next.updated_at,
            generation: next.generation,
            state: next.state,
            attempts: next.attempts,
        });
    return updated > 0 ? next : null;
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
): Promise<{ record: CiSuspensionRecord; runs: CancelledRun[] }> {
    const { target, headSha, taskId, correlationId } = params;
    const repository = repositoryKey(target.owner, target.repo);
    const existing = await loadSuspension(deps, { repository, pull_request: target.pullRequestNumber });
    const timestamp = nowMs(deps);
    const runs = existing && sameSha(existing.head_sha, headSha) ? parseCancelledRuns(existing) : [];
    const record: CiSuspensionRecord = {
        repository,
        pull_request: target.pullRequestNumber,
        head_sha: headSha,
        task_id: taskId,
        correlation_id: correlationId ?? null,
        state: SUSPENSION_ACTIVE,
        cancelled_runs: JSON.stringify(runs),
        attempts: 0,
        // Taking the row over from any previous owner invalidates its in-flight writes.
        generation: (existing?.generation ?? 0) + 1,
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
    };
    await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .insert(record)
        .onConflict(['repository', 'pull_request'])
        .merge(['head_sha', 'task_id', 'correlation_id', 'state', 'cancelled_runs', 'attempts', 'generation', 'updated_at']);
    return { record, runs };
}
