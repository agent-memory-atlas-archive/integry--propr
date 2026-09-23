/**
 * What every follow-up CI suspension operation needs: the GitHub client, the
 * logger, the validation workflow policy and the waiting primitive. Tests
 * replace any of them; production resolves the defaults lazily.
 */

import { getAuthenticatedOctokit, logger } from '@propr/core';
import type { CiSuspensionOctokit } from './followupCiSuspensionRuns.js';
import { loadValidationWorkflowPolicy, type ValidationWorkflowPolicy } from './followupCiSuspensionPolicy.js';
import type { CiSuspensionStoreDeps } from './followupCiSuspensionStore.js';

export interface SuspensionLogger {
    debug(details: Record<string, unknown>, message: string): void;
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
}

export interface CiSuspensionDeps extends CiSuspensionStoreDeps {
    octokit?: CiSuspensionOctokit;
    isEnabled?: (owner: string, repo: string) => Promise<boolean>;
    getTaskState?: (taskId: string) => Promise<{ state: string } | null>;
    /** Which workflows may be cancelled; defaults to the documented policy read from the environment. */
    workflowPolicy?: ValidationWorkflowPolicy;
    log?: SuspensionLogger;
    sleep?: (ms: number) => Promise<void>;
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

export function resolvePolicy(deps: CiSuspensionDeps): ValidationWorkflowPolicy {
    return deps.workflowPolicy ?? loadValidationWorkflowPolicy();
}

export function delay(deps: CiSuspensionDeps, ms: number): Promise<void> {
    if (deps.sleep) return deps.sleep(ms);
    return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}
