import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { USAGE_TIPS_CATALOG, USAGE_TIPS_DAY_MS as DAY, usageTipCooldownDays, isUsageTipEligible,
  resolveUsageTips, rotateUsageTipCandidates, isUsageTipsCooldownDays } from '@propr/shared';
import { createUsageTipsStore } from '../src/services/usageTips/store.js';
import { selectUsageTips, heuristicUsageTipCandidates } from '../src/services/usageTips/selection.js';
import { collectUsageTipSignals, usageSignalTimestamp } from '../src/services/usageTips/signals.js';
import { up, down } from '../src/db/migrations/20260928000000_add_usage_tips.js';

const candidates = USAGE_TIPS_CATALOG.slice(0, 6).map(t => ({ id: t.id, score: 85, reason: 'Recorded usage gap.' }));
const selection = { candidates, signals: {}, model: null, source: 'heuristic' as const, generatedAt: 100, rotationEpoch: 0 };
async function fixture(run: (database: ReturnType<typeof knex>) => Promise<void>) {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await database.schema.createTable('system_configs', t => { t.string('key').primary(); t.text('value'); });
    await up(database);
    await run(database);
  } finally { await database.destroy(); }
}

test('progressive finite cooldowns, exact boundary, current settings, no dismissal eligibility', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9999].map(n => usageTipCooldownDays(45, n)), [45, 180, 720, 2880, 3650, 3650]);
  const dismissal = { tip_id: candidates[0].id, dismissed_at: 1000, dismissal_count: 1 };
  assert.equal(isUsageTipEligible(undefined, 45, 1000), true);
  assert.equal(isUsageTipEligible(dismissal, 45, 1000 + 45 * DAY - 1), false);
  assert.equal(isUsageTipEligible(dismissal, 45, 1000 + 45 * DAY), true);
  assert.equal(isUsageTipEligible(dismissal, 90, 1000 + 45 * DAY), false);
  assert.equal(isUsageTipEligible(dismissal, 1, 1000 + DAY), true);
  for (const invalid of [null, true, '45', 0, 366, 1.1, Infinity, NaN]) assert.equal(isUsageTipsCooldownDays(invalid), false);
});

test('eligibility and unknown-ID filtering happen before cap; sole candidates recur forever', () => {
  const dismissals = candidates.slice(0, 3).map(c => ({ tip_id: c.id, dismissed_at: 0, dismissal_count: 1 }));
  const pool = [{ id: 'removed', score: 100, reason: 'old' }, ...candidates];
  assert.deepEqual(resolveUsageTips(pool, dismissals, 45, 1).map(t => t.id), candidates.slice(3).map(c => c.id));
  assert.deepEqual(resolveUsageTips(pool, dismissals, 45, 45 * DAY).map(t => t.id), candidates.slice(0, 3).map(c => c.id));
  for (let epoch = 0; epoch < 10; epoch++) assert.equal(resolveUsageTips(rotateUsageTipCandidates([candidates[0]], epoch), [], 45, epoch * DAY).length, 1);
});

test('rotation preserves ten-point bands and varies the first three within a band', () => {
  const pool = [...candidates, { id: 'goals-launch', score: 100, reason: 'Highly relevant' }, { id: 'agent-tank', score: 80, reason: 'Lower band' }];
  const first = rotateUsageTipCandidates(pool, 0);
  assert.deepEqual(first, rotateUsageTipCandidates(pool.reverse(), 0));
  assert.equal(first[0].id, 'goals-launch');
  assert.equal(first.at(-1)?.id, 'agent-tank');
  assert.notDeepEqual(first.slice(1, 4), rotateUsageTipCandidates(pool, 1).slice(1, 4));
});

