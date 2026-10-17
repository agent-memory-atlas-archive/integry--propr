import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import type { CommentJobData, UnprocessedComment } from '@propr/core';
import type { PullRequestGitTarget } from './prGitTarget.js';

/**
 * Durable follow-up publication handoff. One row per pull request, written
 * before the agent launches and kept until the owed commit/push/completion
 * comment publication is proven done. Every write is fenced by the generation
 * and incarnation it was read at, so duplicate recovery passes and stale
 * workers can never overwrite or finalize a newer owner's obligation.
 */

export const PR_FOLLOWUP_HANDOFFS_TABLE = 'pr_followup_handoffs';

export const HANDOFF_ACTIVE = 'active';
/** Preserved, never auto-published: cancellation or missing evidence needs an operator decision. */
export const HANDOFF_AWAITING_OPERATOR = 'awaiting_operator';
export const HANDOFF_RELEASED = 'released';

export const HANDOFF_PHASES = ['agent_running', 'agent_exited', 'committed', 'pushed', 'comment_published', 'cleanup_pending'] as const;
export type FollowupHandoffPhase = typeof HANDOFF_PHASES[number];

export interface FollowupHandoffRecord {
    repository: string;
    pull_request: number;
    task_id: string;
    source_task_ids: string;
    correlation_id: string | null;
    target_repository: string;
    branch_name: string;
    is_fork: number;
    worktree_path: string;
    local_repo_path: string;
    claimed_comments: string;
    job_data: string;
    llm: string | null;
    phase: string;
    /** 1 = agent exited with full success, 0 = stopped short, null = unknown (not exited, or lost). */
    agent_completed?: number | null;
    status: string;
    status_reason: string | null;
    operator_authorized: number;
    starting_comment_id: number | null;
    commit_hash: string | null;
    completion_comment_url: string | null;
    head_ref: string | null;
    base_ref: string | null;
    head_sha: string | null;
    container_id: string | null;
    successor_task_id: string | null;
    lock_key: string;
    lock_token: string;
    generation: number;
    incarnation: string;
    created_at: number;
    updated_at: number;
}

export interface FollowupHandoffStoreDeps {
    database?: Knex;
    now?: () => number;
}

export interface FollowupHandoffKey {
    repository: string;
    pull_request: number;
}

function database(deps: FollowupHandoffStoreDeps): Knex {
    return deps.database ?? (db as unknown as Knex);
}

function nowMs(deps: FollowupHandoffStoreDeps): number {
    return (deps.now ?? Date.now)();
}

export function handoffRepositoryKey(owner: string, repo: string): string {
    return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

export function parseClaimedComments(record: Pick<FollowupHandoffRecord, 'claimed_comments'>): UnprocessedComment[] {
    try {
        const parsed = JSON.parse(record.claimed_comments) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is UnprocessedComment => !!entry && typeof entry === 'object')
            : [];
    } catch {
        return [];
    }
}

