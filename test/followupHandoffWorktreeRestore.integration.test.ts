import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';

// Isolate Git's global config and the fixed storage paths before importing production code.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-handoff-restore-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const bin = path.join(root, 'bin');
await fs.ensureDir(bin);
await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db, closeConnection: async () => undefined, runMigrations: async () => undefined,
        configureSqliteConnection: () => undefined, configurePooledSqliteConnection: () => undefined, createKnexConfigForMigrations: () => ({}),
    },
});
after(async () => { await db.destroy(); await fs.remove(root); });

const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { trustManagedGitDirectories, createHooklessGit } = await import('@propr/core');

const BRANCH = 'propr/pr-9';
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let serial = 0;
async function fixture() {
    const dir = path.join(root, `fx-${serial++}`);
    await fs.ensureDir(dir);
    git(dir, 'init', '--bare', 'origin.git');
    git(dir, 'clone', 'origin.git', 'clone');
    const clone = path.join(dir, 'clone');
    await fs.writeFile(path.join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'base');
    git(clone, 'branch', '-M', BRANCH);
    git(clone, 'push', '-u', 'origin', BRANCH);
    git(clone, 'checkout', '--detach');
    const wt = path.join(dir, 'worktrees', 'pr-9-followup');
    git(clone, 'worktree', 'add', wt, BRANCH);
    return { clone, wt };
}

const ops = createFollowupHandoffGitOps(async () => 'unused-token');

test('a deleted follow-up worktree is rebuilt on its branch and keeps the unpushed commit', async () => {
    const { clone, wt } = await fixture();
    await fs.writeFile(path.join(wt, 'b.txt'), 'agent\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'agent work');
    const agentCommit = git(wt, 'rev-parse', 'HEAD');
    await fs.remove(wt); // what a host cleanup's rm -rf does; the registration survives

    assert.equal(await ops.worktreeAttachment(wt, BRANCH), 'missing');
    assert.equal(await ops.restoreMissingWorktree!(clone, wt, BRANCH), true);
    assert.equal(await ops.worktreeAttachment(wt, BRANCH), 'attached');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), agentCommit);
    assert.equal(await ops.hasUnpushedCommits(wt, BRANCH), true);
});

test('a deleted worktree whose registration still holds staged work is not rebuilt', async () => {
    const { clone, wt } = await fixture();
    await fs.writeFile(path.join(wt, 'b.txt'), 'staged\n');
    git(wt, 'add', '.');
    await fs.remove(wt);

    assert.equal(await ops.restoreMissingWorktree!(clone, wt, BRANCH), false);
    assert.equal(await fs.pathExists(wt), false);
    assert.match(git(clone, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${wt}`), 'the registration with staged work is kept');
});

test('startup trust lets Git read worktrees owned by another user after a restart', async () => {
    await trustManagedGitDirectories(createHooklessGit());
    await trustManagedGitDirectories(createHooklessGit()); // idempotent
    const entries = git(root, 'config', '--global', '--get-all', 'safe.directory').split('\n');
    assert.deepEqual(entries.sort(), [`${path.join(root, 'clones')}/*`, `${path.join(root, 'worktrees')}/*`].sort());
});
