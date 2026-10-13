import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StorageCandidate, StorageProtection } from '@propr/shared';
import { assertRealDirectory, repositoryStorageLifecycle, storageControlRoot, type StorageLifecycle } from './lifecycle.js';

// Names alone never establish ownership. Only an empty directory created by a
// trusted producer, with a complete post-generation content proof, is eligible.
export const GENERATED_PAYLOADS = ['node_modules', '.propr/cache', '.propr/build', '.propr/test-cache'] as const;
type Payload = typeof GENERATED_PAYLOADS[number];
interface Record {
  id: string; worktree: string; payload: Payload; device: number; inode: number;
  completed: boolean; fingerprint: string; regeneration: string;
}
interface Budget { entries: number; bytes: number; deadline: number }
interface Limits { maxEntries?: number; maxBytes?: number; maxMs?: number }
const budget = (limits: Limits = {}): Budget => ({ entries: Math.min(100_000, limits.maxEntries ?? 100_000), bytes: Math.min(512 * 1024 * 1024, limits.maxBytes ?? 512 * 1024 * 1024), deadline: Date.now() + Math.min(5_000, limits.maxMs ?? 5_000) });

/** Linux descriptor-pinned walk. Reject links (including hardlinks), mounts,
 * nested Git state, and special files. Delete only exact files already proved.
 * No recursive rm, globbing, or following caller-provided filesystem paths.
 */
async function walk(directory: string, device: number, limits: Budget, signal?: AbortSignal, remove = false, expected?: Map<string, string>, onRemove?: () => void): Promise<{ fingerprint: string; bytes: number; nodes: Map<string, string> }> {
  if (process.platform !== 'linux') throw new Error('unsupported');
  const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean).map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  const hash = createHash('sha256');
  let bytes = 0;
  const nodes = new Map<string, string>();
  const visit = async (target: string, relative: string): Promise<void> => {
    signal?.throwIfAborted();
    if (--limits.entries < 0 || Date.now() >= limits.deadline) throw new Error('bounded_scan');
    const stat = await fs.lstat(target);
    const real = await fs.realpath(target);
    if (stat.dev !== device || stat.isSymbolicLink() || mounts.includes(real) || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1) || path.basename(relative) === '.git') throw new Error('unsafe_path');
    if (relative) bytes += stat.blocks * 512; // Empty root is retained.
    limits.bytes -= stat.blocks * 512;
    if (limits.bytes < 0) throw new Error('bounded_scan');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
    try {
      const pinned = await handle.stat();
      if (pinned.ino !== stat.ino || pinned.dev !== stat.dev) throw new Error('unsafe_path');
      const node = createHash('sha256');
      node.update(`${relative}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? stat.size : 0}\0`);
      if (remove && stat.isDirectory() && expected?.get(relative) !== node.copy().digest('hex')) throw new Error('private_work');
      if (stat.isDirectory()) {
        const pinnedPath = `/proc/self/fd/${handle.fd}`;
        const names: string[] = [];
        const entries = await fs.opendir(pinnedPath);
        for await (const entry of entries) {
          if (names.length >= limits.entries || Date.now() >= limits.deadline) throw new Error('bounded_scan');
          names.push(entry.name);
        }
        for (const name of names.sort()) await visit(path.join(pinnedPath, name), path.posix.join(relative, name));
        if (!remove && (await handle.stat()).mtimeMs !== stat.mtimeMs) throw new Error('changed');
      } else {
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) { signal?.throwIfAborted(); if (Date.now() >= limits.deadline) throw new Error('bounded_scan'); node.update(chunk); }
      }
      const digest = node.digest('hex');
      nodes.set(relative, digest); hash.update(relative).update(digest);
      if (remove && expected?.get(relative) !== digest) throw new Error('private_work');
      if (remove && relative) {
        signal?.throwIfAborted();
        const final = await fs.lstat(target);
        if (final.ino !== pinned.ino || final.dev !== pinned.dev || (stat.isFile() && (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || final.ctimeMs !== stat.ctimeMs))) throw new Error('unsafe_path');
        if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
        onRemove?.();
      }
    } finally { await handle.close(); }
  };
  await visit(directory, '');
  return { fingerprint: hash.digest('hex'), bytes, nodes };
}

