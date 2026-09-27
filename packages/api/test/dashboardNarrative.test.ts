import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import { collectNarrativeFacts, createDashboardNarrative, IDLE_NARRATIVE, MAX_NARRATIVE_LENGTH } from '../routes/dashboardNarrative.js';
import { NOW, minutesAgo, createDashboardTestDatabase, clearDashboardTestDatabase, seedTask } from './dashboardTestHarness.js';

let db: Knex;
before(async () => {
  db = await createDashboardTestDatabase();
  await db.schema.createTable('goals', table => {
    for (const name of ['goal_id', 'owner_id', 'repository', 'title', 'desired_state', 'result_state', 'active_turn_id', 'failure_reason', 'completed_at']) table.string(name);
  });
  await db.schema.createTable('task_drafts', table => {
    for (const name of ['draft_id', 'user_id', 'repository', 'name', 'status']) table.string(name);
  });
});
after(async () => { await db.destroy(); });
beforeEach(async () => {
  await clearDashboardTestDatabase(db);
  await db('goals').del();
  await db('task_drafts').del();
});
const active = () => seedTask(db, { taskId: 'active', title: 'Improve retry handling', states: [{ state: 'processing', timestamp: minutesAgo(2) }] });

test('idle is deterministic and does not resolve or call a model', async () => {
  const narrative = createDashboardNarrative(async () => { throw new Error('Must not resolve'); });
  assert.equal(await narrative(await collectNarrativeFacts(db, 'all', NOW)), IDLE_NARRATIVE);
});

test('facts cover tasks, queue, blockers, completions, goals and plans without crossing owner or repository boundaries', async () => {
  await active();
  for (const [taskId, state] of [['queued', 'pending'], ['blocked', 'action_required'], ['done', 'completed']]) {
    await seedTask(db, { taskId, issueNumber: null, states: [{ state, timestamp: minutesAgo(10) }] });
  }
  await seedTask(db, { taskId: 'old', states: [{ state: 'completed', timestamp: minutesAgo(1500) }] });
  await seedTask(db, { taskId: 'other', repository: 'other/repo', states: [{ state: 'processing', timestamp: minutesAgo(5) }] });
  for (const [id, owner, repository] of [['mine', 'user', 'integry/propr'], ['private', 'another', 'integry/propr'], ['other-repo', 'user', 'other/repo']]) {
    await db('goals').insert({ goal_id: id, owner_id: owner, repository, title: id, desired_state: 'running', active_turn_id: id });
    await db('task_drafts').insert({ draft_id: id, user_id: owner, repository, name: id, status: 'generating' });
  }
  const snapshot = await collectNarrativeFacts(db, 'integry/propr', NOW, 'user');
  assert.equal(snapshot.idle, false);
  assert.deepEqual(snapshot.facts.counts, { running: 1, queued: 1, needsAttention: 1, completedRecently: 1, goals: 1, plans: 1 });
  assert.deepEqual(snapshot.facts.completed.map(row => row.id), ['done']);
  assert.deepEqual(snapshot.facts.goals.map(row => row.id), ['mine']);
  assert.deepEqual(snapshot.facts.plans.map(row => row.id), ['mine']);
  let prompt = '';
  await createDashboardNarrative(async () => ({ id: 'cheap', generate: async value => { prompt = value; return 'A summary.'; } }))(snapshot);
  for (const word of ['Improve retry handling', 'queued', 'blocked', 'done', 'mine', 'untrusted']) assert.ok(prompt.includes(word));
  assert.ok(!prompt.includes('private'));
});

test('two simultaneous browsers share generation; signatures change with activity, scope and model; refresh bypasses cache', async () => {
  await active();
  let calls = 0;
  let model = 'cheap';
  const narrative = createDashboardNarrative(async () => ({ id: model, generate: async () => { calls++; return `Summary ${calls}.`; } }));
  const snapshot = await collectNarrativeFacts(db, 'all', NOW);
  assert.deepEqual(await Promise.all([narrative(snapshot), narrative(snapshot)]), ['Summary 1.', 'Summary 1.']);
  assert.equal(await narrative(snapshot), 'Summary 1.');
  assert.equal(await narrative(snapshot, true), 'Summary 2.');
  assert.equal(await narrative(await collectNarrativeFacts(db, 'integry/propr', NOW)), 'Summary 3.');
  model = 'new-model';
  assert.equal(await narrative(snapshot), 'Summary 4.');
  await db('tasks').where({ task_id: 'active' }).update({ initial_job_data: JSON.stringify({ title: 'Changed work' }) });
  assert.equal(await narrative(await collectNarrativeFacts(db, 'all', NOW)), 'Summary 5.');
});

test('missing model, empty responses and model failures are unavailable and retryable', async () => {
  await active();
  const snapshot = await collectNarrativeFacts(db, 'all', NOW);
  assert.equal(await createDashboardNarrative(async () => null)(snapshot), null);
  let fails = true;
  const narrative = createDashboardNarrative(async () => ({ id: 'cheap', generate: async () => {
    if (fails) throw new Error('Unavailable');
    return 'Recovered.';
  } }));
  assert.equal(await narrative(snapshot), null);
  fails = false;
  assert.equal(await narrative(snapshot), 'Recovered.');
  assert.equal(await createDashboardNarrative(async () => ({ id: 'cheap', generate: async () => '  ' }))(snapshot), null);
});

test('output length is bounded server-side and whitespace is flattened', async () => {
  await active();
  const narrative = createDashboardNarrative(async () => ({ id: 'cheap', generate: async () => '\nRunning\n' + 'work '.repeat(500) }));
  const summary = await narrative(await collectNarrativeFacts(db, 'all', NOW));
  assert.ok(summary && summary.length <= MAX_NARRATIVE_LENGTH);
  assert.ok(summary.startsWith('Running work'));
  assert.ok(!summary.includes('\n'));
});

test('model adapter uses only the configured summarization model and never resolves an empty setting', async (t) => {
  let alias = '';
  let resolutions = 0;
  let requested: Record<string, unknown> | undefined;
  t.mock.module('@propr/core', {
    namedExports: {
      loadSummarizationSettings: async () => ({ agent_alias: alias }),
      resolveConfiguredModel: async (configured: string) => { resolutions++; return configured; },
      runLightweightLLMAnalysis: async (options: Record<string, unknown>) => { requested = options; return 'Generated prose.'; },
    },
  });
  const { dashboardNarrativeModel } = await import('../routes/dashboardNarrativeModel.js');
  assert.equal(await dashboardNarrativeModel(), null);
  assert.equal(resolutions, 0);
  assert.equal(requested, undefined);
  alias = '  cheap-agent:small-model  ';
  const model = await dashboardNarrativeModel();
  assert.equal(model?.id, 'cheap-agent:small-model');
  assert.equal(await model?.generate('Only these facts.', 'integry/propr'), 'Generated prose.');
  assert.equal(requested?.model, 'cheap-agent:small-model');
  assert.equal(requested?.prompt, 'Only these facts.');
  assert.equal(requested?.executionType, 'summarization');
});
