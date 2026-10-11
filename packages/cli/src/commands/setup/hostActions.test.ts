import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import type { OrchestratorConfig, OrchestratorModule } from '../../orchestrator/index.js';

const real = await import('../../orchestrator/index.js');
let orch: OrchestratorModule;
let cfg: OrchestratorConfig;
let configError: Error | undefined;
mock.module('../../orchestrator/index.js', { namedExports: {
  ...real,
  loadOrchestrator: async () => orch,
  getHostConfig: async () => {
    if (configError) throw configError;
    return { orch, cfg, rootDir: '/tmp/propr-selected-review-test' };
  },
} });
const { createDefaultActions } = await import('./hostActions.js');
const { runChecks } = await import('../checkCommands.js');

function platform(t: TestContext, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('Docker checks precede config errors, verify Linux containers, and honor Darwin endpoint precedence', async t => {
  const originalPath = process.env.PATH;
  for (const row of [
    { os: 'linux', engine: 'linux', context: '', host: '', endpoint: 'unix:///socket', local: undefined, remediation: false },
    { os: 'linux', engine: 'windows', context: '', host: '', endpoint: '', local: undefined, remediation: true },
    { os: 'darwin', engine: 'windows', context: '', host: '', endpoint: '', local: undefined, remediation: false },
    { os: 'darwin', engine: 'linux', context: '', host: 'unix:///selected', endpoint: 'ssh://remote', local: 'ok', remediation: false },
    { os: 'darwin', engine: 'linux', context: 'remote', host: 'unix:///selected', endpoint: 'ssh://remote', local: 'fail', remediation: false },
    { os: 'darwin', engine: 'linux', context: '', host: '', endpoint: 'unix:///desktop', local: 'ok', remediation: false },
  ]) {
    await t.test(JSON.stringify(row), async sub => {
      platform(sub, row.os);
      const old = { context: process.env.DOCKER_CONTEXT, host: process.env.DOCKER_HOST };
      process.env.DOCKER_CONTEXT = row.context;
      process.env.DOCKER_HOST = row.host;
      sub.after(() => {
        for (const [key, value] of [['DOCKER_CONTEXT', old.context], ['DOCKER_HOST', old.host]]) {
          if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
        }
      });
      const calls: string[][] = [];
      orch = { dockerAsync: async (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: args[0] === '--version' ? 'Docker fixture' : args[0] === 'info' ? row.engine : row.endpoint };
      } } as unknown as OrchestratorModule;
      configError = new Error('manifest unavailable');
      const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
      try {
        await assert.rejects(runChecks({ onResult: result => results.push(result) }), configError);
        assert.equal(results.find(r => r.name === 'Docker installed')?.status, 'ok');
        assert.equal(results.find(r => r.name === 'Docker daemon')?.status, row.engine === 'linux' ? 'ok' : 'fail');
        assert.equal(results.find(r => r.name === 'Docker daemon')?.remediation?.kind === 'start-docker', row.remediation);
        assert.equal(results.find(r => r.name === 'Docker local endpoint')?.status, row.local);
        assert.equal(calls.some(args => args[0] === 'context'), row.os === 'darwin' && row.engine === 'linux' && Boolean(row.context || !row.host));
        assert.equal(process.env.PATH, originalPath);
      } finally { configError = undefined; }
    });
  }
});

test('missing Docker emits install and daemon guidance before a config failure', async t => {
  platform(t, 'darwin');
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => { calls.push(args); return { status: null }; } } as unknown as OrchestratorModule;
  configError = new Error('manifest unavailable');
  const results: Awaited<ReturnType<typeof runChecks>>['results'] = [];
  try {
    await assert.rejects(runChecks({ onResult: row => results.push(row) }), configError);
    assert.deepEqual(calls, [['--version']]);
    assert.match(results.find(r => r.name === 'Docker installed')!.fix!, /Docker Desktop/);
    assert.equal(results.find(r => r.name === 'Docker daemon')!.remediation, undefined);
  } finally { configError = undefined; }
});

