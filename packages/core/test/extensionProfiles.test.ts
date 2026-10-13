import test from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extensionProfileInputSchema, type ExtensionProfileInput } from '@propr/shared';
import { ExtensionProfileStore, extensionTokenHash } from '../src/extensions/extensionProfileStore.js';
import { extensionGatewayCall, redactExtensionOutput } from '../src/extensions/mcpGateway.js';
import { extensionEndpoint, resolveExtensionEndpoint, extensionPublicAddress } from '../src/extensions/endpointPolicy.js';
import { validateSkillFiles, readSkillArchive } from '../src/extensions/skillBundles.js';
import { unsealExtensionSecrets } from '../src/extensions/privateSecrets.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';

const secret = 'UNMISTAKABLE_EXTENSION_SENTINEL_DO_NOT_DISCLOSE';
const input = (): ExtensionProfileInput => ({ version: 1, name: 'Documentation tools', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }], skillBundleIds: [] });
const skillFiles = () => [{ path: 'SKILL.md', content: Buffer.from('---\nname: synthetic-skill\ndescription: A synthetic isolated skill\nrequirements: ["docs.lookup"]\n---\nRead the selected documentation.').toString('base64') }];
const select = (p: { instanceId: string; profileId: string; revision: number }) => ({ instanceId: p.instanceId, profileId: p.profileId, revision: p.revision });
const context = { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: false };
async function fixture() {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', t => { t.string('key').primary(); t.text('value'); });
  await database.schema.createTable('instance_members', t => { t.string('github_user_id').primary(); t.string('role'); });
  await database.schema.createTable('agent_definitions', t => { t.string('id').primary(); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }, { github_user_id: '3', role: 'admin' }]);
  await up(database);
  return { database, store: new ExtensionProfileStore(database, { SYSTEM_TASK_SECRET: 'synthetic-private-custody-test-key' }) };
}

test('native durable instance-admin CRUD, encrypted custody, revision fencing and immutable running grants without Connect', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  for (const actor of ['2', '4', 'bootstrap', '']) await assert.rejects(store.list(actor), /durable instance administrator/);
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'synthetic.tar' });
  const profile = await store.save('1', { ...input(), skillBundleIds: [bundle.id] }, { docs: secret });
  assert.deepEqual(profile.secrets.docs, { fields: ['bearerToken'], configured: true });
  assert.equal(profile.skillBundles[0].digest, bundle.digest);
  assert.ok(!JSON.stringify(await store.list('1')).includes(secret));
  const encrypted = await database('extension_profile_revisions').first();
  assert.ok(!JSON.stringify(encrypted).includes(secret));
  assert.throws(() => unsealExtensionSecrets(encrypted.secrets_encrypted, `${profile.instanceId}/${randomUUID()}/1`, store.environment), /unavailable/);
  assert.throws(() => unsealExtensionSecrets(encrypted.secrets_encrypted, `${profile.instanceId}/${profile.profileId}/2`, store.environment), /unavailable/);
  await assert.rejects(store.read('1', { ...select(profile), instanceId: randomUUID() }), /unavailable/);
  await assert.rejects(store.read('1', { ...select(profile), profileId: randomUUID() }), /unavailable/);
  await assert.rejects(store.save('2', input(), { docs: secret }), /durable/);
  const pending = await store.createGrant('1', profile, 'task-pending');
  await assert.rejects(store.grantSnapshot(pending), /exhausted/);
  await store.assertLaunch('1', select(profile), context);
  const token = await store.createGrant('1', profile, 'task-running');
  await store.activateGrant(token, '1', select(profile));
  const send = async (_url: string, body: unknown, supplied?: string) => {
    assert.equal(supplied, secret); const rpc = body as { id: number; method: string };
    return { jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'tools/list' ? { tools: [{ name: 'lookup' }, { name: 'delete_everything' }] } : { content: [{ type: 'text', text: `${secret} ${Buffer.from(secret).toString('base64')} Bearer ${secret}` }], authorization: secret } };
  };
  assert.deepEqual(await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, send), { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup' }] } });
  const result = await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup', arguments: {} } }, send);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(Buffer.from(secret).toString('base64')));
  await assert.rejects(extensionGatewayCall(store, token, 'unselected', { jsonrpc: '2.0', id: 3, method: 'ping' }, send), /capability/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_everything' } }, send), /tool unavailable/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 5, method: 'resources/read' }, send), /method/);
  const rotated = await store.save('1', input(), { docs: 'NEW_UNMISTAKABLE_EXTENSION_SENTINEL' }, select(profile));
  await assert.rejects(store.activateGrant(pending, '1', select(profile)), /changed/);
  await assert.rejects(store.assertLaunch('1', select(profile), context), /superseded/);
  await assert.rejects(store.save('1', input(), {}, select(profile)), /changed/);
  assert.equal((await store.grantSnapshot(token)).secrets.docs, secret);
  const disabled = await store.save('1', { ...input(), enabled: false }, {}, select(rotated));
  await assert.rejects(store.assertLaunch('1', select(disabled), context), /disabled/);
  await store.delete('1', select(disabled));
  assert.equal((await store.list('1')).length, 0);
  assert.equal((await store.grantSnapshot(token)).snapshot.revision, 1);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).delete();
  await assert.rejects(store.grantSnapshot(token), /expired/);
});

