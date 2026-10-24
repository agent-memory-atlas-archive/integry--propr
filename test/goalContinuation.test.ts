import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { GoalJobData } from '../packages/core/src/goalExports.ts';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.ts';
import { prepareContinuedGoal, type GoalContinuationOperations, type GoalPullRequestState } from '../src/jobs/goalContinuation.ts';
import { executePreparedGoal } from '../src/jobs/processGoalJob.ts';
import type { GoalRow } from '../src/jobs/goalAttemptState.ts';

let db: typeof import('../packages/core/src/db/connection.ts')['db'];
const worktrees: string[] = [];

before(async () => {
  const connection = await import('../packages/core/src/db/connection.ts');
  await connection.runMigrations();
  db = connection.db;
});

after(async () => {
  for (const dir of worktrees) fs.rmSync(dir, { recursive: true, force: true });
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
  const { closeEventPublisher } = await import('../packages/core/src/utils/eventPublisher.ts');
  await closeStateManager();
  await closeConnection();
  await closeEventPublisher();
});

function existingWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-continuation-'));
  worktrees.push(dir);
  return dir;
}

async function continuedGoal(id: string, overrides: Record<string, unknown> = {}): Promise<{ job: GoalJobData; goal: GoalRow }> {
  const job: GoalJobData = { goalId: id, taskId: `task-${id}`, repoOwner: 'acme', repoName: 'repo', generation: 4, claimId: `claim-${id}` };
  await db('goals').where({ goal_id: id }).delete();
  await db('goals').insert({
    goal_id: id, owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo', objective: 'Ship it',
    launch_strategy: 'direct', initial_prompt: '/goal Ship it', agent_id: 'codex-agent', agent_alias: 'codex',
    agent_type: 'codex', requested_model: 'gpt-5.6', desired_state: 'running', current_task_id: job.taskId,
    run_generation: job.generation, run_claim: job.claimId, claimed_at: db.fn.now(), session_id: 'thread-1',
    branch_name: 'goal/ship-it', worktree_path: existingWorktree(), continue_requested: true,
    final_pr_number: 379, final_pr_url: 'https://github.com/acme/repo/pull/379',
    ...overrides,
  });
  return { job, goal: await db('goals').where({ goal_id: id }).first() as GoalRow };
}

function operations(pull: GoalPullRequestState | null, rebuild?: () => Promise<string>) {
  const calls: string[] = [];
  const ops: GoalContinuationOperations = {
    readPullRequest: async (_repository, number) => { calls.push(`read:${number}`); return pull; },
    convertToDraft: async nodeId => { calls.push(`draft:${nodeId}`); },
    rebuildWorktree: async goal => {
      calls.push(`rebuild:${goal.branch_name}`);
      if (!rebuild) throw new Error('unexpected rebuild');
      return rebuild();
    },
  };
  return { ops, calls };
}

const openDraft: GoalPullRequestState = { state: 'open', merged: false, draft: true, nodeId: 'PR_1' };

test('a goal that was not continued is left untouched', async () => {
  const { job, goal } = await continuedGoal('goal-plain', { continue_requested: false });
  const { ops, calls } = operations(openDraft);
  assert.equal(await prepareContinuedGoal(job, goal, ops), goal);
  assert.deepEqual(calls, []);
});

test('an open draft PR and an existing worktree need no changes', async () => {
  const { job, goal } = await continuedGoal('goal-draft');
  const { ops, calls } = operations(openDraft);
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.equal(prepared.final_pr_number, 379);
  assert.deepEqual(calls, ['read:379']);
});

test('a merged PR continues on a fresh branch so merged commits are not proposed again', async () => {
  const { job, goal } = await continuedGoal('goal-merged');
  const { ops } = operations({ ...openDraft, state: 'closed', merged: true });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, null);
  assert.equal(prepared.worktree_path, null);
  assert.equal(prepared.final_pr_number, null);
  assert.equal(prepared.final_pr_url, null);
  assert.equal(prepared.session_id, 'thread-1', 'the provider session is kept');
});

test('a closed PR keeps the branch and drops the PR so a new draft is opened', async () => {
  const { job, goal } = await continuedGoal('goal-closed');
  const { ops } = operations({ ...openDraft, state: 'closed' });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.equal(prepared.final_pr_number, null);
});

test('a PR marked ready for review is converted back to a draft', async () => {
  const { job, goal } = await continuedGoal('goal-ready');
  const { ops, calls } = operations({ ...openDraft, draft: false, nodeId: 'PR_ready' });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.final_pr_number, 379);
  assert.deepEqual(calls, ['read:379', 'draft:PR_ready']);
});

test('an expired worktree is rebuilt from the remote branch', async () => {
  const missing = path.join(os.tmpdir(), `goal-continuation-missing-${Date.now()}`);
  const rebuilt = existingWorktree();
  const { job, goal } = await continuedGoal('goal-expired', { worktree_path: missing });
  const { ops, calls } = operations(openDraft, async () => rebuilt);
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.worktree_path, rebuilt);
  assert.equal(prepared.branch_name, 'goal/ship-it');
  assert.deepEqual(calls, ['read:379', 'rebuild:goal/ship-it']);
});

test('a deleted remote branch continues on a fresh branch', async () => {
  const missing = path.join(os.tmpdir(), `goal-continuation-gone-${Date.now()}`);
  const { job, goal } = await continuedGoal('goal-branch-gone', { worktree_path: missing });
  const { ops } = operations(openDraft, async () => { throw new Error("couldn't find remote ref goal/ship-it"); });
  const prepared = await prepareContinuedGoal(job, goal, ops);
  assert.equal(prepared.branch_name, null);
  assert.equal(prepared.worktree_path, null);
  assert.equal(prepared.final_pr_number, null);
});

test('the continued attempt tells the provider to re-arm, then clears the flag once it ran', async () => {
  const { job, goal } = await continuedGoal('goal-execute');
  const captured: AgentTaskOptions[] = [];
  const agent = {
    executeTask: async (options: AgentTaskOptions) => {
      captured.push(options);
      return { success: false, modelUsed: 'gpt-5.6', executionTimeMs: 1, logs: '', modifiedFiles: [] };
    },
  };
  await executePreparedGoal(job, {
    goal, agent, githubToken: 'token', worktree: { worktreePath: goal.worktree_path, branchName: goal.branch_name },
    pendingInput: null,
  } as never);

  assert.equal(captured[0].continueTerminalGoal, true);
  assert.equal(captured[0].resumeSessionId, 'thread-1');
  const stored = await db('goals').where({ goal_id: goal.goal_id }).first();
  assert.equal(Boolean(stored.continue_requested), false);
});
