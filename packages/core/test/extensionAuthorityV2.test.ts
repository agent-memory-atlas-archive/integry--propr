import { fixture, create, input } from './helpers/extensionAuthorityV2Fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import knex from 'knex';
import { canonicalFleetJson as canonical, EXTENSION_AUTHORITY_V2_PATH as route, EXTENSION_AUTHORITY_V2_SCHEMA } from '@propr/shared';
import { refusePublicFleetData } from '../../api/fleetDataListener.js';
import { verifyProof } from '../../../docs/contracts/extension-authority-v2/verifier.mjs';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = 'SENTINEL-V2-TRANSPORT-SECRET-NEVER-RETAIN';
const substitute = (field: string, value: unknown) => typeof value === 'number' ? value + 1
  : field.endsWith('Epoch') ? String(Number(value) + 1)
    : /^[0-9a-f]{64}$/.test(String(value)) ? 'b'.repeat(64)
      : /^[0-9a-f-]{36}$/.test(String(value)) ? randomUUID() : field === 'action' ? 'catalog.list' : 'substituted';
test('real Unix listener: one durable decision per phase, exact retained retries, repeatable fresh status and restart', async t => {
  const f = await fixture(t); const w = await f.newWork();
  const receipts: any[] = [];
  for (const phase of ['request', 'dispatch', 'completion']) {
    const r = f.request(w, phase); const native = phase === 'dispatch' ? create : undefined;
    const first = await f.invoke(r, native); receipts.push(first);
    assert.deepEqual(await f.invoke(r, native), first);
    assert.equal((await f.send(canonical(f.envelope(f.request(w, phase), native)))).status, 403);
  }
  assert.equal((await f.db('extension_profiles')).length, 1);
  const snapshot = JSON.parse((await f.db('extension_profile_revisions').first()).snapshot);
  assert.equal(receipts[1].statement.result.nativeResultDigest, hash(canonical({ contract: w.extension.contract,
    operationId: w.extension.operationId, state: 'completed', result: { profile: snapshot } })));
  assert.equal((await f.db('extension_authority_v2_receipts')).length, 3);
  for (let n = 0; n < 2; n++) {
    const r = f.request(w, 'status'); assert.equal((await f.invoke(r)).statement.result.state, 'completed');
    assert.equal((await f.send(canonical(f.envelope(r)))).status, 403);
  }
  const retained = JSON.stringify(await f.db('extension_authority_v2_receipts'));
  for (const sentinel of [secret, input.name, 'PRIVATE KEY', 'mcpServers', 'sealed']) assert.ok(!retained.includes(sentinel));
  await f.restart();
  assert.deepEqual(await f.invoke(receipts[1].statement.request, create), receipts[1]);
  assert.equal((await f.db('extension_profiles')).length, 1);
  await assert.rejects(f.db('extension_authority_v2_receipts').delete(), /Immutable/);
});

