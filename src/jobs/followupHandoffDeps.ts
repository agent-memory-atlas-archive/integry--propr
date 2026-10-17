import {
    getAuthenticatedOctokit, getStateManager, inspectTaskContainerLivenessForTask, logger, TaskStates,
} from '@propr/core';
import type { UnprocessedComment } from '@propr/core';
import type { PRProcessingLockRedisClient } from './prProcessingLock.js';
import { restorePendingComments } from './prPendingComments.js';
import { createFollowupHandoffGitOps, type FollowupHandoffGitOps } from './followupHandoffGitOps.js';
import { splitHandoffRepository, type HandoffOctokit, type HandoffStateManager, type HandoffTaskStates, type LoggerLike } from './followupHandoffResume.js';
import { recordFollowupHandoffDiagnostic, type FollowupHandoffRecord, type FollowupHandoffStoreDeps } from './followupHandoffStore.js';

/** Shared dependency resolution for follow-up handoff recovery and operator actions. */

export type HandoffRedis = PRProcessingLockRedisClient & { lrange?: unknown; quit?(): Promise<unknown> };

export interface TaskContainerInspection {
    liveness: string;
    container?: { id: string; name: string } | null;
}

export interface FollowupHandoffRecoveryDeps {
    store?: FollowupHandoffStoreDeps;
    redis?: HandoffRedis;
    log?: LoggerLike;
    stateManager?: HandoffStateManager;
    getOctokit?: () => Promise<HandoffOctokit>;
    inspectLiveness?: (taskId: string) => Promise<TaskContainerInspection>;
    git?: FollowupHandoffGitOps;
    restoreComments?: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    taskStates?: HandoffTaskStates;
    /** PR lease heartbeat cadence while recovery owns a handoff; tests shorten it. */
    heartbeatIntervalMs?: number;
}

export interface ResolvedRecoveryDeps {
    store: FollowupHandoffStoreDeps;
    redis: HandoffRedis;
    ownRedis: boolean;
    log: LoggerLike;
    stateManager: HandoffStateManager;
    getOctokit: () => Promise<HandoffOctokit>;
    inspectLiveness: (taskId: string) => Promise<TaskContainerInspection>;
    git: FollowupHandoffGitOps;
    restoreComments: (record: FollowupHandoffRecord, comments: UnprocessedComment[]) => Promise<void>;
    taskStates: HandoffTaskStates;
    heartbeatIntervalMs?: number;
}

export async function resolveRecoveryDeps(deps: FollowupHandoffRecoveryDeps): Promise<ResolvedRecoveryDeps> {
    const log = deps.log ?? logger as unknown as LoggerLike;
    let redis = deps.redis;
    let ownRedis = false;
    if (!redis) {
        // Recovery must read the same Redis the workers use for leases and
        // pending comments: the shared runtime configuration carries the URL,
        // credentials, TLS and database selection, not just host and port.
        // (Lazy imports: test suites replace @propr/core with enumerated mocks.)
        const [{ Redis }, { buildRedisRuntimeConfig }] = await Promise.all([import('ioredis'), import('@propr/core')]);
        const { url, options } = buildRedisRuntimeConfig();
        redis = (url ? new Redis(url, options) : new Redis(options)) as unknown as HandoffRedis;
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
        heartbeatIntervalMs: deps.heartbeatIntervalMs,
    };
}

/**
 * The agent container found for the task must be the one the handoff bound at
 * launch. A different or additional container under the same task label is
 * ambiguous evidence, so recovery fails closed instead of trusting it.
 */
export function containerIdentityConflict(
    record: Pick<FollowupHandoffRecord, 'container_id'>,
    inspection: TaskContainerInspection,
): string | null {
    if (!record.container_id || !inspection.container) return null;
    return inspection.container.id === record.container_id ? null : 'container_identity_mismatch';
}

export async function recordFailedClosed(
    record: FollowupHandoffRecord,
    deps: Pick<ResolvedRecoveryDeps, 'store' | 'log'>,
    reason = 'liveness_unavailable',
): Promise<void> {
    deps.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, reason },
        'Agent container evidence is unavailable or ambiguous; failing closed and leaving the handoff untouched');
    if (record.status_reason !== reason) {
        // Diagnostic only: this runs without the PR lease, so it must not
        // advance the generation and invalidate a live owner's checkpoints.
        await recordFollowupHandoffDiagnostic(deps.store, record, reason);
    }
}
