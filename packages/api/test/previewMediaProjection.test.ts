import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Request, Response } from 'express';
import { closeConnection, NotificationService, type RepoToMonitor } from '@propr/core';
import { parseNotification, TASK_UPDATE, trustedPreviewMedia, type Notification, type PublishedVisualPreview } from '@propr/shared';
import { createPreviewMediaReader, goalPreviewSource, projectNotificationPreviews, taskPreviewSource } from '../services/previewMediaProjection.js';
import { createRepositoryMediaRoutes } from '../routes/repositoryMediaRoutes.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import { createNotificationProjectionTestHarness, countNotificationEvents } from './notificationProjectionTestHarness.js';

after(closeConnection);
const url = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const body = (prefix: string) => `![unmarked](${url('ignored')})\n<!-- propr-visual-preview -->\n${Array.from({ length: 5 }, (_, i) => `### ${prefix} ${i}\n\n![Preview](${url(`${prefix}-${i}`)})\n`).join('\n')}`;
function fixture() {
  let repos = [
    { name: 'Acme/Web', enabled: true, baseBranch: 'main', visualPreview: { enabled: false, types: ['image'] } },
    { name: 'acme/web', enabled: true, baseBranch: 'dev', visualPreview: { enabled: true, types: ['image'] } },
    { name: 'acme/legacy', enabled: true },
  ] as RepoToMonitor[];
  const calls: number[] = [];
  const reader = createPreviewMediaReader({ loadRepos: async () => repos, getOctokit: async () => ({
    request: async (_route: string, params: { pull_number: number }) => {
      calls.push(params.pull_number);
      if (params.pull_number === 99) throw new Error('GitHub unavailable');
      return { data: { body: body(String(params.pull_number)) } };
    },
  }) as never });
  return { reader, calls, disable: () => { repos = repos.map(repo => ({ ...repo, visualPreview: { enabled: false, types: ['image'] } })); },
    legacy: () => { repos = repos.map(repo => { const legacy = { ...repo }; delete legacy.visualPreview; return legacy; }); } };
}

test('batch projections preserve branch-sharing, gate cached media, deduplicate reads and truncate rows', async () => {
  const { reader, calls, disable } = fixture();
  const sources = [
    { repository: ' ACME/Web ', prNumbers: [1, 1] },
    { repository: 'acme/web', prNumbers: [1] },
    { repository: 'acme/legacy', prNumbers: [2] },
    { repository: 'acme/disabled', prNumbers: [3] },
  ];
  const media = await reader.project(sources);
  assert.deepEqual(media.map(item => item.previews.length), [3, 3, 0, 0]);
  assert.deepEqual(calls, [1]);
  await reader.project(sources);
  assert.deepEqual(calls, [1]);
  disable();
  assert.deepEqual((await reader.project(sources)).map(item => item.previews), [[], [], [], []]);
  assert.deepEqual(calls, [1]);
});

test('strict published parser rejects unmarked, local, and untrusted Markdown; errors remain optional', async () => {
  const { reader } = fixture();
  assert.equal((await reader.project([{ repository: 'acme/web', prNumbers: [99] }]))[0].unavailable, true);
  const unsafe = createPreviewMediaReader({ loadRepos: async () => [{ name: 'acme/web', enabled: true, visualPreview: { enabled: true, types: ['image'] } }],
    getOctokit: async () => ({ request: async () => ({ data: { body: `![outside](${url('outside')})\n<!-- propr-visual-preview -->\n### Local\n\n![Local](.propr/previews/desktop.png)\n### Evil\n\n![Evil](https://evil.test/preview.png)\n### Query\n\n![Query](${url('query')}?secret=yes)\n### Valid\n\n![Image](${url('valid')})` } }) }) as never });
  assert.deepEqual((await unsafe.project([{ repository: 'acme/web', prNumbers: [1] }]))[0].previews.map(item => item.url), [url('valid')]);
  assert.deepEqual(trustedPreviewMedia([{ title: 'Evil', type: 'image', url: 'https://github.com.evil.test/user-attachments/assets/x' }]), []);
});

const notification = (kind = 'task', severity = 'success') => ({
  id: 'event-1', deduplicationKey: 'event-1', kind, severity,
  target: { type: kind, repository: 'acme/web', taskId: 'task-1', prNumber: 1 },
  title: 'Implementation completed', body: 'Ready to review', actions: ['dismiss'],
  occurredAt: '2026-09-13T12:00:00.000Z', createdAt: '2026-09-13T12:00:00.000Z', readAt: null, dismissedAt: null,
}) as Notification;