export function parseSourceTaskIds(record: Pick<FollowupHandoffRecord, 'source_task_ids'>): string[] {
    try {
        const parsed = JSON.parse(record.source_task_ids) as unknown;
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

export function parseHandoffJobData(record: Pick<FollowupHandoffRecord, 'job_data'>): Partial<CommentJobData> {
    try {
        const parsed = JSON.parse(record.job_data) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Partial<CommentJobData> : {};
    } catch {
        return {};
    }
}

export async function loadFollowupHandoff(
    deps: FollowupHandoffStoreDeps,
    key: FollowupHandoffKey,
): Promise<FollowupHandoffRecord | undefined> {
    return database(deps)<FollowupHandoffRecord>(PR_FOLLOWUP_HANDOFFS_TABLE)
        .where({ repository: key.repository, pull_request: key.pull_request })
        .first();
}

export async function loadFollowupHandoffs(
    deps: FollowupHandoffStoreDeps,
    filter?: { status?: string },
): Promise<FollowupHandoffRecord[]> {
    const query = database(deps)<FollowupHandoffRecord>(PR_FOLLOWUP_HANDOFFS_TABLE);
    return filter?.status ? query.where({ status: filter.status }) : query.select('*');
}

export interface RecordFollowupHandoffParams {
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number };
    taskId: string;
    sourceTaskIds: string[];
    correlationId?: string;
    target: PullRequestGitTarget;
    worktreePath: string;
    localRepoPath: string;
    claimedComments: UnprocessedComment[];
    jobData: CommentJobData;
    llm: string | null | undefined;
    lockKey: string;
    lockToken: string;
    startingCommentId?: number;
    /** PR head/base refs and the worktree HEAD the agent builds on, revalidated before any recovery push. */
    binding?: { headRef?: string | null; baseRef?: string | null; headSha?: string | null };
}

/**
 * An unresolved predecessor obligation must never be erased by a new attempt:
 * only a released row, or this same task's own redelivery, may be taken over.
 * Anything else settles through recovery or an explicit operator decision.
 */
function handoffReplaceable(existing: FollowupHandoffRecord, taskId: string): boolean {
    return existing.status === HANDOFF_RELEASED
        || (existing.task_id === taskId && existing.status === HANDOFF_ACTIVE);
}

/**
 * Records the handoff before the agent launches. Takes over any previous row
 * for the pull request only at the generation it was read at: the caller holds
 * the PR processing lease, and a recoverable predecessor must already have
 * been adopted, so what remains here is either nothing or a finished row.
 */
export async function recordFollowupHandoff(
    params: RecordFollowupHandoffParams,
    deps: FollowupHandoffStoreDeps = {},
): Promise<FollowupHandoffRecord | null> {
    const repository = handoffRepositoryKey(params.ref.repoOwner, params.ref.repoName);
    const key = { repository, pull_request: params.ref.pullRequestNumber };
    const existing = await loadFollowupHandoff(deps, key);
    if (existing && !handoffReplaceable(existing, params.taskId)) return null;
    const timestamp = nowMs(deps);
    const record: FollowupHandoffRecord = {
        ...key,
        task_id: params.taskId,
        source_task_ids: JSON.stringify([...new Set(params.sourceTaskIds)]),
        correlation_id: params.correlationId ?? null,
        target_repository: handoffRepositoryKey(params.target.repoOwner, params.target.repoName),
        branch_name: params.target.branchName,
        is_fork: params.target.isFork ? 1 : 0,
        worktree_path: params.worktreePath,
        local_repo_path: params.localRepoPath,
        claimed_comments: JSON.stringify(params.claimedComments),
        job_data: JSON.stringify(params.jobData),
        llm: params.llm ?? null,
        phase: 'agent_running',
        // Explicit, not omitted: taking over a released row updates only the
        // columns written here, and a predecessor's agent success must never
        // become evidence for this incarnation's agent.
        agent_completed: null,
        status: HANDOFF_ACTIVE,
        status_reason: null,
        operator_authorized: 0,
        starting_comment_id: params.startingCommentId ?? null,
        commit_hash: null,
        completion_comment_url: null,
        head_ref: params.binding?.headRef ?? null,
        base_ref: params.binding?.baseRef ?? null,
        head_sha: params.binding?.headSha ?? null,
        container_id: null,
        successor_task_id: null,
        lock_key: params.lockKey,
        lock_token: params.lockToken,
        generation: (existing?.generation ?? 0) + 1,
        incarnation: randomUUID(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    const written = existing
        ? await takeOverHandoff(deps, existing, record)
        : await insertHandoff(deps, record);
    return written ? record : null;
}

async function takeOverHandoff(
    deps: FollowupHandoffStoreDeps,
    existing: FollowupHandoffRecord,
    record: FollowupHandoffRecord,
): Promise<boolean> {
    const { repository, pull_request, ...columns } = record;
    void repository;
    void pull_request;
    const updated = await database(deps)(PR_FOLLOWUP_HANDOFFS_TABLE)
        .where({
            repository: existing.repository,
            pull_request: existing.pull_request,
            task_id: existing.task_id,
            generation: existing.generation,
            incarnation: existing.incarnation,
        })
        .update(columns);
    return updated > 0;
}

async function insertHandoff(deps: FollowupHandoffStoreDeps, record: FollowupHandoffRecord): Promise<boolean> {
    try {
        await database(deps)(PR_FOLLOWUP_HANDOFFS_TABLE).insert(record);
        return true;
    } catch (error) {
        // Only a row that exists now explains the failure as a conflicting
        // insertion; anything else is a real database error.
        const conflicting = await loadFollowupHandoff(deps, record);
        if (conflicting) return false;
        throw error;
    }
}

export type FollowupHandoffChanges = Partial<Pick<FollowupHandoffRecord,
    'phase' | 'agent_completed' | 'status' | 'status_reason' | 'operator_authorized'
    | 'commit_hash' | 'completion_comment_url' | 'starting_comment_id' | 'lock_token'
    | 'container_id' | 'successor_task_id'>>;

/**
 * Writes the next phase or status of the row the caller read, returning the
 * record at its new generation, or null when the row moved on without this
 * caller. Callers must continue with the returned record.
 */
export async function advanceFollowupHandoff(
    deps: FollowupHandoffStoreDeps,
    record: FollowupHandoffRecord,
    changes: FollowupHandoffChanges,
): Promise<FollowupHandoffRecord | null> {
    const next: FollowupHandoffRecord = {
        ...record,
        ...changes,
        updated_at: nowMs(deps),
        generation: record.generation + 1,
    };
    const updated = await database(deps)(PR_FOLLOWUP_HANDOFFS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
            incarnation: record.incarnation,
        })
        .update({
            ...changes,
            updated_at: next.updated_at,
            generation: next.generation,
        });
    return updated > 0 ? next : null;
}

/**
 * Records a diagnostic status reason without advancing the record's
 * generation. Discovery-time diagnostics run before any lease is held, so they
 * must never invalidate a live owner's generation-fenced publication
 * checkpoints; the incarnation match still keeps the write off a newer row.
 */
export async function recordFollowupHandoffDiagnostic(
    deps: FollowupHandoffStoreDeps,
    record: Pick<FollowupHandoffRecord, 'repository' | 'pull_request' | 'task_id' | 'incarnation'>,
    statusReason: string,
): Promise<boolean> {
    const updated = await database(deps)(PR_FOLLOWUP_HANDOFFS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            incarnation: record.incarnation,
        })
        .update({ status_reason: statusReason, updated_at: nowMs(deps) });
    return updated > 0;
}

/**
 * Deletes the handoff only while it is still the one the caller read, so a
 * stale finalizer can never drop a newer task's obligation.
 */
export async function finalizeFollowupHandoff(
    deps: FollowupHandoffStoreDeps,
    record: Pick<FollowupHandoffRecord, 'repository' | 'pull_request' | 'task_id' | 'generation' | 'incarnation'>,
): Promise<boolean> {
    const deleted = await database(deps)(PR_FOLLOWUP_HANDOFFS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
            incarnation: record.incarnation,
        })
        .delete();
    return deleted > 0;
}