test('atomic durable deduplication, concurrency, isolation, expiry and read-only reads', async () => fixture(async db => {
  let now = 1000;
  let store = createUsageTipsStore(db, () => now);
  assert.equal(await store.persist(selection, null), true);
  assert.equal(await store.persist(selection, null), false);
  const event = randomUUID();
  await Promise.all([store.dismiss('alice', candidates[0].id, event), store.dismiss('alice', candidates[0].id, event)]);
  now += DAY;
  store = createUsageTipsStore(db, () => now); // simulates restarting the service
  await store.dismiss('alice', candidates[0].id, event);
  let dismissal = await db('usage_tip_dismissals').first();
  assert.equal(dismissal.dismissal_count, 1);
  assert.equal(dismissal.dismissed_at, 1000);
  await assert.rejects(store.dismiss('alice', candidates[1].id, event));
  assert.equal((await store.get('alice')).tips.some(t => t.id === candidates[0].id), false);
  assert.equal((await store.get('bob')).tips[0].id, candidates[0].id);
  now = 1000 + 45 * DAY;
  assert.equal((await store.get('alice')).tips[0].id, candidates[0].id);
  await Promise.all([store.dismiss('alice', candidates[0].id, randomUUID()), store.dismiss('alice', candidates[0].id, randomUUID())]);
  dismissal = await db('usage_tip_dismissals').first();
  assert.equal(dismissal.dismissal_count, 3);
  assert.equal(dismissal.dismissed_at, now);
  now += 720 * DAY;
  assert.equal((await store.get('alice')).tips[0].id, candidates[0].id);
  const queries: string[] = [];
  db.on('query', q => queries.push(q.sql));
  await store.get('alice');
  await store.get('bob');
  assert.ok(queries.every(q => /^select /i.test(q)), queries.join('\n'));
  assert.ok(queries.every(q => !/count\(|join |llm_logs|task_history/i.test(q)));
  assert.equal((await db('usage_tip_dismissals').first()).dismissal_count, 3);
  await db('system_configs').where({ key: 'usage_tips_enabled' }).update({ value: 'false' });
  assert.deepEqual(await store.get('alice'), { enabled: false, tips: [] });
}));

test('migration seeds defaults, rollback owns only its keys, and constraints protect storage', async () => fixture(async db => {
  await db('system_configs').insert({ key: 'unrelated', value: '7' });
  assert.deepEqual(await createUsageTipsStore(db).settings(), { enabled: true, cooldownDays: 45 });
  await assert.rejects(db('usage_tip_selection').insert({ id: 2, candidates: '[]', signals: '{}', source: 'heuristic', generated_at: 0, rotation_epoch: 0 }));
  await down(db);
  assert.deepEqual(await db('system_configs'), [{ key: 'unrelated', value: '7' }]);
  await db('system_configs').insert({ key: 'usage_tips_dismissal_cooldown_days', value: '60' });
  await up(db);
  assert.equal((await createUsageTipsStore(db).settings()).cooldownDays, 60);
}));

test('event insertion rolls back if dismissal update fails', async () => fixture(async db => {
  await db.raw("CREATE TRIGGER fail_dismissal BEFORE INSERT ON usage_tip_dismissals BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const store = createUsageTipsStore(db);
  const event = randomUUID();
  await assert.rejects(store.dismiss('alice', candidates[0].id, event));
  assert.equal((await db('usage_tip_dismissal_events')).length, 0);
  await db.raw('DROP TRIGGER fail_dismissal');
  await store.dismiss('alice', candidates[0].id, event);
  assert.equal((await db('usage_tip_dismissals').first()).dismissal_count, 1);
}));

test('model validation, fallback, deterministic heuristics, valid empty and exclusions', async () => {
  const signals = { tasks: 12, manualCycles: 4, ultrafix: 0, oneOffTasks: 8, goals: 0, plans: 0, indexingFailures: 2, review: 8 };
  const aliases: string[] = [];
  const options = { signals, epoch: 3, agentAlias: 'primary', fallbackAgentAlias: 'fallback', now: () => 99 };
  const result = await selectUsageTips({ ...options, generate: async alias => {
    aliases.push(alias);
    if (alias === 'primary') return { text: '{"candidates":[{"id":"pr-ultrafix","score":101,"reason":"bad"}]}', model: alias };
    return { text: JSON.stringify({ candidates: [
      { id: 'unknown', score: 1, reason: 'unknown' },
      { id: 'pr-review', score: 100, reason: 'Must be excluded: used regularly' },
      { id: 'pr-ultrafix', score: 90, reason: 'Repeated manual cycles' },
      { id: 'pr-ultrafix', score: 91, reason: 'duplicate' },
    ] }), model: alias };
  } });
  assert.deepEqual(aliases, ['primary', 'fallback']);
  assert.equal(result.source, 'model');
  assert.deepEqual(result.candidates.map(c => c.id), ['pr-ultrafix']);
  const empty = await selectUsageTips({ ...options, generate: async () => ({ text: '{"candidates":[]}', model: 'primary' }) });
  assert.equal(empty.source, 'model'); assert.deepEqual(empty.candidates, []);
  const heuristic = await selectUsageTips({ ...options, generate: async () => { throw new Error('offline'); } });
  assert.equal(heuristic.source, 'heuristic');
  assert.deepEqual(heuristic.candidates, rotateUsageTipCandidates(heuristicUsageTipCandidates(signals), 3));
  for (const key of ['pr-ultrafix', 'goals-launch', 'planner-studio', 'indexing-options']) assert.ok(heuristic.candidates.some(c => c.id === key));
  assert.deepEqual(heuristicUsageTipCandidates({}), []);
  assert.deepEqual(heuristicUsageTipCandidates({ tasks: 50, goals: 5, plans: 5, oneOffTasks: 20, review: 10, fix: 10, ultrafix: 5, manualCycles: 10 }), []);
});

test('personalized model advice survives persistence and replaces catalog copy without changing identity', async () => fixture(async db => {
  const reason = 'Automate repeated manual review and fix runs with /ultrafix to reduce the commands you need to send. Recent activity shows little /ultrafix use.';
  const selected = await selectUsageTips({
    signals: { manualCycles: 4, ultrafix: 0 }, epoch: 0,
    generate: async (_alias, prompt) => {
      assert.match(prompt, /reason is the user-facing tip body/);
      assert.match(prompt, /why this tip is being displayed/);
      assert.match(prompt, /how it could improve their workflow/);
      assert.match(prompt, /installation-wide aggregates/);
      assert.match(prompt, /"manualCycles":4/);
      return { text: JSON.stringify({ candidates: [{ id: 'pr-ultrafix', score: 95, reason }] }), model: 'test-model' };
    },
  });
  const store = createUsageTipsStore(db);
  await store.persist(selected, null);
  const catalogTip = USAGE_TIPS_CATALOG.find(t => t.id === 'pr-ultrafix')!;
  assert.deepEqual((await store.get('alice')).tips, [{ ...catalogTip, body: reason }]);
  assert.notEqual(catalogTip.body, reason);
  await store.dismiss('alice', catalogTip.id, randomUUID());
  assert.deepEqual((await store.get('alice')).tips, []);
}));

test('offline advice explains the observed workflow and benefit, including slow-only indexing', async () => {
  const selected = await selectUsageTips({ signals: { indexingSlow: 2, indexingFailures: null }, epoch: 0,
    generate: async () => { throw new Error('offline'); } });
  const [tip] = resolveUsageTips(selected.candidates, [], 45, Date.now());
  assert.match(tip.body, /Indexing calls are taking at least two minutes/);
  assert.match(tip.body, /keep repository context available for your tasks/);
  assert.doesNotMatch(tip.body, /failures/);
  assert.equal(selected.source, 'heuristic');
});

test('guarded bounded signals handle real SQLite tables and mixed timestamps', async () => fixture(async db => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const missing = await collectUsageTipSignals(db, now);
  assert.equal(missing.tasks, null); assert.equal(missing.inboxActions, null);
  await db.schema.createTable('tasks', t => { t.string('task_type'); t.text('initial_job_data'); t.timestamp('created_at'); });
  await db('tasks').insert(['review', 'fix', 'review', 'fix', 'ultrafix'].map((commandMode, index) => ({
    task_type: 'pr-comment', initial_job_data: JSON.stringify({ commandMode }), created_at: index % 2 ? now : '2026-09-27 12:00:00',
  })));
  const result = await collectUsageTipSignals(db, now);
  assert.equal(result.tasks, 5); assert.equal(result.manualCycles, 2); assert.equal(result.ultrafix, 1);
  assert.equal(result.plans, null); assert.equal(result.distinctAgents, null);
  await db('tasks').insert({ task_type: 'pr-comment', initial_job_data: '{}', created_at: now });
  assert.equal((await collectUsageTipSignals(db, now)).ultrafix, null);
  await db('tasks').insert({ task_type: 'issue', initial_job_data: '{}', created_at: 'unknown' });
  assert.equal((await collectUsageTipSignals(db, now)).tasks, null);
  assert.equal(usageSignalTimestamp('2026-09-27 12:00:00'), now);
  assert.equal(usageSignalTimestamp(String(now)), now);
}));

test('separate SQLite connections serialize distinct events and deduplication survives reopening', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installSqliteRetry } = await import('../src/db/sqliteRetry.js');
  const directory = await mkdtemp(join(tmpdir(), 'usage-tips-'));
  const clients: ReturnType<typeof knex>[] = [];
  const open = () => {
    const client = installSqliteRetry(knex({ client: 'better-sqlite3', connection: { filename: join(directory, 'test.sqlite') }, useNullAsDefault: true }), { maxTotalMs: 1000 });
    clients.push(client); return client;
  };
  try {
    const a = open();
    await a.schema.createTable('system_configs', t => { t.string('key').primary(); t.text('value'); });
    await up(a);
    const b = open();
    await a.raw('PRAGMA busy_timeout = 1');
    await b.raw('PRAGMA busy_timeout = 1');
    const stores = [createUsageTipsStore(a, () => 123), createUsageTipsStore(b, () => 123)];
    const events = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(events.flatMap((id, i) => [stores[i % 2].dismiss('alice', candidates[0].id, id), stores[(i + 1) % 2].dismiss('alice', candidates[0].id, id)]));
    const before = await a('usage_tip_dismissals').first();
    assert.equal(before.dismissal_count, 6);
    await Promise.all(clients.splice(0).map(c => c.destroy()));
    const reopened = open();
    await createUsageTipsStore(reopened, () => 999).dismiss('alice', candidates[0].id, events[0]);
    assert.deepEqual(await reopened('usage_tip_dismissals').first(), before);
  } finally {
    await Promise.all(clients.map(c => c.destroy()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid persisted selections fail closed without writes; invalid results cannot persist', async () => fixture(async db => {
  const store = createUsageTipsStore(db);
  await assert.rejects(store.persist({ ...selection, generatedAt: NaN }, null));
  await store.persist(selection, null);
  await db('usage_tip_selection').update({ candidates: '[{"id":"pr-review","score":999,"reason":"corrupt"}]' });
  assert.equal(await store.current(), null);
  assert.deepEqual(await store.get('alice'), { enabled: true, tips: [] });
  assert.equal((await db('usage_tip_dismissal_events')).length, 0);
}));