export class GeneratedPayloadStorage {
  constructor(readonly worktreesRoot: string, readonly root = storageControlRoot(), readonly lifecycle: StorageLifecycle = repositoryStorageLifecycle, private readonly limits: Limits = {}) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid generated-payload proof limits');
  }
  private directory(worktree: string, payload: Payload): string {
    if (!GENERATED_PAYLOADS.includes(payload)) throw new Error('unknown_ownership');
    const relative = path.relative(path.resolve(this.worktreesRoot), path.resolve(worktree));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
    return path.join(path.resolve(worktree), payload);
  }
  private async gitProof(worktree: string, payload: Payload, signal?: AbortSignal): Promise<void> {
    const git = async (args: string[]) => (await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', worktree, ...args], {
      timeout: 5000, maxBuffer: 1024 * 1024, signal,
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    })).stdout;
    try {
      const marker = await fs.lstat(path.join(worktree, '.git'));
      if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory()) || (marker.isFile() && marker.nlink !== 1)) throw new Error('unknown_git_state');
      await git(['rev-parse', '--verify', 'HEAD']);
      if ((await git(['ls-files', '--stage', '--', payload])).trim() || (await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', payload])).trim()) throw new Error('private_work');
      await git(['fsck', '--full', '--no-dangling']);
    } catch (error) { if ((error as Error).message === 'private_work') throw error; throw new Error('unknown_git_state'); }
  }
  private async write(record: Record): Promise<void> {
    const root = path.join(this.root, 'generated-payloads');
    await fs.mkdir(root, { recursive: true }); await assertRealDirectory(root);
    const temporary = path.join(root, randomUUID());
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(root, `${record.id}.json`));
  }
  private async read(id: string): Promise<Record> {
    if (!/^payload-[0-9a-f]{64}$/.test(id)) throw new Error('unknown_ownership');
    await assertRealDirectory(path.join(this.root, 'generated-payloads'));
    const handle = await fs.open(path.join(this.root, 'generated-payloads', `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('unknown_ownership');
      const record = JSON.parse(await handle.readFile('utf8')) as Record;
      if (record.id !== id || this.id(record.worktree, record.payload) !== id || !Number.isSafeInteger(record.device) || !Number.isSafeInteger(record.inode) || typeof record.completed !== 'boolean' || !/^[0-9a-f]{64}$/.test(record.fingerprint) || !record.regeneration) throw new Error('unknown_ownership');
      this.directory(record.worktree, record.payload);
      return record;
    } finally { await handle.close(); }
  }
  private id(worktree: string, payload: Payload): string { return `payload-${createHash('sha256').update(`${path.resolve(worktree)}\0${payload}`).digest('hex')}`; }
  /** Trusted producer API, never an HTTP adopt-existing-directory operation.
   * regenerate must produce only refetchable dependencies/generated outputs.
   * It must not copy customer inputs, secrets or private state into the payload.
   * An existing directory, interrupted producer or later edit remains protected.
   */
  async generate(worktree: string, payload: Payload, regeneration: string, regenerate: (directory: string) => Promise<void>): Promise<void> {
    if (!regeneration || regeneration.length > 4096) throw new Error('Regeneration semantics required');
    await this.lifecycle.use(async () => {
      const directory = this.directory(worktree, payload);
      await assertRealDirectory(worktree);
      await this.gitProof(worktree, payload);
      await fs.mkdir(path.dirname(directory), { recursive: true }); await assertRealDirectory(path.dirname(directory));
      await fs.mkdir(directory); // EEXIST deliberately refuses adoption.
      const stat = await fs.lstat(worktree);
      await regenerate(directory);
      const proof = await walk(directory, stat.dev, budget(this.limits));
      await this.write({ id: this.id(worktree, payload), worktree: path.resolve(worktree), payload, device: stat.dev, inode: stat.ino, completed: false, fingerprint: proof.fingerprint, regeneration });
    });
  }
  async complete(worktree: string, success: boolean): Promise<void> {
    await this.lifecycle.use(async () => {
      for (const payload of GENERATED_PAYLOADS) {
        const record = await this.read(this.id(worktree, payload)).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (record) { record.completed = success; await this.write(record); }
      }
    });
  }
  private async pinned<T>(record: Record, run: (directory: string) => Promise<T>): Promise<T> {
    // Pin every ancestor before using it. This also confines same-device symlink
    // substitutions of the worktree or .propr parent, across proof and removal.
    this.directory(record.worktree, record.payload);
    const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean).map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    try {
      let target = path.parse(record.worktree).root;
      for (const component of [...record.worktree.slice(target.length).split(path.sep).filter(Boolean), ...record.payload.split('/')]) {
        const handle = await fs.open(path.join(target, component), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(handle);
        const stat = await handle.stat();
        if (handles.length === record.worktree.slice(path.parse(record.worktree).root.length).split(path.sep).filter(Boolean).length && (stat.dev !== record.device || stat.ino !== record.inode)) throw new Error('unknown_ownership');
        target = `/proc/self/fd/${handle.fd}`;
        const real = await fs.realpath(target);
        const relative = path.relative(path.resolve(this.worktreesRoot), real);
        if (relative && !relative.startsWith('..') && mounts.includes(real)) throw new Error('unsafe_path');
      }
      return await run(`${target}/.`);
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
  private async inspect(record: Record, limits: Budget, signal?: AbortSignal) {
    await this.gitProof(record.worktree, record.payload, signal);
    return this.pinned(record, async directory => {
      const proof = await walk(directory, record.device, limits, signal);
      if (proof.fingerprint !== record.fingerprint) throw new Error('private_work');
      return proof;
    });
  }
  /** Called under the shared cleanup barrier, with fresh queue/DB authority. */
  async preview(busy: boolean, idleHours: number, signal: AbortSignal, enabled = true): Promise<StorageCandidate[]> {
    const candidates: StorageCandidate[] = [];
    const root = path.join(this.root, 'generated-payloads');
    try { await assertRealDirectory(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidates; throw error; }
    const limits = budget(this.limits);
    const clock = await this.lifecycle.lastUse();
    const directory = await fs.opendir(root);
    const names: string[] = [];
    for await (const entry of directory) { if (names.length >= 10_000 || Date.now() >= limits.deadline) break; names.push(entry.name); }
    names.sort();
    const cursorPath = path.join(root, 'cursor');
    let cursor = '';
    try {
      const handle = await fs.open(cursorPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128) throw new Error('unknown_ownership');
        cursor = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const selected = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)].filter(name => name !== 'cursor').slice(0, 10);
    for (const name of selected) {
      if (candidates.length >= 10 || Date.now() >= limits.deadline || limits.entries <= 0 || limits.bytes <= 0) break;
      const candidate: StorageCandidate = { id: name.slice(0, -5), category: 'worktrees', estimatedBytes: null, protectedReasons: [] };
      try {
        const record = await this.read(candidate.id);
        if (!enabled) candidate.protectedReasons = ['unsupported'];
        else if (busy || !record.completed || signal.aborted) candidate.protectedReasons = ['busy'];
        else if (!clock) candidate.protectedReasons = ['unknown_use'];
        else if (Date.now() - clock < Math.max(24, idleHours) * 3_600_000) candidate.protectedReasons = ['recent_use'];
        else candidate.estimatedBytes = (await this.inspect(record, limits, signal)).bytes;
      } catch (error) { candidate.protectedReasons = [signal.aborted ? 'busy' : this.reason(error)]; }
      candidates.push(candidate);
    }
    if (candidates.length) {
      const temporary = path.join(root, randomUUID());
      await fs.writeFile(temporary, `${candidates.at(-1)!.id}.json`, { flag: 'wx' });
      await fs.rename(temporary, cursorPath);
    }
    return candidates;
  }
  private reason(error: unknown): StorageProtection {
    const message = (error as Error).message;
    return ['unsafe_path', 'private_work', 'unknown_ownership', 'unknown_git_state', 'unsupported'].includes(message) ? message as StorageProtection : 'changed';
  }
  async remove(id: string, signal: AbortSignal): Promise<StorageProtection[]> {
    let removed = false;
    try {
      const record = await this.read(id);
      if (!record.completed || await this.lifecycle.busy()) return ['busy'];
      const proof = await this.inspect(record, budget(this.limits), signal);
      signal.throwIfAborted();
      // No rename: the exact worktree/path and manifest remain valid for partial
      // interruption. A partial removal fails its fingerprint on a future retry.
      // Managed writers are excluded by the lifecycle gate for this entire walk.
      await this.pinned(record, directory => walk(directory, record.device, budget(this.limits), signal, true, proof.nodes, () => { removed = true; }));
      // Keep the empty payload root: removing by its original pathname would
      // add a substitution race after releasing descriptors. No customer file
      // can be lost by retaining an empty directory.

      signal.throwIfAborted();
      await fs.unlink(path.join(this.root, 'generated-payloads', `${id}.json`));
      return [];
    } catch (error) { return [signal.aborted ? 'busy' : this.reason(error), ...(removed ? ['partial_generated_cleanup' as const] : [])]; }
  }
}
export function generatedPayloadStorage(): GeneratedPayloadStorage {
  return new GeneratedPayloadStorage(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees');
}
