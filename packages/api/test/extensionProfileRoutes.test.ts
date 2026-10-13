import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ExtensionProfileStore } from '../../core/src/extensions/extensionProfileStore.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';

test('extension HTTP boundary requires fresh durable administration, preflight JSON, and secret-free projections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createExtensionProfileRoutes } = await import('../routes/extensionProfileRoutes.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await up(database); await grantMigration(database); await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const store = new ExtensionProfileStore(database, { SYSTEM_TASK_SECRET: 'synthetic-test-custody-root' });
  const routes = createExtensionProfileRoutes(store); const app = express();
  // Match the production boundary: bound requests before parsing or authorization.
  const rateLimiter = createApiRequestRateLimiter({ PROPR_API_RATE_LIMIT_MAX: '100' });
  app.use(rateLimiter);
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    // A stale admin session is deliberately insufficient.
    req.authorization = { role: 'admin', permissions: req.get('x-test-no-permission') ? [] : ['instance.manage_settings'], source: 'local' }; next();
  });
  app.get('/profiles', routes.list);
  app.get('/profiles/:profileId/history', routes.history);
  app.post('/profiles', routes.save);
  app.post('/delete', routes.remove);
  app.post('/validate', routes.validate);
  app.post('/skills/archive', routes.importArchive);
  app.post('/skills/github', routes.importGithub);
  app.post('/mcp/:serverName', routes.gateway);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + '/profiles')).status, 401);
  assert.equal((await fetch(base + '/profiles', { headers: { 'x-test-actor': '2' } })).status, 403);
  assert.equal((await fetch(base + '/profiles', { headers: { 'x-test-actor': '1', 'x-test-no-permission': '1' } })).status, 403);
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const sentinel = 'UNMISTAKABLE_API_EXTENSION_SENTINEL';
  const input = { version: 1, name: 'Synthetic tools', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'synthetic', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }], skillBundleIds: [] };
  // Every cookie-authenticated mutation must reject browser-simple requests
  // and JSON requests lacking the custom header that forces a CORS preflight.
  for (const route of ['/profiles', '/delete', '/validate', '/skills/archive', '/skills/github']) {
    for (const requestHeaders of [
      { 'x-test-actor': '1', 'content-type': 'application/json' },
      { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': 'wrong' },
      { 'x-test-actor': '1', 'content-type': 'text/plain', 'x-propr-extensions': '1' },
      { 'x-test-actor': '1', 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      assert.equal((await fetch(base + route, { method: 'POST', headers: requestHeaders, body: '{}' })).status, 403, route);
    }
  }
  assert.equal((await fetch(base + '/profiles', { method: 'POST', headers: { 'x-test-actor': '1', 'content-type': 'application/json' }, body: JSON.stringify({ input, secrets: { synthetic: sentinel } }) })).status, 403);
  const saved = await fetch(base + '/profiles', { method: 'POST', headers, body: JSON.stringify({ input, secrets: { synthetic: sentinel } }) });
  assert.equal(saved.status, 200); const text = await saved.text(); assert.ok(!text.includes(sentinel));
  const profile = JSON.parse(text).profile;
  const publicText = await fetch(base + '/profiles', { headers }).then(r => r.text()); assert.ok(!publicText.includes(sentinel)); assert.ok(!publicText.includes('secrets_encrypted'));
  for (const commit of ['main', 'v1.0', 'a'.repeat(39)]) assert.equal((await fetch(base + '/skills/github', { method: 'POST', headers, body: JSON.stringify({ repository: 'fixture/repo', commit, directory: 'skills/test' }) })).status, 400);
  const selection = { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision };
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers, body: JSON.stringify({ selection: { ...selection, instanceId: randomUUID() } }) })).status, 404);
  assert.equal((await fetch(base + '/mcp/synthetic', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401);
  await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
  assert.equal((await fetch(base + '/profiles', { headers })).status, 403);
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers, body: JSON.stringify({ selection }) })).status, 403);
  // Exhaust the shared fixture quota, then prove every mounted handler is
  // bounded even when the request would otherwise fail authorization.
  rateLimiter.resetKey('127.0.0.1');
  for (let i = 0; i < 100; i++) assert.equal((await fetch(base + '/profiles')).status, 401);
  for (const [method, route] of [
    ['GET', '/profiles'], ['GET', `/profiles/${profile.profileId}/history`],
    ['POST', '/profiles'], ['POST', '/delete'], ['POST', '/validate'],
    ['POST', '/skills/archive'], ['POST', '/skills/github'], ['POST', '/mcp/synthetic'],
  ]) {
    const limited = await fetch(base + route, { method });
    assert.equal(limited.status, 429, route);
    assert.equal((await limited.json()).code, 'RATE_LIMIT_EXCEEDED');
  }
});
