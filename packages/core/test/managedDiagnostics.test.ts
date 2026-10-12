import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { ManagedLogSpool, digest } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider } from '../src/diagnostics/providerCollector.js';
import { PinnedDirectory } from '../src/diagnostics/privateDirectory.js';
import { redactRecord } from '../src/diagnostics/redaction.js';

const identity = { provider: 'codex', agent: 'agent-a', source: 'stdout' };
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    return { root, spool, close() { spool.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function drain(spool: ManagedLogSpool) {
    const result: Array<{ manifest: any; text: string; data: Buffer }> = [];
    for (let item; (item = spool.exportOne());) {
        assert.equal(digest(item.data), item.digest);
        result.push({ manifest: item.manifest, text: gunzipSync(item.data).toString(), data: item.data });
        spool.acknowledge(item.id, item.digest);
    }
    return result;
}
test('UTC midnight, multiple size rolls, stable sealed export, restart and cursor CAS', () => {
    const f = fixture();
    try {
        const lines = Array.from({ length: 20 }, (_, n) => JSON.stringify({ n, message: 'a'.repeat(30_000) }));
        const before = Date.parse('2026-10-11T23:59:59Z');
        f.spool.append(identity, lines.slice(0, 10), 'jsonl', [], before);
        f.spool.append(identity, lines.slice(10), 'jsonl', [], before + 2000, { before: {}, after: { offset: 20 } });
        assert.equal(f.spool.append(identity, lines, 'jsonl', [], before, { before: {}, after: { offset: 20 } }), false);
        const second = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
        assert.deepEqual(second.exportOne(), f.spool.exportOne());
        second.close();
        const exported = drain(f.spool);
        assert.equal(exported.length, 4);
        assert.deepEqual(exported.flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line).n)), lines.map((_, n) => n));
        assert.deepEqual([...new Set(exported.map(e => e.manifest.utcDay))], ['2026-10-11', '2026-10-12']);
        assert.equal(exported[0].manifest.historyComplete, false);
    } finally { f.close(); }
});
test('actual managed Codex and Claude layouts: active append-only writers, protected resumable state and immutable credentials', () => {
    const f = fixture();
    try {
        for (const provider of ['codex', 'claude'] as const) {
            const home = path.join(f.root, 'agent-credentials', 'agent-a', provider === 'codex' ? '.codex' : '.claude');
            const native = provider === 'codex' ? 'sessions/2026/10/12/rollout-session.jsonl' : 'projects/-workspace/session.jsonl';
            const debug = provider === 'codex' ? 'log/codex-tui.log' : 'debug/session.txt';
            for (const name of [native, debug]) fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
            const auth = provider === 'codex' ? 'auth.json' : '.credentials.json';
            fs.writeFileSync(path.join(home, auth), '{"access_token":"credential-canary"}');
            fs.writeFileSync(path.join(home, 'config.json'), 'UNRELATED-CONFIG-CANARY');
            fs.writeFileSync(path.join(home, debug), 'INFO token=secret-canary ready\n');
            const writer = fs.openSync(path.join(home, native), 'a');
            fs.writeSync(writer, '{"type":"session_meta","authorization":"Bearer credential-canary"}\n{"type":');
            const args = { provider, agent: 'agent-a', root: home, credentials: ['credential-canary', 'secret-canary'] };
            collectProvider(f.spool, args);
            fs.writeSync(writer, '"message","text":"customer prompt credential-canary"}\n');
            collectProvider(f.spool, args);
            collectProvider(f.spool, args);
            fs.closeSync(writer);
            assert.equal(fs.readFileSync(path.join(home, auth), 'utf8'), '{"access_token":"credential-canary"}');
            assert.equal(fs.readFileSync(path.join(home, native), 'utf8').split('\n').length, 3);
        }
        const exported = drain(f.spool).map(e => e.text).join('');
        assert.equal((exported.match(/session_meta/g) ?? []).length, 2);
        assert.equal((exported.match(/customer prompt/g) ?? []).length, 2);
        for (const secret of ['credential-canary', 'secret-canary', 'UNRELATED-CONFIG-CANARY']) assert.ok(!exported.includes(secret));
        assert.ok(JSON.stringify(f.spool.status()).includes('protected-native-state'));
    } finally { f.close(); }
});
test('no acknowledgement preserves old export, bounded outage drops new data and records gaps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-cap-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', { segments: 2, segmentBytes: 80 });
    try {
        for (let n = 0; n < 20; n++) spool.append(identity, [JSON.stringify({ n, text: 'a'.repeat(50) })], 'jsonl', []);
        const status = spool.status() as any;
        assert.equal(status.spool.segments, 2);
        assert.equal(status.sources[0].gaps, 18);
        const item = spool.exportOne()!;
        assert.throws(() => spool.acknowledge(item.id, 'wrong'));
        assert.deepEqual(spool.exportOne(), item);
        assert.ok(item.data.length < 100);
        spool.report(identity, 'protected-native-state', spool.limits.protectedBytes);
        assert.throws(() => spool.assertCapacity(), /protected native state/);
        spool.acknowledge(item.id, item.digest);
        assert.equal((spool.status() as any).spool.segments, 1);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('hostile symlink, hardlink, FIFO, traversal and ancestor replacement', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'home'); fs.mkdirSync(home); fs.mkdirSync(path.join(home, 'debug'));
        const outside = path.join(f.root, 'secret'); fs.writeFileSync(outside, 'OUTSIDE-CANARY\n');
        fs.symlinkSync(outside, path.join(home, 'debug', 'symlink.txt'));
        fs.linkSync(outside, path.join(home, 'debug', 'hardlink.txt'));
        execFileSync('mkfifo', [path.join(home, 'debug', 'fifo.txt')]);
        collectProvider(f.spool, { provider: 'claude', agent: 'a', root: home, credentials: [] });
        assert.equal(f.spool.exportOne(), null);
        assert.ok(JSON.stringify(f.spool.status()).includes('unsafe-source'));
        assert.throws(() => PinnedDirectory.open(home + '/../secret'));
        const pin = PinnedDirectory.open(home);
        fs.renameSync(home, home + '-old'); fs.symlinkSync(f.root, home);
        const debug = pin.child('debug');
        assert.equal(fs.fstatSync(debug.fd).ino, fs.statSync(path.join(home + '-old', 'debug')).ino);
        debug.close(); pin.close();
        assert.throws(() => PinnedDirectory.open(home));
    } finally { f.close(); }
});
test('oversized partial records are discarded through newline without tail leakage', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'home'); fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
        const file = path.join(home, 'debug', 'active.txt');
        fs.writeFileSync(file, 'x'.repeat(100_000));
        const args = { provider: 'claude' as const, agent: 'a', root: home, credentials: [] };
        collectProvider(f.spool, args);
        fs.appendFileSync(file, 'tail-that-must-not-ship\nINFO ready\n'); collectProvider(f.spool, args);
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(!output.includes('tail-that-must-not-ship'));
        assert.ok(output.includes('ready'));
        assert.ok((f.spool.status() as any).sources.some((s: any) => s.droppedBytes >= 100_000));
    } finally { f.close(); }
});
test('structured and text redaction fail closed', () => {
    assert.equal(redactRecord('{"bad":', 'jsonl', []), null);
    assert.equal(redactRecord('{"bad":', 'text', []), null);
    const value = redactRecord(JSON.stringify({ nested: { refresh_token: 'CANARY', cookies: ['CANARY'] }, text: 'Bearer CANARY password=CANARY sk-1234567890 ghp_abcdefghijk configured-value' }), 'jsonl', ['configured-value'])!;
    assert.ok(!value.includes('CANARY')); assert.ok(!value.includes('configured-value'));
});
test('CLI private export and readback acknowledgement integration', () => {
    const f = fixture();
    try {
        f.spool.append(identity, ['{"msg":"hello"}'], 'jsonl', []);
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a' };
        const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/managed-diagnostics.ts', ...args], { env, encoding: 'utf8' });
        const result = cli('export'); assert.equal(result.status, 0, result.stderr);
        const item = JSON.parse(result.stdout);
        assert.equal(gunzipSync(Buffer.from(item.gzipBase64, 'base64')).toString(), '{"msg":"hello"}\n');
        assert.equal(cli('ack', String(item.manifest.segment), item.manifest.sha256).status, 1);
        assert.equal(cli('ack', String(item.manifest.segment), item.manifest.sha256, '--encrypted-upload-readback-verified').status, 0);
        assert.equal(cli('export').stdout.trim(), 'null');
    } finally { f.close(); }
});
test('all remaining enabled provider layouts have explicit safe collection and protected stores', () => {
    const f = fixture();
    try {
        const layouts = {
            antigravity: 'antigravity-cli/brain/conversation/.system_generated/logs/transcript.jsonl',
            opencode: 'log/2026-10-12.log',
            vibe: 'logs/session/session-id/messages.jsonl',
        } as const;
        for (const [provider, relative] of Object.entries(layouts)) {
            const root = path.join(f.root, provider);
            fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
            fs.writeFileSync(path.join(root, relative), JSON.stringify({ event: 'diagnostic', token: 'OPAQUE-AUTH', ...(provider === 'vibe' ? { message: 'opaque-vibe-key' } : {}) }) + '\n');
            if (provider === 'vibe') fs.writeFileSync(path.join(root, '.env'), 'MISTRAL_API_KEY=opaque-vibe-key\n');
            fs.writeFileSync(path.join(root, 'settings.json'), 'NEVER-EXPORT-CONFIG');
            if (provider === 'opencode') fs.writeFileSync(path.join(root, 'opencode.db'), 'NATIVE-RESUMABLE-STATE');
            collectProvider(f.spool, { provider: provider as keyof typeof layouts, root, agent: 'a', credentials: [] });
        }
        const data = drain(f.spool);
        assert.equal(data.length, 3);
        assert.ok(data.every(e => !/OPAQUE-AUTH|opaque-vibe-key|NEVER-EXPORT|NATIVE-RESUMABLE/.test(e.text)));
        assert.ok((f.spool.status() as any).sources.find((s: any) => s.provider === 'opencode' && s.source === 'native-state').protectedBytes > 20);
    } finally { f.close(); }
});
test('credential canary loaded for redaction only; unsafe auth store refuses all native collection', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'codex'); fs.mkdirSync(path.join(home, 'log'), { recursive: true });
        fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"access_token":"opaque-value-without-known-prefix"}}');
        fs.writeFileSync(path.join(home, 'log/codex-tui.log'), 'INFO opaque-value-without-known-prefix\n');
        collectProvider(f.spool, { provider: 'codex', root: home, agent: 'a', credentials: [] });
        assert.ok(!drain(f.spool).map(s => s.text).join('').includes('opaque-value'));
        fs.writeFileSync(path.join(home, 'auth.json'), '{malformed');
        fs.appendFileSync(path.join(home, 'log/codex-tui.log'), 'INFO must-not-export\n');
        collectProvider(f.spool, { provider: 'codex', root: home, agent: 'a', credentials: [] });
        assert.equal(f.spool.exportOne(), null);
    } finally { f.close(); }
});
test('SQLite full fault rolls back both data and cursor, keeping last acknowledged coverage honest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-full-'));
    const limits = { databaseBytes: 128 * 1024 };
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', limits);
    try {
        let failed = false;
        for (let i = 0; i < 50; i++) {
            const cursor = spool.cursor(identity);
            const random = Array.from({ length: 1000 }, (_, n) => digest(`${i}-${n}`)).join('');
            try { spool.append(identity, [JSON.stringify({ message: random })], 'jsonl', [], Date.now(), { before: cursor, after: { offset: i + 1 } }); }
            catch {
                assert.deepEqual(spool.cursor(identity), cursor);
                failed = true; break;
            }
        }
        assert.ok(failed, 'must actually exercise database full');
        assert.equal((spool.status() as any).historyComplete, false);
        const item = spool.exportOne(); assert.ok(item);
        assert.ok(gunzipSync(item.data).length <= spool.limits.segmentBytes);
        assert.ok(fs.statSync(path.join(root, 'spool/spool.sqlite')).size <= limits.databaseBytes);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('sparse multi-GB provider log is bounded and warns rather than truncating native state', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'large'); fs.mkdirSync(path.join(home, 'log'), { recursive: true });
        const file = path.join(home, 'log/codex-tui.log');
        const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 3 * 1024 ** 3); fs.closeSync(fd);
        const before = process.memoryUsage().rss;
        collectProvider(f.spool, { provider: 'codex', root: home, agent: 'large', credentials: [] });
        assert.ok(process.memoryUsage().rss - before < 32 * 1024 ** 2);
        assert.equal(fs.statSync(file).size, 3 * 1024 ** 3);
        assert.throws(() => f.spool.assertCapacity(), /protected native state/);
        assert.equal(f.spool.exportOne(), null);
    } finally { f.close(); }
});
test('injected ENOSPC during commit is atomic and retry preserves committed record identity', () => {
    const f = fixture();
    try {
        f.spool.cursor(identity);
        const db = (f.spool as any).db;
        const execute = db.exec.bind(db);
        let fail = true;
        db.exec = (sql: string) => {
            if (sql === 'COMMIT' && fail) { fail = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
            return execute(sql);
        };
        assert.throws(() => f.spool.append(identity, ['{"n":1}'], 'jsonl', [], 1000, { before: {}, after: { offset: 8 } }), /disk full/);
        assert.deepEqual(f.spool.cursor(identity), {});
        assert.equal(f.spool.exportOne(), null);
        f.spool.append(identity, ['{"n":1}'], 'jsonl', [], 1000, { before: {}, after: { offset: 8 } });
        assert.equal(drain(f.spool)[0].text, '{"n":1}\n');
    } finally { f.close(); }
});
test('real application Pino hook exports redacted operational records', () => {
    const f = fixture();
    try {
        const env = { ...process.env, NODE_ENV: 'production', PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a', DIAGNOSTIC_TEST_SECRET: 'configured-opaque-canary' };
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
            `import logger from './packages/core/src/utils/logger.ts'; logger.info({ authorization: 'Bearer auth-canary' }, 'configured-opaque-canary');`], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const records = drain(f.spool).map(e => e.text).join('');
        assert.ok(records.includes('REDACTED'));
        assert.ok(!records.includes('auth-canary')); assert.ok(!records.includes('configured-opaque-canary'));
    } finally { f.close(); }
});
test('concurrent process rotation, export and cursor CAS recover without duplicate committed records', async () => {
    const { spawn } = await import('node:child_process');
    const f = fixture();
    try {
        const modulePath = new URL('../src/diagnostics/managedLogSpool.ts', import.meta.url).href;
        const script = `import { ManagedLogSpool } from ${JSON.stringify(modulePath)};
            const spool = new ManagedLogSpool(${JSON.stringify(path.join(f.root, 'spool'))}, 'tenant-a');
            const identity = ${JSON.stringify(identity)};
            for (let n=0;n<12;n++) { let done=false; while(!done) { try { spool.append(identity,[JSON.stringify({writer:process.env.WRITER,n})],'jsonl',[]); done=true; } catch(e) { if(e.code!=='SQLITE_BUSY') throw e; } } }
            spool.close();`;
        const run = (writer: string) => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, WRITER: writer }, stdio: ['ignore', 'ignore', 'pipe'] });
            let error = ''; child.stderr.on('data', chunk => { error += chunk; });
            child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
        });
        const exported: ReturnType<typeof drain> = [];
        const timer = setInterval(() => {
            try {
                const item = f.spool.exportOne();
                if (item) {
                    f.spool.acknowledge(item.id, item.digest);
                    exported.push({ manifest: item.manifest, data: item.data, text: gunzipSync(item.data).toString() });
                }
            } catch (error) { if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error; }
        }, 30);
        try { await Promise.all([run('a'), run('b')]); }
        finally { clearInterval(timer); }
        exported.push(...drain(f.spool));
        const output = exported.flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line)));
        assert.equal(output.length, 24);
        assert.equal(new Set(output.map(r => `${r.writer}:${r.n}`)).size, 24);
    } finally { f.close(); }
});
test('file replacement, malicious spool roots and cross-instance access fail safe', () => {
    const f = fixture();
    try {
        assert.throws(() => new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-b'), /mismatch/);
        const linked = path.join(f.root, 'linked'); fs.symlinkSync(path.join(f.root, 'spool'), linked);
        assert.throws(() => new ManagedLogSpool(linked, 'tenant-a'));
        const home = path.join(f.root, 'home'); fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
        const log = path.join(home, 'debug/session.txt'); fs.writeFileSync(log, 'INFO original-record\n');
        const args = { provider: 'claude' as const, root: home, agent: 'a', credentials: [] };
        collectProvider(f.spool, args);
        // Reuse the same inode, regrow past its old offset before the next scan.
        fs.writeFileSync(log, 'INFO replaced-record-with-longer-value\n');
        collectProvider(f.spool, args);
        assert.ok(JSON.stringify(f.spool.status()).includes('source-replaced'));
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(output.includes('original-record')); assert.ok(output.includes('replaced-record'));
    } finally { f.close(); }
});
test('stream capture stays bounded across chunks and keeps the original live child stream usable', () => {
    const f = fixture();
    try {
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a' };
        const script = `import { captureProviderOutput } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const capture=captureProviderOutput({provider:'claude',agent:'live',source:'stdout'},['secret-value']);
            for(let n=0;n<4;n++) { const chunk=JSON.stringify({n,message:'secret-value'})+'\\n'; process.stdout.write(chunk); capture.write(chunk.slice(0,12)); capture.write(chunk.slice(12)); }
            capture.write('x'.repeat(100000)); capture.write('unsafe-tail\\n'); capture.close();`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim().split('\n').length, 4);
        const records = drain(f.spool).flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line)));
        assert.deepEqual(records.map(r => r.n), [0, 1, 2, 3]);
        assert.ok(!JSON.stringify(records).includes('secret-value'));
        assert.ok((f.spool.status() as any).sources.some((s: any) => s.droppedBytes >= 100000));
    } finally { f.close(); }
});
