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
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PlanItem } from '../../claude/prompts/plannerPrompts.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';
import logger from '../../utils/logger.js';
import { PlanningFailedError } from '../planning/index.js';
import type { SyntheticRoutingSession } from '../syntheticRoutingService.js';
import { PLAN_FILE, PLAN_TASKS_DIR, PLAN_VALIDATOR_FILE, PLAN_VALIDATOR_SCRIPT, validatePlanTaskFiles, validatePlanText } from './planValidation.js';

const execFileAsync = promisify(execFile);

/**
 * Agent containers bind the workspace by host path, so it must live where the
 * API and the Docker daemon see the same files (see the worktree root).
 */
export function planWorkspaceRoot(): string {
  return process.env.PROPR_PLAN_WORKSPACE_ROOT || '/tmp/git-processor/plan-workspaces';
}

/**
 * The workspace or agent could not be set up, or the agent task threw before
 * it could produce anything. Unlike an invalid plan, this says nothing about
 * the model's output, so callers may fall back to another way of running it.
 */
export class PlanFileAgentUnavailableError extends PlanningFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PlanFileAgentUnavailableError';
  }
}

// Bounds on what is read back from an agent-writable workspace.
const MAX_TASK_FILES = 200;
const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
/**
 * Plan agents take one turn per task file plus validator runs, more than the
 * shipped CLAUDE_MAX_TURNS=10; the validator and the task timeout bound them.
 */
export const PLAN_AGENT_MAX_TURNS = 200;

/** Content of a regular file in the workspace; never follows a symlink out of it. */
async function readWorkspaceFile(file: string): Promise<string | null> {
  const stats = await lstat(file).catch(() => null);
  if (!stats || !stats.isFile() || stats.size > MAX_WORKSPACE_FILE_BYTES) return null;
  return readFile(file, 'utf8');
}

async function readTaskFiles(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter(name => name.endsWith('.json')).sort().slice(0, MAX_TASK_FILES);
  const files: Record<string, string> = {};
  for (const name of names) {
    const content = await readWorkspaceFile(path.join(directory, name));
    if (content !== null) files[name] = content;
  }
  return files;
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
  /**
   * The agent writes one task object per file under `tasks/` instead of a
   * single plan.json, so no single tool call has to hold the whole plan.
   */
  taskFiles?: boolean;
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

// The registry, model aliases and log helpers open database and queue
// connections when first loaded; loading them on use keeps planning modules
// (and their tests) free of those side effects until an agent actually runs.
async function resolveAgent(model: string, routingSession?: SyntheticRoutingSession) {
  const { resolveModelAlias } = await import('../../config/modelAliases.js');
  const separator = model.indexOf(':');
  const alias = separator === -1 ? null : model.slice(0, separator);
  const modelName = separator === -1 ? model : model.slice(separator + 1);
  if (routingSession) return { runner: routingSession, model: resolveModelAlias(modelName) };
  const { AgentRegistry } = await import('../../agents/AgentRegistry.js');
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const agent = alias ? registry.getAgentByAlias(alias) : registry.getDefaultAgent();
  if (!agent) throw new PlanningFailedError(`No enabled agent can run ${model}.`);
  return { runner: agent, model: resolveModelAlias(modelName) };
}

export async function runPlanFileAgent(options: PlanFileAgentOptions): Promise<PlanItem[]> {
  const { purpose, prompt, files = {}, original, taskFiles = false, model, draftId, repository, githubToken, executionType, correlationId, metadata, routingSession } = options;
  const log = correlationId ? logger.withCorrelation(correlationId) : logger;
  const root = planWorkspaceRoot();
  const workspace = await mkdir(root, { recursive: true })
    .then(() => mkdtemp(path.join(root, `${purpose}-`)))
    .catch(error => { throw new PlanFileAgentUnavailableError(`Could not create a plan workspace under ${root}: ${(error as Error).message}`); });
  try {
    try {
      await writeFile(path.join(workspace, PLAN_VALIDATOR_FILE), PLAN_VALIDATOR_SCRIPT);
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(workspace, name), content);
      if (taskFiles) await mkdir(path.join(workspace, PLAN_TASKS_DIR));
    } catch (error) {
      throw new PlanFileAgentUnavailableError(`Could not prepare the plan workspace: ${(error as Error).message}`);
    }
    // Some agent CLIs refuse to run outside a git repository.
    await execFileAsync('git', ['init', '-q'], { cwd: workspace }).catch(() => undefined);

    const { runner, model: resolvedModel } = await resolveAgent(model, routingSession).catch(error => {
      throw new PlanFileAgentUnavailableError((error as Error).message);
    });
    const { buildAnalysisWorkRef, withTaskLogAttribution } = await import('../../utils/llmLogger.js');
    const [repoOwner = 'unknown', repoName = 'unknown'] = repository.split('/');
    log.info({ purpose, model, workspace, taskFiles }, 'Running plan file agent');
    const result = await runner.executeTask({
      worktreePath: workspace,
      issueRef: { number: 0, repoOwner, repoName },
      prompt,
      githubToken,
      model: resolvedModel,
      taskId: draftId,
      maxTurns: PLAN_AGENT_MAX_TURNS,
      metadata: withTaskLogAttribution({ ...metadata, planFileAgent: purpose }, {
        executionType,
        workRef: buildAnalysisWorkRef(executionType, draftId, repository),
      }),
    }).catch(error => {
      // Usage limits drive requeueing upstream and must keep their type.
      if ((error as Error)?.name === 'UsageLimitError') throw error;
      throw new PlanFileAgentUnavailableError(`Plan ${purpose} agent could not run: ${(error as Error).message}`);
    });

    const agentFailure = result.success ? '' : ` The agent reported: ${(result.error || 'execution failed').slice(0, 300)}`;
    // Never trust the workspace copy of the validator or of the original.
    let planText: string | null;
    let report;
    if (taskFiles) {
      const written = await readTaskFiles(path.join(workspace, PLAN_TASKS_DIR));
      if (Object.keys(written).length === 0) throw new PlanningFailedError(`Plan ${purpose} wrote no task files to ${PLAN_TASKS_DIR}/.${agentFailure}`);
      ({ planText, ...report } = await validatePlanTaskFiles(written));
    } else {
      planText = await readWorkspaceFile(path.join(workspace, PLAN_FILE));
      if (planText === null) throw new PlanningFailedError(`Plan ${purpose} produced no ${PLAN_FILE}.${agentFailure}`);
      report = await validatePlanText(planText, original);
    }
    if (!report.valid) {
      log.warn({ purpose, model, errors: report.errors.slice(0, 10) }, 'Plan file agent result failed validation');
      throw new PlanningFailedError(`Plan ${purpose} did not produce a valid plan: ${report.errors.slice(0, 3).join('; ')}.${agentFailure}`);
    }
    log.info({ purpose, model, taskCount: report.taskCount }, 'Plan file agent produced a valid plan');
    return JSON.parse(planText!) as PlanItem[];
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(error => {
      log.warn({ workspace, error: (error as Error).message }, 'Failed to remove plan workspace');
    });
  }
}
