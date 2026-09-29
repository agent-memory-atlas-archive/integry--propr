import { Worker } from 'node:worker_threads';
import type { Knex } from 'knex';
import { loadCompletedRows, type CompletedRow } from '../routes/dashboardOutcomeQueries.js';
import { sqliteFilename } from './backgroundDatabase.js';

export type CompletionLoader = (repository: string, options?: { limit?: number; search?: string }) => Promise<CompletedRow[]>;
export interface DashboardReadService { load: CompletionLoader; close(): Promise<void> }

function workerUrl(): URL {
  if (!import.meta.url.endsWith('.ts')) return new URL('./dashboardReadWorker.js', import.meta.url);
  const source = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};`
    + `register(); await import(${JSON.stringify(new URL('./dashboardReadWorker.ts', import.meta.url).href)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

class SQLiteDashboardReads implements DashboardReadService {
  private worker?: Worker;
  private ready?: Promise<Worker>;
  private rejectReady?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextId = 0;
  private pending = new Map<number, { resolve(rows: CompletedRow[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private inFlight = new Map<string, Promise<CompletedRow[]>>();

  constructor(private filename: string, private timeoutMs: number) {}

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.ready = undefined;
    clearTimeout(this.startupTimer);
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void worker.terminate();
  }

  async start(): Promise<Worker> {
    if (this.closed) throw new Error('Dashboard read service is closed');
    if (this.ready) return this.ready;
    const worker = new Worker(workerUrl(), { workerData: { filename: this.filename } });
    this.worker = worker;
    this.ready = new Promise<Worker>((resolve, reject) => {
      this.rejectReady = reject;
      this.startupTimer = setTimeout(() => this.fail(worker, new Error('Dashboard read worker startup timed out')), 30_000);
      worker.on('message', (message: { type?: string; id: number; rows: CompletedRow[]; error?: string }) => {
        if (this.worker !== worker) return;
        if (message.type === 'ready') {
          clearTimeout(this.startupTimer);
          this.rejectReady = undefined;
          resolve(worker);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.rows);
      });
      worker.on('error', (error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown error';
        this.fail(worker, error instanceof Error ? error : new Error(`Dashboard read worker failed: ${code}`));
      });
      worker.on('exit', code => this.fail(worker, new Error(`Dashboard read worker exited with code ${code}`)));
    });
    return this.ready;
  }

  load: CompletionLoader = (repository, options = {}) => {
    if (this.closed) return Promise.reject(new Error('Dashboard read service is closed'));
    const key = JSON.stringify([repository, options.limit ?? 20, options.search ?? '']);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= 32) return Promise.reject(new Error('Dashboard read queue is full'));
    const promise = this.send(repository, options);
    this.inFlight.set(key, promise);
    // Share concurrent identical reads only; the next request reads current DB
    // state. No response TTL or cross-repository result cache is introduced.
    void promise.finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }).catch(() => undefined);
    return promise;
  };

  private async send(repository: string, options: { limit?: number; search?: string }): Promise<CompletedRow[]> {
    const worker = await this.start();
    if (this.closed || this.worker !== worker) throw new Error('Dashboard read worker is unavailable');
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail(worker, new Error('Dashboard read timed out')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, repository, options }); }
      catch (error) { this.fail(worker, error as Error); }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) {
      this.fail(worker, new Error('Dashboard read service is closed'));
      await worker.terminate();
    }
  }
}

export async function startDashboardReadService(db: Knex, options: { timeoutMs?: number } = {}): Promise<DashboardReadService> {
  const filename = sqliteFilename(db);
  if (db.client.config.client !== 'better-sqlite3' || !filename || filename === ':memory:') {
    return { load: (repository, query) => loadCompletedRows(db, repository, query), close: async () => undefined };
  }
  const service = new SQLiteDashboardReads(filename, options.timeoutMs ?? 30_000);
  await service.start();
  return service;
}
