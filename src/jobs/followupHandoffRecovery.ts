import { randomUUID } from 'node:crypto';
import {
    getAuthenticatedOctokit, getStateManager, inspectTaskContainerLivenessForTask, logger, TaskStates,
} from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import {
    adoptPRProcessingLock, releasePRProcessingLock, type PRProcessingLockRedisClient,
} from './prProcessingLock.js';
import { restorePendingComments } from './prPendingComments.js';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, handoffRepositoryKey, loadFollowupHandoff, loadFollowupHandoffs,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED,
    type FollowupHandoffKey, type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';
import {
    createFollowupHandoffGitOps, reportHandoffOnTaskTimeline, resumeFollowupHandoff, splitHandoffRepository,
    type FollowupHandoffGitOps, type HandoffOctokit, type HandoffStateManager, type HandoffTaskStates,
    type LoggerLike, type ResumeOutcome,
} from './followupHandoffResume.js';

/**
 * Discovers follow-up publication handoffs a worker restart interrupted and
 * finishes their owed publication exactly once. Discovery distinguishes a
 * still-live agent container from an exited or lost one, fails closed when
 * liveness cannot be determined, serializes with every other writer under the
 * pull request's processing lease, and never destroys retained worktrees.
 */

type HandoffRedis = PRProcessingLockRedisClient & { lrange?: unknown; quit?(): Promise<unknown> };

export interface FollowupHandoffRecoveryDeps {
    store?: FollowupHandoffStoreDeps;
    redis?: HandoffRedis;
    log?: LoggerLike;
    stateManager?: HandoffStateManager;
    getOctokit?: () => Promise<HandoffOctokit>;
    inspectLiveness?: (taskId: string) => Promise<{ liveness: string }>;
    git?: FollowupHandoffGitOps;
    restoreComments?: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    taskStates?: HandoffTaskStates;
}

interface ResolvedRecoveryDeps {
    store: FollowupHandoffStoreDeps;
    redis: HandoffRedis;
    ownRedis: boolean;
    log: LoggerLike;
    stateManager: HandoffStateManager;
    getOctokit: () => Promise<HandoffOctokit>;
    inspectLiveness: (taskId: string) => Promise<{ liveness: string }>;
    git: FollowupHandoffGitOps;
    restoreComments: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    taskStates: HandoffTaskStates;
}

async function resolveRecoveryDeps(deps: FollowupHandoffRecoveryDeps): Promise<ResolvedRecoveryDeps> {
    const log = deps.log ?? logger as unknown as LoggerLike;
    let redis = deps.redis;
    let ownRedis = false;
    if (!redis) {
        const { Redis } = await import('ioredis');
        redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null, enableReadyCheck: false,
        }) as unknown as HandoffRedis;
        ownRedis = true;
    }
    let octokit: Promise<HandoffOctokit> | undefined;
    const getOctokit = deps.getOctokit
        ?? (() => octokit ??= getAuthenticatedOctokit() as unknown as Promise<HandoffOctokit>);
    const git = deps.git ?? createFollowupHandoffGitOps(async () => {
        const client = await getOctokit();
        return (await client.auth({ type: 'installation' }) as { token: string }).token;
    });
    const resolvedRedis = redis;
    return {
        store: deps.store ?? {},
        redis: resolvedRedis,
        ownRedis,
        log,
        stateManager: deps.stateManager ?? getStateManager() as unknown as HandoffStateManager,
        getOctokit,
        inspectLiveness: deps.inspectLiveness ?? (taskId => inspectTaskContainerLivenessForTask(taskId)),
        git,
        restoreComments: deps.restoreComments ?? (async (record, comments) => {
            const { owner, repo } = splitHandoffRepository(record.repository);
            await restorePendingComments(comments, {
                repoOwner: owner, repoName: repo, pullRequestNumber: record.pull_request,
                redisClient: resolvedRedis as Parameters<typeof restorePendingComments>[1]['redisClient'],
            });
        }),
        taskStates: deps.taskStates ?? {
            COMPLETED: TaskStates.COMPLETED, FAILED: TaskStates.FAILED, CANCELLED: TaskStates.CANCELLED,
        },
    };
}

export interface FollowupHandoffRecoverySummary {
    inspected: number;
    published: number;
    noChanges: number;
    skippedLiveAgent: number;
    failedClosed: number;
    awaitingOperator: number;
    lockedByOtherWriter: number;
    errors: number;
}

/**
 * Finishes an adopted record under the pull request's processing lease. The
 * lease is taken over from the dead predecessor's recorded token only; a lease
 * some other writer holds, or one the recorded owner still renews, is left
 * alone and the record is retried on a later pass.
 */
