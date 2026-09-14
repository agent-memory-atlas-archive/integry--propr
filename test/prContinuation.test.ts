import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHooklessGit as realGit } from '../packages/core/src/git/hooklessGit.js';
import { up, down } from '../packages/core/src/db/migrations/20260914000000_add_pr_continuations.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'pr-continuation-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Worker', '-c', 'user.email=worker@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// All repositories are disposable fixtures; no workspace Git metadata is modified.
git(root, 'init', '--bare', 'upstream.git');
git(root, 'clone', path.join(root, 'upstream.git'), 'seed');
const seed = path.join(root, 'seed');
await writeFile(path.join(seed, 'base.txt'), 'base\n');
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Base');
git(seed, 'branch', '-M', 'release'); git(seed, 'push', 'origin', 'release');
git(root, 'clone', '--bare', path.join(root, 'upstream.git'), 'fork.git');
git(seed, 'checkout', '-b', 'contribution');
await writeFile(path.join(seed, 'contributor.txt'), 'contribution\n');
git(seed, 'add', '.'); git(seed, 'commit', '--author=Original Contributor <contributor@example.test>', '-m', 'Contributor change');
const sourceSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'push', path.join(root, 'fork.git'), 'contribution');
// GitHub's PR refs make the contribution commit available in the upstream repository.
git(seed, 'push', 'origin', 'HEAD:refs/pull/42/head');

let probeError: Error | undefined;
let finalPushError: Error | undefined;
let calls: Array<{ operation: string; args: unknown }> = [];
let cloneIndex = 0;
const token = 'ghs_worker_installation_token';
const repoPath = (owner: string) => path.join(root, owner === 'upstream' ? 'upstream.git' : 'fork.git');

await mock.module('@propr/core', { namedExports: {
    db: database,
    getAuthenticatedOctokit: async () => octokit,
    getRepoUrl: ({ repoOwner }: { repoOwner: string }) => repoPath(repoOwner),
    createHooklessGit: (worktree: string) => {
        const actual = realGit(worktree);
        return {
            raw: async (args: string[]) => {
                calls.push({ operation: 'git', args });
                if (args.includes('--dry-run') && probeError) throw probeError;
                return actual.raw(args);
            },
            revparse: (args: string[]) => actual.revparse(args),
        };
    },
    ensureRepoCloned: async ({ owner, authToken }: { owner: string; authToken: string }) => {
        assert.equal(authToken, token);
        return repoPath(owner);
    },
    createWorktreeFromExistingBranch: async (repo: string, branchName: string) => {
        const worktreePath = path.join(root, `work-${++cloneIndex}`);
        git(root, 'clone', '--branch', branchName, repo, worktreePath);
        git(worktreePath, 'config', 'user.name', 'Test Worker');
        git(worktreePath, 'config', 'user.email', 'worker@example.test');
        calls.push({ operation: 'worktree', args: { repo, branchName, worktreePath } });
        return { worktreePath, branchName };
    },
    cleanupWorktree: async (...args: unknown[]) => { calls.push({ operation: 'cleanup', args }); },
    pushBranch: async (worktree: string, branchName: string, options: { repoUrl: string; authToken: string }) => {
        assert.equal(options.authToken, token);
        calls.push({ operation: 'forkPush', args: { worktree, branchName, options } });
        if (finalPushError) throw finalPushError;
        git(worktree, 'push', options.repoUrl, `HEAD:refs/heads/${branchName}`);
        return { rebased: false, commitHash: git(worktree, 'rev-parse', 'HEAD') };
    },
} });

