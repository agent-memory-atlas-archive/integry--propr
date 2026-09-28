/**
 * Runs an agent that writes a plan to a file in a scratch workspace and checks
 * it with the plan validator until it passes.
 *
 * A plan held in a file does not depend on the agent's final chat message, so
 * it cannot be truncated at a message boundary, and the agent can fix its own
 * mistakes instead of re-emitting the whole plan. ProPR then validates the
 * file again with its own copy of the validator before accepting it.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import { resolveModelAlias } from '../../config/modelAliases.js';
import type { PlanItem } from '../../claude/prompts/plannerPrompts.js';
import { buildAnalysisWorkRef, withTaskLogAttribution } from '../../utils/llmLogger.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import logger from '../../utils/logger.js';
import { PlanningFailedError } from '../planning/index.js';
import type { SyntheticRoutingSession } from '../syntheticRoutingService.js';
import { PLAN_FILE, PLAN_VALIDATOR_FILE, PLAN_VALIDATOR_SCRIPT, validatePlanText } from './planValidation.js';

const execFileAsync = promisify(execFile);
const PLAN_FILE_AGENT_MAX_TURNS = 200;

/**
 * Agent containers bind the workspace by host path, so it must live where the
 * API and the Docker daemon see the same files (see the worktree root).
 */
export function planWorkspaceRoot(): string {
  return process.env.PROPR_PLAN_WORKSPACE_ROOT || '/tmp/git-processor/plan-workspaces';
}

export interface PlanFileAgentOptions {
  /** Workspace name prefix and log label. */
  purpose: 'generation' | 'repair';
  /** The whole task, including the file contract. */
  prompt: string;
  /** Extra workspace files, by name. */
  files?: Record<string, string>;
  /** Content the result must preserve (repair); validated against it. */
  original?: string;
  /** `agent:model`, as configured for planning. */
  model: string;
  draftId: string;
  repository: string;
  githubToken: string;
  executionType: ExecutionType;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  routingSession?: SyntheticRoutingSession;
}

async function resolveAgent(model: string, routingSession?: SyntheticRoutingSession) {
  const separator = model.indexOf(':');
  const alias = separator === -1 ? null : model.slice(0, separator);
  const modelName = separator === -1 ? model : model.slice(separator + 1);
  if (routingSession) return { runner: routingSession, model: resolveModelAlias(modelName) };
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const agent = alias ? registry.getAgentByAlias(alias) : registry.getDefaultAgent();
  if (!agent) throw new PlanningFailedError(`No enabled agent can run ${model}.`);
  return { runner: agent, model: resolveModelAlias(modelName) };
}

export async function runPlanFileAgent(options: PlanFileAgentOptions): Promise<PlanItem[]> {
  const { purpose, prompt, files = {}, original, model, draftId, repository, githubToken, executionType, correlationId, metadata, routingSession } = options;
  const log = correlationId ? logger.withCorrelation(correlationId) : logger;
  const root = planWorkspaceRoot();
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, `${purpose}-`));
  try {
    await writeFile(path.join(workspace, PLAN_VALIDATOR_FILE), PLAN_VALIDATOR_SCRIPT);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(workspace, name), content);
    // Some agent CLIs refuse to run outside a git repository.
    await execFileAsync('git', ['init', '-q'], { cwd: workspace }).catch(() => undefined);

    const { runner, model: resolvedModel } = await resolveAgent(model, routingSession);
    const [repoOwner = 'unknown', repoName = 'unknown'] = repository.split('/');
    log.info({ purpose, model, workspace }, 'Running plan file agent');
    const result = await runner.executeTask({
      worktreePath: workspace,
      issueRef: { number: 0, repoOwner, repoName },
      prompt,
      githubToken,
      model: resolvedModel,
      taskId: draftId,
      // Run, inspect, edit and re-validate; hosts may set a much lower default.
      maxTurns: PLAN_FILE_AGENT_MAX_TURNS,
      metadata: withTaskLogAttribution({ ...metadata, planFileAgent: purpose }, {
        executionType,
        workRef: buildAnalysisWorkRef(executionType, draftId, repository),
      }),
    });

    const planText = await readFile(path.join(workspace, PLAN_FILE), 'utf8').catch(() => null);
    const agentFailure = result.success ? '' : ` The agent reported: ${(result.error || 'execution failed').slice(0, 300)}`;
    if (planText === null) throw new PlanningFailedError(`Plan ${purpose} produced no ${PLAN_FILE}.${agentFailure}`);
    // Never trust the workspace copy of the validator or of the original.
    const report = await validatePlanText(planText, original);
    if (!report.valid) {
      log.warn({ purpose, model, errors: report.errors.slice(0, 10) }, 'Plan file agent result failed validation');
      throw new PlanningFailedError(`Plan ${purpose} did not produce a valid plan: ${report.errors.slice(0, 3).join('; ')}.${agentFailure}`);
    }
    log.info({ purpose, model, taskCount: report.taskCount }, 'Plan file agent produced a valid plan');
    return JSON.parse(planText) as PlanItem[];
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(error => {
      log.warn({ workspace, error: (error as Error).message }, 'Failed to remove plan workspace');
    });
  }
}
