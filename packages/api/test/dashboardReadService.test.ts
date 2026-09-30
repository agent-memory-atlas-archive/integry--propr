import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import knex from 'knex';
import { startDashboardReadService } from '../services/dashboardReadService.js';
import { loadCompletedRows } from '../routes/dashboardOutcomeQueries.js';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import { call, createDashboardTestDatabase, seedTask, minutesAgo } from './dashboardTestHarness.js';

async function fixture(count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-reads-'));
  const filename = join(directory, 'fixture.sqlite');
  const source = await createDashboardTestDatabase();
  for (let offset = 0; offset < count; offset += 100) {
    const ids = Array.from({ length: Math.min(100, count - offset) }, (_, index) => offset + index);
    await source('tasks').insert(ids.map(index => ({ task_id: `task-${index}`, repository: index % 2 ? 'acme/other' : 'acme/app',
      task_type: 'issue', issue_number: index, created_at: minutesAgo(index), initial_job_data: JSON.stringify({ title: `Title ${index}` }) })));
    await source('task_history').insert(ids.map(index => ({ task_id: `task-${index}`, state: 'completed', timestamp: minutesAgo(index) })));
  }
  await source.raw('VACUUM INTO ?', [filename]);
  await source.destroy();
  const db = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
  await db.raw('PRAGMA journal_mode=WAL');
  return { db, close: async () => { await db.destroy(); await rm(directory, { recursive: true, force: true }); } };
}

test('read worker preserves projection/filter results, coalesces only concurrent reads, and sees subsequent writes', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  try {
    const first = service.load('all');
    assert.equal(service.load('all'), first);
    assert.deepEqual(await first, await loadCompletedRows(data.db, 'all'));
    assert.deepEqual(await service.load('acme/app'), await loadCompletedRows(data.db, 'acme/app'));
    await data.db('tasks').where('task_id', 'task-0').update({ initial_job_data: JSON.stringify({ title: 'Änderung' }) });
    const fresh = await service.load('all', { search: 'ÄNDERUNG' });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].title, 'Änderung');
    assert.deepEqual(fresh, await loadCompletedRows(data.db, 'all', { search: 'ÄNDERUNG' }));
    await data.db.schema.renameTable('tasks', 'temporarily_unavailable_tasks');
    await assert.rejects(service.load('all'), /no such table/);
    await data.db.schema.renameTable('temporarily_unavailable_tasks', 'tasks');
    assert.equal((await service.load('all')).length, 2, 'a query error must not poison the worker');
  } finally { await service.close(); await data.close(); }
  await assert.rejects(service.load('all'), /closed/);
});

test('bounds queued work and rejects outstanding reads on shutdown', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  try {
    const reads = Array.from({ length: 32 }, (_, index) => service.load('all', { search: `query-${index}` }));
    const settled = Promise.allSettled(reads);
    await assert.rejects(service.load('all', { search: 'overflow' }), /queue is full/);
    await service.close();
    assert.ok((await settled).some(result => result.status === 'rejected'));
  } finally { await service.close(); await data.close(); }
});

test('large completion reads allow an API-thread timer and independent SQLite read to complete first', async () => {
  const data = await fixture(6000);
  const service = await startDashboardReadService(data.db);
  try {
    let completed = false;
    const heavy = service.load('all', { limit: 50 }).then(rows => { completed = true; return rows; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const count = await data.db('tasks').count({ total: '*' }).first();
    assert.equal(Number(count?.total), 6000);
    assert.equal(completed, false, 'foreground work should finish during the completion projection');
    assert.equal((await heavy).length, 50);
  } finally { await service.close(); await data.close(); }
});

test('retains the supplied in-memory connection', async () => {
  const db = await createDashboardTestDatabase();
  const service = await startDashboardReadService(db);
  try {
    await seedTask(db, { taskId: 'memory', states: [{ state: 'completed', timestamp: minutesAgo(1) }] });
    assert.equal((await service.load('all'))[0].taskId, 'memory');
  } finally { await service.close(); await db.destroy(); }
});

test('bounds a stalled read and releases its worker on shutdown', async () => {
  const data = await fixture(2000);
  const service = await startDashboardReadService(data.db, { timeoutMs: 1 });
  try {
    await assert.rejects(service.load('all'), /timed out/);
  } finally { await service.close(); await data.close(); }
});

test('a missing SQLite file fails startup instead of creating an empty database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-missing-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: join(directory, 'absent.sqlite') }, useNullAsDefault: true });
  try { await assert.rejects(startDashboardReadService(db), /unable to open|does not exist|SQLITE_CANTOPEN/i); }
  finally { await db.destroy(); await rm(directory, { recursive: true, force: true }); }
});


test('outcomes and narrative route their completion reads through the supplied service', async () => {
  const data = await fixture();
  const service = await startDashboardReadService(data.db);
  const calls: Array<{ repository: string; limit?: number; search?: string }> = [];
  const routes = createDashboardRoutes({
    db: data.db, redisClient: {} as never,
    taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 },
    liveDetails: async () => null,
    completedRows: (repository, options) => {
      calls.push({ repository, ...options });
      return service.load(repository, options);
    },
  });
  try {
    assert.equal((await call(routes.getOutcomes, { repository: 'acme/app', search: 'Title', limit: '1' })).status, 200);
    assert.equal((await call(routes.getNarrative, { repository: 'acme/other' })).status, 200);
    assert.deepEqual(calls, [
      { repository: 'acme/app', search: 'Title', limit: 1 },
      { repository: 'acme/other', limit: 8 },
    ]);
  } finally { await service.close(); await data.close(); }
});
