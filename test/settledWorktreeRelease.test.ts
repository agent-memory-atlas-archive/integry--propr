import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
    addWorktreeWithoutTracking,
    releaseBranchFromSettledWorktree,
    worktreeHoldingBranch,
} from '../packages/core/src/git/worktreeCreation.js';

const BRANCH = '254/feature';

/** A clone whose `feature` branch is pushed and checked out in a leftover worktree. */
async function leftoverWorktree() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-worktree-'));
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    const holder = path.join(root, 'pr-255-merge-old');
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    await fs.mkdir(repo);
    const git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.test');
    await fs.writeFile(path.join(repo, 'file.txt'), 'base');
    await git.add('.').commit('base');
    await git.addRemote('origin', remote);
    await git.raw(['worktree', 'add', '-b', BRANCH, holder]);
    const holderGit = simpleGit(holder);
    await fs.writeFile(path.join(holder, 'file.txt'), 'merged');
    await holderGit.add('.').commit('merge: resolve conflicts');
    await holderGit.push('origin', BRANCH);
    await git.raw(['fetch', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
    return { root, repo, git, holder, holderGit };
}

async function branchInUseError(git: ReturnType<typeof simpleGit>, worktreePath: string): Promise<Error> {
    try {
        await addWorktreeWithoutTracking(git, worktreePath, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected the branch to be in use');
}

test('releases a branch held by a clean, pushed leftover worktree and keeps the worktree', async () => {
    const { root, git, holder, holderGit } = await leftoverWorktree();
    try {
        const head = await holderGit.revparse(['HEAD']);
        const retry = path.join(root, 'pr-255-merge-new');
        const error = await branchInUseError(git, retry);
        assert.equal(worktreeHoldingBranch(error.message), holder, 'the holder is read from Git\'s own message');

        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), true);

        assert.equal(await holderGit.revparse(['HEAD']), head, 'the leftover worktree keeps its commit');
        assert.equal((await holderGit.raw(['branch', '--show-current'])).trim(), '', 'only its HEAD is detached');
        await addWorktreeWithoutTracking(git, retry, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
        assert.equal(await simpleGit(retry).revparse(['HEAD']), head);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

for (const [name, change] of [
    ['an uncommitted change', async (holder: string) => fs.writeFile(path.join(holder, 'file.txt'), 'edited')],
    ['an untracked file', async (holder: string) => fs.writeFile(path.join(holder, 'new.txt'), 'new')],
    ['an unpushed commit', async (holder: string) => {
        await fs.writeFile(path.join(holder, 'file.txt'), 'unpushed');
        await simpleGit(holder).add('.').commit('unpushed work');
    }],
] as const) {
    test(`keeps a worktree with ${name} holding its branch`, async () => {
        const { root, git, holder, holderGit } = await leftoverWorktree();
        try {
            await change(holder);
            assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), false);
            assert.equal((await holderGit.raw(['branch', '--show-current'])).trim(), BRANCH);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

test('does nothing for a missing holder or a holder on another branch', async () => {
    const { root, git, holder } = await leftoverWorktree();
    try {
        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, path.join(root, 'missing')), false);
        assert.equal(await releaseBranchFromSettledWorktree(git, 'other', holder), false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('parses both spellings of Git\'s branch-in-use error', () => {
    assert.equal(worktreeHoldingBranch("fatal: 'a/b' is already used by worktree at '/tmp/w x'"), '/tmp/w x');
    assert.equal(worktreeHoldingBranch("fatal: 'a/b' is already checked out at '/tmp/w'"), '/tmp/w');
    assert.equal(worktreeHoldingBranch('fatal: invalid reference: a/b'), null);
});
