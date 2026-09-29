/** Run against an offline SQLite snapshot, never the live writer's database. */
import { performance } from 'node:perf_hooks';
import knex from 'knex';
import { loadCompletedRows } from '../packages/api/routes/dashboardOutcomeQueries.js';

const filename = process.argv.find(value => value.startsWith('--database='))?.slice('--database='.length);
if (!filename) throw new Error('Pass --database=/path/to/offline-snapshot.sqlite');
const repository = process.argv.find(value => value.startsWith('--repository='))?.slice('--repository='.length) ?? 'all';
const search = process.argv.find(value => value.startsWith('--search='))?.slice('--search='.length);
const db = knex({ client: 'better-sqlite3', connection: { filename, readonly: true }, useNullAsDefault: true });
try {
  for (let iteration = 0; iteration < 3; iteration++) {
    const start = performance.now();
    const rows = await loadCompletedRows(db, repository, { limit: 50, search });
    console.log(JSON.stringify({
      iteration, milliseconds: Math.round(performance.now() - start),
      entities: rows.length, earlierUpdates: rows.reduce((count, row) => count + row.earlierUpdates.length, 0),
    }));
  }
} finally {
  await db.destroy();
}
