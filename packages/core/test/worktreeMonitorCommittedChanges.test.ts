import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getWorktreeChanges } from '../src/services/worktreeMonitorService.js';

for (const tracking of [true, false]) {
  test(`committing preserves file patches and counts ${tracking ? 'against the tracking branch' : 'without an upstream'}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-committed-changes-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString();
    const commit = () => git('-c', 'user.name=Acceptance Test', '-c', 'user.email=acceptance@example.invalid', 'commit', '-m', 'fixture');
    git('init', '-b', 'main');
    await writeFile(join(directory, 'modified.txt'), 'old\n');
    await writeFile(join(directory, 'deleted.txt'), 'remove\n');
    git('add', '.');
    commit();
    git('switch', '-c', 'task');
    if (tracking) git('branch', '--set-upstream-to=main');
    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'docs/acceptance.md'), '# Acceptance\n\n- one\n- two\n- three\n');
    await writeFile(join(directory, 'modified.txt'), 'new\nsecond\n');
    await rm(join(directory, 'deleted.txt'));
    git('add', '.');

    const expected = [
      { path: 'deleted.txt', status: 'deleted', linesAdded: 0, linesRemoved: 1 },
      { path: 'docs/acceptance.md', status: 'added', linesAdded: 5, linesRemoved: 0 },
      { path: 'modified.txt', status: 'modified', linesAdded: 2, linesRemoved: 1 },
    ];
    const checkChanges = async () => {
      const changes = await getWorktreeChanges(directory);
      assert.deepEqual(changes.map(({ diff: _diff, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path)), expected);
      assert.match(changes.find(file => file.path === 'docs/acceptance.md')!.diff, /\+# Acceptance/);
    };
    await checkChanges();
    commit();
    await checkChanges();
  });
}
