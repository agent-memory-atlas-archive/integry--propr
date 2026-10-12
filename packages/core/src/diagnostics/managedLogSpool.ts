import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PinnedDirectory } from './privateDirectory.js';
import { redactRecord, REDACTION_VERSION } from './redaction.js';

interface Statement { run(...args: unknown[]): { lastInsertRowid: number | bigint }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (file: string) => Database;
export const MANAGED_LOG_POLICY = Object.freeze({
    version: 1, recordBytes: 64 * 1024, segmentBytes: 256 * 1024,
    sourceBytes: 8 * 1024 * 1024, spoolBytes: 64 * 1024 * 1024,
    segments: 1024, sources: 2048, databaseBytes: 96 * 1024 * 1024,
    retentionMs: 14 * 86400_000, scanBytes: 1024 * 1024, scanFiles: 4096,
    scanMs: 250, protectedBytes: 256 * 1024 * 1024,
});
export type LogIdentity = { provider: string; agent: string; source: string };
export type Cursor = { inode?: string; offset?: number; discard?: boolean; anchor?: string };
export interface AppendOptions {
    credentials: readonly string[];
    now?: number;
    cursor?: { before: Cursor; after: Cursor };
    droppedBytes?: number;
}
interface Source { id: string; identity: string; cursor: string; next: number; dropped: number; gaps: number; last_success: number | null; reason: string | null; protected_bytes: number; protection: string | null }
interface Segment { id: number; source: string; day: string; first: number; last: number; start: number; end: number; raw: number; digest: string; data: Buffer; sealed: number; ack: number }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** A private transactional outbox. Only this database is pruned, never provider state.
 * DELETE journalling keeps the on-disk bound independent of long-lived readers.
 * Immediate transactions serialize writers, collectors, exporters and pruning. */
export class ManagedLogSpool {
    private readonly dir: PinnedDirectory;
    private readonly db!: Database;
    readonly limits: typeof MANAGED_LOG_POLICY;
    constructor(root: string, readonly instance: string, limits: Partial<typeof MANAGED_LOG_POLICY> = {}) {
        if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(instance)) throw new Error('invalid diagnostic instance');
        this.limits = { ...MANAGED_LOG_POLICY, ...limits };
        this.dir = PinnedDirectory.open(root, true);
        try {
            for (const name of ['spool.sqlite', 'spool.sqlite-journal', 'spool.sqlite-wal', 'spool.sqlite-shm']) {
                try {
                    const s = fs.lstatSync(this.dir.path(name));
                    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('unsafe diagnostic database');
                } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            }
            try { fs.closeSync(fs.openSync(this.dir.path('spool.sqlite'), 'wx', 0o600)); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
            this.db = new Sqlite(this.dir.path('spool.sqlite'));
            this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
                PRAGMA max_page_count=${Math.floor(this.limits.databaseBytes / 4096)};
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, identity TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '{}', next INTEGER NOT NULL DEFAULT 1,
                    dropped INTEGER NOT NULL DEFAULT 0, gaps INTEGER NOT NULL DEFAULT 0, last_success INTEGER, reason TEXT, protection TEXT, protected_bytes INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, day TEXT NOT NULL,
                    first INTEGER NOT NULL, last INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, raw INTEGER NOT NULL,
                    digest TEXT NOT NULL, data BLOB NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS segments_source ON segments(source,id); COMMIT; PRAGMA busy_timeout=100;`);
            this.atomic(() => {
                const binding = JSON.stringify({ instance, policy: this.limits });
                this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('binding', binding);
                if ((this.db.prepare('SELECT value FROM settings WHERE key=?').get('binding') as { value: string }).value !== binding) throw new Error('diagnostic policy/instance mismatch');
            });
        } catch (e) { this.db?.close(); this.dir.close(); throw e; }
    }
    private atomic<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = fn(); this.db.exec('COMMIT'); return result; }
        catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* SQLite may have rolled back on SQLITE_FULL. */ } throw e; }
    }
    private source(identity: LogIdentity): Source {
        for (const value of Object.values(identity)) if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) throw new Error('invalid diagnostic identity');
        const json = JSON.stringify(identity), id = digest(json);
        let source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source | undefined;
        if (!source) {
            if ((this.db.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }).n >= this.limits.sources) throw new Error('diagnostic source capacity');
            this.db.prepare('INSERT INTO sources(id,identity) VALUES (?,?)').run(id, json);
            source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source;
        }
        return source;
    }
    private gap(source: Source, bytes: number, reason: string): void {
        this.db.prepare('UPDATE sources SET dropped=dropped+?,gaps=gaps+1,reason=? WHERE id=?').run(bytes, reason, source.id);
    }
    report(identity: LogIdentity, reason: 'unsafe-source' | 'scan-limit' | 'source-replaced' | 'capture-interrupted' | 'protected-native-state' | 'ownership-unverified' | 'storage-unavailable', bytes = 0): void {
        this.atomic(() => {
            const source = this.source(identity);
            if (reason === 'protected-native-state') this.db.prepare('UPDATE sources SET protected_bytes=?,protection=? WHERE id=?').run(bytes, reason, source.id);
            else this.gap(source, bytes, reason);
        });
    }
    cursor(identity: LogIdentity): Cursor {
        return this.atomic(() => JSON.parse(this.source(identity).cursor) as Cursor);
    }
    /** Cursor CAS + segments commit together. Concurrent/restarted scans cannot duplicate records. */
    append(identity: LogIdentity, records: string[], format: 'jsonl' | 'text', options: AppendOptions): boolean {
        const { credentials, now = Date.now(), cursor, droppedBytes = 0 } = options;
        if (records.length > 4096 || records.reduce((sum, r) => sum + Buffer.byteLength(r), 0) > this.limits.scanBytes) throw new Error('diagnostic batch exceeds bound');
        return this.atomic(() => {
            const source = this.source(identity);
            if (cursor && source.cursor !== JSON.stringify(cursor.before)) return false;
            this.prune(now);
            let next = source.next;
            const deadline = performance.now() + this.limits.scanMs;
            if (droppedBytes) this.gap(source, droppedBytes, 'oversize-record');
            for (const record of records) {
                const size = Buffer.byteLength(record) + (record.endsWith('\n') ? 0 : 1);
                const redacted = performance.now() <= deadline && size <= this.limits.recordBytes ? redactRecord(record, format, credentials) : null;
                const seq = next++;
                if (!redacted || Buffer.byteLength(redacted) > this.limits.recordBytes) { this.gap(source, size, 'unsafe-record'); continue; }
                this.appendRecord(source, redacted, { seq, now, size });
            }
            this.db.prepare('UPDATE sources SET next=?,cursor=?,last_success=? WHERE id=?').run(next, cursor ? JSON.stringify(cursor.after) : source.cursor,
                (this.db.prepare('SELECT gaps FROM sources WHERE id=?').get(source.id) as { gaps: number }).gaps === source.gaps ? now : source.last_success, source.id);
            return true;
        });
    }
    private appendRecord(source: Source, redacted: string, { seq, now, size }: { seq: number; now: number; size: number }): void {
        const day = new Date(now).toISOString().slice(0, 10);
        let segment = this.db.prepare('SELECT * FROM segments WHERE source=? ORDER BY id DESC LIMIT 1').get(source.id) as Segment | undefined;
        if (segment && (segment.sealed || segment.day !== day || segment.raw + Buffer.byteLength(redacted) > this.limits.segmentBytes || segment.last !== seq - 1)) segment = undefined;
        const data = Buffer.from(redacted);
        const raw = segment ? Buffer.concat([gunzipSync(segment.data, { maxOutputLength: this.limits.segmentBytes }), data]) : data;
        const compressed = gzipSync(raw, { level: 6 });
        const total = this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes, count(*) AS n FROM segments').get() as { bytes: number; n: number };
        const perSource = this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes FROM segments WHERE source=?').get(source.id) as { bytes: number };
        const added = compressed.length - (segment?.data.length ?? 0);
        if (total.bytes + added > this.limits.spoolBytes || perSource.bytes + added > this.limits.sourceBytes || (!segment && total.n >= this.limits.segments)) {
            this.gap(source, size, 'unacknowledged-capacity'); return;
        }
        if (segment) this.db.prepare('UPDATE segments SET last=?,end=?,raw=?,digest=?,data=? WHERE id=?').run(seq, now, raw.length, digest(compressed), compressed, segment.id);
        else {
            this.db.prepare('UPDATE segments SET sealed=1 WHERE source=?').run(source.id);
            this.db.prepare('INSERT INTO segments(source,day,first,last,start,end,raw,digest,data) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(source.id, day, seq, seq, now, now, raw.length, digest(compressed), compressed);
        }
    }
    private prune(now: number): void {
        // Acknowledgement includes encrypted upload AND verified readback. Unacked
        // data is never evicted; capacity drops NEW diagnostics with durable gaps.
        this.db.prepare('DELETE FROM segments WHERE ack=1').run();
        this.db.prepare('UPDATE segments SET sealed=1 WHERE day<>?').run(new Date(now).toISOString().slice(0, 10));
    }
    status(): object {
        const sources = this.db.prepare('SELECT * FROM sources ORDER BY id').all() as Source[];
        return { policyVersion: 1, redactionVersion: REDACTION_VERSION, instance: this.instance, private: true, historyComplete: false,
            offsiteRetentionDays: 14, limits: this.limits, sourceCapacityWarning: sources.length >= this.limits.sources,
            sources: sources.map(s => ({ ...JSON.parse(s.identity), id: s.id, nextSequence: s.next, droppedBytes: s.dropped, gaps: s.gaps,
                lastSuccessfulCollection: s.last_success, reason: s.reason, protectedReason: s.protection, protectedBytes: s.protection && !s.reason && JSON.parse(s.identity).source === 'native-state' ? s.protected_bytes : null, capacityWarning: s.protected_bytes >= this.limits.protectedBytes })),
            nativeSources: {
                rotation: 'none', growthBounded: false, inventoryComplete: false,
                unmeasured: ['container-only', 'unowned', 'excluded-or-unrecognized'],
                sources: sources.filter(s => ['native-state', 'unmapped-native-state', 'shared-tmp-claude-logs'].includes(JSON.parse(s.identity).source))
                    .map(s => ({ ...JSON.parse(s.identity), protected: true, growthBounded: false,
                        measurement: s.protection && !s.reason && JSON.parse(s.identity).source === 'native-state' ? 'allowlisted-files-only' : 'unknown',
                        measuredBytes: s.protection && !s.reason && JSON.parse(s.identity).source === 'native-state' ? s.protected_bytes : null })),
            },
            spool: this.db.prepare('SELECT count(*) AS segments,coalesce(sum(length(data)),0) AS bytes FROM segments').get() };
    }
    assertCapacity(): void {
        const row = this.db.prepare('SELECT coalesce(sum(protected_bytes),0) AS bytes,max(protected_bytes) AS largest FROM sources').get() as { bytes: number; largest: number };
        const count = (this.db.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }).n;
        if (count >= this.limits.sources) throw new Error('managed diagnostics: source capacity; operator action required');
        if (row.largest >= this.limits.protectedBytes || row.bytes >= 4 * this.limits.protectedBytes) throw new Error('managed diagnostics: protected native state capacity; operator action required');
    }
    exportOne(): { manifest: object; data: Buffer; id: number; digest: string } | null {
        return this.atomic(() => {
            const s = this.db.prepare('SELECT * FROM segments WHERE ack=0 ORDER BY id LIMIT 1').get() as Segment | undefined;
            if (!s) return null;
            this.db.prepare('UPDATE segments SET sealed=1 WHERE id=?').run(s.id);
            const source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(s.source) as Source;
            return { id: s.id, digest: s.digest, data: s.data, manifest: {
                schemaVersion: 1, policyVersion: 1, redactionVersion: REDACTION_VERSION, tenantPrivate: true, instance: this.instance,
                ...JSON.parse(source.identity), sourceId: source.id, segment: s.id, utcDay: s.day,
                collectionWindow: { start: s.start, end: s.end }, firstSequence: s.first, lastSequence: s.last,
                compressedBytes: s.data.length, uncompressedBytes: s.raw, sha256: s.digest, encoding: 'gzip-jsonl',
                droppedBytes: source.dropped, gaps: source.gaps, historyComplete: false, lastSuccessfulCollection: source.last_success,
            } };
        });
    }
    acknowledge(id: number, sha256: string): void {
        this.atomic(() => {
            const s = this.db.prepare('SELECT * FROM segments WHERE id=? AND digest=? AND sealed=1').get(id, sha256) as Segment | undefined;
            if (!s) {
                const previous = this.db.prepare('SELECT value FROM settings WHERE key=?').get('lastAck') as { value: string } | undefined;
                if (previous?.value === JSON.stringify({ id, sha256 })) return;
                throw new Error('unknown diagnostic acknowledgement');
            }
            this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('lastAck', JSON.stringify({ id, sha256 }));
            this.db.prepare('UPDATE segments SET ack=1 WHERE id=?').run(id);
            this.prune(Date.now());
        });
    }
    close(): void { this.db.close(); this.dir.close(); }
}