test('scope, runtime, capability, demotion, tenant and secret substitution fail closed', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  const scoped = await store.save('1', { ...input(), agentScope: ['claude-main'], repositoryScope: ['team/repo'] }, { docs: secret });
  await assert.rejects(store.assertLaunch('1', select(scoped), { ...context, agentAlias: 'codex-other' }), /scope/);
  await assert.rejects(store.assertLaunch('1', select(scoped), { ...context, repositories: ['other/repo'] }), /scope/);
  await assert.rejects(store.assertLaunch('1', select(scoped), { ...context, runtime: 'opencode' }), /Claude or Codex/);
  const writes = await store.save('1', { ...input(), mcpServers: [{ ...input().mcpServers[0], capability: 'write' }] }, { docs: secret });
  await assert.rejects(store.assertLaunch('1', select(writes), context), /write capabilities/);
  await store.assertLaunch('1', select(writes), { ...context, allowWrite: true });
  await assert.rejects(store.save('1', { ...input(), name: secret }, { docs: secret }), /public profile/);
  await assert.rejects(store.save('1', { ...input(), skillBundleIds: [randomUUID()] }, { docs: secret }), /unavailable/);
  const moved = await store.save('1', { ...input(), mcpServers: [{ ...input().mcpServers[0], url: 'https://8.8.4.4/mcp' }] }, {}, select(scoped));
  assert.equal(moved.secrets.docs.configured, false);
  await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
  await assert.rejects(store.assertLaunch('1', select(writes), context), /durable/);
  await assert.rejects(store.assertLaunch('3', select(writes), context), /durable/);
  const { database: other, store: otherStore } = await fixture(); t.after(() => other.destroy());
  await assert.rejects(otherStore.read('1', select(writes)), /unavailable/);
});

test('typed descriptors reject commands, host paths, mounts, credentials and unknown substitutions', () => {
  for (const addition of [{ hostPath: '/etc' }, { mounts: ['/var/run/docker.sock'] }, { command: 'curl example.com' }, { revision: 1 }]) assert.equal(extensionProfileInputSchema.safeParse({ ...input(), ...addition }).success, false);
  assert.equal(extensionProfileInputSchema.safeParse({ ...input(), mcpServers: [{ kind: 'stdio', name: 'shell', command: 'sh' }] }).success, false);
  assert.equal(extensionProfileInputSchema.safeParse({ ...input(), mcpServers: [input().mcpServers[0], input().mcpServers[0]] }).success, false);
});

test('HTTPS policy refuses private, metadata, mapped addresses and DNS rebinding', async () => {
  for (const url of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp#token', 'https://example.com/mcp?token=secret', 'https://localhost/mcp', 'https://127.0.0.1/mcp', 'https://169.254.169.254/mcp', 'https://10.0.0.1/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://[fc00::1]/mcp']) assert.throws(() => extensionEndpoint(url));
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1']) assert.equal(extensionPublicAddress(address), false, address);
  assert.equal(extensionPublicAddress('198.18.0.1'), true);
  assert.equal((await resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '198.18.0.1', family: 4 }])).address, '198.18.0.1');
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /public/);
  let calls = 0; const lookup = async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  assert.equal((await resolveExtensionEndpoint('https://tools.example.com/mcp', lookup)).address, '8.8.8.8');
  await assert.rejects(resolveExtensionEndpoint('https://tools.example.com/mcp', lookup), /public/);
});

