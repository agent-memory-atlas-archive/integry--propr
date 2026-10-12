import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { DatabaseExportStatus } from '@propr/shared';
import { assertRealDirectory } from './lifecycle.js';
import { databaseExportWorker, isExportSecretName, isExportSecretValue } from './databaseExportWorker.js';

const require = createRequire(import.meta.url);
const MAX_BYTES = 512 * 1024 ** 2;
const TTL = 5 * 60_000;
// Recollect at job execution, including credentials absent from current agents.
// Preserve exact values (whitespace may be significant); never expose this set
// through job metadata, diagnostics, or errors.
export function configuredExportSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(Object.entries(env).flatMap(([name, value]) =>
    isExportSecretName(name) && isExportSecretValue(value) ? [value] : []))];
}
export type StorageAuthority = () => Promise<void>;
// Compatibility boundary for existing storage callers.
type ExportOperationArgs = [instanceId: string, generation: string, id: string, actor: string, authorize: StorageAuthority];
interface ExportRequest {
  instanceId: string;
  generation: string;
  operationId: string;
  actor: string;
  authorize: StorageAuthority;
}
function exportRequest(args: ExportOperationArgs): ExportRequest {
  const [instanceId, generation, operationId, actor, authorize] = args;
  return { instanceId, generation, operationId, actor, authorize };
}
interface ExportJob { actor: string; status: DatabaseExportStatus; directory: string; worker?: Worker; disposed?: Promise<void>; removing?: Promise<void>; identity?: { dev: number; ino: number }; ancestry: Array<{ path: string; dev: number; ino: number }> }

