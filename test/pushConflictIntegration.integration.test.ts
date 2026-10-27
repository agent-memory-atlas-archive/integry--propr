import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-push-conflict-'));
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db, closeConnection: async () => undefined, runMigrations: async () => undefined,
        configureSqliteConnection: () => undefined, configurePooledSqliteConnection: () => undefined, createKnexConfigForMigrations: () => ({}),
    },
});
after(async () => { await db.destroy(); await fs.remove(root); });

// The agent is the only stub: it resolves (or fails to resolve) the conflicted file in place.
let agentResolution: (worktreePath: string, files: string[]) => Promise<void> = async () => undefined;
const resolverCalls: string[][] = [];
await mock.module('../src/jobs/mergeConflictAgentRunner.js', {
    namedExports: {
        createAgentConflictResolver: async () => ({
            resolvedModel: 'test-model',
            resolveConflicts: async ({ worktreePath, conflictedFiles }: { worktreePath: string; conflictedFiles: string[] }) => {
                resolverCalls.push(conflictedFiles);
                await agentResolution(worktreePath, conflictedFiles);
                return { success: true, model: 'test-model' };
            },
        }),
    },
});

const { integrateRemoteAndPush, isRebaseConflictPushError } = await import('../src/jobs/pushConflictIntegration.js');
const { pushBranch } = await import('@propr/core');

const BRANCH = 'feature';
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let serial = 0;
/** The follow-up's worktree has its own commit; meanwhile someone pushed a conflicting commit to the PR branch. */
async function movedBranch() {
    const dir = path.join(root, `fx-${serial++}`);
    await fs.ensureDir(dir);
    git(dir, 'init', '--bare', '--initial-branch=main', 'origin.git');
    git(dir, 'clone', 'origin.git', 'wt');
    const wt = path.join(dir, 'wt');
    await fs.writeFile(path.join(wt, 'doc.md'), 'intro\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'base');
    git(wt, 'branch', '-M', BRANCH);
    git(wt, 'push', '-u', 'origin', BRANCH);
    git(dir, 'clone', '-b', BRANCH, 'origin.git', 'other');
    await fs.writeFile(path.join(dir, 'other', 'doc.md'), 'intro\nfrom another push\n');
    git(path.join(dir, 'other'), 'commit', '-am', 'pushed meanwhile');
    git(path.join(dir, 'other'), 'push', 'origin', BRANCH);
    await fs.writeFile(path.join(wt, 'doc.md'), 'intro\nfrom the follow-up\n');
    git(wt, 'commit', '-am', 'follow-up work');
    return { dir, wt, origin: path.join(dir, 'origin.git'), followup: git(wt, 'rev-parse', 'HEAD'), remote: git(path.join(dir, 'other'), 'rev-parse', 'HEAD') };
}

const publicationFor = (origin: string) => ({
    target: { branchName: BRANCH, isFork: false },
    push: async (worktreePath: string, _completion: unknown, options: { rebaseOnNonFastForward?: boolean }) => {
        assert.equal(options.rebaseOnNonFastForward, false, 'the merge is pushed without rebasing');
        git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
        return { commitHash: git(origin, 'rev-parse', `refs/heads/${BRANCH}`) };
    },
});
const options = (fx: Awaited<ReturnType<typeof movedBranch>>) => ({
    publication: publicationFor(fx.origin) as never, worktreeInfo: { worktreePath: fx.wt } as never,
    pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', getGithubToken: async () => 'token',
    stateManager: {} as never, taskId: 'task-1', correlationId: 'corr', redisClient: {} as never,
    correlatedLogger: { info() {}, warn() {}, error() {}, debug() {} } as never,
});

test('the real rebase-conflict push error is recognized', async () => {
    const fx = await movedBranch();
    await assert.rejects(pushBranch(fx.wt, BRANCH, { rebaseOnNonFastForward: true }), error => {
        assert.equal(isRebaseConflictPushError(error), true);
        return true;
    });
    assert.equal(git(fx.wt, 'rev-parse', 'HEAD'), fx.followup, 'the aborted rebase left the follow-up commit intact');
});

test('a push that conflicts with commits pushed meanwhile is merged, resolved by the agent and pushed', async () => {
    const fx = await movedBranch();
    resolverCalls.length = 0;
    agentResolution = async worktreePath => fs.writeFile(path.join(worktreePath, 'doc.md'), 'intro\nfrom another push\nfrom the follow-up\n');

    const result = await integrateRemoteAndPush(options(fx), fx.wt);
    assert.ok(result?.commitHash);
    assert.deepEqual(resolverCalls, [['doc.md']]);
    const head = git(fx.origin, 'rev-parse', `refs/heads/${BRANCH}`);
    assert.equal(head, result.commitHash);
    assert.deepEqual(git(fx.origin, 'rev-list', '--parents', '-n', '1', head).split(' ').slice(1).sort(), [fx.followup, fx.remote].sort(),
        'a merge of the follow-up and the commits pushed meanwhile');
    assert.equal(git(fx.origin, 'show', `${head}:doc.md`), 'intro\nfrom another push\nfrom the follow-up');
});

test('unresolved conflicts fall back with the follow-up commit untouched and nothing pushed', async () => {
    const fx = await movedBranch();
    agentResolution = async () => undefined; // leaves the markers in place

    assert.equal(await integrateRemoteAndPush(options(fx), fx.wt), null);
    assert.equal(git(fx.wt, 'rev-parse', 'HEAD'), fx.followup);
    assert.equal(git(fx.wt, 'status', '--porcelain'), '', 'the local merge was aborted');
    assert.equal(git(fx.origin, 'rev-parse', `refs/heads/${BRANCH}`), fx.remote);
});
