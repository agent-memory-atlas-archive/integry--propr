import { rememberDiagnosticCredentials, diagnosticCredentials } from './redaction.js';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getManagedAgentConfigRelativePath } from '@propr/shared';
import { collectProvider } from './providerCollector.js';
import { nativeCredentialValues } from './credentialRedaction.js';
import { ManagedLogSpool, type LogIdentity } from './managedLogSpool.js';

let spool: ManagedLogSpool | undefined;
let warningAt = 0;
let applicationLostBytes = 0;
export function diagnosticsFailure(): void {
    if (Date.now() - warningAt > 60_000) {
        warningAt = Date.now();
        // Deliberately no exception text, file names or record contents.
        process.stderr.write('managed diagnostics unavailable; collection coverage is incomplete\n');
    }
}
export function managedDiagnostics(): ManagedLogSpool | null {
    if (spool !== undefined) return spool;
    const enabled = Boolean(process.env.PROPR_FLEET_CONTROL_SECRET) || process.env.PROPR_MANAGED_LOGS === '1';
    if (!enabled) return null;
    const root = process.env.PROPR_DIAGNOSTIC_ROOT || '/usr/src/app/data/managed-diagnostics';
    spool = new ManagedLogSpool(root, process.env.PROPR_INSTANCE_ID || '');
    return spool;
}
export function configuredDiagnosticSecrets(env: Record<string, string | undefined> = process.env): string[] {
    return Object.entries(env).filter(([k, v]) => /secret|token|password|key|credential/i.test(k) && v).map(([, v]) => v!);
}
/** Application hook receives complete Pino JSON records before pretty printing. */
export function captureApplicationRecord(line: string): void {
    const identity = { provider: 'application', agent: 'application', source: 'pino' };
    try {
        const db = managedDiagnostics();
        if (applicationLostBytes && db) { db.report(identity, 'storage-unavailable', applicationLostBytes); applicationLostBytes = 0; }
        const known = diagnosticCredentials();
        if (db && known === null) db.report(identity, 'unsafe-source', Buffer.byteLength(line));
        else db?.append(identity, [line], 'jsonl', [...configuredDiagnosticSecrets(), ...(known ?? [])]);
    } catch { applicationLostBytes = Math.min(Number.MAX_SAFE_INTEGER, applicationLostBytes + Buffer.byteLength(line)); diagnosticsFailure(); }
}
export function captureProviderOutput(identity: LogIdentity, secrets: readonly string[]): { write(chunk: string): void; close(): void } {
    let pending = '', discard = false, lostBytes = 0;
    const db = managedDiagnostics();
    if (!db) return { write() {}, close() {} };
    // There is no durable stdout offset across process death. Expose the capture
    // boundary rather than claiming continuous history after a restart.
    db.report(identity, 'capture-interrupted');
    return {
        write(chunk) {
            try {
                if (lostBytes) { db.report(identity, 'storage-unavailable', lostBytes); lostBytes = 0; }
                const records: string[] = [];
                let dropped = 0, start = 0, bytes = 0;
                const flush = () => {
                    if (records.length || dropped) db.append(identity, records, 'text', secrets, Date.now(), undefined, dropped);
                    records.length = 0; dropped = 0; bytes = 0;
                };
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== '\n') continue;
                    const part = chunk.slice(start, i); start = i + 1;
                    const size = Buffer.byteLength(pending) + Buffer.byteLength(part);
                    if (discard || size > db.limits.recordBytes) dropped += size + 1;
                    else {
                        if (bytes + size > db.limits.scanBytes || records.length >= 4096) flush();
                        records.push(pending + part); bytes += size;
                    }
                    pending = ''; discard = false;
                }
                const rest = chunk.slice(start);
                if (discard || Buffer.byteLength(pending) + Buffer.byteLength(rest) > db.limits.recordBytes) {
                    dropped += Buffer.byteLength(pending) + Buffer.byteLength(rest);
                    pending = ''; discard = true;
                } else pending += rest;
                flush();
            } catch { lostBytes = Math.min(Number.MAX_SAFE_INTEGER, lostBytes + Buffer.byteLength(chunk) + Buffer.byteLength(pending)); pending = ''; discard = true; diagnosticsFailure(); }
        },
        close() {
            try { if (lostBytes) db.report(identity, 'storage-unavailable', lostBytes); if (pending || discard) db.append(identity, [], 'text', secrets, Date.now(), undefined, Buffer.byteLength(pending) || 1); }
            catch { diagnosticsFailure(); }
            pending = '';
        },
    };
}