function tarEntry(name: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512); header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
const archive = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
test('bounded immutable skill archives reject traversal, links, devices, duplicate/colliding paths and bombs', () => {
  const body = Buffer.from(skillFiles()[0].content, 'base64');
  assert.equal(readSkillArchive(archive(tarEntry('SKILL.md', body))).length, 1);
  assert.equal(readSkillArchive(gzipSync(archive(tarEntry('SKILL.md', body)))).length, 1);
  for (const name of ['../SKILL.md', '/SKILL.md', 'a/../../SKILL.md', 'a\\SKILL.md', 'C:/SKILL.md']) assert.throws(() => readSkillArchive(archive(tarEntry(name, body))));
  for (const type of ['1', '2', '3', '4', '6', 'x', 'L']) assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body, type))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('skill.md', body))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('Assets/', Buffer.alloc(0), '5'), tarEntry('assets/file.txt', Buffer.from('asset')))));
  assert.throws(() => readSkillArchive(archive(tarEntry('SKILL.md', body), tarEntry('SKILL.md', body))));
  assert.throws(() => readSkillArchive(gzipSync(Buffer.alloc(8 * 1024 * 1024))));
  assert.throws(() => validateSkillFiles([{ path: 'SKILL.md', content: Buffer.from('no frontmatter').toString('base64') }]));
  assert.throws(() => validateSkillFiles([{ path: 'asset.txt', content: Buffer.from('missing skill').toString('base64') }]));
  const files = skillFiles(); const before = validateSkillFiles(files).digest;
  assert.equal(validateSkillFiles([...files]).digest, before);
  assert.notEqual(validateSkillFiles([{ ...files[0], content: Buffer.from(body.toString() + '\nChanged').toString('base64') }]).digest, before);
});

test('selected skill appears only in its read-only run staging and all temporary state is cleaned', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-launch-')); const oldData = process.env.DATA_DIR; const oldTransport = process.env.PROPR_EGRESS_SOCKET_DIR;
  process.env.DATA_DIR = root; process.env.PROPR_EGRESS_SOCKET_DIR = root;
  const { executeWithExtensions, currentExtensionLaunch } = await import('../src/extensions/extensionLaunch.js');
  const { database, store } = await fixture();
  t.after(async () => { await (await import('../src/db/connection.js')).closeConnection(); await database.destroy(); if (oldTransport === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = oldTransport; if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData; await fs.rm(root, { recursive: true, force: true }); });
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'github', repository: 'team/repo', commit: 'a'.repeat(40), directory: 'skills/synthetic' });
  const profile = await store.save('1', { ...input(), mcpServers: [...input().mcpServers, { ...input().mcpServers[0], name: 'docs-tools' }], skillBundleIds: [bundle.id] }, { docs: secret, 'docs-tools': secret });
  const config = { type: 'claude' as const, alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'] };
  const options = { extensionProfile: select(profile), extensionActorId: '1', taskId: 'selected-run', extensionAllowWrite: false, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'A selected run', githubToken: '' };
  const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
  let staged = '';
  await executeWithExtensions(config, options, async prepared => {
    const launch = currentExtensionLaunch()!; assert.ok(launch);
    const { claudeToolPolicyArgs, codexToolPolicyArgs } = await import('../src/agents/agentToolPolicy.js');
    assert.doesNotThrow(() => claudeToolPolicyArgs(prepared.toolPolicy!));
    assert.doesNotThrow(() => codexToolPolicyArgs(prepared.toolPolicy!));
    assert.equal(prepared.toolPolicy!.mcpServers![1].name, 'docs-tools');
    assert.match(launch.mounts[1], /readonly,bind-recursive=disabled$/);
    staged = launch.mounts[1].match(/source=([^,]+)/)![1];
    assert.match(await fs.readFile(path.join(staged, bundle.id, 'SKILL.md'), 'utf8'), /synthetic-skill/);
    assert.match(prepared.prompt, /\/opt\/propr\/extensions/);
    assert.ok(!JSON.stringify(prepared.toolPolicy!.mcpServers!.map(({ bearerToken: _token, ...args }) => args)).includes(secret));
    const { extensionLaunchForDockerRun } = await import('../src/extensions/extensionLaunch.js');
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId, extensionAgentLaunch: true }), launch);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], {}), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId }), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: options.taskId, extensionAgentLaunch: true, costCapExempt: true }), undefined);
    assert.equal(extensionLaunchForDockerRun('docker', ['run'], { taskId: 'another-task', extensionAgentLaunch: true }), undefined);
    await launch.beforeLaunch();
    await launch.beforeLaunch();
    const token = prepared.toolPolicy!.mcpServers![0].bearerToken;
    await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup' } }, async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: secret }] } }));
    return result;
  }, store);
  await assert.rejects(fs.stat(staged), /ENOENT/);
  assert.equal((await database('extension_run_grants')).length, 0);
  await executeWithExtensions(config, { ...options, extensionProfile: null }, async prepared => { assert.equal(currentExtensionLaunch(), undefined); assert.ok(!prepared.prompt.includes('/opt/propr/extensions')); return result; }, store);
  assert.ok(!JSON.stringify(redactExtensionOutput({ Authorization: secret, text: secret }, [secret])).includes(secret));
});

