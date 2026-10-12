import { rememberDiagnosticCredentials } from './redaction.js';
import { nativeCredentialValues } from './credentialRedaction.js';
import fs from 'node:fs';
import { ManagedLogSpool, digest, type LogIdentity } from './managedLogSpool.js';
import { PinnedDirectory } from './privateDirectory.js';

export type DiagnosticProvider = 'codex' | 'claude' | 'antigravity' | 'opencode' | 'vibe';
// Exact structural allowlists. No glob of an entire home; no repository paths.
const files: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:log\/codex-tui\.log|(?:sessions|archived_sessions)\/\d{4}\/\d{2}\/\d{2}\/rollout-[\w.-]+\.jsonl)$/,
    claude: /^(?:debug\/[\w.-]+\.txt|projects\/[^/]+\/[\w.-]+\.jsonl|projects\/[^/]+\/[\w.-]+\/subagents\/agent-[\w.-]+\.jsonl)$/,
    opencode: /^log\/[\w.-]+\.log$/,
    vibe: /^logs\/session\/[\w.-]+\/messages\.jsonl$/,
    antigravity: /^antigravity-cli\/(?:log\/[\w.-]+\.log|brain\/[\w.-]+\/\.system_generated\/logs\/transcript\.jsonl)$/,
};
const protectedFiles: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:state_\d+|logs_\d+)\.sqlite(?:-wal|-shm)?$/,
    claude: /^history\.jsonl$/,
    opencode: /^opencode\.db(?:-wal|-shm)?$/,
    antigravity: /$a/, vibe: /$a/,
};
const directories: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:log|sessions|archived_sessions|(?:sessions|archived_sessions)\/\d{4}(?:\/\d{2}){0,2})$/,
    claude: /^(?:debug|projects|projects\/[^/]+|projects\/[^/]+\/[\w.-]+(?:\/subagents)?)$/,
    opencode: /^log$/,
    vibe: /^(?:logs|logs\/session|logs\/session\/[\w.-]+)$/,
    antigravity: /^(?:antigravity-cli|antigravity-cli\/log|antigravity-cli\/brain|antigravity-cli\/brain\/[\w.-]+(?:\/\.system_generated(?:\/logs)?)?)$/,
};
export interface ProviderRoot { provider: DiagnosticProvider; agent: string; root: string; credentials: readonly string[] }

/** Snapshot only committed newline-delimited records. Never modifies the writer's
 * descriptor, native filename, DB, resume state, or live UI watcher. */
export function collectProvider(spool: ManagedLogSpool, input: ProviderRoot, now = Date.now()): void {
    const summary: LogIdentity = { provider: input.provider, agent: input.agent, source: 'native-state' };
    let root: PinnedDirectory;
    try { root = PinnedDirectory.open(input.root); }
    catch (e) {
        spool.report(summary, (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ownership-unverified' : 'unsafe-source');
        return;
    }
    let credentials: readonly string[];
    try { credentials = [...input.credentials, ...nativeCredentialValues(input.root, input.provider, root)]; }
    catch { root.close(); spool.report(summary, 'unsafe-source'); return; }
    rememberDiagnosticCredentials(credentials);
    let count = 0, readBytes = 0, protectedBytes = 0;
    const deadline = performance.now() + spool.limits.scanMs;
    let limited = false, inventoryIncomplete = false;
    const walk = (dir: PinnedDirectory, prefix: string): void => {
        const listing = fs.opendirSync(`/proc/self/fd/${dir.fd}`);
        try {
            let entry: fs.Dirent | null;
            while ((entry = listing.readSync())) {
                if (++count > spool.limits.scanFiles || performance.now() > deadline) { limited = true; inventoryIncomplete = true; break; }
                const relative = prefix + entry.name;
                // File matches precede directory matches (Claude session basenames).
                if (protectedFiles[input.provider].test(relative)) {
                    let fd: number | undefined;
                    try { fd = dir.file(entry.name); protectedBytes += fs.fstatSync(fd).size; }
                    catch { inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); }
                    finally { if (fd !== undefined) fs.closeSync(fd); }
                } else if (files[input.provider].test(relative)) {
                    const identity = { provider: input.provider, agent: input.agent, source: digest(relative) };
                    let fd: number | undefined;
                    try {
                        fd = dir.file(entry.name);
                        const stat = fs.fstatSync(fd);
                        protectedBytes += stat.size;
                        if (readBytes >= spool.limits.scanBytes) { limited = true; continue; }
                        const before = spool.cursor(identity);
                        const inode = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
                        let offset = before.offset ?? 0;
                        const anchorAt = (position: number) => {
                            const bytes = Buffer.alloc(Math.min(128, position));
                            const n = fs.readSync(fd!, bytes, 0, bytes.length, position - bytes.length);
                            return digest(bytes.subarray(0, n));
                        };
                        const replaced = Boolean((before.anchor && offset <= stat.size && before.anchor !== anchorAt(offset)) || (before.inode && before.inode !== inode) || offset > stat.size);
                        if (replaced) {
                            spool.report(identity, 'source-replaced', Math.max(0, offset - stat.size)); offset = 0;
                        }
                        const buffer = Buffer.alloc(Math.min(spool.limits.scanBytes - readBytes, stat.size - offset));
                        const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
                        readBytes += length;
                        let start = 0, dropped = 0, discard = replaced ? false : before.discard ?? false;
                        const records: string[] = [];
                        let recordBound = false;
                        for (let end = 0; end < length; end++) if (buffer[end] === 10) {
                            if (discard || end - start > spool.limits.recordBytes) dropped += end + 1 - start;
                            else records.push(buffer.subarray(start, end).toString('utf8'));
                            discard = false; start = end + 1;
                            if (records.length >= 4096) { recordBound = true; limited = true; break; }
                        }
                        // An oversized unfinished line is consumed in bounded pieces,
                        // and its tail can NEVER be reclassified as a safe record.
                        if (!recordBound && (discard || length - start > spool.limits.recordBytes)) { dropped += length - start; start = length; discard = true; }
                        spool.append(identity, records, relative.endsWith('.jsonl') ? 'jsonl' : 'text', credentials, now,
                            { before, after: { inode, offset: offset + start, discard, anchor: anchorAt(offset + start) } }, dropped);
                    } catch { inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); spool.report(identity, 'unsafe-source'); }
                    finally { if (fd !== undefined) fs.closeSync(fd); }
                } else if (directories[input.provider].test(relative)) {
                    let child: PinnedDirectory | undefined;
                    try { child = dir.child(entry.name); walk(child, relative + '/'); }
                    catch { inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); }
                    finally { child?.close(); }
                }
            }
        } finally { listing.closeSync(); }
    };
    try { walk(root, ''); }
    finally { root.close(); }
    spool.report(summary, 'protected-native-state', inventoryIncomplete ? Math.max(protectedBytes, spool.limits.protectedBytes) : protectedBytes);
    if (limited) spool.report(summary, 'scan-limit');
}
