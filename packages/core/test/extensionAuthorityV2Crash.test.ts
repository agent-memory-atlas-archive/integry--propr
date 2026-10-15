import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';
import { verifyProof } from '../../../docs/contracts/extension-authority-v2/verifier.mjs';
test('SIGKILL at every dispatch boundary: SQLite recovers mutation and receipt together', async t => {
  const transcript: string[] = [];
  const { spawn } = await import('node:child_process');
  for (const fault of ['intent-before', 'intent-after', 'nonce-before', 'nonce-after', 'native-intent-before', 'native-intent-after', 'mutation-before', 'mutation-after', 'decision-before', 'decision-after', 'result-before', 'result-after', 'reply-before', 'reply-after']) await t.test(fault, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-crash-parent-'));
    const metadata = path.join(dir, 'metadata.json');
    let root: string | undefined;
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'packages/core/test/helpers/extensionAuthorityV2Crash.ts', fault, metadata], { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = ''; child.stderr.on('data', data => { error += data; }); child.on('error', reject);
        child.on('exit', (code, signal) => signal === 'SIGKILL' ? resolve({ code, signal }) : reject(Error(error || `Unexpected exit ${code}`)));
      });
      assert.equal(exit.signal, 'SIGKILL');
      const m = JSON.parse(await fs.readFile(metadata, 'utf8')); root = m.root;
      const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(root!, 'db.sqlite') }, useNullAsDefault: true });
      try {
        const committed = fault === 'result-after' || fault.startsWith('reply');
        assert.equal((await db('extension_profiles')).length, committed ? 1 : 0);
        const receipt = await db('extension_authority_v2_receipts').where({ challenge: m.r.challenge }).first();
        assert.equal(Boolean(receipt), committed);
        assert.equal(Boolean(await db('extension_authority_v2_intents').where({ challenge: m.r.challenge }).first()), fault !== 'intent-before');
        if (receipt) verifyProof(receipt.response, m.r, m.envelope.routing, m.trust, m.coreSPKI, Date.now(), new Set());
        assert.deepEqual(await db.raw('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
        transcript.push(`SIGKILL/${fault}: intent=${Number(fault !== 'intent-before')} mutation=${Number(committed)} receipt=${Number(committed)} integrity=ok\n`);
      } finally { await db.destroy(); }
    } finally { if (root) await fs.rm(root, { recursive: true, force: true }); await fs.rm(dir, { recursive: true, force: true }); }
  });
  assert.equal(transcript.join(''), await fs.readFile('docs/contracts/extension-authority-v2/crash-transcript.txt', 'utf8'));
});