test('Routing statement substitutions: every coordinate and epoch, keys, times, strict wire and HMAC', async t => {
  const f = await fixture(t); const w = await f.newWork(); const r = f.request(w);
  const altered: any[] = [];
  for (const field of Object.keys(r)) {
    if (field === 'work') continue;
    const x = structuredClone(r); (x as any)[field] = field === 'phase' ? 'completion' : field.includes('At') ? (x as any)[field] + 1 : 'b'.repeat(64); altered.push(x);
  }
  for (const group of ['scope', 'extension']) for (const field of Object.keys((w as any)[group])) {
    const x = structuredClone(r); x.work[group][field] = substitute(field, x.work[group][field]); altered.push(x);
  }
  for (const field of ['extensionInstanceId', 'workDigest', 'acquisitionOperationId', 'coreAuthorityEpoch']) {
    const x = structuredClone(r); x.work[field] = field === 'coreAuthorityEpoch' ? '9' : randomUUID(); altered.push(x);
  }
  for (const substituted of altered) assert.equal((await f.send(canonical(f.envelope(r, undefined, f.authorization(substituted))))).status, 403);
  for (const changes of [{ keyId: 'unknown' }, { keyEpoch: '2' }, { authorityEpoch: '2' }, { producerRevision: 'b'.repeat(64) }, { producerEpoch: '2' }, { checkedAt: r.issuedAt - 1 }, { checkedAt: r.expiresAt }, { expiresAt: r.expiresAt + 1 }, { decision: 'deny' }, { unexpected: true }]) {
    assert.equal((await f.send(canonical(f.envelope(r, undefined, f.authorization(r, changes))))).status, 403);
  }
  const other = generateKeyPairSync('ed25519');
  assert.equal((await f.send(canonical(f.envelope(r, undefined, f.authorization(r, {}, other.privateKey))))).status, 403);
  const e = f.envelope(r); e.routing.signature = 'a'.repeat(86);
  for (const raw of [canonical(e), canonical({ ...f.envelope(r), mac: '0'.repeat(64) }), canonical(f.envelope(r)) + ' ', '{"request":null,' + canonical(f.envelope(r)).slice(1), canonical({ ...f.envelope(r), extra: true }), 'x'.repeat(278529)]) {
    assert.equal((await f.send(raw)).status, 403);
  }
  assert.equal((await f.send(canonical(f.envelope(r)), '/extensions/authority/v2/invoke?route=other' as any)).status, 403);
  assert.equal((await f.db('extension_authority_v2_intents')).length, 0);
  await f.invoke(r);
});

test('independent Core denial, immutable work, rotation, actor ABA, rollback and clock rollback', async t => {
  const f = await fixture(t); const w = await f.newWork(); await f.invoke(f.request(w));
  for (const group of ['scope', 'extension']) for (const field of Object.keys((w as any)[group])) {
    const changed = structuredClone(w); changed[group][field] = substitute(field, changed[group][field]);
    assert.equal((await f.send(canonical(f.envelope(f.request(changed, 'dispatch'), create)))).status, 403);
  }
  const r = f.request(w, 'dispatch'); const raw = canonical(f.envelope(r, create));
  await f.writeTrust({ ...f.trust, keyEpoch: '2' }); assert.equal((await f.send(raw)).status, 403);
  const rotated = f.authorization(r, { keyEpoch: '2' });
  assert.equal((await f.send(canonical(f.envelope(r, create, rotated)))).status, 403);
  await f.writeTrust(f.trust);
  await assert.rejects(f.db.transaction(async trx => { await trx('instance_members').update({ role: 'member' }); throw Error('rollback'); }));
  assert.equal((await f.db('native_authority_epoch').first()).epoch, 2);
  await f.db('instance_members').update({ role: 'member' }); assert.equal((await f.send(raw)).status, 403);
  await f.db('instance_members').update({ role: 'admin' }); assert.equal((await f.send(raw)).status, 403);
  const next = await f.newWork(); next.coreAuthorityEpoch = '4';
  const future = Date.now() + 1000; await f.db('extension_authority_v2_clock').update({ checked_ms: future });
  assert.equal((await f.send(canonical(f.envelope(f.request(next))))).status, 403);
  assert.equal((await f.db('extension_profiles')).length, 0);
});

test('concurrent contenders return one receipt and mutate once; distinct challenges cannot redispatch', async t => {
  const f = await fixture(t); const w = await f.newWork(); await f.invoke(f.request(w));
  const r = f.request(w, 'dispatch'); const raw = canonical(f.envelope(r, create));
  const responses = await Promise.all([f.send(raw), f.send(raw), f.send(canonical(f.envelope(f.request(w, 'dispatch'), create)))]);
  assert.equal(responses[0].status, 200); assert.deepEqual(responses[1].body, responses[0].body); assert.equal(responses[2].status, 403);
  assert.equal((await f.db('extension_profiles')).length, 1);
});