/** Private, bounded, process-generation-bound jobs. Never accepts a caller path. */
export class DatabaseExports {
  readonly generation = randomUUID();
  private job?: ExportJob;
  private admitting = false;
  constructor(private readonly source: string, private readonly root: string) {
    // Old process generations are never redeemable. Reap expired artifacts only
    // after proving the owning process no longer exists; never steal a live job.
    const timer = setTimeout(() => { void this.reap().catch(() => undefined); }, TTL);
    timer.unref();
  }
  private async reap() {
    if (this.job || process.platform !== 'linux') return;
    await assertRealDirectory(this.root);
    const active = path.join(this.root, 'active');
    await assertRealDirectory(active);
    const handle = await fs.open(path.join(active, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let owner: { pid: number; pidNamespace: string; expiresAt: number; directory: string };
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) return;
      owner = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.expiresAt) || owner.expiresAt > Date.now() || !/^snapshot-[A-Za-z0-9]{6}$/.test(owner.directory)) return;
    if (owner.pidNamespace !== await fs.readlink('/proc/self/ns/pid')) return;
    try { process.kill(owner.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    const directory = path.join(this.root, owner.directory);
    await this.eraseSnapshot(directory);
    await fs.unlink(path.join(active, 'owner.json'));
    await fs.rmdir(active);
  }
  private async eraseSnapshot(directory: string) {
    try { await assertRealDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory;
      const entries = await fs.readdir(pinned);
      if (entries.length > 4 || entries.some(name => !/^database\.sqlite(?:-wal|-shm|-journal)?$/.test(name))) throw new Error('Unknown export files');
      for (const name of entries) {
        const stat = await fs.lstat(path.join(pinned, name));
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe export file');
      }
      for (const name of entries) await fs.unlink(path.join(pinned, name));
      const current = await fs.lstat(directory), original = await handle.stat();
      if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('Export moved');
      await fs.rmdir(directory);
    } finally { await handle.close(); }
  }

  private async validateSource() {
    await assertRealDirectory(path.dirname(this.source));
    const stat = await fs.lstat(this.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Unsafe database');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const side = await fs.lstat(`${this.source}${suffix}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (side && (!side.isFile() || side.isSymbolicLink() || side.nlink !== 1 || side.size > MAX_BYTES)) throw new Error('Unsafe database sidecar');
    }
    return stat;
  }

  async start(instanceId: string, actor: string, authorize: StorageAuthority): Promise<DatabaseExportStatus> {
    if (this.admitting || this.job) throw new Error('Export admission busy');
    this.admitting = true;
    try {
      await authorize();
      const stat = await this.validateSource();
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await assertRealDirectory(this.root);
      const rootStat = await fs.stat(this.root);
      if ((rootStat.mode & 0o077) !== 0) throw new Error('Export directory must be private');
      const space = await fs.statfs(this.root);
      if (space.bavail * space.bsize < MAX_BYTES * 3) throw new Error('Insufficient export space');
      // Cross-process admission, never steal a crashed owner's lock.
      await this.reap().catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.mkdir(path.join(this.root, 'active'), { mode: 0o700 });
      let directory: string;
      try { directory = await fs.mkdtemp(path.join(this.root, 'snapshot-')); }
      catch (error) { await fs.rmdir(path.join(this.root, 'active')); throw error; }
      const ancestry = await this.captureAncestry(directory);
      const job: ExportJob = {
        actor, directory, ancestry,
        status: { version: 1, instanceId, generation: this.generation, operationId: randomUUID(), state: 'running', expiresAt: new Date(Date.now() + TTL).toISOString(), scope: 'customer_database' },
      };
      await fs.writeFile(path.join(this.root, 'active', 'owner.json'), JSON.stringify({ pid: process.pid, pidNamespace: process.platform === 'linux' ? await fs.readlink('/proc/self/ns/pid') : null, expiresAt: Date.parse(job.status.expiresAt), directory: path.basename(directory) }), { flag: 'wx', mode: 0o600 });
      this.job = job;
      void this.run(job, stat, authorize).catch(() => { job.status.state = 'failed'; });
      const expiry = setTimeout(() => { void this.discard(job).catch(() => undefined); }, TTL);
      expiry.unref();
      return { ...job.status };
    } finally { this.admitting = false; }
  }

  private async captureAncestry(directory: string): Promise<ExportJob['ancestry']> {
    const ancestry: ExportJob['ancestry'] = [];
    for (const leaf of [path.dirname(this.source), directory]) {
      let current = path.resolve(leaf);
      for (;;) {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe ancestor');
        ancestry.push({ path: current, dev: stat.dev, ino: stat.ino });
        const parent = path.dirname(current); if (parent === current) break; current = parent;
      }
    }
    return ancestry;
  }

  private async run(job: ExportJob, original: Awaited<ReturnType<typeof fs.stat>>, authorize: StorageAuthority) {
    let deadline: NodeJS.Timeout | undefined;
    let revocation: NodeJS.Timeout | undefined;
    try {
      await authorize();
      const worker = new Worker(databaseExportWorker, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: {
        sqliteModule: require.resolve('better-sqlite3'), source: this.source,
        forbiddenSecrets: configuredExportSecrets(),
        ancestry: job.ancestry, identity: { dev: original.dev, ino: original.ino },
        target: path.join(job.directory, 'database.sqlite'), maxBytes: MAX_BYTES,
      } });
      job.worker = worker;
      const metadata = await new Promise<Partial<DatabaseExportStatus>>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Export timed out')), 60_000);
        revocation = setInterval(() => { void authorize().catch(reject); }, 250);
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Export interrupted')));
        worker.once('message', value => value.failed ? reject(new Error('Export failed')) : resolve(value));
      });
      await authorize();
      await assertRealDirectory(path.dirname(this.source));
      const current = await fs.lstat(this.source);
      if (!current.isFile() || current.nlink !== 1 || current.dev !== original.dev || current.ino !== original.ino) throw new Error('Source changed');
      await this.checkAncestry(job);
      const snapshot = await fs.lstat(path.join(job.directory, 'database.sqlite'));
      job.identity = { dev: snapshot.dev, ino: snapshot.ino };
      Object.assign(job.status, metadata, { state: 'ready' });
    } catch {
      job.status.state = 'failed';
      await job.worker?.terminate();
      await this.removeFiles(job);
    } finally {
      clearTimeout(deadline); clearInterval(revocation);
      await job.worker?.terminate(); job.worker = undefined;
    }
  }

  private selected(request: ExportRequest): ExportJob {
    const { instanceId, generation, operationId, actor } = request;
    const job = this.job;
    if (!job || job.actor !== actor || job.status.instanceId !== instanceId || generation !== this.generation || job.status.operationId !== operationId || Date.parse(job.status.expiresAt) <= Date.now()) throw new Error('Export unavailable');
    return job;
  }
  async status(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    try { await authorize(); } catch (error) { await this.discard(job); throw error; }
    return { ...job.status };
  }
  async redeem(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    await authorize();
    if (job.status.state !== 'ready') throw new Error('Export not ready or consumed');
    // Synchronous consumption before opening: simultaneous redemptions cannot both succeed.
    job.status.state = 'redeemed';
    try {
      await this.checkAncestry(job);
      const file = await fs.open(path.join(job.directory, 'database.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== job.status.sizeBytes || stat.dev !== job.identity?.dev || stat.ino !== job.identity?.ino) throw new Error('Unsafe export');
        await authorize();
        return { file, status: { ...job.status }, dispose: () => this.discard(job) };
      } catch (error) { await file.close(); throw error; }
    } catch (error) { await this.discard(job); throw error; }
  }
  async cancel(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    await authorize(); await this.discard(job);
  }
  private async checkAncestry(job: ExportJob) {
    for (const item of job.ancestry) {
      const stat = await fs.lstat(item.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) throw new Error('Export ancestor changed');
    }
  }
  private removeFiles(job: ExportJob): Promise<void> {
    job.removing ??= (async () => {
      // A substituted ancestor is uncertainty: retain it for operator investigation.
      try { await this.checkAncestry(job); }
      catch { return; }
      await this.eraseSnapshot(job.directory);
    })();
    return job.removing;
  }
  private discard(job: ExportJob): Promise<void> {
    job.disposed ??= (async () => {
      await job.worker?.terminate();
      await this.removeFiles(job);
      if (this.job === job) {
        const root = job.ancestry.find(item => item.path === path.resolve(this.root));
        const stat = await fs.lstat(this.root);
        if (stat.isDirectory() && stat.dev === root?.dev && stat.ino === root?.ino) {
          await assertRealDirectory(path.join(this.root, 'active'));
          await fs.unlink(path.join(this.root, 'active', 'owner.json'));
          await fs.rmdir(path.join(this.root, 'active'));
        }
        this.job = undefined;
      }
    })();
    return job.disposed;
  }
}
