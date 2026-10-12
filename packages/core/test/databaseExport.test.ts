import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseExports } from '../src/storage/databaseExport.js';
const SQLite = createRequire(import.meta.url)('better-sqlite3');
const allow = async () => {};
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'database-export-'));
  const source = path.join(root, 'customer.sqlite');
  const db = new SQLite(source);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE customer(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE encrypted_credentials(value TEXT);
    CREATE TABLE system_configs(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE knex_migrations(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO knex_migrations VALUES(1, 'customer-schema-v1');
    PRAGMA user_version=7;`);
  db.prepare('INSERT INTO customer(body) VALUES(?)').run('customer content survives');
  db.prepare('INSERT INTO encrypted_credentials VALUES(?)').run('encrypted-customer-canary');
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('agents', JSON.stringify([{ id: 'agent', alias: 'My agent', configPath: '/provider-home-canary', envVars: { API_KEY: 'operator-env-canary' } }]));
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('fleet_control_secret', JSON.stringify('fleet-secret-canary'));
  db.prepare('INSERT INTO system_configs VALUES(?,?)').run('settings', JSON.stringify({ worker_concurrency: 2 }));
  await fs.writeFile(path.join(root, '.env'), 'env-file-canary');
  await fs.mkdir(path.join(root, 'provider-home'));
  await fs.writeFile(path.join(root, 'provider-home', 'auth.json'), 'provider-file-canary');
  const exports = new DatabaseExports(source, path.join(root, 'exports'));
  let job: Awaited<ReturnType<typeof exports.start>> | undefined;
  const start = async (authority = allow) => job = await exports.start('instance', 'admin', authority);
  t.after(async () => {
    if (job) await exports.cancel('instance', exports.generation, job.operationId, 'admin', allow).catch(() => {});
    db.close(); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, db, exports, start };
}
async function settled(exports: DatabaseExports, id: string, authority = allow) {
  for (let i = 0; i < 400; i++) {
    const status = await exports.status('instance', exports.generation, id, 'admin', authority);
    if (status.state !== 'running') return status;
    await delay(10);
  }
  throw new Error('Export did not settle');
}

test('real WAL writer: coherent restorable customer database, integrity, metadata and DB-only privacy', async t => {
  const f = await fixture(t);
  const writer = setInterval(() => f.db.transaction(() => {
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('concurrent customer');
    f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('paired customer');
  })(), 2);
  t.after(() => clearInterval(writer));
  const job = await f.start();
  assert.equal(job.state, 'running');
  assert.ok((await fs.stat(f.source + '-wal')).size > 0);
  const ready = await settled(f.exports, job.operationId);
  clearInterval(writer);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.schemaVersion, 7); assert.equal(ready.migration, 'customer-schema-v1');
  const download = await f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow);
  try {
    const data = await download.file.readFile();
    assert.equal(data.length, ready.sizeBytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), ready.sha256);
    for (const canary of ['operator-env-canary', 'fleet-secret-canary', 'provider-home-canary', 'env-file-canary', 'provider-file-canary']) assert.equal(data.includes(Buffer.from(canary)), false, canary);
    const imported = path.join(f.root, 'restored.sqlite'); await fs.writeFile(imported, data);
    const db = new SQLite(imported);
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.prepare('SELECT body FROM customer WHERE id=1').get().body, 'customer content survives');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer').get().n % 2, 1);
      assert.equal(db.prepare('SELECT value FROM encrypted_credentials').get().value, 'encrypted-customer-canary');
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM system_configs WHERE key='agents'").get().value), [{ id: 'agent', alias: 'My agent' }]);
      db.prepare('INSERT INTO customer(body) VALUES(?)').run('restored write');
    } finally { db.close(); }
    await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  } finally { await download.file.close(); await download.dispose(); }
});

test('actor, instance, generation, opaque ID, concurrent admission, restart and revocation boundaries', async t => {
  const f = await fixture(t); const job = await f.start();
  await assert.rejects(f.start());
  for (const [instance, generation, id, actor] of [
    ['other', f.exports.generation, job.operationId, 'admin'], ['instance', 'old', job.operationId, 'admin'],
    ['instance', f.exports.generation, '../database.sqlite', 'admin'], ['instance', f.exports.generation, job.operationId, 'other'],
  ]) await assert.rejects(f.exports.status(instance, generation, id, actor, allow));
  const restarted = new DatabaseExports(f.source, path.join(f.root, 'exports'));
  await assert.rejects(restarted.status('instance', f.exports.generation, job.operationId, 'admin', allow));
  await assert.rejects(restarted.start('instance', 'admin', allow));
  await settled(f.exports, job.operationId);
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', async () => { throw Error('demoted'); }));
  await assert.rejects(f.exports.status('instance', f.exports.generation, job.operationId, 'admin', async () => { throw Error('revoked'); }));
  assert.equal((await fs.readdir(path.join(f.root, 'exports'))).length, 0);
});

test('revocation during execution fails the job and never produces a downloadable artifact', async t => {
  const f = await fixture(t); let calls = 0;
  const job = await f.start(async () => { if (++calls >= 3) throw Error('revoked'); });
  const result = await settled(f.exports, job.operationId);
  assert.equal(result.state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});

for (const kind of ['symlink', 'hardlink', 'fifo', 'sidecar', 'ancestor'] as const) test(`refuses ${kind} source paths`, async t => {
  const f = await fixture(t);
  let target = f.source;
  if (kind === 'symlink') { target = path.join(f.root, 'link'); await fs.symlink(f.source, target); }
  if (kind === 'hardlink') await fs.link(f.source, path.join(f.root, 'link'));
  if (kind === 'fifo') {
    target = path.join(f.root, 'fifo');
    const { execFileSync } = await import('node:child_process'); execFileSync('mkfifo', [target]);
  }
  if (kind === 'sidecar') { await fs.unlink(f.source + '-shm'); await fs.symlink(path.join(f.root, '.env'), f.source + '-shm'); }
  if (kind === 'ancestor') { await fs.symlink(f.root, path.join(f.root, 'alias')); target = path.join(f.root, 'alias', 'customer.sqlite'); }
  const exports = new DatabaseExports(target, path.join(f.root, 'private'));
  await assert.rejects(exports.start('instance', 'admin', allow));
});

test('ancestor replacement after admission is refused, cancellation releases admission', async t => {
  const f = await fixture(t); let calls = 0;
  const job = await f.start(async () => {
    if (++calls === 2) {
      await fs.rename(f.source, f.source + '.original');
      await fs.copyFile(f.source + '.original', f.source);
    }
  });
  assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
  assert.equal((await fs.readdir(path.join(f.root, 'exports'))).length, 0);
});

test('ENOSPC admission fails before creating an export job', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
  await assert.rejects(f.start(), /Insufficient export space/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
});

test('download refuses hardlinked output and expired jobs', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const snapshot = (await fs.readdir(path.join(f.root, 'exports'))).find(name => name.startsWith('snapshot-'))!;
  const file = path.join(f.root, 'exports', snapshot, 'database.sqlite');
  await fs.link(file, path.join(f.root, 'linked-export'));
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  await fs.unlink(path.join(f.root, 'linked-export'));
});

test('expiry denies status and redemption even before the cleanup timer runs', async t => {
  const f = await fixture(t); const job = await f.start(); await settled(f.exports, job.operationId);
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 5 * 60_000 + 1);
  await assert.rejects(f.exports.status('instance', f.exports.generation, job.operationId, 'admin', allow));
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
  t.mock.timers.reset();
});

test('expired artifacts of a proven-dead process are reaped; a new generation can export', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, 'exports'); await fs.mkdir(path.join(root, 'active'), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const directory = await fs.mkdtemp(path.join(root, 'snapshot-'));
  await fs.writeFile(path.join(directory, 'database.sqlite'), 'expired private canary');
  await fs.writeFile(path.join(root, 'active', 'owner.json'), JSON.stringify({ pid: 2147483647, pidNamespace: await fs.readlink('/proc/self/ns/pid'), expiresAt: Date.now() - 1, directory: path.basename(directory) }));
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'ready');
  await assert.rejects(fs.stat(directory));
});

test('historical customer content containing a configured Fleet control secret is never downloadable', async t => {
  const f = await fixture(t);
  const previous = process.env.PROPR_FLEET_CONTROL_SECRET;
  process.env.PROPR_FLEET_CONTROL_SECRET = 'fleet-control-historical-log-canary';
  t.after(() => { if (previous === undefined) delete process.env.PROPR_FLEET_CONTROL_SECRET; else process.env.PROPR_FLEET_CONTROL_SECRET = previous; });
  f.db.prepare('INSERT INTO customer(body) VALUES(?)').run('historical log: ' + process.env.PROPR_FLEET_CONTROL_SECRET);
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});

test('cancelling an in-flight export removes its private files and permits another export', async t => {
  const f = await fixture(t); const job = await f.start();
  await f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
  const next = await f.start(); assert.equal((await settled(f.exports, next.operationId)).state, 'ready');
});

test('swapping a database ancestor during execution refuses the snapshot and retains source data', async t => {
  const f = await fixture(t); let checks = 0;
  const moved = f.root + '-moved';
  try {
    const job = await f.start(async () => {
      if (++checks === 2) { await fs.rename(f.root, moved); await fs.mkdir(f.root); }
    });
    assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
    await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
    await assert.rejects(f.exports.cancel('instance', f.exports.generation, job.operationId, 'admin', allow));
  } finally {
    await fs.rmdir(f.root); await fs.rename(moved, f.root);
  }
  assert.equal(f.db.prepare('SELECT body FROM customer WHERE id=1').get().body, 'customer content survives');
});

test('execution deadline terminates a worker and leaves no downloadable partial snapshot', async t => {
  const f = await fixture(t);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => schedule(callback, ms === 60_000 ? 1 : ms, ...args));
  const job = await f.start(); assert.equal((await settled(f.exports, job.operationId)).state, 'failed');
  await assert.rejects(f.exports.redeem('instance', f.exports.generation, job.operationId, 'admin', allow));
});
