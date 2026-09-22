import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { up } from '../src/db/migrations/20260922000000_add_task_submissions.js';
import { closeConnection } from '../src/db/connection.js';
import { insertTaskSubmission, resumeTaskSubmission, findIssueSubmission, materializeSubmissionAttachments, submissionAssetPath } from '../src/services/taskSubmissionService.js';
import { handleDispatchWithDeps } from '../../../src/jobs/issueJobDispatcher.js';
import type { IssueJobData } from '@propr/core';
import type { Job } from 'bullmq';

after(closeConnection);
const input = { user_id: 'alice', submission_key: 'request-1', payload_hash: 'hash', repository: 'owner/repo', payload: '{}', attachments: '[]' };
async function fixture() {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(database);
  return database;
}

test('concurrent submissions, response loss, dispatch retry and a late webhook converge on one issue and implementation', async () => {
  const database = await fixture();
  try {
    const rows = await Promise.all(Array.from({ length: 8 }, () => insertTaskSubmission(database, input)));
    assert.equal(new Set(rows.map(row => row.id)).size, 1);
    const row = rows[0];
    let creates = 0;
    let exists = false;
    let failDispatch = true;
    const children = new Map<string, IssueJobData>();
    const queuedOptions: Array<{ removeOnComplete: boolean }> = [];
    const deps = {
      resolveSubmissionRetry: async () => null,
      findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
      recordDispatch: async (id: string) => { await database('task_submissions').where({ id }).update({ dispatch_complete: true }); },
      recordDispatchFailure: async () => undefined,
      getAuthenticatedOctokit: async () => ({ request: async () => ({ data: { labels: [{ name: 'AI' }, { name: 'llm-chosen' }, { name: 'base-release' }] } }) }),
      withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
      validateRepositoryInfo: async () => ({ isValid: true, repoData: { defaultBranch: 'main' } }),
      resolveLlmLabel: async () => ({ agentAlias: 'issue-only-agent', model: 'chosen-model' }),
      getAllCustomLabels: async () => [], getDefaultModel: () => 'wrong-model',
      issueQueue: { add: async (_name: string, data: IssueJobData, options: { jobId: string; removeOnComplete: boolean }) => {
        children.set(options.jobId, data); queuedOptions.push(options);
      } },
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
    const dispatch = () => handleDispatchWithDeps({ id: 'parent', name: 'processGitHubIssue', data: { repoOwner: 'owner', repoName: 'repo', number: 17, userId: 'bot', correlationId: 'webhook' } } as Job<IssueJobData>, deps);
    const services = {
      createIssue: async () => { creates++; exists = true; throw new Error('Lost GitHub response after creation'); },
      reconcileIssue: async () => exists ? { number: 17, url: 'https://github.com/owner/repo/issues/17' } : null,
      dispatch: async () => {
        if (failDispatch) throw new Error('Queue unavailable');
        // Direct enqueue and webhook race through the SAME production dispatcher.
        await Promise.all([dispatch(), dispatch()]);
      },
    };
    await resumeTaskSubmission(database, row.id, services);
    const failed = await resumeTaskSubmission(database, row.id, services);
    assert.equal(failed.issue_number, 17);
    assert.equal(failed.state, 'failed');
    assert.equal(creates, 1);
    failDispatch = false;
    await Promise.all([resumeTaskSubmission(database, row.id, services), resumeTaskSubmission(database, row.id, services)]);
    assert.equal(children.size, 1);
    const child = [...children.values()][0];
    assert.equal(child.userId, 'alice');
    assert.equal(child.correlationId, row.id);
    assert.equal(child.baseBranch, 'release');
    assert.equal(child.agentAlias, 'issue-only-agent');
    assert.equal(child.modelName, 'chosen-model');
    assert.equal(child.isChildJob, true);
    assert.ok(queuedOptions.every(options => !options.removeOnComplete));
    // Completed jobs may disappear; the durable receipt still suppresses a late webhook.
    children.clear();
    assert.equal((await dispatch()).status, 'skipped');
    assert.equal(children.size, 0);
    assert.equal((await resumeTaskSubmission(database, row.id, services)).state, 'queued');
    assert.equal(creates, 1);
    await assert.rejects(insertTaskSubmission(database, { ...input, payload_hash: 'different' }), /different content/);
    const intentional = await insertTaskSubmission(database, { ...input, submission_key: 'new-request' });
    assert.notEqual(intentional.id, row.id);
  } finally { await database.destroy(); }
});

test('an ambiguous creation without a visible issue stays recoverable and never repeats creation', async () => {
  const database = await fixture();
  try {
    const row = await insertTaskSubmission(database, input);
    let creates = 0;
    const services = {
      createIssue: async () => { creates++; throw new Error('timeout'); },
      reconcileIssue: async () => null,
      dispatch: async () => { assert.fail('must not dispatch'); },
    };
    await Promise.all(Array.from({ length: 5 }, () => resumeTaskSubmission(database, row.id, services)));
    await resumeTaskSubmission(database, row.id, services);
    assert.equal(creates, 1);
    assert.equal((await database('task_submissions').first()).state, 'creating');
  } finally { await database.destroy(); }
});

test('durable attachment bytes reach the ordinary issue worktree without a goal or planner draft', async () => {
  const database = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-assets-'));
  try {
    const attachment = { id: 'file-id', extension: '.txt', originalName: 'expected.txt', mimeType: 'text/plain', content: Buffer.from('Expected invoice: 22/09/2026').toString('base64') };
    const row = await insertTaskSubmission(database, { ...input, attachments: JSON.stringify([attachment]) });
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 17 });
    await materializeSubmissionAttachments({ repoOwner: 'owner', repoName: 'repo', number: 17 }, root, database);
    assert.equal(await fs.readFile(path.join(root, submissionAssetPath(attachment, row.id)), 'utf8'), 'Expected invoice: 22/09/2026');
    assert.equal(await database.schema.hasTable('goals'), false);
    assert.equal(await database.schema.hasTable('task_drafts'), false);
  } finally { await fs.remove(root); await database.destroy(); }
});

