import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runElectronFixture } from './electron-fixture-runner.mjs';

const nativeSetup = { electronExecutable: '/electron' };
const headlessSetup = { electronExecutable: '/electron', xvfbRun: '/tools/xvfb-run' };

const crashed = { code: 135, signal: null, stderr: '', stdout: '', timedOut: false };
const reported = report => ({
  code: 0,
  signal: null,
  stderr: '',
  stdout: `some Chromium noise\n${JSON.stringify(report)}\n`,
  timedOut: false,
});

const scriptedRunner = outcomes => {
  const launches = [];
  return {
    launches,
    runAttempt: launch => {
      launches.push(launch);
      return Promise.resolve(outcomes[launches.length - 1]);
    },
  };
};

describe('Electron fixture runner', () => {
  it('launches the resolved Electron directly and returns the reported evidence', async () => {
    const { launches, runAttempt } = scriptedRunner([reported({ ok: true })]);

    const report = await runElectronFixture({
      diagnostic: () => assert.fail('a clean launch has nothing to report'),
      electronArguments: ['/probe.cjs'],
      name: 'probe',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    });

    assert.deepEqual(report, { ok: true });
    assert.deepEqual(launches, [{ args: ['/probe.cjs'], command: '/electron', timeout: 20_000 }]);
  });

  it('wraps a headless Linux launch in a freshly numbered xvfb-run display', async () => {
    const { launches, runAttempt } = scriptedRunner([crashed, reported({ ok: true })]);

    await runElectronFixture({
      diagnostic: () => {},
      electronArguments: ['--no-sandbox', '/probe.cjs'],
      name: 'probe',
      runAttempt,
      setup: headlessSetup,
      timeout: 20_000,
    });

    // Every attempt re-runs `--auto-servernum`, so a retry cannot inherit the
    // display number that the killed launch was sharing.
    assert.deepEqual(launches, [
      { args: ['--auto-servernum', '/electron', '--no-sandbox', '/probe.cjs'], command: '/tools/xvfb-run', timeout: 20_000 },
      { args: ['--auto-servernum', '/electron', '--no-sandbox', '/probe.cjs'], command: '/tools/xvfb-run', timeout: 20_000 },
    ]);
  });

  it('relaunches a fixture the worker killed before it reported anything', async () => {
    const diagnostics = [];
    const { launches, runAttempt } = scriptedRunner([crashed, reported({ ok: true })]);

    const report = await runElectronFixture({
      diagnostic: message => diagnostics.push(message),
      electronArguments: ['/probe.cjs'],
      name: 'Electron frame fixture',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    });

    assert.deepEqual(report, { ok: true });
    assert.equal(launches.length, 2);
    assert.deepEqual(diagnostics, [
      'Electron frame fixture needed 2 launches on this worker: attempt 1 exited 135 and reported no evidence: ',
    ]);
  });

  it('keeps evidence a fixture reported before Electron failed its own shutdown', async () => {
    const diagnostics = [];
    const { launches, runAttempt } = scriptedRunner([{ ...reported({ ok: true }), code: null, signal: 'SIGSEGV' }]);

    const report = await runElectronFixture({
      diagnostic: message => diagnostics.push(message),
      electronArguments: ['/probe.cjs'],
      name: 'Electron frame fixture',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    });

    assert.deepEqual(report, { ok: true });
    assert.equal(launches.length, 1);
    assert.deepEqual(diagnostics, ['Electron frame fixture reported its evidence, then exited SIGSEGV']);
  });

  it('fails with every attempt once the relaunch budget is spent', async () => {
    const { launches, runAttempt } = scriptedRunner([
      { ...crashed, stderr: 'first stderr' },
      { code: null, signal: 'SIGKILL', stderr: 'second stderr', stdout: '', timedOut: true },
    ]);

    await assert.rejects(() => runElectronFixture({
      electronArguments: ['/probe.cjs'],
      name: 'Electron frame fixture',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    }), /^Error: Electron frame fixture failed: attempt 1 exited 135 and reported no evidence: first stderr; attempt 2 exited SIGKILL after exhausting its own budget and reported no evidence: second stderr$/u);
    assert.equal(launches.length, 2);
  });

  it('treats a truncated evidence line as no evidence at all', async () => {
    const { runAttempt } = scriptedRunner([
      { code: 0, signal: null, stderr: '', stdout: '{"ok": tr', timedOut: false },
      { code: 0, signal: null, stderr: '', stdout: '{"ok": tr', timedOut: false },
    ]);

    await assert.rejects(() => runElectronFixture({
      electronArguments: ['/probe.cjs'],
      name: 'probe',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    }), /reported unparseable evidence/u);
  });

  it('reports a fixture that could not be spawned at all', async () => {
    const { runAttempt } = scriptedRunner([
      { spawnError: new Error('spawn /electron ENOENT'), stderr: '', stdout: '', timedOut: false },
      { spawnError: new Error('spawn /electron ENOENT'), stderr: '', stdout: '', timedOut: false },
    ]);

    await assert.rejects(() => runElectronFixture({
      electronArguments: ['/probe.cjs'],
      name: 'probe',
      runAttempt,
      setup: nativeSetup,
      timeout: 20_000,
    }), /attempt 1 could not start \(spawn \/electron ENOENT\); attempt 2 could not start/u);
  });

  it('spawns the real fixture, collects its evidence and enforces the timeout', async () => {
    const report = await runElectronFixture({
      electronArguments: ['-e', 'process.stdout.write(`warm-up\\n{"spawned":true}\\n`)'],
      name: 'probe',
      setup: { electronExecutable: process.execPath },
      timeout: 20_000,
    });

    assert.deepEqual(report, { spawned: true });

    await assert.rejects(() => runElectronFixture({
      attempts: 1,
      electronArguments: ['-e', 'setTimeout(() => {}, 60_000)'],
      name: 'probe',
      setup: { electronExecutable: process.execPath },
      timeout: 250,
    }), /exited SIGKILL after exhausting its own budget/u);
  });
});
