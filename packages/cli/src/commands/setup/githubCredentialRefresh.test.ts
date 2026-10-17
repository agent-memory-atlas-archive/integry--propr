import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GITHUB_SIGN_IN_REVOKED_MESSAGE, GithubBrowserSignInError, type GithubUserCredential } from '@propr/local-setup';
import { ConfigManager } from '../../config/ConfigManager.js';
import { createDefaultActions } from './hostActions.js';

const HOUR = 3_600_000;

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'propr-github-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = new ConfigManager(dir);
  await config.init();
  const seen: string[] = [];
  let rejectToken: string | undefined;
  const server = createServer((request: IncomingMessage, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    seen.push(token);
    response.setHeader('content-type', 'application/json');
    if (token === rejectToken) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: 'unauthorized' } }));
      return;
    }
    response.end(JSON.stringify({ username: `user-of-${token}`, avatar_url: null, installations: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { dir, config, seen, relayUrl, rejectWith: (token: string) => { rejectToken = token; } };
}

const expiring = (accessToken: string, refreshToken: string, now: number): GithubUserCredential => ({
  accessToken, expiresAt: now + 8 * HOUR, refreshToken, refreshTokenExpiresAt: now + 4_000 * HOUR,
});

test('non-expiring browser tokens are stored without refresh metadata and never refreshed', async t => {
  const env = await setup(t);
  let refreshed = 0;
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => ({ accessToken: 'gho_static' }),
    refreshGithubCredential: async () => { refreshed++; throw new Error('unused'); },
  });
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', Date.now()));
  assert.equal(await actions.loginWithGithub(), true);
  assert.deepEqual(env.config.getGithubCredential(), { accessToken: 'gho_static' });
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-gho_static');
  assert.equal(refreshed, 0);
});

test('expiring credentials persist across restart and refresh near expiry before relay use', async t => {
  const env = await setup(t);
  let now = 1_000_000_000;
  const login = createDefaultActions(env.config, { githubBrowserLogin: async () => expiring('ghu_first', 'ghr_first', now), now: () => now });
  assert.equal(await login.loginWithGithub(), true);
  const stored = JSON.parse(readFileSync(join(env.dir, 'config.json'), 'utf8'));
  assert.equal(stored.profiles.default.githubRefreshToken, 'ghr_first');

  // A relaunch reads the same private config with a new manager and host.
  const restarted = new ConfigManager(env.dir);
  await restarted.init();
  const refreshCalls: string[] = [];
  const actions = createDefaultActions(restarted, {
    now: () => now,
    refreshGithubCredential: async refreshToken => {
      refreshCalls.push(refreshToken);
      return expiring('ghu_second', 'ghr_second', now);
    },
  });
  assert.equal(actions.hasGithubToken(), true);
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_first');
  assert.deepEqual(refreshCalls, []);

  now += 8 * HOUR - 60_000;
  // Concurrent relay calls share one rotation: a refresh token is single-use.
  const [first, second] = await Promise.all([
    actions.fetchRelayInstallations({ relayUrl: env.relayUrl }),
    actions.fetchRelayInstallations({ relayUrl: env.relayUrl }),
  ]);
  assert.equal(first.username, 'user-of-ghu_second');
  assert.equal(second.username, 'user-of-ghu_second');
  assert.deepEqual(refreshCalls, ['ghr_first']);
  const rotated = new ConfigManager(env.dir);
  await rotated.init();
  assert.deepEqual(rotated.getGithubCredential(), expiring('ghu_second', 'ghr_second', now));
});

test('a relay 401 for an expiring token triggers one refresh and retry', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_revoked_early', 'ghr_live', now));
  env.rejectWith('ghu_revoked_early');
  const actions = createDefaultActions(env.config, { refreshGithubCredential: async () => expiring('ghu_fresh', 'ghr_fresh', now) });
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_fresh');
  assert.deepEqual(env.seen, ['ghu_revoked_early', 'ghu_fresh']);
});

test('a revoked refresh grant clears the saved credential and requires a new sign-in', async t => {
  const env = await setup(t);
  let now = 2_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_revoked', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: async () => { throw new Error('unused'); },
    refreshGithubCredential: async () => { throw new GithubBrowserSignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE); },
  });
  assert.equal(actions.hasGithubToken(), true);
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), new RegExp(GITHUB_SIGN_IN_REVOKED_MESSAGE));
  assert.equal(env.config.getGithubCredential(), undefined);
  assert.equal(actions.hasGithubToken(), false);
  assert.equal(actions.githubLoginRecovery?.()?.detail, GITHUB_SIGN_IN_REVOKED_MESSAGE);
  assert.deepEqual(env.seen, []);
});

test('an expired refresh grant is not presented as a usable identity', async t => {
  const env = await setup(t);
  const now = 3_000_000_000;
  await env.config.setGithubCredential({ accessToken: 'ghu_old', expiresAt: now - HOUR, refreshToken: 'ghr_old', refreshTokenExpiresAt: now - 1 });
  let refreshed = 0;
  const actions = createDefaultActions(env.config, { now: () => now, refreshGithubCredential: async () => { refreshed++; throw new Error('unused'); } });
  assert.equal(actions.hasGithubToken(), false);
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), /expired or was revoked/);
  assert.equal(refreshed, 0);
  assert.equal(env.config.getGithubCredential(), undefined);
});

test('transient refresh failures keep the saved credential and never leak provider text', async t => {
  const env = await setup(t);
  let now = 4_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, {
    now: () => now,
    refreshGithubCredential: async () => { throw new Error('ghr_old provider body'); },
  });
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), error => {
    assert.ok(!(error as Error).message.includes('ghr_old'));
    return true;
  });
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_old');
  assert.equal(actions.hasGithubToken(), true);
});

test('a rotated credential that cannot be saved is not used and requires sign-in', async t => {
  const env = await setup(t);
  let now = 5_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, { now: () => now, refreshGithubCredential: async () => expiring('ghu_new', 'ghr_new', now) });
  t.mock.method(env.config, 'setGithubCredential', async () => { throw new Error('disk full'); });
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), /could not save it/);
  assert.equal(actions.hasGithubToken(), false);
  assert.deepEqual(env.seen, []);
});

test('an account switch confirmed during an in-flight refresh is not overwritten by the old account', async t => {
  const env = await setup(t);
  let now = 6_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  now += 9 * HOUR;
  let release!: () => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
    refreshGithubCredential: async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return expiring('ghu_integry2', 'ghr_integry2', now);
    },
  });
  const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
  await refreshStarted;
  assert.equal(await actions.loginWithGithub({ force: true }), true);
  release();
  assert.equal((await discovery).username, 'user-of-ghu_ultrafix');
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
});

test('a failed account switch keeps the previous credential intact', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => { throw new GithubBrowserSignInError('GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.'); },
  });
  assert.equal(await actions.loginWithGithub({ force: true }), false);
  assert.equal(actions.githubLoginRecovery?.()?.detail, 'GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.');
  assert.equal(env.config.getGithubCredential()?.accessToken, 'ghu_integry');
});
