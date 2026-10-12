import { parse as parseEnv } from 'dotenv';
import fs from 'node:fs';
import { PinnedDirectory } from './privateDirectory.js';

/** Read only the known auth stores for redaction, never for export. A malformed,
 * oversized, linked or unreadable store refuses collection instead of leaking an
 * opaque configured credential. No recursive home/config traversal. */
export function nativeCredentialValues(root: string, provider: string, pinned?: PinnedDirectory): string[] {
    const names: Record<string, string[]> = {
        codex: ['auth.json'], claude: ['.credentials.json'],
        opencode: ['auth.json', 'account.json'], antigravity: ['oauth_creds.json', 'antigravity-cli/antigravity-oauth-token'], vibe: ['credentials.json', '.env'],
    };
    let dir: PinnedDirectory;
    try { dir = pinned ?? PinnedDirectory.open(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const values: string[] = [];
    let size = 0;
    const walk = (value: unknown, depth = 0): void => {
        if (depth > 16) throw new Error('unsafe credential structure');
        if (typeof value === 'string' && value) {
            size += value.length;
            if (size > 128 * 1024 || values.length >= 256) throw new Error('credential redaction bound');
            values.push(value);
            // PEM lines must remain redacted even in split text diagnostics.
            if (value.includes('\n')) values.push(...value.split('\n').filter(v => v.length >= 8));
        } else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
    };
    try {
        for (const name of names[provider] ?? []) {
            let fd: number | undefined;
            const children: PinnedDirectory[] = [];
            try {
                let parent = dir;
                const parts = name.split('/');
                for (const part of parts.slice(0, -1)) { parent = parent.child(part); children.push(parent); }
                fd = parent.file(parts.at(-1)!);
                const stat = fs.fstatSync(fd);
                if (stat.size > 64 * 1024) throw new Error('credential redaction bound');
                const buffer = Buffer.alloc(64 * 1024 + 1);
                const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
                if (n > 64 * 1024) throw new Error('credential redaction bound');
                const content = buffer.subarray(0, n).toString('utf8');
                if (name === '.env') {
                    for (const line of content.split(/\r?\n/)) {
                        if (line.trim() && !line.trim().startsWith('#') && !/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) throw new Error('unsupported credential format');
                    }
                    walk(parseEnv(content));
                } else if (name.endsWith('antigravity-oauth-token') && /^[A-Za-z0-9._-]+\s*$/.test(content)) walk(content.trim());
                else walk(JSON.parse(content));
            } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('credential redaction unavailable'); }
            finally { if (fd !== undefined) fs.closeSync(fd); for (const child of children.reverse()) child.close(); }
        }
    } finally { if (!pinned) dir.close(); }
    return values;
}
