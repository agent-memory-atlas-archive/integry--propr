import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { AgentTankUsageWatcher } from '../services/agentTankUsageWatcher.js';

after(async () => closeConnection());

interface WatcherHarness {
  watcher: AgentTankUsageWatcher;
  published: number;
  setStatus(status: unknown): void;
  setSettings(settings: { enabled: boolean; url: string }): void;
  setListeners(listening: boolean): void;
}

function createWatcher(): WatcherHarness {
  let status: unknown = { claude: { usage: { session: { percent: 1 } } } };
  let settings = { enabled: true, url: 'http://agent-tank.test' };
  let listening = true;
  const harness = {
    published: 0,
    setStatus(next: unknown) { status = next; },
    setSettings(next: { enabled: boolean; url: string }) { settings = next; },
    setListeners(next: boolean) { listening = next; },
  } as WatcherHarness;
  harness.watcher = new AgentTankUsageWatcher({
    loadSettings: async () => settings,
    probe: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
    publish: () => { harness.published += 1; },
    hasListeners: () => listening,
  });
  return harness;
}

describe('agent tank usage watcher', { concurrency: false }, () => {
  test('says nothing while the numbers it already published hold', async () => {
    const harness = createWatcher();

    assert.equal(await harness.watcher.probeOnce(), true, 'the first probe announces its baseline');
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 1);
  });

  test('ignores provider countdowns, refresh metadata, and response key order', async () => {
    const harness = createWatcher();
    harness.setStatus({
      claude: { name: 'claude', usage: { session: { percent: 42, resetsInSeconds: 764 } },
        lastUpdated: '2026-09-28T10:00:00Z', isRefreshing: false },
      codex: { usage: { weekly: { percent: 31, resetsInSeconds: 364_364 } } },
    });
    assert.equal(await harness.watcher.probeOnce(), true);
    harness.setStatus({
      codex: { usage: { weekly: { resetsInSeconds: 364_304, percent: 31 } } },
      claude: { isRefreshing: true, lastUpdated: '2026-09-28T10:01:00Z',
        usage: { session: { resetsInSeconds: 704, percent: 42 } }, name: 'claude' },
    });
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 1);
  });

  test('preserves provider membership and error changes', async () => {
    const harness = createWatcher();
    const claude = { name: 'claude', usage: { session: { percent: 42 } } };
    harness.setStatus({ claude });
    await harness.watcher.probeOnce();
    for (const status of [
      { claude, codex: { usage: {} } },
      { claude },
      { claude: { ...claude, error: 'Quota unavailable' } },
      { claude },
      'HTTP 503',
      new Error('Agent Tank is unreachable'),
      { claude },
    ]) {
      harness.setStatus(status);
      assert.equal(await harness.watcher.probeOnce(), true);
      assert.equal(await harness.watcher.probeOnce(), false);
    }
    assert.equal(harness.published, 8);
  });

  test('preserves configured URL changes even when usage is identical', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();
    harness.setSettings({ enabled: true, url: 'http://replacement.test' });
    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(await harness.watcher.probeOnce(), false);
  });

  test('does not publish a snapshot that completes after shutdown', async () => {
    let resolveProbe!: (status: unknown) => void;
    let published = 0;
    const watcher = new AgentTankUsageWatcher({
      loadSettings: async () => ({ enabled: true, url: 'http://agent-tank.test' }),
      probe: () => new Promise(resolve => { resolveProbe = resolve; }),
      publish: () => { published += 1; },
      hasListeners: () => true,
    });
    const probing = watcher.probeOnce();
    await Promise.resolve();
    assert.equal(await watcher.probeOnce(), false, 'overlapping probes are suppressed');
    await watcher.close();
    resolveProbe({ claude: { usage: { session: { percent: 42 } } } });
    assert.equal(await probing, false);
    assert.equal(published, 0);
  });

  test('announces the first snapshot, which a mounted sidebar may already be behind', async () => {
    // The sidebar mounts and reads A, the quota moves to B, and only then does
    // the first probe run. Staying silent here would leave that sidebar on A
    // for as long as it stays connected: every later probe sees B and matches.
    const harness = createWatcher();
    harness.setStatus({ claude: { usage: { session: { percent: 2 } } } });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 1);
    assert.equal(await harness.watcher.probeOnce(), false, 'B is now the baseline');
    assert.equal(harness.published, 1);
  });

  test('publishes when a provider quota moves', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    harness.setStatus({ claude: { usage: { session: { percent: 2 } } } });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 2);
    assert.equal(await harness.watcher.probeOnce(), false, 'the new value is now the baseline');
    assert.equal(harness.published, 2);
  });

  test('publishes when the integration is enabled or disabled behind the sidebar', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    harness.setSettings({ enabled: false, url: 'http://agent-tank.test' });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 2);
  });

  test('does not probe when nobody is connected to be told', async () => {
    const harness = createWatcher();
    harness.setListeners(false);
    harness.setStatus({ claude: { usage: { session: { percent: 3 } } } });

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });

  test('stops probing once closed', async () => {
    const harness = createWatcher();
    await harness.watcher.close();

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });
});