test('synthetic HTTPS MCP enforces TLS, pins the vetted address, refuses redirects and bounds/redacts responses', async t => {
  const https = (await import('node:https')).default;
  const { execFileSync } = await import('node:child_process');
  const { requestExtensionMcp } = await import('../src/extensions/endpointPolicy.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-https-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=mcp.synthetic.example', '-addext', 'subjectAltName=DNS:mcp.synthetic.example'], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem')); let redirect = false; let oversized = false; let authorizations = 0;
  const server = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`); authorizations++;
    if (redirect) { res.writeHead(307, { location: 'https://127.0.0.1/metadata' }).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: oversized ? 'x'.repeat(1024 * 1024 + 1) : secret }] } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  const original = https.request;
  // Only the test transport maps the already-vetted public destination to the
  // synthetic TLS fixture. Production uses the checked lookup unchanged.
  t.mock.method(https, 'request', (url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    assert.equal(url.href, 'https://8.8.8.8/mcp');
    (options.lookup as Function)('8.8.8.8', {}, (error: unknown, address: string) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
    return original(`https://127.0.0.1:${port}/mcp`, { ...options, lookup: undefined, ca: cert, servername: 'mcp.synthetic.example' }, callback);
  });
  const { database, store } = await fixture();
  t.after(async () => { t.mock.restoreAll(); await new Promise<void>(r => server.close(() => r())); await database.destroy(); await fs.rm(root, { recursive: true, force: true }); });
  const profile = await store.save('1', input(), { docs: secret }); const token = await store.createGrant('1', profile, 'https-selected'); await store.activateGrant(token, '1', select(profile));
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup' } };
  const output = await extensionGatewayCall(store, token, 'docs', body); assert.ok(!JSON.stringify(output).includes(secret)); assert.equal(authorizations, 1);
  await assert.rejects(extensionGatewayCall(store, 'x'.repeat(43), 'docs', body), /expired/); assert.equal(authorizations, 1);
  redirect = true; await assert.rejects(requestExtensionMcp(input().mcpServers[0].url, body, secret), /connection failed/); assert.equal(authorizations, 2);
  redirect = false; oversized = true; await assert.rejects(requestExtensionMcp(input().mcpServers[0].url, body, secret), /connection failed/);
});

test('concurrent edits, pending launch disable/delete and exhausted grants refuse safely', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  const profile = await store.save('1', input(), { docs: secret });
  const raced = await Promise.allSettled([store.save('1', { ...input(), name: 'Edit A' }, {}, select(profile)), store.save('1', { ...input(), name: 'Edit B' }, {}, select(profile))]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1); assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
  for (const operation of ['disable', 'delete']) {
    const current = await store.save('1', input(), { docs: secret });
    const token = await store.createGrant('1', current, 'pending-' + operation);
    if (operation === 'disable') await store.save('1', { ...input(), enabled: false }, {}, select(current)); else await store.delete('1', select(current));
    await assert.rejects(store.activateGrant(token, '1', select(current)), /changed|unavailable/);
  }
  const current = await store.save('1', input(), { docs: secret }); const token = await store.createGrant('1', current, 'bounded-run'); await store.activateGrant(token, '1', select(current));
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ calls: 256 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ calls: 0, connections: 4 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
  await database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).update({ connections: 0, bytes: 16 * 1024 * 1024 });
  await assert.rejects(store.grantSnapshot(token), /exhausted/);
});

test('extension credentials are redacted across every possible subprocess chunk split before retention', async () => {
  const { ExtensionStreamRedactor } = await import('../src/extensions/extensionOutput.js');
  for (const variant of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
    const source = `before ${variant} after\n`;
    for (let cut = 0; cut < source.length; cut++) {
      const redactor = new ExtensionStreamRedactor([secret]);
      const output = redactor.push(source.slice(0, cut)) + redactor.push(source.slice(cut)) + redactor.finish();
      assert.equal(output, 'before [REDACTED] after\n');
    }
  }
});

test('extension gateway reuses container MCP routing without accepting URL credentials', async () => {
  const { extensionGatewayBaseUrl } = await import('../src/extensions/extensionLaunch.js');
  assert.equal(extensionGatewayBaseUrl({}), 'http://api:4000/api/extensions/mcp');
  assert.equal(extensionGatewayBaseUrl({ PROPR_INTERNAL_API_URL: 'https://core.example.com/' }), 'https://core.example.com/api/extensions/mcp');
  assert.equal(extensionGatewayBaseUrl({ PROPR_AGENT_MCP_URL: 'https://core.example.com/prefix/api/mcp' }), 'https://core.example.com/prefix/api/extensions/mcp');
  assert.throws(() => extensionGatewayBaseUrl({ PROPR_AGENT_MCP_URL: 'https://user:sentinel@core.example.com/api/mcp' }), /credential-free/);
});