async function adoptAndResume(
    record: FollowupHandoffRecord,
    deps: ResolvedRecoveryDeps,
    recoveredBy?: string,
): Promise<ResumeOutcome | { outcome: 'locked' }> {
    const successorToken = `handoff-recovery:${record.incarnation}:${randomUUID()}`;
    const adoption = await adoptPRProcessingLock(deps.redis, record.lock_key, { predecessorToken: record.lock_token, successorToken });
    if (adoption !== 'adopted') {
        deps.log.info({ repository: record.repository, pullRequest: record.pull_request, adoption },
            'Follow-up handoff lease is held by another writer; retrying on a later pass');
        return { outcome: 'locked' };
    }
    try {
        // Re-read under the lease: the row may have moved on while unlocked.
        const fresh = await loadFollowupHandoff(deps.store, record);
        if (!fresh || fresh.incarnation !== record.incarnation || fresh.generation !== record.generation
            || fresh.status !== HANDOFF_ACTIVE) {
            return { outcome: 'superseded' };
        }
        // Durable successor ownership: later passes adopt from this token, not the dead one's.
        const owned = await advanceFollowupHandoff(deps.store, fresh, { lock_token: successorToken });
        if (!owned) return { outcome: 'superseded' };
        return await resumeFollowupHandoff({
            record: owned, octokit: await deps.getOctokit(), git: deps.git,
            stateManager: deps.stateManager, restoreComments: deps.restoreComments,
            store: deps.store, log: deps.log, taskStates: deps.taskStates, recoveredBy,
        });
    } finally {
        await releasePRProcessingLock(deps.redis, record.lock_key, successorToken);
    }
}

async function recordFailedClosed(record: FollowupHandoffRecord, deps: ResolvedRecoveryDeps): Promise<void> {
    deps.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Agent container liveness is unavailable; failing closed and leaving the handoff untouched');
    if (record.status_reason !== 'liveness_unavailable') {
        await advanceFollowupHandoff(deps.store, record, { status_reason: 'liveness_unavailable' });
    }
}

