// Real process death, never a simulated exception or graceful database close.
import fs from 'node:fs/promises';
import { canonicalFleetJson as canonical } from '@propr/shared';
import { fixture, create } from './extensionAuthorityV2Fixture.js';
const [fault, metadata] = process.argv.slice(2);
const f = await fixture({ after() {} });
const work = await f.newWork();
await f.invoke(f.request(work));
const r = f.request(work, 'dispatch'), envelope = f.envelope(r, create);
await fs.writeFile(metadata, JSON.stringify({ root: f.root, r, envelope, trust: f.trust, coreSPKI: f.spki(f.core) }));
const die = (): never => { process.kill(process.pid, 'SIGKILL'); throw Error('unreachable'); };
const conn = await f.db.client.acquireConnection(); await f.db.client.releaseConnection(conn);
const exec = conn.exec.bind(conn); let commits = 0;
conn.exec = (sql: string) => {
  const boundary = fault.startsWith('intent') ? 1 : fault.startsWith('result') ? 2 : 0;
  if (sql === 'COMMIT' && ++commits === boundary) { if (fault.endsWith('after')) exec(sql); die(); }
  return exec(sql);
};
const createFile = f.fleet.files.create.bind(f.fleet.files);
f.fleet.files.create = async (name, value) => {
  const prefix = name.startsWith('extension-nonce-') ? 'nonce' : 'native-intent';
  if (fault === `${prefix}-before`) die();
  await createFile(name, value);
  if (fault === `${prefix}-after`) die();
};
const prepare = conn.prepare.bind(conn);
conn.prepare = (sql: string) => {
  const statement = prepare(sql);
  if (sql.startsWith('INSERT INTO extension_authority_v2_receipts')) {
    const run = statement.run.bind(statement);
    statement.run = (...args: unknown[]) => {
      if (fault === 'decision-before') die();
      const result = run(...args);
      if (fault === 'decision-after') die();
      return result;
    };
  }
  return statement;
};
const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
f.extensions.dispatchAtomic = async (...args) => {
  if (fault === 'mutation-before') die();
  const result = await dispatch(...args);
  if (fault === 'mutation-after') die();
  return result;
};
await f.plane.invoke(canonical(envelope), response => {
  if (fault === 'reply-before') die();
  // A serialized reply may have left Core without reaching Fleet.
  canonical(response);
  if (fault === 'reply-after') die();
});
throw Error('Fault boundary was not reached');