test('fault transcript: create-only intent, native mutation, result commit and reply boundaries retain exact outcomes', async t => {
  const transcript: string[] = [];
  for (const phase of ['request', 'dispatch', 'completion']) for (const fault of ['intent-before', 'intent-after', 'mutation-before', 'mutation-after', 'result-before', 'result-after', 'reply-before', 'reply-after']) {
    if (phase !== 'dispatch' && fault.startsWith('mutation')) continue;
    await t.test(`${phase}/${fault}`, async t => {
      const f = await fixture(t); const w = await f.newWork();
      if (phase !== 'request') await f.invoke(f.request(w));
      if (phase === 'completion') await f.invoke(f.request(w, 'dispatch'), create);
      const r = f.request(w, phase), raw = canonical(f.envelope(r, phase === 'dispatch' ? create : undefined));
      const conn = await f.db.client.acquireConnection(); await f.db.client.releaseConnection(conn);
      const exec = conn.exec.bind(conn); let commits = 0; let hit = false;
      const target = fault.startsWith('intent') ? 1 : fault.startsWith('result') ? 2 : 0;
      const mock = t.mock.method(conn, 'exec', (sql: string) => {
        if (sql === 'COMMIT' && ++commits === target) { hit = true; if (fault.endsWith('after')) exec(sql); throw Error('fault'); }
        return exec(sql);
      });
      const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
      const mutation = t.mock.method(f.extensions, 'dispatchAtomic', async (...args: Parameters<typeof dispatch>) => {
        if (fault === 'mutation-before') { hit = true; throw Error('fault'); }
        const result = await dispatch(...args);
        if (fault === 'mutation-after') { hit = true; throw Error('fault'); }
        return result;
      });
      let delivered: any;
      try {
        const attempt = f.plane.invoke(raw, response => {
          if (fault === 'reply-before') { hit = true; throw Error('fault'); }
          delivered = response;
          if (fault === 'reply-after') { hit = true; throw Error('lost reply'); }
        });
        await assert.rejects(attempt, /unavailable/); assert.ok(hit);
      } finally { mock.mock.restore(); mutation.mock.restore(); }
      const committed = fault === 'result-after' || fault.startsWith('reply');
      const intent = fault !== 'intent-before';
      await f.restart();
      assert.equal(Boolean(await f.db('extension_authority_v2_intents').where({ challenge: r.challenge }).first()), intent);
      assert.equal(Boolean(await f.db('extension_authority_v2_receipts').where({ challenge: r.challenge }).first()), committed);
      assert.equal((await f.db('extension_profiles')).length, phase === 'completion' || (phase === 'dispatch' && committed) ? 1 : 0);
      const retry = await f.send(raw);
      assert.equal(retry.status, committed || !intent ? 200 : 403);
      if (committed && delivered) assert.deepEqual(retry.body, delivered);
      if (intent && !committed) {
        const status = await f.invoke(f.request(w, 'status'));
        assert.equal(status.statement.result.state, phase === 'completion' ? 'completed' : 'incomplete');
        assert.equal((await f.send(canonical(f.envelope(f.request(w, phase), phase === 'dispatch' ? create : undefined)))).status, 403);
      }
      transcript.push(`${phase}/${fault}: intent=${Number(intent)} receipt=${Number(committed)} retry=${committed ? 'retained' : intent ? 'refused' : 'new'}\n`);
    });
  }
  assert.equal(transcript.join(''), await fs.readFile('docs/contracts/extension-authority-v2/fault-transcript.txt', 'utf8'));
});

test('signed proof/result tampering and pinned generated artifacts', async () => {
  const root = 'docs/contracts/extension-authority-v2/';
  assert.equal(await fs.readFile(root + 'schema.json', 'utf8'), EXTENSION_AUTHORITY_V2_SCHEMA);
  const f = JSON.parse(await fs.readFile(root + 'fixtures.json', 'utf8'));
  for (const p of f.phases) {
    verifyProof(p.responseCanonical, p.request, p.routing, f.trust, f.coreSPKI, f.nowMs, new Set());
    const response = JSON.parse(p.responseCanonical); response.statement.result.nativeResultDigest = '0'.repeat(64);
    for (const raw of [canonical(response), p.responseCanonical + ' ', '{"signature":"duplicate",' + p.responseCanonical.slice(1)]) {
      assert.throws(() => verifyProof(raw, p.request, p.routing, f.trust, f.coreSPKI, f.nowMs, new Set()), /unavailable/);
    }
  }
  for (const line of (await fs.readFile(root + 'SHA256SUMS', 'utf8')).trim().split('\n')) {
    const [pin, name] = line.split('  '); assert.equal(hash(await fs.readFile(root + name, 'utf8')), pin, name);
  }
  for (const [file, pin] of Object.entries(JSON.parse(await fs.readFile(root + 'source-pins.json', 'utf8')))) assert.equal(hash(await fs.readFile(file, 'utf8')), pin, file);
});