/** One recovery pass over every active handoff; wired into worker startup and reconciliation. */
export async function recoverInterruptedFollowupHandoffs(
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<FollowupHandoffRecoverySummary> {
    const resolved = await resolveRecoveryDeps(deps);
    const summary: FollowupHandoffRecoverySummary = {
        inspected: 0, published: 0, noChanges: 0, skippedLiveAgent: 0,
        failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0,
    };
    try {
        const handoffs = await loadFollowupHandoffs(resolved.store, { status: HANDOFF_ACTIVE });
        for (const record of handoffs) {
            summary.inspected += 1;
            try {
                const { liveness } = await resolved.inspectLiveness(record.task_id);
                if (liveness === 'running') {
                    summary.skippedLiveAgent += 1;
                    await reportHandoffOnTaskTimeline({ stateManager: resolved.stateManager, log: resolved.log }, record, 'agent container is still running; waiting');
                    continue;
                }
                if (liveness !== 'stopped' && liveness !== 'not_found') {
                    summary.failedClosed += 1;
                    await recordFailedClosed(record, resolved);
                    continue;
                }
                const result = await adoptAndResume(record, resolved);
                if (result.outcome === 'published') summary.published += 1;
                else if (result.outcome === 'no_changes') summary.noChanges += 1;
                else if (result.outcome === 'awaiting_operator') summary.awaitingOperator += 1;
                else if (result.outcome === 'locked') summary.lockedByOtherWriter += 1;
            } catch (error) {
                summary.errors += 1;
                resolved.log.error({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, error: (error as Error).message },
                    'Failed to recover an interrupted follow-up handoff; it stays recorded for the next pass');
            }
        }
        return summary;
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface PredecessorAdoptionParams {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    currentTaskId: string;
    log: LoggerLike;
}

export type PredecessorAdoption =
    | { blocked: 'predecessor_agent_still_running' | 'predecessor_liveness_unavailable' }
    | { resumed?: ResumeOutcome };

/**
 * Serializes a redelivered or new follow-up behind its recoverable
 * predecessor. The caller already holds the pull request processing lease, so
 * the predecessor is finished here, in-line, before another worktree is
 * prepared. A still-live or unverifiable predecessor blocks the new writer.
 */
export async function adoptPredecessorFollowupHandoff(
    params: PredecessorAdoptionParams,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<PredecessorAdoption> {
    const resolved = await resolveRecoveryDeps(deps);
    try {
        const key: FollowupHandoffKey = {
            repository: handoffRepositoryKey(params.repoOwner, params.repoName),
            pull_request: params.pullRequestNumber,
        };
        const record = await loadFollowupHandoff(resolved.store, key);
        if (!record || record.status !== HANDOFF_ACTIVE) return {};
        const { liveness } = await resolved.inspectLiveness(record.task_id);
        if (liveness === 'running') return { blocked: 'predecessor_agent_still_running' };
        if (liveness !== 'stopped' && liveness !== 'not_found') {
            await recordFailedClosed(record, resolved);
            return { blocked: 'predecessor_liveness_unavailable' };
        }
        const recoveredBy = record.task_id === params.currentTaskId ? undefined : params.currentTaskId;
        const resumed = await resumeFollowupHandoff({
            record, octokit: await resolved.getOctokit(), git: resolved.git,
            stateManager: resolved.stateManager, restoreComments: resolved.restoreComments,
            store: resolved.store, log: resolved.log, taskStates: resolved.taskStates, recoveredBy,
        });
        params.log.info({ repository: record.repository, pullRequest: record.pull_request, predecessorTaskId: record.task_id, outcome: resumed.outcome },
            'Adopted a recoverable predecessor follow-up handoff before preparing a new worktree');
        return { resumed };
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface HandoffFailureSettlement {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    taskId: string;
    cancelled: boolean;
}

/**
 * Settles this attempt's handoff once the in-process error handler delivered
 * the owed failure comment and terminal state. A cancellation instead holds
 * the record (and its retained work) for an explicit operator decision.
 */
export async function settleFollowupHandoffAfterFailure(
    params: HandoffFailureSettlement,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<void> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, {
        repository: handoffRepositoryKey(params.repoOwner, params.repoName),
        pull_request: params.pullRequestNumber,
    });
    if (!record || record.task_id !== params.taskId || record.status !== HANDOFF_ACTIVE) return;
    if (params.cancelled) {
        await advanceFollowupHandoff(store, record, {
            status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user',
        });
        return;
    }
    await finalizeFollowupHandoff(store, record);
}

/** Re-arms a cancelled handoff for publication under explicit operator authority. */
export async function authorizeCancelledFollowupHandoff(
    key: FollowupHandoffKey,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<FollowupHandoffRecord | null> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, key);
    if (!record) return null;
    return advanceFollowupHandoff(store, record, {
        status: HANDOFF_ACTIVE, status_reason: 'operator_authorized', operator_authorized: 1,
    });
}

/**
 * Marks a handoff released so recovery stops attempting it. Never deletes the
 * worktree or any commits: it only detaches the worktree HEAD to free the
 * branch, and refuses even that while unpublished work exists unless the
 * operator forces it (files and commits stay in the worktree either way).
 */
export async function releaseFollowupHandoffRecord(
    key: FollowupHandoffKey,
    options: { force?: boolean },
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<{ released: boolean; reason?: string }> {
    const resolved = await resolveRecoveryDeps(deps);
    try {
        const record = await loadFollowupHandoff(resolved.store, key);
        if (!record) return { released: false, reason: 'not_found' };
        if (record.status === HANDOFF_RELEASED) return { released: true };
        const settled = await resolved.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path);
        if (!settled && !options.force) {
            return { released: false, reason: 'worktree_holds_unpublished_work' };
        }
        if (!settled && options.force) {
            const attachment = await resolved.git.worktreeAttachment(record.worktree_path, record.branch_name);
            if (attachment === 'attached') await resolved.git.detachWorktreeHead(record.worktree_path);
        }
        const advanced = await advanceFollowupHandoff(resolved.store, record, {
            status: HANDOFF_RELEASED, status_reason: options.force ? 'released_by_operator_force' : 'released_by_operator',
        });
        return { released: Boolean(advanced), reason: advanced ? undefined : 'superseded' };
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface FollowupHandoffStatus {
    record: FollowupHandoffRecord;
    liveness: string;
    nextAction: string;
}

function handoffNextAction(record: FollowupHandoffRecord, liveness: string): string {
    if (record.status === HANDOFF_RELEASED) return 'none';
    if (record.status === HANDOFF_AWAITING_OPERATOR) {
        return record.status_reason === 'cancelled_by_user'
            ? 'resume --authorize-cancelled to publish the cancelled work, or release to stop tracking it'
            : 'inspect the retained worktree, then resume or release';
    }
    if (liveness === 'running') return 'wait for the live agent container to exit';
    if (liveness !== 'stopped' && liveness !== 'not_found') return 'restore container runtime visibility; recovery fails closed until liveness is known';
    return 'automatic recovery will resume the missing publication phase';
}

/** Non-destructive status for the operator CLI and task timeline. */
export async function inspectFollowupHandoffs(
    deps: FollowupHandoffRecoveryDeps = {},
    key?: FollowupHandoffKey,
): Promise<FollowupHandoffStatus[]> {
    const store = deps.store ?? {};
    const inspectLiveness = deps.inspectLiveness ?? (taskId => inspectTaskContainerLivenessForTask(taskId));
    const records = key
        ? [await loadFollowupHandoff(store, key)].filter((record): record is FollowupHandoffRecord => Boolean(record))
        : await loadFollowupHandoffs(store);
    const statuses: FollowupHandoffStatus[] = [];
    for (const record of records) {
        const { liveness } = record.status === HANDOFF_ACTIVE
            ? await inspectLiveness(record.task_id)
            : { liveness: 'not_checked' };
        statuses.push({ record, liveness, nextAction: handoffNextAction(record, liveness) });
    }
    return statuses;
}
