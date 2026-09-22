import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
    MAX_LOCAL_CONCURRENCY,
    buildShardEnvironment,
    cleanupLocalShards,
    findOwnedProcesses,
    parseArguments,
    runLocalShards,
    shardPaths,
} from '../scripts/run-local-shards.mjs';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CI_REDIS = join(REPOSITORY, 'scripts', 'ci-redis.sh');
const COORDINATOR = join(REPOSITORY, 'scripts', 'run-local-shards.mjs');
const TRUSTED = "vars.PROPR_SELF_HOSTED_PR_CHECKS != 'false' && (github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'))";
const SELF_HOSTED = '[self-hosted, linux, x64, propr]';

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-local-shards-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
// Killed orphans can linger as zombies when PID 1 does not reap them.
const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    try {
        return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
        return true;
    }
};
async function waitFor(predicate, message, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(50);
    }
    assert.fail(message);
}

function jobBlock(workflow, job) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `job ${job} exists`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

function jobNames(workflow) {
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
    return [...jobs.matchAll(/\n {2}([a-z][a-z0-9_-]*):\n/g)].map(match => match[1]);
}

function extractRunBlock(block, stepName) {
    const lines = block.slice(block.indexOf(`- name: ${stepName}`)).split('\n');
    const runLine = lines.findIndex(line => line.trim() === 'run: |');
    assert.ok(runLine > 0, `${stepName} must use a run block`);
    const indent = lines[runLine + 1].match(/^ */)[0].length;
    const result = [];
    for (const line of lines.slice(runLine + 1)) {
        if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break;
        result.push(line.slice(indent));
    }
    return result.join('\n');
}

// Evaluates the routing expression the way Actions does for these operand
// types: missing properties are null and comparisons are strict.
function evaluateRoute(expression, { github, vars = {} }) {
    const javascript = expression
        .replaceAll('==', '===')
        .replaceAll('!===', '!==')
        .replace(/\bvars\.([A-Z_]+)/g, (_match, name) => `(vars[${JSON.stringify(name)}] ?? null)`)
        .replace(/\bgithub\.([a-z_.]+)/g, (_match, path) => `(${path.split('.').reduce((code, key) => `${code}?.[${JSON.stringify(key)}]`, 'github')} ?? null)`);
    return Function('github', 'vars', `return (${javascript});`)(github, vars);
}

