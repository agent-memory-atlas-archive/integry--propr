/**
 * Bundled Agent Tank readiness reporting.
 *
 * A bundled run can succeed while describing nothing: with only OpenCode/Vibe
 * enabled - or no enabled agent at all - the runner starts no container and
 * returns an empty map. The Settings radio group turns "available" into a green
 * "Bundled Agent Tank ready", so an empty snapshot must not be reported as
 * available and an empty forced refresh must not be reported as a success.
 *
 * The transport is mocked because the assertion is about how the route reads the
 * snapshot, not about Docker; the readiness predicate itself is the real one.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { hasAgentTankStatuses } = await import('../../core/src/services/agentTankTypes.js');

let snapshot: Record<string, unknown> | undefined;
const refreshCalls: Array<{ force?: boolean }> = [];

await mock.module('@propr/core', {
  namedExports: {
    loadAgentTankSettings: async () => ({ mode: 'bundled', enabled: true, url: 'http://0.0.0.0:3456' }),
    refreshBundledStatuses: async (options: { force?: boolean } = {}) => {
      refreshCalls.push(options);
      return snapshot;
    },
    getAgentTankStatuses: async () => snapshot,
    canRunBundledAgentTank: async () => false,
    hasAgentTankStatuses,
  },
});

const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');

function responseSpy() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };
}

test('a bundled snapshot with no provider is not reported as ready', async () => {
  const routes = createAgentTankRoutes();
  snapshot = {};

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: false, mode: 'bundled', reason: 'no_supported_agents' });

  // Same evidence rule for the explicit operator refresh: nothing was refreshed.
  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: false, error: 'no_supported_agents' });
});

test('a bundled run that failed outright keeps its own reason', async () => {
  const routes = createAgentTankRoutes();
  snapshot = undefined;

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: false, mode: 'bundled', reason: 'bundled_run_failed' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: false, error: 'bundled_run_failed' });
});

test('a bundled snapshot describing a provider stays available', async () => {
  const routes = createAgentTankRoutes();
  snapshot = { claude: { name: 'claude', usage: { session: { percent: 12 } } } };
  refreshCalls.length = 0;

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: true, mode: 'bundled' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: true });
  // The status probe reuses the cache; only the operator's refresh forces a run.
  assert.deepEqual(refreshCalls, [{}, { force: true }]);
});
