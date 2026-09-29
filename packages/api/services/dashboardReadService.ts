import { Worker, parentPort } from 'node:worker_threads';
import knex, { type Knex } from 'knex';
import { advanceOutcomeProjection, installOutcomeProjection, loadOutcomeSummaries, OUTCOME_TABLES, type OutcomeReadRow, loadCompletedRows, type CompletedRow } from '../routes/dashboardOutcomeQueries.js';
import { sqliteFilename } from './backgroundDatabase.js';

export type CompletionLoader = ((repository: string, options?: { limit?: number; search?: string }) => Promise<OutcomeReadRow[]>) & {
  summary?: (repository: string, options?: { limit?: number; search?: string }) => Promise<OutcomeReadRow[]>;
};
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

  load = (repository: string, options: { limit?: number; search?: string } = {}) => {
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

export async function startDashboardReadService(db: Knex, options: { timeoutMs?: number; projection?: boolean } = {}): Promise<DashboardReadService> {
  const filename = sqliteFilename(db);
  if (db.client.config.client !== 'better-sqlite3' || !filename || filename === ':memory:') {
    return { load: Object.assign((repository: string, query?: { limit?: number; search?: string }) => loadCompletedRows(db, repository, query),
      { summary: (repository: string, query?: { limit?: number; search?: string }) => loadOutcomeSummaries(db, repository, query) }), close: async () => undefined };
  }
  const service = new SQLiteDashboardReads(filename, options.timeoutMs ?? 30_000);
  await service.start();
  const projection = options.projection === false || process.env.DASHBOARD_OUTCOME_PROJECTION === 'legacy' ? undefined : startProjectionWorker(filename);
  let closed = false;
  const summaries = shareSummaryReads(db);
  return {
    load: Object.assign(service.load, { summary: (repository: string, query?: { limit?: number; search?: string }) =>
      closed ? Promise.reject(new Error('Dashboard read service is closed')) : summaries(repository, query) }),
    close: async () => { closed = true; await projection?.close(); await service.close(); },
  };
}


// The route supplies the existing authenticated instance's Redis publisher.
// The durable outbox is acknowledged only after publication succeeds.
let publishOutcomeActivity: ((repository: string) => Promise<void>) | undefined;
export function setOutcomeActivityPublisher(publish: (repository: string) => Promise<void>): void {
  publishOutcomeActivity = publish;
}

function startProjectionWorker(filename: string): { close(): Promise<void> } {
  let worker: Worker | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    const registration = import.meta.url.endsWith('.ts')
      ? `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();` : '';
    const source = `${registration} const { runOutcomeProjectionWorker } = await import(${JSON.stringify(import.meta.url)});
      await runOutcomeProjectionWorker(${JSON.stringify(filename)});`;
    const current = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    worker = current;
    const publishing = new Set<string>();
    current.on('message', (message: { repository: string; token: string }) => {
      if (!publishOutcomeActivity || publishing.has(message.repository)) return;
      publishing.add(message.repository);
      void publishOutcomeActivity(message.repository).then(() => {
        if (!closed && worker === current) current.postMessage(message);
      }).catch(() => undefined).finally(() => publishing.delete(message.repository)); // Retain failed outbox entries.
    });
    current.on('error', error => console.error('Outcome projection worker:', error.message));
    current.on('exit', () => { if (!closed) retry = setTimeout(start, 1000); });
  };
  start();
  return { close: async () => { closed = true; clearTimeout(retry); await worker?.terminate(); } };
}

/** Runs off the API event loop. Restarts resume the persisted cursor and dirty queue. */
export async function runOutcomeProjectionWorker(filename: string): Promise<void> {
  const db = knex({ client: 'better-sqlite3', connection: { filename },
    useNullAsDefault: true, pool: { min: 1, max: 1,
      afterCreate: (connection: { pragma(sql: string): void }, done: (error: Error | null, connection: unknown) => void) => {
        connection.pragma('busy_timeout = 0'); done(null, connection);
      } } });
  const acknowledgements: Array<{ repository: string; token: string }> = [];
  parentPort?.on('message', message => acknowledgements.push(message));
  let installed = false;
  let lastPublish = 0;
  try {
    for (;;) {
      try {
        if (!installed) { await installOutcomeProjection(db); installed = true; }
        for (const ack of acknowledgements.splice(0)) await db(OUTCOME_TABLES.outbox).where(ack).delete();
        const more = await advanceOutcomeProjection(db);
        if (Date.now() - lastPublish > 500 && (await db(OUTCOME_TABLES.state).first('ready'))?.ready) {
          for (const event of await db(OUTCOME_TABLES.outbox).limit(100)) parentPort?.postMessage(event);
          lastPublish = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, more ? 0 : 250));
      } catch (error) {
        // Lock contention is normal; a failed attempt never consumes dirty work.
        if (!(error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message))) {
          console.error('Outcome projection failed:', error);
          if (installed) await db(OUTCOME_TABLES.state).where('id', 1)
            .update({ error: error instanceof Error ? error.message : String(error) }).increment('failures', 1).catch(() => undefined);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } finally { await db.destroy(); }
}


function shareSummaryReads(db: Knex): NonNullable<CompletionLoader['summary']> {
  const pending = new Map<string, Promise<OutcomeReadRow[]>>();
  return (repository, options = {}) => {
    const key = JSON.stringify([repository, options.limit ?? 20, options.search ?? '']);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 32) return Promise.reject(new Error('Dashboard read queue is full'));
    const read = loadOutcomeSummaries(db, repository, options);
    pending.set(key, read);
    void read.finally(() => { if (pending.get(key) === read) pending.delete(key); }).catch(() => undefined);
    return read;
  };
}
