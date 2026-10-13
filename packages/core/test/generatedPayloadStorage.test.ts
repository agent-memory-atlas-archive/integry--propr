import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { GeneratedPayloadStorage } from '../src/storage/generatedPayloads.js';
import { InstanceStorageService } from '../src/storage/service.js';
const exec = promisify(execFile);
const signal = () => new AbortController().signal;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-generated-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worktrees = path.join(root, 'worktrees');
  const worktree = path.join(worktrees, 'customer');
  await fs.mkdir(worktree, { recursive: true });
  const git = async (...args: string[]) => (await exec('git', ['-C', worktree, ...args])).stdout;
  await git('init'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(worktree, 'customer.txt'), 'customer data');
  await fs.writeFile(path.join(worktree, '.gitignore'), 'private/\nnode_modules/\n');
  await git('add', '.'); await git('commit', '-m', 'fixture');
  const remote = path.join(root, 'remote.git');
  await exec('git', ['init', '--bare', remote]); await git('remote', 'add', 'origin', remote); await git('push', 'origin', 'HEAD');
  const lifecycle = new StorageLifecycle(path.join(root, 'barrier'));
  const storageRoot = path.join(root, 'control');
  const payloads = new GeneratedPayloadStorage(worktrees, storageRoot, lifecycle);
  const service = new InstanceStorageService({ lifecycle, storageRoot, clonesRoot: path.join(root, 'clones'), roots: [{ category: 'worktrees', path: worktrees }], hasPendingTasks: async () => pending });
  let pending = false;
  const id = await service.initialize();
  const age = async (hours = 25) => fs.writeFile(path.join(lifecycle.root, 'last-use'), String(Date.now() - hours * 3_600_000));
  const generate = async () => {
    await payloads.generate(worktree, 'node_modules', 'fixture public dependency regenerated from lockfile', async directory => {
      await fs.mkdir(path.join(directory, 'dependency'));
      await fs.writeFile(path.join(directory, 'dependency', 'index.js'), 'generated dependency');
    });
    await payloads.complete(worktree, true); await age();
  };
  return { root, worktree, worktrees, lifecycle, payloads, service, id, git, age, generate, pending: (value: boolean) => { pending = value; } };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === 'node_modules') continue;
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else result[relative] = (await fs.readFile(path.join(directory, entry.name))).toString('hex');
    }
  };
  await visit(root); return result;
}
for (const state of ['clean-published', 'detached', 'dirty', 'ignored-private', 'stashed', 'unpublished', 'salvage-retained']) {
  test(`generated cleanup preserves byte-identical Git/private state: ${state}`, async t => {
    const f = await fixture(t); await f.generate();
    if (state === 'detached') await f.git('checkout', '--detach');
    if (state === 'dirty') { await fs.writeFile(path.join(f.worktree, 'customer.txt'), 'staged private'); await f.git('add', 'customer.txt'); await fs.writeFile(path.join(f.worktree, 'untracked'), 'private'); }
    if (state === 'ignored-private') { await fs.mkdir(path.join(f.worktree, 'private')); await fs.writeFile(path.join(f.worktree, 'private', 'secret'), 'private canary'); }
    if (state === 'stashed') { await fs.writeFile(path.join(f.worktree, 'customer.txt'), 'stash canary'); await f.git('stash'); }
    if (state === 'unpublished') await f.git('commit', '--allow-empty', '-m', 'unpublished');
    if (state === 'salvage-retained') { await f.git('update-ref', 'refs/propr/rescue/fixture', 'HEAD'); await f.payloads.complete(f.worktree, false); }
    const before = await snapshot(f.worktree);
    await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
    const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
    const result = await f.service.execute(f.id, preview.confirmation, 'operator');
    assert.deepEqual(await snapshot(f.worktree), before);
    assert.equal(result.deleted.length, state === 'salvage-retained' ? 0 : 1);
    if (state !== 'salvage-retained') assert.deepEqual(await fs.readdir(path.join(f.worktree, 'node_modules')), []);
    assert.ok(result.retained.some(value => value.id === 'worktrees-coverage'));
  });
}
test('opt-in, actual use clock, pending/failed/recovery authority, and read claim race', async t => {
  const f = await fixture(t); await f.generate();
  let preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.equal(preview.candidates.filter(c => !c.protectedReasons.length).length, 0);
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 1 }, 'operator');
  await f.age(23);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('recent_use')));
  await f.age();
  f.pending(true);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('busy')));
  f.pending(false);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await f.lifecycle.use(async () => {});
  const changed = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(changed.deleted.length, 0);
  await f.age();
  await fs.writeFile(path.join(f.lifecycle.root, 'readers', 'abandoned-read'), '');
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('busy')));
});
for (const mutation of ['private-edit', 'symlink', 'parent-symlink', 'hardlink', 'corrupt']) {
  test(`fails closed: ${mutation}`, async t => {
    const f = await fixture(t); await f.generate();
    const target = path.join(f.worktree, 'node_modules', 'dependency', 'index.js');
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'canary'), 'outside');
    if (mutation === 'private-edit') await fs.writeFile(target, 'private data');
    if (mutation === 'symlink') { await fs.unlink(target); await fs.symlink(path.join(outside, 'canary'), target); }
    if (mutation === 'hardlink') { await fs.unlink(target); await fs.link(path.join(outside, 'canary'), target); }
    if (mutation === 'parent-symlink') { await fs.rename(path.join(f.worktree, 'node_modules'), path.join(outside, 'node_modules')); await fs.symlink(path.join(outside, 'node_modules'), path.join(f.worktree, 'node_modules')); }
    if (mutation === 'corrupt') await fs.writeFile(path.join(f.worktree, '.git', 'HEAD'), 'broken');
    await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
    const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
    const result = await f.service.execute(f.id, preview.confirmation, 'operator');
    assert.equal(result.deleted.length, 0);
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'outside');
  });
}
test('fresh proof after preview protects added private data; consumed retries are rejected', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await fs.writeFile(path.join(f.worktree, 'node_modules', 'private'), 'private');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 0);
  await assert.rejects(f.service.execute(f.id, preview.confirmation, 'operator'));
  assert.equal((await f.service.result(f.id, preview.confirmation, 'operator')).state, 'completed');
  assert.ok((await f.service.usage()).generatedPayloads);
});
test('producer refuses adoption, path escape, tracked payloads and unknown names', async t => {
  const f = await fixture(t); await f.generate();
  await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async () => {}), { code: 'EEXIST' });
  await assert.rejects(f.payloads.generate(f.root, 'node_modules', 'regenerate', async () => {}));
  await assert.rejects(f.payloads.generate(f.worktree, '../private' as never, 'regenerate', async () => {}));
  await f.git('add', '-f', 'node_modules/dependency/index.js'); await f.age();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates.some(c => c.protectedReasons.includes('private_work')));
});
test('bounded batches and pressure admission preserve reserve and release rejected claims', async t => {
  const f = await fixture(t); await f.generate();
  const records = path.join(f.root, 'control', 'generated-payloads');
  for (let i = 0; i < 30; i++) await fs.writeFile(path.join(records, `unknown-${i}.json`), '{}');
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates.length <= 10);
  await assert.rejects(f.lifecycle.use(async () => assert.fail('must not start'), { filesystem: f.worktrees, reserveBytes: Number.MAX_SAFE_INTEGER - 1024, taskBytes: 1024 }), /disk pressure/);
  assert.deepEqual(await fs.readdir(path.join(f.lifecycle.root, 'readers')), []);
  await f.lifecycle.use(async () => {}, { filesystem: f.worktrees, reserveBytes: 1, taskBytes: 1 });
});
test('live lifecycle reader and queued admission cannot race execute', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  let reader: Promise<void> | undefined;
  let readerStarted = false;
  const result = await f.service.execute(f.id, preview.confirmation, 'operator', async () => {
    reader ??= f.lifecycle.use(async () => { readerStarted = true; await fs.writeFile(path.join(f.worktree, 'node_modules', 'private'), 'read claim private canary'); });
    // use() publishes intent asynchronously before waiting at the gate.
    for (let i = 0; i < 100 && !await f.lifecycle.busy(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(readerStarted, false);
  });
  await reader;
  assert.equal(result.deleted.length, 0);
  assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'private'), 'utf8'), 'read claim private canary');
});
test('real linked, detached worktree registration survives generated cleanup', async t => {
  const f = await fixture(t);
  const linked = path.join(f.worktrees, 'linked');
  await f.git('worktree', 'add', '--detach', linked, 'HEAD');
  await f.payloads.generate(linked, '.propr/test-cache', 'refetchable fixture test output', async directory => fs.writeFile(path.join(directory, 'result'), 'generated'));
  await f.payloads.complete(linked, true); await f.age();
  const before = await snapshot(f.worktree);
  const registration = await fs.readFile(path.join(linked, '.git'), 'utf8');
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 1);
  assert.equal(await fs.readFile(path.join(linked, '.git'), 'utf8'), registration);
  assert.deepEqual(await snapshot(f.worktree), before);
});
test('aborted cleanup retains payload and durable record for fresh protected retry', async t => {
  const f = await fixture(t); await f.generate();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.lifecycle.cleanup(() => f.payloads.remove(candidates[0].id, controller.signal)), ['busy']);
  assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'dependency', 'index.js'), 'utf8'), 'generated dependency');
  const retry = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.equal(retry[0].protectedReasons.length, 0);
});
test('entry, byte and time budgets fail closed', async t => {
  const f = await fixture(t); await f.generate();
  assert.throws(() => new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle, { maxEntries: NaN }), /Invalid/);
  for (const limits of [{ maxEntries: 1 }, { maxBytes: 1 }, { maxMs: 0 }]) {
    const bounded = new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle, limits);
    const candidates = await f.lifecycle.cleanup(s => bounded.preview(false, 24, s));
    assert.equal(candidates.filter(c => !c.protectedReasons.length).length, 0);
    assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'dependency', 'index.js'), 'utf8'), 'generated dependency');
  }
});
test('partial interruption is truthful and retries protect remaining state', async t => {
  const f = await fixture(t); await f.generate();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  const controller = new AbortController();
  const original = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (target: Parameters<typeof fs.unlink>[0]) => {
    await original(target);
    if (String(target).endsWith('/index.js')) controller.abort();
  });
  const retained = await f.lifecycle.cleanup(() => f.payloads.remove(candidates[0].id, controller.signal));
  assert.deepEqual(retained, ['busy', 'partial_generated_cleanup']);
  assert.ok((await fs.readdir(path.join(f.root, 'control', 'generated-payloads'))).some(name => name === `${candidates[0].id}.json`));
  const retry = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(retry[0].protectedReasons.includes('private_work'));
  assert.equal(await fs.readFile(path.join(f.worktree, 'customer.txt'), 'utf8'), 'customer data');
});
test('real same-device bind mount is rejected in an isolated mount namespace', async t => {
  try { await exec('unshare', ['--user', '--map-root-user', '--mount', 'true']); }
  catch { t.skip('Requires unshare with user/mount namespaces; no host mounts are changed'); return; }
  const f = await fixture(t); await f.generate();
  const outside = path.join(f.root, 'mount-source'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'canary'), 'outside');
  const source = path.resolve('packages/core/src/storage/generatedPayloads.ts');
  const lifecycleSource = path.resolve('packages/core/src/storage/lifecycle.ts');
  const program = `
    import { execFileSync } from 'node:child_process';
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { GeneratedPayloadStorage } from ${JSON.stringify(source)};
    import { StorageLifecycle } from ${JSON.stringify(lifecycleSource)};
    execFileSync('mount', ['--bind', ${JSON.stringify(outside)}, ${JSON.stringify(path.join(f.worktree, 'node_modules', 'dependency'))}]);
    const lifecycle = new StorageLifecycle(${JSON.stringify(f.lifecycle.root)});
    const storage = new GeneratedPayloadStorage(${JSON.stringify(f.worktrees)}, ${JSON.stringify(path.join(f.root, 'control'))}, lifecycle);
    const candidates = await lifecycle.cleanup(signal => storage.preview(false, 24, signal));
    assert.ok(candidates.some(candidate => candidate.protectedReasons.includes('unsafe_path')));
    assert.equal(await fs.readFile(${JSON.stringify(path.join(outside, 'canary'))}, 'utf8'), 'outside');
  `;
  await exec('unshare', ['--user', '--map-root-user', '--mount', process.execPath, '--import', 'tsx', '--input-type=module', '-e', program]);
});
test('missing/corrupt/future use clocks and old mtimes cannot authorize cleanup', async t => {
  const f = await fixture(t); await f.generate();
  const target = path.join(f.worktree, 'node_modules');
  await fs.utimes(target, new Date(0), new Date(0));
  await f.age(23);
  let candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates[0].protectedReasons.includes('recent_use'));
  for (const clock of ['', 'corrupt', String(Date.now() + 3_600_000)]) {
    await fs.writeFile(path.join(f.lifecycle.root, 'last-use'), clock);
    candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
    assert.ok(candidates[0].protectedReasons.includes('unknown_use'));
  }
  await fs.unlink(path.join(f.lifecycle.root, 'last-use'));
  candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates[0].protectedReasons.includes('unknown_use'));
});
test('policy withdrawal after preview prevents manual execution', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await f.service.updatePolicy(f.id, { enabled: false, idleHours: 24 }, 'operator');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 0);
  assert.ok(result.retained.some(candidate => candidate.reasons.includes('unsupported')));
});
