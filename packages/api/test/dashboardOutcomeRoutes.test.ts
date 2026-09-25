import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import {
  NOW,
  call,
  createDashboardTestDatabase,
  minutesAgo,
  seedTask,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());

test('outcomes exclude operational handoffs without letting them consume the result limit', async () => {
  const handoffs = Array.from({ length: 30 }, (_, index) => ({
    taskId: `lock-handoff-${index}`,
    issueNumber: 2513,
    taskType: 'pr-comment',
    states: [{
      state: 'cancelled',
      timestamp: minutesAgo(index + 1),
      reason: index % 2 === 0
        ? 'PR comment job rescheduled: pr_locked_by_other_job'
        : 'Task handed to another attempt',
      metadata: index % 2 === 0 ? {} : { jobResultStatus: 'rescheduled' },
    }],
  }));
  for (const handoff of handoffs) await seedTask(database, handoff);

  await seedTask(database, {
    taskId: 'meaningful-completion',
    issueNumber: 2506,
    taskType: 'pr-comment',
    states: [{ state: 'completed', timestamp: minutesAgo(40), reason: 'Review processing completed successfully' }],
  });
  await seedTask(database, {
    taskId: 'user-cancelled',
    issueNumber: 2507,
    taskType: 'pr-comment',
    states: [{ state: 'cancelled', timestamp: minutesAgo(35), reason: 'Cancelled by user' }],
  });

  const dashboard = createDashboardRoutes({
    db: database,
    redisClient: {} as RedisClientType,
    taskQueue: {} as never,
    liveDetails: async () => null,
    now: () => NOW,
  });
  const outcomes = await call(dashboard.getOutcomes, { repository: 'all', limit: '2' });
  const items = outcomes.body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => item.taskId), ['user-cancelled', 'meaningful-completion']);
  assert.deepEqual(items.map(item => item.kind), ['cancelled', 'completed']);
  assert.deepEqual(items.map(item => item.prNumber), [2507, 2506]);
});
