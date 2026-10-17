import { randomUUID } from 'node:crypto';
import { inspectTaskContainerLivenessForTask } from '@propr/core';
import { adoptPRProcessingLock, releasePRProcessingLock } from './prProcessingLock.js';
import {
    containerIdentityConflict, recordFailedClosed, resolveRecoveryDeps,
    type FollowupHandoffRecoveryDeps, type TaskContainerInspection,
} from './followupHandoffDeps.js';
import {
    advanceFollowupHandoff, loadFollowupHandoff, loadFollowupHandoffs, parseSourceTaskIds,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED,
    type FollowupHandoffKey, type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';
import type { FollowupHandoffGitOps } from './followupHandoffGitOps.js';

/**
 * Operator actions over durable follow-up publication handoffs, exposed
 * through the admin API and the packaged CLI. None of them delete retained
 * worktrees or commits, and every mutation serializes under the pull request's
 * processing lease with the recorded agent proven gone first.
 */

/** Re-arms a cancelled, operator-held handoff for publication under explicit operator authority. */
export async function authorizeCancelledFollowupHandoff(
    key: FollowupHandoffKey,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<FollowupHandoffRecord | null> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, key);
    if (!record || record.status !== HANDOFF_AWAITING_OPERATOR) return null;
    return advanceFollowupHandoff(store, record, {
        status: HANDOFF_ACTIVE, status_reason: 'operator_authorized', operator_authorized: 1,
    });
}

export interface OperatorResumeResult { resumed: boolean; reason?: string }

/**
 * Reactivates an operator-held handoff after its blocking condition was
 * repaired (for example a restored worktree registration), without granting
 * cancelled-work publication authority: a cancellation hold still requires the
 * explicit authorization step.
 */
export async function resumeOperatorHeldFollowupHandoff(
    key: FollowupHandoffKey,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<OperatorResumeResult> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, key);
    if (!record) return { resumed: false, reason: 'not_found' };
    if (record.status === HANDOFF_ACTIVE) return { resumed: true };
    if (record.status !== HANDOFF_AWAITING_OPERATOR) return { resumed: false, reason: 'released' };
    if (record.status_reason === 'cancelled_by_user' && !record.operator_authorized) {
        return { resumed: false, reason: 'requires_cancellation_authorization' };
    }
    const advanced = await advanceFollowupHandoff(store, record, {
        status: HANDOFF_ACTIVE, status_reason: 'operator_resumed',
    });
    return advanced ? { resumed: true } : { resumed: false, reason: 'superseded' };
}

/**
 * Refusal reason while any linked worktree registration still holds the
 * branch, or when the registrations cannot be read; null once it is free.
 */
async function branchReleaseRefusal(
    git: FollowupHandoffGitOps,
    record: FollowupHandoffRecord,
): Promise<'branch_still_registered' | 'worktree_registrations_unavailable' | null> {
    try {
        const holders = await git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name);
        return holders.length > 0 ? 'branch_still_registered' : null;
    } catch {
        return 'worktree_registrations_unavailable';
    }
}

/**
 * Marks a handoff released so recovery stops attempting it. Never deletes the
 * worktree or any commits: it only detaches the worktree HEAD to free the
 * branch, and refuses even that while unpublished work exists unless the
 * operator forces it (files and commits stay in the worktree either way).
 * The row is marked released only once no Git worktree registration holds the
 * branch any more; otherwise the obligation stays and the refusal names why.
 * The mutation runs only with the recorded agent proven gone and under the
 * pull request's processing lease, so it can never detach a live writer.
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
        const inspection = await resolved.inspectLiveness(record.task_id);
        const identityConflict = containerIdentityConflict(record, inspection);
        if (identityConflict) {
            await recordFailedClosed(record, resolved, identityConflict);
            return { released: false, reason: identityConflict };
        }
        if (inspection.liveness === 'running') return { released: false, reason: 'agent_still_running' };
        if (inspection.liveness !== 'stopped' && inspection.liveness !== 'not_found') {
            // Unverifiable liveness refuses even a forced release: a separate
            // explicit stop procedure must settle the agent first.
            return { released: false, reason: 'liveness_unavailable' };
        }
        const successorToken = `handoff-release:${record.incarnation}:${randomUUID()}`;
        const adoption = await adoptPRProcessingLock(resolved.redis, record.lock_key, {
            predecessorToken: record.lock_token, successorToken,
        });
        if (adoption !== 'adopted') return { released: false, reason: 'lease_held_by_live_writer' };
        try {
            const settled = await resolved.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path);
            if (!settled && !options.force) {
                return { released: false, reason: 'worktree_holds_unpublished_work' };
            }
            if (!settled && options.force) {
                const attachment = await resolved.git.worktreeAttachment(record.worktree_path, record.branch_name);
                if (attachment === 'attached') await resolved.git.detachWorktreeHead(record.worktree_path);
            }
            // Permission to attempt the release is not proof it happened: a
            // removed directory whose Git registration survives still holds
            // the branch, and admission ignores a released row. The
            // repository's own registrations must show the branch free.
            const refusal = await branchReleaseRefusal(resolved.git, record);
            if (refusal) return { released: false, reason: refusal };
            const advanced = await advanceFollowupHandoff(resolved.store, record, {
                status: HANDOFF_RELEASED, status_reason: options.force ? 'released_by_operator_force' : 'released_by_operator',
            });
            return { released: Boolean(advanced), reason: advanced ? undefined : 'superseded' };
        } finally {
            await releasePRProcessingLock(resolved.redis, record.lock_key, successorToken);
        }
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface FollowupHandoffStatus {
    record: FollowupHandoffRecord;
    liveness: string;
    nextAction: string;
    predecessorTaskIds: string[];
    successorTaskId: string | null;
}

function handoffNextAction(record: FollowupHandoffRecord, liveness: string): string {
    if (record.status === HANDOFF_RELEASED) return 'none';
    if (record.status === HANDOFF_AWAITING_OPERATOR) {
        return record.status_reason === 'cancelled_by_user'
            ? 'resume --authorize-cancelled to publish the cancelled work, or release to stop tracking it'
            : 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it';
    }
    if (record.phase === 'cleanup_pending') return 'publication is complete; automatic recovery retries the branch release';
    if (liveness === 'running') return 'wait for the live agent container to exit';
    if (liveness !== 'stopped' && liveness !== 'not_found') return 'restore container runtime visibility; recovery fails closed until liveness is known';
    return 'automatic recovery will resume the missing publication phase';
}

/** Non-destructive status for the operator CLI/API and task timeline. */
export async function inspectFollowupHandoffs(
    deps: FollowupHandoffRecoveryDeps = {},
    key?: FollowupHandoffKey,
): Promise<FollowupHandoffStatus[]> {
    const store: FollowupHandoffStoreDeps = deps.store ?? {};
    const inspectLiveness = deps.inspectLiveness
        ?? ((taskId: string): Promise<TaskContainerInspection> => inspectTaskContainerLivenessForTask(taskId));
    const records = key
        ? [await loadFollowupHandoff(store, key)].filter((record): record is FollowupHandoffRecord => Boolean(record))
        : await loadFollowupHandoffs(store);
    const statuses: FollowupHandoffStatus[] = [];
    for (const record of records) {
        const { liveness } = record.status === HANDOFF_ACTIVE
            ? await inspectLiveness(record.task_id)
            : { liveness: 'not_checked' };
        statuses.push({
            record, liveness, nextAction: handoffNextAction(record, liveness),
            predecessorTaskIds: parseSourceTaskIds(record),
            successorTaskId: record.successor_task_id,
        });
    }
    return statuses;
}