test('stored revision and credential substitutions cannot redirect a live grant to another profile', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  const first = await store.save('1', input(), { docs: secret });
  const second = await store.save('1', { ...input(), name: 'Other profile' }, { docs: 'OTHER_UNMISTAKABLE_EXTENSION_SENTINEL' });
  const token = await store.createGrant('1', first, 'bound-live-grant'); await store.activateGrant(token, '1', select(first));
  const source = await database('extension_profile_revisions').where({ profile_id: second.profileId, revision: 1 }).first();
  await database('extension_profile_revisions').where({ profile_id: first.profileId, revision: 1 }).update({ snapshot: source.snapshot, secrets_encrypted: source.secrets_encrypted });
  await assert.rejects(store.read('1', select(first)), /identity mismatch/);
  await assert.rejects(store.grantSnapshot(token), /identity mismatch/);
  await database('extension_profile_revisions').where({ profile_id: first.profileId, revision: 1 }).update({ snapshot: JSON.stringify(first) });
  await assert.rejects(store.grantSnapshot(token), /credentials unavailable/);
});


test('gateway accepts progress metadata without forwarding it and preserves credential-named schemas', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  const profile = await store.save('1', input(), { docs: secret });
  const token = await store.createGrant('1', profile, 'progress'); await store.activateGrant(token, '1', select(profile));
  await store.activateGrant(token, '1', select(profile)); // Same task's retry is idempotent.
  await assert.rejects(store.activateGrant(token, '3', select(profile)), /grant unavailable/);
  const schema = { type: 'object', properties: { page_token: { type: 'string' }, secret: { type: 'string' }, password: { type: 'string' }, authorization: { type: 'string' } } };
  const catalog = await extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lookup', inputSchema: schema, description: secret }] } }));
  assert.deepEqual((catalog as any).result.tools[0].inputSchema, schema);
  assert.equal((catalog as any).result.tools[0].description, '[REDACTED]');
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup', arguments: { page_token: 'next' }, _meta: { progressToken: 'progress-1' } } };
  await extensionGatewayCall(store, token, 'docs', body, async (_url, forwarded) => {
    assert.deepEqual(forwarded, { ...body, params: { name: 'lookup', arguments: { page_token: 'next' } } });
    return { jsonrpc: '2.0', id: 2, result: { Authorization: 'Bearer unrelated', text: secret } };
  });
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { ...body, params: { ...body.params, unauthorized: true } }), /tool unavailable/);
  await assert.rejects(extensionGatewayCall(store, token, 'docs', { ...body, params: { ...body.params, name: 'unselected' } }), /tool unavailable/);
  assert.deepEqual(redactExtensionOutput({ headers: { Authorization: 'Bearer unrelated', 'x-api-key': 'unknown' }, next_token: 'next', password: { type: 'string' } }, []), { headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' }, next_token: 'next', password: { type: 'string' } });
});

test('snapshot loading failures release only their own reserved slot and keep failure charges', async t => {
  const { database, store } = await fixture(); t.after(() => database.destroy());
  const profile = await store.save('1', input(), { docs: secret });
  const token = await store.createGrant('1', profile, 'bad-snapshot'); await store.activateGrant(token, '1', select(profile));
  const revision = await database('extension_profile_revisions').first();
  // Keep a successful call outstanding: failed loads must not release its slot.
  await store.grantSnapshot(token);
  for (const mutation of [
    { snapshot: JSON.stringify({ ...profile, instanceId: randomUUID() }) },
    { snapshot: revision.snapshot, secrets_encrypted: 'invalid' },
  ]) {
    await database('extension_profile_revisions').update(mutation);
    await assert.rejects(extensionGatewayCall(store, token, 'docs', { jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal((await database('extension_run_grants').first()).connections, 1);
  }
  await database('extension_profile_revisions').delete();
  await assert.rejects(store.grantSnapshot(token), /unavailable/);
  const grant = await database('extension_run_grants').first();
  assert.equal(grant.connections, 1); assert.equal(grant.calls, 4);
  const { EXTENSION_LIMITS } = await import('@propr/shared');
  assert.equal(grant.bytes, 4 * EXTENSION_LIMITS.responseBytes);
  await store.finishGatewayCall(token, EXTENSION_LIMITS.responseBytes);
  assert.equal((await database('extension_run_grants').first()).connections, 0);
});