test('v2 refuses the public/tunnel listener', () => {
  const res: any = { set: () => res, status: (status: number) => { assert.equal(status, 404); return res; }, json: (body: any) => assert.deepEqual(body, { error: 'extension_authority_unavailable' }) };
  refusePublicFleetData({ path: route } as any, res, () => assert.fail('public route escaped'));
});

test('authority changes during native work roll back the mutation and leave a terminal intent', async t => {
  for (const kind of ['actor', 'key', 'trust', 'runtime', 'extension', 'expiry']) await t.test(kind, async t => {
    const f = await fixture(t); const w = await f.newWork(); await f.invoke(f.request(w));
    const r = f.request(w, 'dispatch'); const realNow = Date.now;
    const original = f.extensions.dispatchAtomic.bind(f.extensions);
    t.mock.method(f.extensions, 'dispatchAtomic', async (...args: Parameters<typeof original>) => {
      const outcome = await original(...args);
      const database = args[3];
      if (kind === 'actor') await database('instance_members').update({ source: 'managed' });
      if (kind === 'extension') await database('extension_instance_identity').update({ instance_id: randomUUID() });
      if (kind === 'key') await fs.writeFile(path.join(f.control, 'native-authority-key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
      if (kind === 'trust') await f.writeTrust({ ...f.trust, authorityEpoch: '2' });
      if (kind === 'runtime') (f.storage as any).generation = randomUUID();
      if (kind === 'expiry') Date.now = () => r.expiresAt * 1000;
      return outcome;
    });
    try { await assert.rejects(f.plane.invoke(canonical(f.envelope(r, create))), /unavailable/); }
    finally { Date.now = realNow; }
    assert.equal((await f.db('extension_profiles')).length, 0);
    assert.ok(await f.db('extension_authority_v2_intents').where({ challenge: r.challenge }).first());
    assert.equal(await f.db('extension_authority_v2_receipts').where({ challenge: r.challenge }).first(), undefined);
  });
});


test('exclusive expiry, future statements, nonce reuse, native substitution and unsafe Unix root refuse', async t => {
  const f = await fixture(t); const w = await f.newWork();
  const now = Math.floor(Date.now() / 1000);
  for (const times of [{ issuedAt: now + 5, expiresAt: now + 30 }, { issuedAt: now - 10, expiresAt: now }, { issuedAt: now, expiresAt: now + 31 }]) {
    const r = { ...f.request(w), ...times };
    assert.equal((await f.send(canonical(f.envelope(r)))).status, 403);
  }
  await fs.chmod(f.control, 0o755);
  assert.equal((await f.send(canonical(f.envelope(f.request(w))))).status, 403);
  await fs.chmod(f.control, 0o700);
  await f.invoke(f.request(w));
  const duplicate = await f.newWork(); duplicate.extension.nonce = w.extension.nonce;
  assert.equal((await f.send(canonical(f.envelope(f.request(duplicate))))).status, 403);
  const substituted = { ...create, input: { ...input, name: 'different' } };
  assert.equal((await f.send(canonical(f.envelope(f.request(w, 'dispatch'), substituted)))).status, 403);
  assert.equal((await f.db('extension_profiles')).length, 0);
});

test('bounded append-only ledgers fail closed at capacity and retain admitted operations', async t => {
  const f = await fixture(t); const w = await f.newWork(); await f.invoke(f.request(w));
  await f.db.raw(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4095)
    INSERT INTO extension_authority_v2_operations SELECT 'seed-'||i, ?, printf('%064x',i), ?, ? FROM n`, ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  assert.equal((await f.send(canonical(f.envelope(f.request(await f.newWork()))))).status, 403);
  await f.invoke(f.request(w, 'dispatch'), create);
  await f.db.raw(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<16381)
    INSERT INTO extension_authority_v2_intents SELECT printf('%064x',i), 'seed-'||i, 'status', ? FROM n`, ['a'.repeat(64)]);
  const last = f.request(w, 'completion'); await f.invoke(last);
  assert.equal(Number((await f.db('extension_authority_v2_intents').count('* as n').first())!.n), 16384);
  await f.restart();
  await f.invoke(last); // Capacity does not require a second admission for exact retry.
  assert.equal((await f.send(canonical(f.envelope(f.request(w, 'status'))))).status, 403);
});

test('recipient acquisition is committed to the exact mutation operation and intent without exposing material', async t => {
  const f = await fixture(t);
  const native = { ...create, input: { ...input, mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }] } };
  const mutation = await f.newWork(native);
  const intent = { action: native.action, input: native.input };
  const issue = { action: 'recipient.issue', intent, mutationOperationId: mutation.extension.operationId, server: 'docs', field: 'bearerToken' };
  const acquisition = await f.newWork(issue);
  await f.invoke(f.request(acquisition));
  const receipt = await f.invoke(f.request(acquisition, 'dispatch'), issue);
  assert.deepEqual(receipt.statement.result.recipientCommitment, { operationId: mutation.extension.operationId, intentDigest: hash(canonical(intent)) });
  assert.ok(!canonical(receipt).includes('privateKey'));
  const other: any = await f.newWork(native); other.acquisitionOperationId = acquisition.extension.operationId;
  assert.equal((await f.send(canonical(f.envelope(f.request(other))))).status, 403);
  (mutation as any).acquisitionOperationId = acquisition.extension.operationId;
  await f.invoke(f.request(mutation));
  await f.invoke(f.request(mutation, 'dispatch'), native);
  assert.equal((await f.db('extension_profiles')).length, 1);
});