test('real implementation completion persists one PR event and projects one trusted preview only while enabled', async () => {
  const now = () => new Date('2026-09-13T12:00:00.000Z');
  const { database, projection } = await createNotificationProjectionTestHarness(now);
  const { reader, calls, disable, legacy } = fixture();
  try {
    await database('tasks').insert({
      task_id: 'implementation-1', repository: 'Acme/Web', issue_number: 2373,
      task_type: 'issue', initial_job_data: '{}',
    });
    await database('task_history').insert({
      task_id: 'implementation-1', state: 'completed', timestamp: now().toISOString(),
      metadata: JSON.stringify({ prResult: { prNumber: 1, prUrl: 'https://evil.test/secret' } }),
    });
    const payload = {
      eventType: TASK_UPDATE, taskId: 'implementation-1', state: 'completed',
      repository: 'Acme/Web', timestamp: now().toISOString(),
      metadata: { secret: 'never copy task metadata' },
    };
    await projection.projectTaskUpdate(payload);
    await projection.projectTaskUpdate(payload);
    assert.equal(await countNotificationEvents(database), 1);
    const service = new NotificationService({ database, now });
    const { notifications } = await service.listNotifications('member-user');
    assert.equal(notifications.length, 1);
    const [completion] = notifications;
    assert.equal(completion.kind, 'pull_request');
    assert.equal(completion.severity, 'info');
    assert.deepEqual(completion.target, { type: 'pull_request', repository: 'Acme/Web', prNumber: 1 });
    assert.deepEqual(completion.metadata, { completedImplementationTaskId: 'implementation-1' });
    assert.deepEqual(completion.actions, ['open_pr', 'dismiss']);
    assert.equal(completion.action?.href, 'https://github.com/Acme/Web/pull/1');
    // The immutable event retains its original PR even if the task subsequently changes.
    await database('tasks').where({ task_id: 'implementation-1' }).update({ pr_number: 88 });
    const [projected] = await projectNotificationPreviews(notifications, reader, database);
    assert.deepEqual(projected.previewMedia?.map(item => item.url), [url('1-0')]);
    assert.deepEqual(parseNotification(projected), projected);
    const unchanged = { ...projected };
    delete unchanged.previewMedia;
    assert.deepEqual(unchanged, completion);
    assert.deepEqual(calls, [1]);
    const overfull = Array.from({ length: 5 }, (_, i) => ({ title: `Image ${i}`, type: 'image', url: url(String(i)) }));
    assert.equal(parseNotification({ ...completion, previewMedia: overfull }).previewMedia?.length, 1);
    disable();
    assert.equal((await projectNotificationPreviews([projected], reader, database))[0].previewMedia, undefined);
    legacy();
    assert.equal((await projectNotificationPreviews([projected], reader, database))[0].previewMedia, undefined);
    assert.deepEqual(calls, [1]);
  } finally { projection.close(); await database.destroy(); }
});

test('unrelated notifications and malformed completion identities never fetch or retain thumbnails', async () => {
  const { reader, calls } = fixture();
  const pr = { ...notification(), kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'acme/web', prNumber: 1 } } as Notification;
  const unrelated: Notification[] = [
    pr,
    ...[null, false, 1, {}, [], '', '   '].map(taskId => ({ ...pr, metadata: { completedImplementationTaskId: taskId } })),
    { ...pr, severity: 'warning', metadata: { completedImplementationTaskId: 'task-1' } },
    notification('task', 'error'), notification('task', 'warning'),
    { ...pr, kind: 'review', severity: 'success', target: { type: 'review', repository: 'acme/web', prNumber: 1 } },
    { ...pr, kind: 'plan', target: { type: 'plan', repository: 'acme/web', draftId: 'draft-1' } },
    { ...pr, kind: 'indexing', target: { type: 'indexing', repository: 'acme/web' } },
    { ...pr, kind: 'system_failure', target: { type: 'system_failure', component: 'worker' } },
  ];
  const previews: PublishedVisualPreview[] = [{ type: 'image', title: 'Preview', url: url('injected') }];
  const injected = unrelated.map(item => ({ ...item, previewMedia: previews }));
  for (const item of injected) assert.equal(parseNotification(item).previewMedia, undefined);
  const projected = await projectNotificationPreviews(injected, reader);
  assert.ok(projected.every(item => item.previewMedia === undefined));
  assert.deepEqual(calls, []);
});

