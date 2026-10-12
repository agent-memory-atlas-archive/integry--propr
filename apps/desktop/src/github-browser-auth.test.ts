import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubBrowserLogin, type GithubBrowserAuthDependencies } from './github-browser-auth';

const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const token = { access_token: 'fixture_token', token_type: 'bearer' };
function fixture(responses: unknown[] = [device, token, { login: 'propr-ultrafix', id: 123 }]) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const waits: number[] = [];
  const identities: string[] = [];
  let closed = 0;
  const dependencies: GithubBrowserAuthDependencies = {
    clientId: 'propr-client',
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json(responses.shift()); },
    presentCode: async (code, url) => {
      assert.equal(code, device.user_code); assert.equal(url, device.verification_uri);
      return async () => { closed++; };
    },
    confirmIdentity: async login => { assert.equal(closed, 1); identities.push(login); return true; },
    sleep: async ms => { waits.push(ms); },
  };
  return { dependencies, calls, waits, identities, closed: () => closed };
}

test('browser sign-in verifies and confirms identity, keeping codes out of logs and browser URL', async () => {
  const f = fixture(); const logs: string[] = [];
  assert.equal(await createGithubBrowserLogin(f.dependencies)({ onLog: line => logs.push(line) }), token.access_token);
  assert.deepEqual(f.identities, ['propr-ultrafix']);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(f.calls[2].url, 'https://api.github.com/user');
  assert.equal(f.calls[2].options?.redirect, 'error');
  assert.equal(new Headers(f.calls[2].options?.headers).get('Authorization'), `Bearer ${token.access_token}`);
  assert.equal(new URLSearchParams(f.calls[1].options?.body as URLSearchParams).get('device_code'), device.device_code);
  for (const secret of [device.device_code, device.user_code, token.access_token]) assert.ok(!logs.join().includes(secret));
});

test('polling respects pending and cumulative slowdown intervals', async () => {
  const f = fixture([device, { error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'slow_down' }, token, { login: 'propr-ultrafix', id: 123 }]);
  await createGithubBrowserLogin(f.dependencies)();
  assert.deepEqual(f.waits, [5000, 5000, 10000, 15000]);
});

for (const error of ['access_denied', 'expired_token', 'incorrect_client_credentials']) test(`handles ${error} and closes native UI`, async () => {
  const f = fixture([device, { error }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /GitHub sign-in/);
  assert.equal(f.closed(), 1);
});

for (const uri of ['https://evil.example/login/device', 'https://github.com/login/device?code=forged', 'propr://connect', 'http://github.com/login/device']) test(`rejects untrusted verification URL ${uri}`, async () => {
  const f = fixture([{ ...device, verification_uri: uri }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /unavailable/);
  assert.equal(f.calls.length, 1);
});

test('missing public client configuration fails before browser or network access', async () => {
  const f = fixture(); delete f.dependencies.clientId;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /PROPR_DESKTOP_GITHUB_CLIENT_ID/);
  assert.equal(f.calls.length, 0);
});

test('unconfirmed identity cannot authorize setup', async () => {
  const f = fixture(); f.dependencies.confirmIdentity = async () => false;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /account was not confirmed/);
});

test('cancellation discards a late token response; a fresh attempt can retry', async () => {
  const f = fixture(); const controller = new AbortController();
  f.dependencies.sleep = async () => { controller.abort(); };
  const login = createGithubBrowserLogin(f.dependencies);
  await assert.rejects(login({ signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.length, 1); assert.equal(f.closed(), 1);
  const fresh = fixture();
  Object.assign(f.dependencies, fresh.dependencies);
  assert.equal(await login(), token.access_token);
});

test('superseded attempt cannot publish a late successful identity', async () => {
  const f = fixture(); let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.dependencies.confirmIdentity = async () => { started(); await waiting; return true; };
  const login = createGithubBrowserLogin(f.dependencies);
  const old = login(); const rejected = assert.rejects(old);
  await ready;
  const fresh = fixture(); Object.assign(f.dependencies, fresh.dependencies);
  assert.equal(await login(), token.access_token);
  release(); await rejected;
});

test('deadline cancels polling and closes native UI', async () => {
  const f = fixture(); f.dependencies.deadlineMs = 10; delete f.dependencies.sleep;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /timed out/);
  assert.equal(f.closed(), 1);
});

test('transport exceptions containing secrets are never surfaced', async () => {
  const f = fixture(); f.dependencies.fetch = async () => { throw new Error(`GitHub ${device.device_code}`); };
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), error => {
    assert.ok(!(error as Error).message.includes(device.device_code)); return true;
  });
});

test('a token arriving after cancellation is discarded before identity lookup', async () => {
  const f = fixture(); const caller = new AbortController();
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.dependencies.fetch!;
  f.dependencies.fetch = async (url, options) => {
    if (String(url).endsWith('/access_token')) { started(); await pending; }
    return fetch(url, options);
  };
  const result = createGithubBrowserLogin(f.dependencies)({ signal: caller.signal });
  const rejected = assert.rejects(result, /cancelled/);
  await ready; caller.abort(); release(); await rejected;
  assert.equal(f.calls.length, 2); assert.deepEqual(f.identities, []);
});

test('browser-open failure aborts the attempt without polling', async () => {
  const f = fixture(); f.dependencies.presentCode = async () => { throw new Error('OS refused to open browser'); };
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /Check your browser/);
  assert.equal(f.calls.length, 1);
});

test('unsupported expiring credentials fail clearly before storage or identity confirmation', async () => {
  const f = fixture([device, { ...token, expires_in: 28800, refresh_token: 'fixture_refresh' }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /non-expiring user tokens/);
  assert.deepEqual(f.identities, []);
  assert.equal(f.closed(), 1);
});