test('Darwin pulls share architecture inspection, keep missing source failures structured, and use local metadata offline', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'local/app', ui: 'local/ui', redis: 'redis:7' }, docsEnabled: false,
    manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } },
  } as unknown as OrchestratorConfig;
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'manifest') throw new Error('local images must not need a registry');
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args.at(-1) === 'local/app') return { status: 1 };
    if (args[0] === 'pull') return { status: 1, stderr: 'registry offline' };
    return { status: 0, stdout: JSON.stringify({ Os: 'linux', Architecture: 'arm64' }) };
  }, tagAgentLatest: () => {} } as unknown as OrchestratorModule;
  const result = await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] });
  assert.deepEqual(result.failedCore, ['local/app']);
  assert.deepEqual(result.pulledCore, ['local/ui', 'redis:7']);
  assert.equal(calls.filter(args => args[0] === 'info').length, 1);
  assert.equal(calls.filter(args => args[0] === 'image' && args.includes('--format') && args.at(-1) === 'redis:7').length, 2);
});

test('offline skip avoids pulls and failed pull cannot reuse a vanished local image', async t => {
  platform(t, 'darwin');
  cfg = { images: { redis: 'redis:7' }, manifest: {} } as unknown as OrchestratorConfig;
  const old = process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  t.after(() => { if (old === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK; else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = old; });
  let pulled = false;
  orch = { dockerAsync: async (args: string[]) => {
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args[0] === 'pull') { pulled = true; return { status: 1 }; }
    return pulled ? { status: 1 } : { status: 0, stdout: JSON.stringify({ Os: 'linux', Architecture: 'arm64' }) };
  } } as unknown as OrchestratorModule;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).pulledCore, ['redis:7']);
  assert.equal(pulled, false);
  delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).failedCore, ['redis:7']);
});

test('Darwin stack hint preserves the exact typed error', async t => {
  platform(t, 'darwin');
  cfg = {} as OrchestratorConfig;
  class Conflict extends Error { code = 'STACK_INCOMPATIBLE'; }
  const conflict = new Conflict('incompatible stack');
  orch = {
    validateEnv: () => ({ ok: true, warnings: [] }),
    ensureNetworkAsync: async () => {},
    startStackAsync: async () => { throw conflict; },
  } as unknown as OrchestratorModule;
  await assert.rejects(createDefaultActions().startStack({ rootDir: '/tmp/root' }), error => {
    assert.equal(error, conflict);
    assert.equal(conflict.code, 'STACK_INCOMPATIBLE');
    assert.match(conflict.message, /File sharing/);
    return true;
  });
});


test('an incompatible cached core variant can be replaced from its published manifest', async t => {
  platform(t, 'darwin');
  cfg = { images: { redis: 'redis:7' }, manifest: {} } as unknown as OrchestratorConfig;
  const calls: string[][] = [];
  orch = { dockerAsync: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    if (args[0] === 'manifest') return { status: 0, stdout: '{"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]}' };
    return { status: 0, stdout: '{"Os":"linux","Architecture":"amd64"}' };
  } } as unknown as OrchestratorModule;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).pulledCore, ['redis:7']);
  assert.deepEqual(calls.find(args => args[0] === 'pull'), ['pull', '--platform', 'linux/arm64', 'redis:7']);
});

test('source image disappearance during platform inspection remains a failedCore result', async t => {
  platform(t, 'darwin');
  cfg = { images: { app: 'local/app' }, manifest: { desktopRuntime: { schemaVersion: 1, distribution: 'local' } } } as unknown as OrchestratorConfig;
  orch = { dockerAsync: async (args: string[]) => {
    if (args[0] === 'info') return { status: 0, stdout: 'arm64' };
    return { status: args.includes('--format') ? 1 : 0 };
  } } as unknown as OrchestratorModule;
  assert.deepEqual((await createDefaultActions().pullImages({ rootDir: '/tmp/root', agentTypes: [] })).failedCore, ['local/app']);
});

test('GitHub probes retain Finder tool discovery without changing the parent PATH', async t => {
  platform(t, 'darwin');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const childProcess = await import('node:child_process');
  const parentPath = process.env.PATH;
  const paths: string[] = [];
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    spawn: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      paths.push(options.env.PATH!);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      process.nextTick(() => {
        child.stdout.write(args[0] === '--version' ? 'gh fixture' : 'fixture-token');
        child.emit('close', 0);
      });
      return child;
    },
  } });
  const { loginWithGithubCli } = await import('../../auth/githubLogin.js');
  let stored: string | undefined;
  const result = await loginWithGithubCli({ setGithubToken: async (token: string) => { stored = token; } } as never, {
    authenticationHandoff: async () => { throw new Error('existing session should be reused'); },
  });
  assert.equal(result.ok, true);
  assert.equal(stored, 'fixture-token');
  assert.equal(paths.length, 2);
  assert.ok(paths.every(path => path.includes('/opt/homebrew/bin')));
  assert.equal(process.env.PATH, parentPath);
});
