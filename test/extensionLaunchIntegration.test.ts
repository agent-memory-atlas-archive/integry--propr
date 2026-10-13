import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { runRepositoryWorkflow } from '../src/jobs/repositoryWorkflow.js';
import { extensionLaunchIntegrationFixture } from './fixtures/extensionLaunchIntegration.js';
after(closeConnection);

test('the issue workflow captures the enforced policy before extension preparation', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const result = await runRepositoryWorkflow({ taskId: 'issue-extension-policy', repoOwner: 'acme', repoName: 'web', redisClient: {} as any, stateManager: { getTaskState: async () => ({ state: 'claude_execution' }) } as any, correlatedLogger: { warn() {} } as any },
    () => fixture.execute({ extensionProfile: fixture.selection, extensionActorId: '1', taskId: 'issue-extension-policy', issueRef: { repoOwner: 'acme', repoName: 'web', number: 1 }, worktreePath: '/unused', prompt: 'Check documentation', githubToken: '' }));
  assert.equal(result.success, true);
  assert.equal(fixture.captures(), 1);
});