// Minimal Docker CLI double for scripts/ci-redis.sh: containers are files
// holding their labels, and every removal is logged.
function createFakeDocker() {
    const root = freshDirectory('fake-docker');
    const bin = join(root, 'bin');
    const state = join(root, 'containers');
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(state)}
command="$1"; shift
case "$command" in
  run)
    name=""; labels=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --label) labels+=("$2"); shift 2 ;;
        --publish|--health-cmd|--health-interval|--health-timeout|--health-retries) shift 2 ;;
        --*) shift ;;
        *) shift ;;
      esac
    done
    [[ ! -e "$state/$name" ]] || { echo "Conflict: $name" >&2; exit 125; }
    printf '%s\\n' "\${labels[@]}" > "$state/$name"
    echo "run $name" >> "$state/.log"
    ;;
  inspect)
    name="\${@: -1}"
    [[ -e "$state/$name" ]] || exit 1
    if [[ "\${1:-}" == --format ]]; then echo healthy; fi
    ;;
  rm)
    name="\${@: -1}"
    rm -f "$state/$name"
    echo "rm $name" >> "$state/.log"
    ;;
  port)
    printf '127.0.0.1:%s\\n' "$(( $(printf '%s' "$1" | cksum | cut -d' ' -f1) % 20000 + 20000 ))"
    ;;
  ps)
    filters=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --filter) filters+=("\${2#label=}"); shift 2 ;;
        --format) shift 2 ;;
        *) shift ;;
      esac
    done
    for file in "$state"/*; do
      [[ -e "$file" ]] || continue
      matched=true
      for filter in "\${filters[@]}"; do
        grep -qxF -- "$filter" "$file" || matched=false
      done
      if $matched; then basename "$file"; fi
    done
    ;;
  logs) ;;
  *) echo "unexpected docker $command" >&2; exit 1 ;;
esac
`);
    chmodSync(join(bin, 'docker'), 0o755);
    const containers = () => readdirSync(state).filter(name => !name.startsWith('.')).sort();
    const removals = () => (existsSync(join(state, '.log')) ? readFileSync(join(state, '.log'), 'utf8') : '')
        .split('\n').filter(line => line.startsWith('rm ')).map(line => line.slice(3));
    return { bin, state, containers, removals };
}

function runRedis(docker, action, env) {
    return spawnSync('bash', [CI_REDIS, action], {
        encoding: 'utf8',
        env: {
            PATH: `${docker.bin}:${process.env.PATH}`,
            GITHUB_RUN_ID: '777',
            GITHUB_JOB: 'local',
            GITHUB_RUN_ATTEMPT: '1',
            CI_REDIS_STATE_DIR: docker.state.replace(/containers$/, 'redis-state'),
            ...env,
        },
    });
}

describe('scripts/ci-redis.sh shared-host isolation', () => {
    test('gives every shard its own container, port and connection file within one run and job', () => {
        const docker = createFakeDocker();
        const envFiles = {};
        for (const instance of ['shard-1', 'shard-2']) {
            envFiles[instance] = join(docker.state, `../${instance}.env`);
            const result = runRedis(docker, 'start', { CI_REDIS_INSTANCE: instance, CI_REDIS_ENV_FILE: envFiles[instance] });
            assert.equal(result.status, 0, result.stderr);
        }
        assert.deepEqual(docker.containers(), [
            'propr-ci-redis-777-local-shard-1-a1',
            'propr-ci-redis-777-local-shard-2-a1',
        ]);
        const settings = Object.fromEntries(Object.entries(envFiles).map(([instance, file]) => [
            instance,
            Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split('='))),
        ]));
        assert.notEqual(settings['shard-1'].REDIS_PORT, settings['shard-2'].REDIS_PORT);
        assert.equal(settings['shard-1'].REDIS_CONTAINER_NAME, 'propr-ci-redis-777-local-shard-1-a1');
        assert.equal(settings['shard-1'].PROPR_TEST_REDIS_ISOLATION, 'flush');

        const stop = runRedis(docker, 'stop', { CI_REDIS_INSTANCE: 'shard-1' });
        assert.equal(stop.status, 0, stop.stderr);
        assert.deepEqual(docker.containers(), ['propr-ci-redis-777-local-shard-2-a1']);
        assert.deepEqual(docker.removals(), ['propr-ci-redis-777-local-shard-1-a1']);
        assert.equal(runRedis(docker, 'name', { CI_REDIS_INSTANCE: 'shard-2' }).stdout.trim(), 'propr-ci-redis-777-local-shard-2-a1');
    });

    test('keys containers by attempt and only replaces this instance\'s earlier attempt', () => {
        const docker = createFakeDocker();
        for (const env of [
            { CI_REDIS_INSTANCE: 'shard-1' },
            { CI_REDIS_INSTANCE: 'shard-2' },
            { CI_REDIS_INSTANCE: 'shard-1', GITHUB_RUN_ID: '778' },
            { CI_REDIS_INSTANCE: 'shard-1', GITHUB_JOB: 'other' },
        ]) {
            assert.equal(runRedis(docker, 'start', { ...env, CI_REDIS_ENV_FILE: join(docker.state, '../ignored.env') }).status, 0);
        }
        const retry = runRedis(docker, 'start', {
            CI_REDIS_INSTANCE: 'shard-1',
            GITHUB_RUN_ATTEMPT: '2',
            CI_REDIS_ENV_FILE: join(docker.state, '../retry.env'),
        });
        assert.equal(retry.status, 0, retry.stderr);
        assert.deepEqual(docker.removals(), ['propr-ci-redis-777-local-shard-1-a1']);
        assert.deepEqual(docker.containers(), [
            'propr-ci-redis-777-local-shard-1-a2',
            'propr-ci-redis-777-local-shard-2-a1',
            'propr-ci-redis-777-other-shard-1-a1',
            'propr-ci-redis-778-local-shard-1-a1',
        ]);
    });

    test('keeps the single-Redis behaviour for existing callers without an instance', () => {
        const docker = createFakeDocker();
        const githubEnv = join(docker.state, '../github.env');
        writeFileSync(githubEnv, '');
        assert.equal(runRedis(docker, 'start', { GITHUB_JOB: 'e2e-tests', GITHUB_ENV: githubEnv }).status, 0);
        assert.deepEqual(docker.containers(), ['propr-ci-redis-777-e2e-tests-a1']);
        assert.match(readFileSync(githubEnv, 'utf8'), /^REDIS_PORT=\d+$/m);
        assert.match(readFileSync(githubEnv, 'utf8'), /^PROPR_TEST_REDIS_ISOLATION=flush$/m);
        assert.equal(runRedis(docker, 'stop', { GITHUB_JOB: 'e2e-tests' }).status, 0);
        assert.deepEqual(docker.containers(), []);
    });

    test('rejects instance names that sanitizing could collide', () => {
        const docker = createFakeDocker();
        for (const instance of ['shard/1', 'shard 1', '-shard', 'a'.repeat(64)]) {
            const result = runRedis(docker, 'start', { CI_REDIS_INSTANCE: instance });
            assert.equal(result.status, 2, instance);
            assert.match(result.stderr, /CI_REDIS_INSTANCE must match/);
        }
        assert.equal(runRedis(docker, 'start', { GITHUB_RUN_ATTEMPT: '0' }).status, 2);
        assert.deepEqual(docker.containers(), []);
    });
});

function createCoordinatorFixture({ suiteMode = 'pass', failShard, redisFailInstance } = {}) {
    const root = freshDirectory(`coordinator-${suiteMode}`);
    const source = join(root, 'source');
    const observations = join(root, 'observations');
    mkdirSync(join(source, 'node_modules', 'dependency'), { recursive: true });
    mkdirSync(observations);
    writeFileSync(join(source, 'node_modules', 'dependency', 'index.js'), 'export default 1;\n');
    writeFileSync(join(source, 'fake-suite.mjs'), `
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const env = process.env;
const shard = Number(env.PROPR_TEST_SHARD_INDEX);
const observations = env.FAKE_OBSERVATIONS;
const siblingsMutated = existsSync(join(process.cwd(), 'node_modules', 'mutated-by-shard'));
writeFileSync(join(process.cwd(), 'node_modules', 'mutated-by-shard'), String(shard));
writeFileSync(join(env.TMPDIR, 'scratch'), String(shard));
const record = (extra = {}) => writeFileSync(join(observations, 'shard-' + shard + '.json'), JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    home: env.HOME,
    tmp: env.TMPDIR,
    port: env.REDIS_PORT,
    flush: env.PROPR_TEST_REDIS_ISOLATION,
    owner: env.PROPR_LOCAL_SHARD_OWNER,
    count: env.PROPR_TEST_SHARD_COUNT,
    summaryFile: env.PROPR_TEST_SUMMARY_FILE,
    githubEnv: env.GITHUB_ENV ?? null,
    stepSummary: env.GITHUB_STEP_SUMMARY ?? null,
    token: env.GITHUB_TOKEN_TO_REDACT ?? null,
    siblingsMutated,
    ...extra,
}));
console.log('shard ' + shard + ' authorization: bearer ghp_' + 'a'.repeat(36));
const mode = env.FAKE_SUITE_MODE;
if (mode === 'barrier' || mode === 'hang') {
    writeFileSync(join(observations, 'started-' + shard), String(Date.now()));
}
if (mode === 'hang') {
    const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    escaped.unref();
    record({ escapedPid: escaped.pid });
    setInterval(() => {}, 1000);
} else {
    if (mode === 'barrier') {
        const deadline = Date.now() + 10000;
        while (readdirSync(observations).filter(name => name.startsWith('started-')).length < Number(env.PROPR_TEST_SHARD_COUNT)) {
            if (Date.now() > deadline) { console.error('shards did not run concurrently'); process.exit(3); }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    if (mode === 'overlap') {
        writeFileSync(join(observations, 'running-' + shard), '');
        const running = readdirSync(observations).filter(name => name.startsWith('running-')).length;
        writeFileSync(join(observations, 'peak-' + shard), String(running));
        await new Promise(resolve => setTimeout(resolve, 150));
        (await import('node:fs')).rmSync(join(observations, 'running-' + shard));
    }
    record();
    writeFileSync(env.PROPR_TEST_SUMMARY_FILE, JSON.stringify({
        shard: { index: shard, count: Number(env.PROPR_TEST_SHARD_COUNT) },
        runAttempt: 1,
        results: [{ kind: 'file', id: 'test/shard' + shard + '.test.ts', status: 'passed', durationMs: 1 }],
    }));
    process.exit(Number(env.FAKE_FAIL_SHARD) === shard ? 1 : 0);
}
`);
    const redisLog = join(root, 'redis.log');
    const redisScript = join(root, 'fake-redis.sh');
    writeFileSync(redisScript, `#!/usr/bin/env bash
set -euo pipefail
echo "$1 $CI_REDIS_INSTANCE $GITHUB_RUN_ID-$GITHUB_JOB state=$CI_REDIS_STATE_DIR" >> ${JSON.stringify(redisLog)}
if [[ "$1" == start ]]; then
  [[ "$CI_REDIS_INSTANCE" != "\${FAKE_REDIS_FAIL:-}" ]] || { echo "redis failed" >&2; exit 1; }
  [[ -z "\${GITHUB_ENV:-}" ]] || { echo "GITHUB_ENV leaked into redis start" >&2; exit 1; }
  {
    echo "REDIS_HOST=127.0.0.1"
    echo "REDIS_PORT=$(( 16000 + \${CI_REDIS_INSTANCE#shard-} ))"
    echo "REDIS_CONTAINER_NAME=fake-$CI_REDIS_INSTANCE"
    echo "PROPR_TEST_REDIS_ISOLATION=flush"
  } >> "$CI_REDIS_ENV_FILE"
fi
`);
    chmodSync(redisScript, 0o755);
    const stepSummary = join(root, 'step-summary.md');
    const env = {
        PATH: process.env.PATH,
        GITHUB_RUN_ID: '4242',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'local',
        RUNNER_NAME: 'fixture-runner',
        GITHUB_ENV: join(root, 'github.env'),
        GITHUB_STEP_SUMMARY: stepSummary,
        GITHUB_TOKEN_TO_REDACT: 'fixture-token-value',
        REDIS_PORT: '6379',
        PROPR_TEST_SHARD_INDEX: '9',
        PROPR_TEST_SHARD_COUNT: '4',
        FAKE_OBSERVATIONS: observations,
        FAKE_SUITE_MODE: suiteMode,
        ...(failShard ? { FAKE_FAIL_SHARD: String(failShard) } : {}),
        ...(redisFailInstance ? { FAKE_REDIS_FAIL: redisFailInstance } : {}),
    };
    return {
        root,
        source,
        observations,
        redisLog,
        redisScript,
        stepSummary,
        workRoot: join(root, 'work'),
        outputDir: join(root, 'output'),
        env,
        redisCalls: () => readFileSync(redisLog, 'utf8').trim().split('\n').map(line => line.split(' ').slice(0, 2).join(' ')).sort(),
        observation: shard => JSON.parse(readFileSync(join(observations, `shard-${shard}.json`), 'utf8')),
        output: (shard, file) => readFileSync(join(root, 'output', `shard-${shard}`, file), 'utf8'),
    };
}

function coordinatorOptions(fixture, overrides = {}) {
    return {
        sourceDir: fixture.source,
        workRoot: fixture.workRoot,
        outputDir: fixture.outputDir,
        shardCount: 4,
        concurrency: 4,
        env: fixture.env,
        redisScript: fixture.redisScript,
        suiteCommand: [process.execPath, ['fake-suite.mjs']],
        log: () => {},
        ...overrides,
    };
}

describe('scripts/run-local-shards.mjs', () => {
    test('runs four shards concurrently in isolated workspaces, homes, temp directories and Redis instances', async () => {
        const fixture = createCoordinatorFixture({ suiteMode: 'barrier' });
        assert.equal(await runLocalShards(coordinatorOptions(fixture)), 0);

        const seen = [1, 2, 3, 4].map(fixture.observation);
        for (const key of ['cwd', 'home', 'tmp', 'port', 'owner', 'summaryFile']) {
            assert.equal(new Set(seen.map(observation => observation[key])).size, 4, `${key} is unique per shard`);
        }
        seen.forEach((observation, index) => {
            const shard = index + 1;
            const paths = shardPaths(fixture.workRoot, fixture.outputDir, shard);
            assert.equal(observation.cwd, paths.workspace);
            assert.equal(observation.home, paths.home);
            assert.equal(observation.tmp, paths.tmp);
            assert.equal(observation.port, String(16000 + shard), 'inherited REDIS_PORT is replaced');
            assert.equal(observation.flush, 'flush');
            assert.equal(observation.count, '4');
            assert.equal(observation.owner, `4242-1-local:shard-${shard}`);
            assert.equal(observation.summaryFile, join(fixture.outputDir, `shard-${shard}`, 'summary.json'));
            assert.equal(observation.githubEnv, null, 'tests cannot write the job environment');
            assert.equal(observation.stepSummary, null);
            assert.equal(observation.token, null, 'the redaction token never reaches tests');
            assert.equal(observation.siblingsMutated, false, 'node_modules is not shared between shards');

            const stages = JSON.parse(fixture.output(shard, 'stages.json'));
            assert.deepEqual(stages, {
                shard,
                runAttempt: 1,
                stages: { 'Workspace copy': 'success', 'Redis startup': 'success', 'Test shard': 'success' },
            });
            const output = fixture.output(shard, 'test_output.sanitized.txt');
            assert.match(output, new RegExp(`shard ${shard} authorization: bearer \\[REDACTED\\]`));
            assert.doesNotMatch(output, /ghp_a{36}/);
            assert.equal(JSON.parse(fixture.output(shard, 'summary.json')).shard.index, shard);
            assert.equal(existsSync(paths.workspace), false, 'finished shard workspaces are removed');
            assert.equal(existsSync(join(paths.root, 'test_output.txt')), false, 'raw output is removed');
        });
        assert.equal(existsSync(join(fixture.source, 'node_modules', 'mutated-by-shard')), false, 'the source checkout is untouched');
        assert.deepEqual(fixture.redisCalls(), [
            'start shard-1', 'start shard-2', 'start shard-3', 'start shard-4',
            'stop shard-1', 'stop shard-2', 'stop shard-3', 'stop shard-4',
        ]);
        const report = JSON.parse(readFileSync(join(fixture.outputDir, 'coordinator.json'), 'utf8'));
        assert.equal(report.runnerName, 'fixture-runner');
        assert.deepEqual(report.shards.map(shard => [shard.shard, shard.status, shard.units]), [[1, 'passed', 1], [2, 'passed', 1], [3, 'passed', 1], [4, 'passed', 1]]);
        assert.match(readFileSync(fixture.stepSummary, 'utf8'), /Self-hosted full suite: 4\/4 shards passed/);
    });

    test('never runs more shards at once than the concurrency bound', async () => {
        const fixture = createCoordinatorFixture({ suiteMode: 'overlap' });
        assert.equal(await runLocalShards(coordinatorOptions(fixture, { concurrency: 2 })), 0);
        const peaks = [1, 2, 3, 4].map(shard => Number(readFileSync(join(fixture.observations, `peak-${shard}`), 'utf8')));
        assert.ok(Math.max(...peaks) <= 2, `peak concurrency ${Math.max(...peaks)}`);
        await assert.rejects(runLocalShards(coordinatorOptions(createCoordinatorFixture(), { concurrency: MAX_LOCAL_CONCURRENCY + 1 })), /Concurrency must be between 1 and 4/);
    });

    test('propagates one failing shard while the others finish and every Redis is stopped', async () => {
        const fixture = createCoordinatorFixture({ failShard: 2 });
        assert.equal(await runLocalShards(coordinatorOptions(fixture)), 1);
        assert.equal(JSON.parse(fixture.output(2, 'stages.json')).stages['Test shard'], 'failure');
        for (const shard of [1, 3, 4]) assert.equal(JSON.parse(fixture.output(shard, 'stages.json')).stages['Test shard'], 'success');
        assert.equal(fixture.redisCalls().filter(call => call.startsWith('stop ')).length, 4);
        const report = JSON.parse(readFileSync(join(fixture.outputDir, 'coordinator.json'), 'utf8'));
        assert.equal(report.shards[1].status, 'failed');
        assert.match(report.shards[1].failure, /Test shard: exit 1/);
    });

    test('fails a shard whose Redis cannot start without running its tests', async () => {
        const fixture = createCoordinatorFixture({ redisFailInstance: 'shard-3' });
        assert.equal(await runLocalShards(coordinatorOptions(fixture)), 1);
        assert.deepEqual(JSON.parse(fixture.output(3, 'stages.json')).stages, {
            'Workspace copy': 'success',
            'Redis startup': 'failure',
            'Test shard': 'skipped',
        });
        assert.equal(existsSync(join(fixture.observations, 'shard-3.json')), false);
        assert.equal(existsSync(join(fixture.outputDir, 'shard-3', 'summary.json')), false, 'no summary means coverage verification fails closed');
    });

    test('cancellation stops every shard and its Redis, and cleanup kills only this run\'s escaped processes', async () => {
        const fixture = createCoordinatorFixture({ suiteMode: 'hang' });
        const driver = join(fixture.root, 'driver.mjs');
        writeFileSync(driver, `
import { runLocalShards } from ${JSON.stringify(COORDINATOR)};
process.exitCode = await runLocalShards({
    sourceDir: ${JSON.stringify(fixture.source)},
    workRoot: ${JSON.stringify(fixture.workRoot)},
    outputDir: ${JSON.stringify(fixture.outputDir)},
    shardCount: 4,
    concurrency: 4,
    env: process.env,
    redisScript: ${JSON.stringify(fixture.redisScript)},
    suiteCommand: [process.execPath, ['fake-suite.mjs']],
    terminationGraceMs: 500,
    log: () => {},
});
`);
        const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, PROPR_LOCAL_SHARD_OWNER: '4242-2-local:shard-1' },
        });
        const coordinator = spawn(process.execPath, [driver], { env: fixture.env, stdio: 'ignore' });
        const exited = new Promise(resolveExit => coordinator.once('exit', (code, signal) => resolveExit({ code, signal })));
        try {
            await waitFor(() => [1, 2, 3, 4].every(shard => existsSync(join(fixture.observations, `shard-${shard}.json`))), 'all shards started');
            const running = [1, 2, 3, 4].map(fixture.observation);
            coordinator.kill('SIGTERM');
            assert.deepEqual(await exited, { code: 143, signal: null });

            for (const observation of running) assert.equal(isAlive(observation.pid), false, `shard process ${observation.pid} stopped`);
            for (const shard of [1, 2, 3, 4]) {
                assert.equal(JSON.parse(fixture.output(shard, 'stages.json')).stages['Test shard'], 'cancelled');
            }
            assert.equal(fixture.redisCalls().filter(call => call.startsWith('stop ')).length, 4);

            // Detached from its shard's process group, so only the owner marker finds it.
            const escaped = running.map(observation => observation.escapedPid);
            assert.ok(escaped.every(isAlive));
            assert.deepEqual(findOwnedProcesses('4242-1-local').sort(), [...escaped].sort());
            const cleanup = await cleanupLocalShards({
                sourceDir: fixture.source,
                workRoot: fixture.workRoot,
                shardCount: 4,
                env: fixture.env,
                redisScript: fixture.redisScript,
                log: () => {},
            });
            assert.equal(cleanup, 0);
            await waitFor(() => escaped.every(pid => !isAlive(pid)), 'escaped shard processes killed');
            assert.equal(isAlive(decoy.pid), true, 'another run attempt\'s process survives');
            assert.equal(existsSync(fixture.workRoot), false);
            assert.equal(fixture.redisCalls().filter(call => call.startsWith('stop ')).length, 8);
        } finally {
            coordinator.kill('SIGKILL');
            try { process.kill(decoy.pid, 'SIGKILL'); } catch {}
            for (const file of readdirSync(fixture.observations).filter(name => name.startsWith('shard-'))) {
                const { escapedPid } = JSON.parse(readFileSync(join(fixture.observations, file), 'utf8'));
                try { process.kill(escapedPid, 'SIGKILL'); } catch {}
            }
        }
    });

    test('cleanup refuses to remove a work root owned by another run', async () => {
        const workRoot = freshDirectory('foreign-work-root');
        writeFileSync(join(workRoot, '.propr-local-shards'), '9999-1-local\n');
        const result = await cleanupLocalShards({
            sourceDir: REPOSITORY,
            workRoot,
            shardCount: 4,
            env: { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'local' },
            procRoot: join(workRoot, 'no-proc'),
            log: () => {},
        });
        assert.equal(result, 1);
        assert.equal(existsSync(join(workRoot, '.propr-local-shards')), true);
    });

    test('validates coordinator arguments before touching the host', () => {
        const env = { PROPR_TEST_SHARD_COUNT: '4' };
        const valid = ['run', '--source=/work/propr', '--work-root=/runner/_temp/shards', '--output=/runner/_temp/output'];
        assert.deepEqual(parseArguments(valid, env), {
            command: 'run',
            sourceDir: '/work/propr',
            workRoot: '/runner/_temp/shards',
            outputDir: '/runner/_temp/output',
            shardCount: 4,
            concurrency: 4,
        });
        assert.equal(parseArguments([...valid, '--concurrency=2'], env).concurrency, 2);
        for (const [argv, testEnv, message] of [
            [[...valid, '--concurrency=5'], env, /must not exceed 4/],
            [['run', '--source=relative', '--work-root=/w', '--output=/o'], env, /must be an absolute path/],
            [['run', '--source=/work/propr', '--work-root=/work/propr/shards', '--output=/o'], env, /--work-root must be outside the source checkout/],
            [['run', '--source=/work/propr', '--work-root=/w', '--output=/work/propr'], env, /--output must be outside the source checkout/],
            [['run', '--source=/work/propr', '--work-root=/w'], env, /--output is required/],
            [valid, {}, /PROPR_TEST_SHARD_COUNT must be a positive integer/],
            [['prune'], env, /Usage/],
        ]) {
            assert.throws(() => parseArguments(argv, testEnv), message);
        }
    });

    test('isolates shard environments from job state and each other', () => {
        const paths = shardPaths('/work-root', '/output', 3);
        const env = buildShardEnvironment({
            baseEnv: {
                PATH: '/bin',
                HOME: '/root',
                GITHUB_RUN_ID: '1',
                GITHUB_OUTPUT: '/x',
                ACTIONS_RUNTIME_TOKEN: 'secret',
                GITHUB_TOKEN_TO_REDACT: 'secret',
                REDIS_PORT: '6379',
                PROPR_TEST_REDIS_ISOLATION: 'flush',
                LOCAL_SHARD_OUTPUT: '/output',
            },
            paths,
            shard: 3,
            shardCount: 4,
            redis: { REDIS_HOST: '127.0.0.1', REDIS_PORT: '16003', PROPR_TEST_REDIS_ISOLATION: 'flush' },
        });
        assert.equal(env.HOME, '/work-root/shard-3/home');
        assert.equal(env.TMPDIR, '/work-root/shard-3/tmp');
        assert.equal(env.XDG_CACHE_HOME, '/work-root/shard-3/home/.cache');
        assert.equal(env.REDIS_PORT, '16003');
        assert.equal(env.PROPR_TEST_SHARD_INDEX, '3');
        assert.equal(env.PATH, '/bin');
        for (const key of ['GITHUB_OUTPUT', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_TOKEN_TO_REDACT', 'LOCAL_SHARD_OUTPUT']) {
            assert.equal(key in env, false, key);
        }
    });
});

describe('PR check routing', () => {
    const fullSuite = readWorkflow('pr-test-on-label.yml');
    const buildCheck = readWorkflow('pr-build-check.yml');

    test('uses one identical routing expression everywhere it chooses a runner', () => {
        const count = (workflow) => workflow.split(TRUSTED).length - 1;
        assert.equal(count(fullSuite), 5, 'shard, docs, local, native-electron and the gate');
        assert.equal(count(buildCheck), 1, 'validate');
        for (const workflow of [fullSuite, buildCheck]) {
            const variants = workflow.match(/vars\.PROPR_SELF_HOSTED_PR_CHECKS[^\n]*/g);
            for (const variant of variants) assert.ok(variant.includes(TRUSTED), variant);
        }
    });

    test('routes only trusted same-repository PRs and dispatches to the self-hosted runner', () => {
        const pr = (headRepository, author = 'propr-dev[bot]') => ({
            event_name: 'pull_request',
            repository: 'integry/propr',
            event: { pull_request: { head: { repo: { full_name: headRepository } }, user: { login: author } } },
        });
        assert.equal(evaluateRoute(TRUSTED, { github: pr('integry/propr') }), true);
        assert.equal(evaluateRoute(TRUSTED, { github: pr('someone/propr') }), false, 'fork PRs stay hosted');
        assert.equal(evaluateRoute(TRUSTED, { github: pr('integry/propr', 'dependabot[bot]') }), false, 'dependency update PRs stay hosted');
        assert.equal(evaluateRoute(TRUSTED, { github: { event_name: 'workflow_dispatch', repository: 'integry/propr', event: {} } }), true);
        assert.equal(evaluateRoute(TRUSTED, { github: pr('integry/propr'), vars: { PROPR_SELF_HOSTED_PR_CHECKS: 'false' } }), false, 'maintainers can route everything back to hosted');
        assert.equal(evaluateRoute(TRUSTED, { github: pr('integry/propr'), vars: { PROPR_SELF_HOSTED_PR_CHECKS: 'true' } }), true);
    });

    test('places each full-suite job on the intended runner', () => {
        assert.deepEqual(jobNames(fullSuite), ['shard', 'docs', 'local', 'native-electron', 'test', 'comment']);
        const local = jobBlock(fullSuite, 'local');
        assert.match(local, new RegExp(`runs-on: ${SELF_HOSTED.replace(/[[\]]/g, '\\$&')}\n`));
        assert.ok(local.includes(`(${TRUSTED})`));
        for (const job of ['shard', 'docs']) {
            const block = jobBlock(fullSuite, job);
            assert.match(block, /runs-on: ubuntu-latest\n/);
            assert.ok(block.includes(`!(${TRUSTED})`), `${job} runs only for untrusted PRs`);
        }
        for (const job of ['native-electron', 'test', 'comment']) assert.match(jobBlock(fullSuite, job), /runs-on: ubuntu-latest\n/);
        assert.equal(fullSuite.split('self-hosted, linux, x64, propr').length - 1, 1, 'only the local coordinator is self-hosted');
        assert.doesNotMatch(fullSuite, /pull_request_target/);
        assert.doesNotMatch(fullSuite, /secrets\./);
    });

    test('keeps the self-hosted coordinator isolated, bounded and self-cleaning', () => {
        const local = jobBlock(fullSuite, 'local');
        assert.match(local, /persist-credentials: false/);
        assert.match(local, /echo "HOME=\$job_root\/home"/);
        assert.match(local, /echo "PLAYWRIGHT_BROWSERS_PATH=\$job_root\/playwright"/);
        assert.match(local, /echo "PROPR_CACHE_DIR=\$job_root\/setup-cache"/);
        assert.match(local, /exec node scripts\/run-local-shards\.mjs run/);
        assert.doesNotMatch(local, /--concurrency=/, 'the coordinator default is the four-shard bound');
        assert.doesNotMatch(local, /--with-deps/);
        const build = extractRunBlock(local, 'Build workspace packages');
        assert.ok(build.indexOf('rm -rf packages/shared/dist') < build.indexOf('npm run test:prepare'));
        assert.ok(build.indexOf('test -f packages/shared/dist/index.js') > build.indexOf('npm run test:prepare'));
        for (let shard = 1; shard <= 4; shard += 1) {
            assert.ok(local.includes(`name: full-test-output-\${{ github.run_id }}-\${{ github.run_attempt }}-shard-${shard}\n`), `shard ${shard} artifact`);
        }
        const cleanup = local.slice(local.indexOf('- name: Clean up shard processes and Redis'));
        assert.match(cleanup, /^- name: Clean up shard processes and Redis\n\s+if: always\(\)\n/);
        assert.match(cleanup, /node scripts\/run-local-shards\.mjs cleanup/);
        assert.match(local, /- name: Fail Job\n\s+if: steps\.tests\.outcome != 'success' \|\| steps\.docs\.outcome != 'success'/);
        for (const workflow of [fullSuite, buildCheck, readWorkflow('test-nightly.yml')]) {
            assert.doesNotMatch(workflow, /docker (?:system|container|volume|image) prune|docker rm[^\n]*\$\(docker ps/, 'no machine-wide Docker cleanup');
        }
    });

    test('runs the Electron units that cannot launch on the self-hosted runner on a hosted runner without skipping', () => {
        const electron = jobBlock(fullSuite, 'native-electron');
        assert.ok(electron.includes(`(${TRUSTED})`));
        assert.match(electron, /PROPR_REQUIRE_NATIVE_ELECTRON: '1'/);
        const run = extractRunBlock(electron, 'Run native Electron units without skipping');
        const units = spawnSync('bash', ['-c', `${run.split('\n').filter(line => line.startsWith('mapfile')).join('\n')}\nprintf '%s\\n' "\${files[@]}"`], {
            cwd: REPOSITORY,
            encoding: 'utf8',
        }).stdout.trim().split('\n');
        assert.deepEqual(units, [
            'apps/desktop/scripts/electron-frame-semantics.test.mjs',
            'apps/desktop/scripts/electron-pairing-zstd.test.mjs',
        ]);
        assert.match(run, /node scripts\/run-test-suite\.mjs "\$\{files\[@\]\}"/);
    });

    test('fails the required gate closed on the selected route', () => {
        const gate = jobBlock(fullSuite, 'test');
        assert.match(gate, /name: Run Full Test Suite\n/);
        assert.match(gate, /needs: \[shard, docs, local, native-electron\]/);
        assert.ok(gate.includes(`ROUTE: \${{ (${TRUSTED}) && 'self-hosted' || 'hosted' }}`));
        const enforce = extractRunBlock(gate, 'Enforce shard and docs results');
        const runGate = env => spawnSync('bash', ['-e', '-c', enforce], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, COVERAGE_RESULT: 'success', ...env },
        });
        const selfHosted = { ROUTE: 'self-hosted', LOCAL_RESULT: 'success', ELECTRON_RESULT: 'success', SHARD_RESULT: 'skipped', DOCS_RESULT: 'skipped' };
        const hosted = { ROUTE: 'hosted', SHARD_RESULT: 'success', DOCS_RESULT: 'success', LOCAL_RESULT: 'skipped', ELECTRON_RESULT: 'skipped' };
        assert.equal(runGate(selfHosted).status, 0);
        assert.equal(runGate(hosted).status, 0);
        for (const [env, message] of [
            [{ ...selfHosted, LOCAL_RESULT: 'failure' }, /local shards and docs validation finished with result 'failure'/],
            [{ ...selfHosted, LOCAL_RESULT: 'cancelled' }, /local shards and docs validation finished with result 'cancelled'/],
            [{ ...selfHosted, LOCAL_RESULT: 'skipped' }, /local shards and docs validation finished with result 'skipped'/],
            [{ ...selfHosted, ELECTRON_RESULT: 'skipped' }, /native Electron units finished with result 'skipped'/],
            [{ ...selfHosted, ELECTRON_RESULT: 'failure' }, /native Electron units finished with result 'failure'/],
            [{ ...hosted, SHARD_RESULT: 'skipped' }, /shards finished with result 'skipped'/],
            [{ ...hosted, SHARD_RESULT: 'failure' }, /shards finished with result 'failure'/],
            [{ ...hosted, DOCS_RESULT: 'cancelled' }, /docs validation finished with result 'cancelled'/],
            [{ ...selfHosted, COVERAGE_RESULT: 'failure' }, /coverage verification finished with result 'failure'/],
            [{ ...hosted, COVERAGE_RESULT: 'skipped' }, /coverage verification finished with result 'skipped'/],
            [{ ...hosted, ROUTE: '' }, /Unknown full-suite route ''/],
        ]) {
            const result = runGate(env);
            assert.equal(result.status, 1, JSON.stringify(env));
            assert.match(result.stdout, message);
        }
    });

    test('routes Validate Changes and keeps every other build check on its hosted platform', () => {
        const validate = jobBlock(buildCheck, 'validate');
        assert.ok(validate.includes(`runs-on: \${{ (${TRUSTED}) && fromJSON('["self-hosted","linux","x64","propr"]') || 'ubuntu-latest' }}`));
        assert.match(validate, /- name: Isolate job state from the shared host\n\s+if: runner\.environment == 'self-hosted'/);
        assert.match(validate, /persist-credentials: false/);
        assert.doesNotMatch(validate, /--with-deps/, 'Chromium system packages are installed only by the hosted-aware helper');
        assert.equal(validate.split('./scripts/ci-install-chromium.sh').length - 1, 2);
        const expected = {
            'visual-previews': 'ubuntu-latest',
            'cli-node-matrix': 'ubuntu-latest',
            'cli-agent-skill-glibc-231': 'ubuntu-latest',
            'cli-agent-skill-darwin': 'macos-15',
            'windows-connect-discovery': 'windows-2025',
            'connect-authority-darwin': 'macos-15',
            'cli-init-json': 'ubuntu-latest',
            comment: 'ubuntu-latest',
        };
        assert.deepEqual(jobNames(buildCheck).sort(), [...Object.keys(expected), 'validate'].sort());
        for (const [job, runner] of Object.entries(expected)) {
            assert.match(jobBlock(buildCheck, job), new RegExp(`\n    runs-on: ${runner}\n`), job);
        }
        for (const desktop of ['desktop-release-guard.yml', 'desktop-connect-discovery-guard.yml', 'cli-node-compatibility.yml']) {
            assert.doesNotMatch(readWorkflow(desktop), /self-hosted/, `${desktop} stays hosted`);
        }
    });

    test('installs Chromium system packages only on disposable hosted runners', () => {
        const root = freshDirectory('chromium-helper');
        writeFileSync(join(root, 'npx'), '#!/usr/bin/env bash\necho "npx $*"\n');
        chmodSync(join(root, 'npx'), 0o755);
        const install = environment => spawnSync('bash', [join(REPOSITORY, 'scripts', 'ci-install-chromium.sh')], {
            encoding: 'utf8',
            env: { PATH: `${root}:${process.env.PATH}`, ...(environment ? { RUNNER_ENVIRONMENT: environment } : {}) },
        }).stdout.trim();
        assert.equal(install('github-hosted'), 'npx playwright install --with-deps chromium');
        assert.equal(install('self-hosted'), 'npx playwright install chromium');
        assert.equal(install(undefined), 'npx playwright install chromium');
    });
});