const { PullRequestPublication } = await import('../src/jobs/prPublication.js');
const { ensurePRContinuation, findPRContinuation, continuationStatus } = await import('../src/jobs/prContinuation.js');
const { isPublicationPermissionDenied } = await import('../src/jobs/prPublicationGit.js');
const ref = { repoOwner: 'upstream', repoName: 'project', pullRequestNumber: 42 };
const source = {
    head: { ref: 'contribution', sha: sourceSha, repo: { owner: { login: 'contributor' }, name: 'project' } },
    base: { ref: 'release' }, title: 'Contribution', body: 'Original objective', user: { login: 'contributor' },
};
type FakePR = { number: number; state: string; html_url: string; body: string; base: { ref: string }; head: { ref: string; repo: { full_name: string } } };
let prs: FakePR[] = [];
let comments: Array<{ id: number; body: string; user: { type: string } }> = [];
let loseCreateResponse = false;
let failComment = false;
const octokit = {
    auth: async (options: unknown) => {
        calls.push({ operation: 'auth', args: options });
        assert.deepEqual(options, { type: 'installation' });
        return { token };
    },
    paginate: async (endpoint: string) => endpoint.endsWith('/pulls') ? [...prs] : [...comments],
    request: async (endpoint: string, options: Record<string, any>) => {
        calls.push({ operation: endpoint, args: options });
        if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') {
            try { git(repoPath('upstream'), 'show-ref', '--verify', options.ref); }
            catch { git(repoPath('upstream'), 'update-ref', options.ref, options.sha); return { data: {} }; }
            throw Object.assign(new Error('Reference already exists'), { status: 422 });
        }
        if (endpoint.includes('/compare/')) {
            const tip = git(repoPath('upstream'), 'rev-parse', 'refs/heads/propr/continuation-pr-42');
            return { data: { status: tip === sourceSha ? 'identical' : 'ahead' } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
            if (prs.length) throw Object.assign(new Error('PR already exists'), { status: 422 });
            const pr = { number: 100, state: 'open', html_url: 'https://github.com/upstream/project/pull/100', body: options.body, base: { ref: options.base }, head: { ref: options.head, repo: { full_name: 'upstream/project' } } };
            prs.push(pr);
            if (loseCreateResponse) { loseCreateResponse = false; throw new Error('ECONNRESET after create'); }
            return { data: pr };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: prs[0] };
        if (endpoint.endsWith('/comments') && endpoint.startsWith('POST')) {
            assert.equal(options.issue_number, 42);
            if (failComment) throw new Error('Comment network error');
            const comment = { id: comments.length + 1, body: options.body, user: { type: 'Bot' } };
            comments.push(comment);
            return { data: comment };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
};
const session = (contribution = source) => new PullRequestPublication(octokit as never, ref, contribution);
const denial = () => new Error('remote: Write access to repository not granted. fatal: HTTP 403');

beforeEach(async () => {
    await database('pr_continuations').delete();
    git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
    git(repoPath('contributor'), 'update-ref', 'refs/heads/contribution', sourceSha);
    calls = []; prs = []; comments = []; probeError = undefined; finalPushError = undefined;
    loseCreateResponse = false; failComment = false;
});
after(async () => { await down(database); await database.destroy(); await rm(root, { recursive: true, force: true }); });

async function implement(worktree: string) {
    await writeFile(path.join(worktree, 'implementation.txt'), 'implemented once\n');
    git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'Implementation');
    return git(worktree, 'rev-parse', 'HEAD');
}

test('writable forks use installation auth for preflight and publish on the original branch', async () => {
    const publication = session();
    const prepared = await publication.prepare('writable');
    const head = await implement(prepared.worktreeInfo.worktreePath);
    await publication.push(prepared.worktreeInfo.worktreePath);
    assert.equal(git(repoPath('contributor'), 'rev-parse', 'contribution'), head);
    assert.equal(await findPRContinuation(ref), undefined);
    assert.equal(prs.length, 0);
    assert.equal(publication.status, '');
    assert.ok(calls.some(c => c.operation === 'git' && (c.args as string[]).includes('--dry-run')));
    assert.equal(calls.filter(c => c.operation === 'auth').length, 2);
});

test('denial before execution starts upstream at the exact source SHA, preserving attribution and base', async () => {
    probeError = denial();
    const publication = session();
    const { worktreeInfo } = await publication.prepare('denied');
    assert.equal(publication.target.repoOwner, 'upstream');
    assert.equal(git(worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(git(worktreeInfo.worktreePath, 'show', '-s', '--format=%an <%ae>', sourceSha), 'Original Contributor <contributor@example.test>');
    assert.equal(prs[0].base.ref, 'release');
    assert.ok(prs[0].body.includes(sourceSha));
    assert.match(prs[0].body, /upstream\/project\/pull\/42/);
    assert.match(comments[0].body, /pull\/100/);
    assert.match(comments[0].body, /remain open/);
    assert.ok(!calls.some(c => c.operation.startsWith('PATCH')));
});

test('final push denial publishes the existing implementation commit without rerunning execution', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('revoked');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = denial();
    const pushed = await publication.push(worktreeInfo.worktreePath);
    assert.equal(pushed.commitHash, produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', `${produced}^`), sourceSha);
    assert.equal(calls.filter(c => c.operation === 'worktree').length, 1);
    const createRef = calls.find(c => c.operation.endsWith('/git/refs'))!;
    assert.equal((createRef.args as any).sha, sourceSha);
});

for (const message of ['Could not resolve host github.com', 'Connection timed out', 'non-fast-forward', 'Authentication failed', 'HTTP 403 rate limit', 'remote: GH013: Repository rule violations', 'Repository not found']) {
    test(`transient/other failure does not adopt: ${message}`, async () => {
        probeError = new Error(message);
        await assert.rejects(session().prepare('transient'), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.equal(prs.length, 0);
        assert.equal(await findPRContinuation(ref), undefined);
        probeError = undefined;
        const publication = session();
        const prepared = await publication.prepare('final-transient');
        finalPushError = new Error(message);
        await assert.rejects(publication.push(prepared.worktreeInfo.worktreePath));
        assert.equal(await findPRContinuation(ref), undefined);
    });
}

test('duplicate/concurrent requests and a lost create response reuse one durable PR', async () => {
    loseCreateResponse = true;
    const records = await Promise.all(Array.from({ length: 5 }, () => ensurePRContinuation(octokit as never, ref, source)));
    assert.deepEqual(records.map(r => r.continuation_pr), [100, 100, 100, 100, 100]);
    assert.equal(prs.length, 1);
    assert.equal((await database('pr_continuations')).length, 1);
    const retry = await ensurePRContinuation(octokit as never, ref, { ...source, head: { ...source.head, sha: 'f'.repeat(40) } });
    assert.equal(retry.source_sha, sourceSha);
    assert.equal(retry.continuation_pr, 100);
});

test('a failed announcement is repaired on retry without duplicating the continuation', async () => {
    failComment = true;
    await assert.rejects(ensurePRContinuation(octokit as never, ref, source), /Comment network error/);
    assert.equal((await findPRContinuation(ref))?.continuation_pr, 100);
    failComment = false;
    await ensurePRContinuation(octokit as never, ref, source);
    await ensurePRContinuation(octokit as never, ref, source);
    assert.equal(prs.length, 1);
    assert.equal(comments.length, 1);
});

test('subsequent original-PR follow-ups use the existing continuation even if fork access returns', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('first');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    await first.push(initial.worktreeInfo.worktreePath);
    probeError = undefined;
    const later = session();
    const followup = await later.prepare('later');
    assert.equal(git(followup.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(later.target.branchName, 'propr/continuation-pr-42');
    assert.equal(prs.length, 1);
    assert.match(later.status, /pull\/100/);
    assert.match(later.status, /pull\/42/);
    const reverse = await findPRContinuation({ ...ref, pullRequestNumber: 100 });
    assert.equal(reverse?.source_pr, 42);
    assert.equal(continuationStatus(reverse), later.status);
});

test('closed continuations remain mapped and are never replaced', async () => {
    await ensurePRContinuation(octokit as never, ref, source);
    prs[0].state = 'closed';
    await assert.rejects(session().prepare('closed'), /Continuation PR is closed/);
    assert.equal(prs.length, 1);
});

test('permission classification is narrow and rejects generic HTTP status failures', () => {
    for (const message of ['Permission to contributor/project.git denied to propr[bot].', 'Resource not accessible by integration']) {
        assert.equal(isPublicationPermissionDenied(new Error(message)), true);
    }
    assert.equal(isPublicationPermissionDenied(new Error('The requested URL returned error: 403')), false);
});

test('an existing continuation remains usable after the original fork is deleted', async () => {
    await ensurePRContinuation(octokit as never, ref, source);
    const publication = session({ ...source, head: { ...source.head, repo: null } } as never);
    const prepared = await publication.prepare('deleted-source');
    assert.equal(git(prepared.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(publication.target.repoOwner, 'upstream');
});

test('concurrent continuation pushes merge while preserving both implementation commit identities', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('concurrent-first');
    const second = session();
    const other = await second.prepare('concurrent-second');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    await writeFile(path.join(other.worktreeInfo.worktreePath, 'other.txt'), 'concurrent implementation\n');
    git(other.worktreeInfo.worktreePath, 'add', '.');
    git(other.worktreeInfo.worktreePath, 'commit', '-m', 'Other implementation');
    const concurrent = git(other.worktreeInfo.worktreePath, 'rev-parse', 'HEAD');
    await second.push(other.worktreeInfo.worktreePath);
    const result = await first.push(initial.worktreeInfo.worktreePath);
    const upstream = repoPath('upstream');
    git(upstream, 'merge-base', '--is-ancestor', produced, result.commitHash!);
    git(upstream, 'merge-base', '--is-ancestor', concurrent, result.commitHash!);
    git(upstream, 'merge-base', '--is-ancestor', sourceSha, result.commitHash!);
    assert.equal(prs.length, 1);
});

test('permission failures never expose the installation token', async () => {
    probeError = new Error(`remote: Write access to repository not granted: https://x-access-token:${token}@github.com/contributor/project`);
    // Make adoption fail too, to inspect the preflight error separately.
    const { checkPullRequestHeadWritable } = await import('../src/jobs/prPublicationGit.js');
    await assert.rejects(checkPullRequestHeadWritable(seed, { repoOwner: 'contributor', repoName: 'project', branchName: 'contribution', isFork: true }, token), error => {
        assert.equal((error as Error).message.includes(token), false);
        assert.equal(isPublicationPermissionDenied(error), true);
        return true;
    });
});

test('preflight adoption uses the captured contribution SHA even if the fork advances during preparation', async () => {
    git(seed, 'commit', '--allow-empty', '-m', 'Later contributor commit');
    const advanced = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', repoPath('contributor'), 'HEAD:refs/heads/contribution');
    probeError = denial();
    const publication = session();
    const prepared = await publication.prepare('moving-fork');
    assert.equal(git(prepared.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(git(repoPath('contributor'), 'rev-parse', 'contribution'), advanced);
    assert.equal(publication.continuation?.source_sha, sourceSha);
});

test('same-repository permission failures never create a fork continuation', async () => {
    const publication = session({ ...source, head: { ref: 'release', sha: sourceSha, repo: { owner: { login: 'upstream' }, name: 'project' } } });
    const prepared = await publication.prepare('same-repository');
    finalPushError = denial();
    await assert.rejects(publication.push(prepared.worktreeInfo.worktreePath), /Write access/);
    assert.equal(await findPRContinuation(ref), undefined);
    assert.equal(prs.length, 0);
});
