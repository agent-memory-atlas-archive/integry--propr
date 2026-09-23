/**
 * What every follow-up CI suspension operation needs: the GitHub client, the
 * logger, the validation workflow policy and the waiting primitive. Tests
 * replace any of them; production resolves the defaults lazily.
 */

import { getAuthenticatedOctokit, getCancelCiDuringFollowupWorkflowsForRepository, logger } from '@propr/core';
import type { CiSuspensionOctokit } from './followupCiSuspensionRuns.js';
import { resolveValidationWorkflowPolicy, type ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';
import type { SuspensionLeaseDeps } from './followupCiSuspensionLease.js';

export interface SuspensionLogger {
    debug(details: Record<string, unknown>, message: string): void;
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
}

export interface CiSuspensionDeps extends SuspensionLeaseDeps {
    octokit?: CiSuspensionOctokit;
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getTaskState?: (taskId: string) => Promise<{ state: string } | null>;
    /** Which workflows the repository selected; defaults to the stored repository configuration. */
    loadSelectedWorkflows?: (owner: string, repo: string) => Promise<string[]>;
    /** A resolved policy, for callers and tests that already know the selection. */
    workflowPolicy?: ValidationWorkflowPolicy;
    log?: SuspensionLogger;
    restoreBudgetMs?: number;
    pollIntervalMs?: number;
}

const defaultLogger: SuspensionLogger = logger as unknown as SuspensionLogger;

export async function resolveOctokit(deps: CiSuspensionDeps): Promise<CiSuspensionOctokit> {
    return deps.octokit ?? (await getAuthenticatedOctokit() as unknown as CiSuspensionOctokit);
}

export function resolveLog(deps: CiSuspensionDeps): SuspensionLogger {
    return deps.log ?? defaultLogger;
}

/**
 * The workflows this repository's operator selected. Nothing is inferred: with
 * no repository selection the documented environment fallback is consulted, and
 * with neither, the resulting policy selects nothing at all.
 */
export async function resolvePolicy(
    deps: CiSuspensionDeps,
    target: { owner: string; repo: string },
): Promise<ValidationWorkflowPolicy> {
    if (deps.workflowPolicy) return deps.workflowPolicy;
    const loadSelected = deps.loadSelectedWorkflows ?? getCancelCiDuringFollowupWorkflowsForRepository;
    return resolveValidationWorkflowPolicy(await loadSelected(target.owner, target.repo));
}

export function delay(deps: CiSuspensionDeps, ms: number): Promise<void> {
    if (deps.sleep) return deps.sleep(ms);
    return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}
