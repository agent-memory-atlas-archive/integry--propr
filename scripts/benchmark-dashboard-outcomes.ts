/** Run against an offline SQLite snapshot, never the live writer's database. */
import { performance } from 'node:perf_hooks';
import knex from 'knex';
import { loadCompletedRows } from '../packages/api/routes/dashboardOutcomeQueries.js';
import { startDashboardReadService, type DashboardReadService } from '../packages/api/services/dashboardReadService.js';

const filename = process.argv.find(value => value.startsWith('--database='))?.slice('--database='.length);
if (!filename) throw new Error('Pass --database=/path/to/offline-snapshot.sqlite');
const repository = process.argv.find(value => value.startsWith('--repository='))?.slice('--repository='.length) ?? 'all';
const search = process.argv.find(value => value.startsWith('--search='))?.slice('--search='.length);
const db = knex({ client: 'better-sqlite3', connection: { filename, options: { readonly: true } }, useNullAsDefault: true });
let worker: DashboardReadService | undefined;
try {
  if (process.argv.includes('--worker')) worker = await startDashboardReadService(db);
  for (let iteration = 0; iteration < 3; iteration++) {
    const start = performance.now();
    const probe = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 10));
    const rows = await (worker ? worker.load(repository, { limit: 50, search }) : loadCompletedRows(db, repository, { limit: 50, search }));
    const milliseconds = Math.round(performance.now() - start);
    const foregroundProbeMilliseconds = Math.round(await probe);
    console.log(JSON.stringify({
      iteration, milliseconds, foregroundProbeMilliseconds,
      entities: rows.length, earlierUpdates: rows.reduce((count, row) => count + row.earlierUpdates.length, 0),
    }));
  }
} finally {
  await worker?.close();
  await db.destroy();
}