test('artifact sources use stored PR identities, including final results, and ignore cross-repository goal artifacts', () => {
  assert.deepEqual(taskPreviewSource({ repository: 'acme/web', final_result: JSON.stringify({ postProcessing: { pr: { number: 7 } } }) }).prNumbers, [7]);
  assert.deepEqual(goalPreviewSource({ repository: 'acme/web', final_pr_number: 7, artifact_refs: JSON.stringify([
    { type: 'pull_request', number: 8, url: 'https://github.com/acme/web/pull/8' },
    { type: 'pull_request', number: 9, url: 'https://github.com/other/repo/pull/9' },
  ]) }).prNumbers, [7, 8]);
});

function response() {
  const state: { status: number; body: { previews?: PublishedVisualPreview[]; unavailable?: boolean; nextOffset?: number | null; error?: string } } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: typeof state.body) { state.body = body; } } as Response;
  return { res, state };
}

test('repository gallery scopes tasks and owned goals, paginates, reports empty/unavailable, and skips disabled reads', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { reader, calls, disable } = fixture();
  try {
    await db.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type'); table.integer('pr_number');
      table.text('initial_job_data'); table.text('final_result'); table.string('created_at');
    });
    await db.schema.createTable('goals', table => {
      table.string('goal_id'); table.string('owner_id'); table.string('repository'); table.integer('final_pr_number');
      table.text('artifact_refs'); table.string('created_at');
    });
    await db('tasks').insert(Array.from({ length: 25 }, (_, i) => ({ task_id: String(i), repository: 'acme/web', pr_number: 1, created_at: '2026-09-13' })));
    await db('tasks').insert({ task_id: 'foreign', repository: 'other/repo', pr_number: 80 });
    await db('tasks').insert({ task_id: 'private-goal-task', repository: 'acme/web', task_type: 'goal', pr_number: 81 });
    await db('goals').insert([
      { goal_id: 'owned', owner_id: 'alice', repository: 'acme/web', final_pr_number: 2 },
      { goal_id: 'private', owner_id: 'bob', repository: 'acme/web', final_pr_number: 82 },
      { goal_id: 'failed-read', owner_id: 'alice', repository: 'acme/web', final_pr_number: 99 },
    ]);
    const route = createRepositoryMediaRoutes({ db, reader }).getMedia;
    const req = { user: { id: 'alice' }, query: { repository: 'acme/web' } } as unknown as Request;
    const first = response(); await route(req, first.res);
    assert.equal(first.state.body.previews?.length, 10);
    assert.equal(first.state.body.unavailable, true);
    assert.equal(first.state.body.nextOffset, 24);
    assert.deepEqual([...calls].sort((a, b) => a - b), [1, 2, 99]);
    const last = response(); await route({ ...req, query: { ...req.query, offset: '24' } } as Request, last.res);
    assert.equal(last.state.body.nextOffset, null);
    disable();
    const disabled = response(); await route(req, disabled.res);
    assert.deepEqual(disabled.state.body, { previews: [], nextOffset: null });
    const unauthenticated = response(); await route({ ...req, user: undefined } as Request, unauthenticated.res);
    assert.equal(unauthenticated.state.status, 401);
    const invalid = response(); await route({ ...req, query: { repository: '../web' } } as Request, invalid.res);
    assert.equal(invalid.state.status, 400);
  } finally { await db.destroy(); }
});

test('task list includes bounded media in the existing response and omits it after disabling', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const { reader, disable } = fixture();
  try {
    await db.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type'); table.integer('pr_number');
      table.text('initial_job_data'); table.text('final_result'); table.string('created_at'); table.integer('issue_number');
    });
    await db.schema.createTable('task_history', table => { table.string('task_id'); table.string('state'); table.string('timestamp'); table.string('reason'); });
    await db.schema.createTable('plan_issues', table => { table.string('task_id'); table.string('status'); });
    await db.schema.createTable('llm_executions', table => { table.string('task_id'); table.string('execution_id'); table.text('analysis_report'); });
    await db('tasks').insert({ task_id: 'task-1', repository: 'acme/web', pr_number: 1, created_at: '2026-09-13' });
    await db('task_history').insert({ task_id: 'task-1', state: 'completed', timestamp: '2026-09-13' });
    const olderNotification = notification();
    if (olderNotification.kind === 'task') delete olderNotification.target.prNumber;
    const inbox = await projectNotificationPreviews([olderNotification], reader, db);
    assert.equal(inbox[0].previewMedia?.length, 1);
    const query = { db, previewReader: reader, status: 'all', repository: 'all', offset: 0, limit: 10 };
    const result = await getTasksFromDb(query);
    assert.equal((result.tasks[0] as { previewMedia: unknown[] }).previewMedia.length, 3);
    disable();
    const disabled = await getTasksFromDb(query);
    assert.equal('previewMedia' in (disabled.tasks[0] as object), false);
  } finally { await db.destroy(); }
});