export interface DiagnosticAgent { provider: string; agent: string; configPath?: string; credentials?: Record<string, string>; nativeRoot?: string }
/** Prepare BEFORE spawning so protected-state backpressure cannot orphan a child. */
export function prepareProviderCapture(agent: DiagnosticAgent, args: string[] = [], extraEnv: Record<string, string> = {}) {
    const db = managedDiagnostics();
    if (!db) return null;
    db.assertCapacity();
    const secrets = [...configuredDiagnosticSecrets(), ...Object.values(agent.credentials ?? {}), ...configuredDiagnosticSecrets(extraEnv)];
    for (let i = 0; i < args.length - 1; i++) if (args[i] === '-e' || args[i] === '--env') {
        const separator = args[i + 1].indexOf('=');
        if (separator > 0) secrets.push(...configuredDiagnosticSecrets({ [args[i + 1].slice(0, separator)]: args[i + 1].slice(separator + 1) }));
    }
    const relative = getManagedAgentConfigRelativePath(agent.configPath ?? '');
    try {
        const mounts: Record<string, string | undefined> = {
            codex: process.env.CODEX_CONFIG_PATH || process.env.HOST_CODEX_DIR,
            claude: process.env.CLAUDE_CONFIG_PATH || process.env.HOST_CLAUDE_DIR,
            antigravity: process.env.ANTIGRAVITY_CONFIG_PATH || process.env.HOST_ANTIGRAVITY_DIR,
            opencode: process.env.HOST_OPENCODE_DATA_DIR,
            vibe: process.env.VIBE_CONFIG_PATH || process.env.HOST_VIBE_DIR,
        };
        let root: string | undefined;
        if (relative && process.env.PROPR_MANAGED_CREDENTIALS_DIR) {
            root = path.join(process.env.PROPR_MANAGED_CREDENTIALS_DIR, relative);
            if (agent.provider === 'opencode') root = root.replace(/\/\.config\/opencode$/, '/.local/share/opencode');
        } else if (!relative && (agent.configPath?.startsWith('~/') || agent.configPath === mounts[agent.provider])) {
            root = mounts[agent.provider];
        }
        if (root) secrets.push(...nativeCredentialValues(root, agent.provider));
        rememberDiagnosticCredentials(secrets);
        const snapshot = () => {
            if (db && agent.provider === 'vibe' && agent.nativeRoot) {
                try { collectProvider(db, { provider: 'vibe', agent: agent.agent, root: agent.nativeRoot, credentials: secrets }); }
                catch { diagnosticsFailure(); }
            }
        };
        return {
            snapshot,
            stdout: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stdout' }, secrets),
            stderr: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stderr' }, secrets),
        };
    } catch {
        diagnosticsFailure();
        try { db?.report({ provider: agent.provider, agent: agent.agent, source: 'capture' }, 'unsafe-source'); } catch { /* failure is already surfaced */ }
        return null;
    }
}
export function attachProviderCapture(child: ChildProcess, capture: ReturnType<typeof prepareProviderCapture>): void {
    if (!capture) return;
    const timer = setInterval(capture.snapshot, 30_000); timer.unref();
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => capture.stdout.write(stdout.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => capture.stderr.write(stderr.write(chunk)));
    child.once('close', () => {
        clearInterval(timer); capture.snapshot();
        capture.stdout.write(stdout.end()); capture.stdout.close();
        capture.stderr.write(stderr.end()); capture.stderr.close();
    });
}