test('a deliberate label retry after terminal work is distinct from delayed initial delivery', async () => {
  const { resolveTaskSubmissionRetry } = await import('../src/services/taskSubmissionRetry.js');
  const database = await fixture();
  try {
    await database.schema.createTable('task_history', table => { table.string('task_id'); table.string('state'); table.string('timestamp'); });
    const row = await insertTaskSubmission(database, { ...input, payload: JSON.stringify({ trigger: 'AI' }) });
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 17, task_id: 'initial-task', dispatch_complete: true });
    await database('task_history').insert({ task_id: 'initial-task', state: 'failed', timestamp: '2026-09-22T10:00:00Z' });
    let eventId = 1;
    let timestamp = '2026-09-22T09:59:00Z';
    const octokit = async () => ({ request: async () => ({ data: [{ id: eventId, event: 'labeled', created_at: timestamp, label: { name: 'AI' }, actor: { id: 123 } }] }) }) as never;
    const read = async () => (await database('task_submissions').first())!;
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit), null);
    eventId = 2; timestamp = '2026-09-22T10:01:00Z';
    assert.deepEqual(await resolveTaskSubmissionRetry(await read(), database, octokit), { eventId: '2', userId: '123' });
    await database('task_submissions').where({ id: row.id }).update({ retry_event_id: '2' });
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit), null);
    eventId = 3; timestamp = '2026-09-22T10:02:00Z';
    await database('task_history').insert({ task_id: 'initial-task', state: 'processing', timestamp: '2026-09-22T10:01:30Z' });
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit), null);
  } finally { await database.destroy(); }
});

test('a definitive GitHub rejection can retry creation with the same identity', async () => {
  const database = await fixture();
  try {
    const row = await insertTaskSubmission(database, input);
    let attempts = 0;
    const services = {
      createIssue: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('Installation cannot write issues'), { status: 403 });
        return { number: 18, url: 'https://github.com/owner/repo/issues/18' };
      },
      reconcileIssue: async () => null,
      dispatch: async () => undefined,
    };
    assert.equal((await resumeTaskSubmission(database, row.id, services)).state, 'prepared');
    const success = await resumeTaskSubmission(database, row.id, services);
    assert.equal(success.issue_number, 18);
    assert.equal(success.state, 'queued');
    assert.equal(attempts, 2);
  } finally { await database.destroy(); }
});