test('a valid signed receipt for another operation cannot replace a retained native result', async t => {
  const f = await fixture(t); const native = { action: 'catalog.list' };
  const first = await f.newWork(native), second = await f.newWork(native);
  const phases: any[] = [];
  for (const work of [first, second]) {
    await f.invoke(f.request(work)); const r = f.request(work, 'dispatch');
    phases.push({ r, response: await f.invoke(r, native) });
  }
  // Simulate offline corruption, bypassing the immutable-table SQL trigger.
  await f.db.raw('DROP TRIGGER extension_authority_v2_receipts_update');
  await f.db('extension_authority_v2_receipts').where({ challenge: phases[0].r.challenge }).update({
    response: canonical(phases[1].response), response_digest: hash(canonical(phases[1].response)),
  });
  assert.equal((await f.send(canonical(f.envelope(f.request(first, 'completion'))))).status, 403);
  assert.equal((await f.send(canonical(f.envelope(phases[0].r, native)))).status, 403);
});

test('the Unix listener refuses invalid UTF-8 rather than authenticating replacement characters', async t => {
  const f = await fixture(t); const native = { ...create, input: { ...input, name: 'replacement-\uFFFD' } };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const r = f.request(work, 'dispatch'); const wire = Buffer.from(canonical(f.envelope(r, native)));
  const offset = wire.indexOf(Buffer.from('\uFFFD')); assert.ok(offset > 0);
  const malformed = Buffer.concat([wire.subarray(0, offset), Buffer.from([0xff]), wire.subarray(offset + 3)]);
  assert.equal((await f.send(malformed)).status, 403);
  assert.equal(await f.db('extension_authority_v2_intents').where({ challenge: r.challenge }).first(), undefined);
  await f.invoke(r, native);
});
