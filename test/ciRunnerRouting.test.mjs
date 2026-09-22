import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CI_REDIS = join(REPOSITORY, 'scripts', 'ci-redis.sh');
const CI_RUNNER_EVIDENCE = join(REPOSITORY, 'scripts', 'ci-runner-evidence.sh');
const TRUSTED = "vars.PROPR_SELF_HOSTED_PR_CHECKS != 'false' && (github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'))";
const ROUTED_RUNS_ON = `runs-on: \${{ (${TRUSTED}) && fromJSON('["self-hosted","linux","x64","propr"]') || 'ubuntu-latest' }}`;

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-runner-routing-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};
const escapeRegExp = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');

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
    arguments=("$@"); name=""; labels=()
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
    printf '%s\\n' "\${arguments[@]}" > "$state/.args-$name"
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
    const runArguments = name => readFileSync(join(state, `.args-${name}`), 'utf8').trim().split('\n');
    return { bin, state, containers, removals, runArguments };
}

function runRedis(docker, action, env) {
    return spawnSync('bash', [CI_REDIS, action], {
        encoding: 'utf8',
        env: {
            PATH: `${docker.bin}:${process.env.PATH}`,
            GITHUB_RUN_ID: '777',
            GITHUB_JOB: 'shard',
            GITHUB_RUN_ATTEMPT: '1',
            CI_REDIS_STATE_DIR: docker.state.replace(/containers$/, 'redis-state'),
            ...env,
        },
    });
}

describe('scripts/ci-redis.sh shared-host isolation', () => {
    test('gives every matrix shard its own container, port and connection file within one run and job', () => {
        const docker = createFakeDocker();
        const envFiles = {};
        for (const instance of ['shard-1', 'shard-2']) {
            envFiles[instance] = join(docker.state, `../${instance}.env`);
            const result = runRedis(docker, 'start', { CI_REDIS_INSTANCE: instance, CI_REDIS_ENV_FILE: envFiles[instance] });
            assert.equal(result.status, 0, result.stderr);
        }
        assert.deepEqual(docker.containers(), [
            'propr-ci-redis-777-shard-shard-1-a1',
            'propr-ci-redis-777-shard-shard-2-a1',
        ]);
        const settings = Object.fromEntries(Object.entries(envFiles).map(([instance, file]) => [
            instance,
            Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split('='))),
        ]));
        assert.notEqual(settings['shard-1'].REDIS_PORT, settings['shard-2'].REDIS_PORT);
        assert.equal(settings['shard-1'].REDIS_CONTAINER_NAME, 'propr-ci-redis-777-shard-shard-1-a1');
        assert.equal(settings['shard-1'].PROPR_TEST_REDIS_ISOLATION, 'flush');

        const stop = runRedis(docker, 'stop', { CI_REDIS_INSTANCE: 'shard-1' });
        assert.equal(stop.status, 0, stop.stderr);
        assert.deepEqual(docker.containers(), ['propr-ci-redis-777-shard-shard-2-a1']);
        assert.deepEqual(docker.removals(), ['propr-ci-redis-777-shard-shard-1-a1']);
        assert.equal(runRedis(docker, 'name', { CI_REDIS_INSTANCE: 'shard-2' }).stdout.trim(), 'propr-ci-redis-777-shard-shard-2-a1');
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
        assert.deepEqual(docker.removals(), ['propr-ci-redis-777-shard-shard-1-a1']);
        assert.deepEqual(docker.containers(), [
            'propr-ci-redis-777-other-shard-1-a1',
            'propr-ci-redis-777-shard-shard-1-a2',
            'propr-ci-redis-777-shard-shard-2-a1',
            'propr-ci-redis-778-shard-shard-1-a1',
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

    test('bounds every Redis container with explicit Docker limits outside the runner cgroup', () => {
        const docker = createFakeDocker();
        assert.equal(runRedis(docker, 'start', { CI_REDIS_INSTANCE: 'shard-1', CI_REDIS_ENV_FILE: join(docker.state, '../limits.env') }).status, 0);
        const argumentsOf = docker.runArguments('propr-ci-redis-777-shard-shard-1-a1');
        const option = name => argumentsOf[argumentsOf.indexOf(name) + 1];
        assert.equal(option('--memory'), '512m');
        assert.equal(option('--memory-swap'), '512m', 'no swap beyond the memory limit');
        assert.equal(option('--cpus'), '1');
        assert.equal(option('--pids-limit'), '64');
        assert.equal(option('--publish'), '127.0.0.1::6379', 'loopback only, with a Docker-assigned port');

        assert.equal(runRedis(docker, 'start', {
            CI_REDIS_INSTANCE: 'shard-2',
            CI_REDIS_ENV_FILE: join(docker.state, '../limits.env'),
            CI_REDIS_MEMORY: '1g',
            CI_REDIS_CPUS: '0.5',
        }).status, 0);
        const overridden = docker.runArguments('propr-ci-redis-777-shard-shard-2-a1');
        assert.equal(overridden[overridden.indexOf('--memory') + 1], '1g');
        assert.equal(overridden[overridden.indexOf('--cpus') + 1], '0.5');

        for (const env of [{ CI_REDIS_MEMORY: 'unlimited' }, { CI_REDIS_MEMORY: '0m' }, { CI_REDIS_CPUS: '-1' }, { CI_REDIS_PIDS_LIMIT: '0' }]) {
            const result = runRedis(docker, 'start', { CI_REDIS_INSTANCE: 'shard-3', ...env });
            assert.equal(result.status, 2, JSON.stringify(env));
        }
        assert.ok(!docker.containers().includes('propr-ci-redis-777-shard-shard-3-a1'));
    });
});
describe('scripts/ci-runner-evidence.sh', () => {
    test('records the runner name, user and cgroup limits without changing anything', () => {
        const summary = join(freshDirectory('runner-evidence'), 'summary.md');
        const result = spawnSync('bash', [CI_RUNNER_EVIDENCE], {
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                GITHUB_JOB: 'shard',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_STEP_SUMMARY: summary,
                PROPR_EVIDENCE_LABEL: 'shard 3/4',
                RUNNER_NAME: 'gitfix-propr-3',
                RUNNER_ENVIRONMENT: 'self-hosted',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const report = readFileSync(summary, 'utf8');
        assert.equal(report.trim(), result.stdout.trim());
        assert.match(report, /### Runner placement: shard \(shard 3\/4\)/);
        assert.match(report, /\| Runner name \| `gitfix-propr-3` \|/);
        assert.match(report, /\| Runner environment \| `self-hosted` \|/);
        assert.match(report, new RegExp(`\\| User \\(uid\\) \\| \`[^\`]+\` \\(\`${process.getuid()}\`\\) \\|`));
        assert.match(report, /\| Run attempt \| `2` \|/);
        for (const limit of ['cpu.max', 'memory.high', 'memory.max']) assert.match(report, new RegExp(`\\| ${escapeRegExp(limit)} \\| \`[^\`]+\` \\|`));
    });
});

describe('PR check routing', () => {
    const fullSuite = readWorkflow('pr-test-on-label.yml');
    const buildCheck = readWorkflow('pr-build-check.yml');
    const selfHostedJobs = () => [
        ['pr-test-on-label.yml shard', jobBlock(fullSuite, 'shard')],
        ['pr-test-on-label.yml docs', jobBlock(fullSuite, 'docs')],
        ['pr-build-check.yml validate', jobBlock(buildCheck, 'validate')],
    ];

    test('uses one identical routing expression everywhere it chooses a runner', () => {
        const count = (workflow) => workflow.split(TRUSTED).length - 1;
        assert.equal(count(fullSuite), 4, 'shard and docs runners, native-electron and the gate');
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

    test('runs the four shard matrix jobs and docs on the routed runner, one job per worker', () => {
        assert.deepEqual(jobNames(fullSuite), ['shard', 'docs', 'native-electron', 'test', 'comment']);
        const shard = jobBlock(fullSuite, 'shard');
        assert.match(shard, /matrix:\n\s+shard: \[1, 2, 3, 4\]\n/);
        for (const job of ['shard', 'docs']) {
            const block = jobBlock(fullSuite, job);
            assert.ok(block.includes(`\n    ${ROUTED_RUNS_ON}\n`), `${job} is routed`);
            assert.match(block, /\n {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft \}\}\n/, `${job} runs on both routes`);
        }
        for (const job of ['native-electron', 'test', 'comment']) assert.match(jobBlock(fullSuite, job), /\n {4}runs-on: ubuntu-latest\n/);
        assert.doesNotMatch(fullSuite, /runs-on: \[/, 'no job is pinned to self-hosted regardless of trust');
        assert.doesNotMatch(fullSuite, /run-local-shards|LOCAL_SHARD/, 'no nested local shard coordinator');
        assert.ok(!existsSync(join(REPOSITORY, 'scripts', 'run-local-shards.mjs')));
        assert.doesNotMatch(fullSuite, /pull_request_target/);
        assert.doesNotMatch(fullSuite, /secrets\./);
    });

    test('keeps every self-hosted job isolated, evidenced and self-cleaning', () => {
        for (const [name, block] of selfHostedJobs()) {
            assert.match(block, /persist-credentials: false/, name);
            assert.doesNotMatch(block, /clean: false/, `${name} keeps the clean checkout`);
            assert.match(block, /- name: Isolate job state from the shared host\n\s+if: runner\.environment == 'self-hosted'\n/, name);
            const isolate = extractRunBlock(block, 'Isolate job state from the shared host');
            assert.match(isolate, /^job_root="\$RUNNER_TEMP\/ci"$/m, name);
            for (const variable of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) {
                assert.match(isolate, new RegExp(`echo "${variable}=\\$job_root/`), `${name} ${variable}`);
            }
            // The runner tree can have a group-writable ancestor that the CLI's
            // private-directory checks reject, so TMPDIR is a private mktemp
            // directory under the sticky /tmp, as on hosted runners.
            assert.match(isolate, /^tmp_dir="\$\(mktemp -d \/tmp\/propr-ci\.XXXXXX\)"$/m, name);
            assert.match(isolate, /echo "TMPDIR=\$tmp_dir"\n\s+echo "PROPR_CI_TMPDIR=\$tmp_dir"\n/, name);
            assert.doesNotMatch(isolate, /\$job_root\/tmp/, name);
            assert.match(block, /- name: Record runner placement\n(?:\s+env:\n\s+PROPR_EVIDENCE_LABEL: [^\n]+\n)?\s+run: \.\/scripts\/ci-runner-evidence\.sh\n/, name);
            assert.doesNotMatch(block, /--with-deps/, `${name} never apt-installs onto the host`);
            const cleanup = block.slice(block.indexOf('- name: Remove job files from the persistent workspace'));
            assert.match(cleanup, /^- name: Remove job files from the persistent workspace\n\s+if: always\(\) && runner\.environment == 'self-hosted'\n\s+run: \|\n\s+git -C "\$GITHUB_WORKSPACE" clean -ffdxq\n\s+case "\$\{PROPR_CI_TMPDIR:-\}" in \/tmp\/propr-ci\.\*\) rm -rf -- "\$PROPR_CI_TMPDIR" ;; esac\n/, name);
            assert.doesNotMatch(cleanup.slice(cleanup.indexOf('\n')), /- name: /, `${name} cleans up after its uploads, as the last step`);
        }
        assert.match(extractRunBlock(jobBlock(fullSuite, 'docs'), 'Isolate job state from the shared host'), /echo "PROPR_CACHE_DIR=\$job_root\/setup"/);
        for (const workflow of [fullSuite, buildCheck, readWorkflow('test-nightly.yml')]) {
            assert.doesNotMatch(workflow, /docker (?:system|container|volume|image) prune|docker rm[^\n]*\$\(docker ps|docker kill/, 'no machine-wide Docker cleanup');
        }
    });

    test('isolates each shard Redis by shard and attempt and records the worker that ran it', () => {
        const shard = jobBlock(fullSuite, 'shard');
        assert.equal(shard.match(/CI_REDIS_INSTANCE: shard-\$\{\{ matrix\.shard \}\}\n\s+run: \.\/scripts\/ci-redis\.sh (?:start|stop)/g).length, 2);
        assert.match(shard, /- name: Stop isolated Redis\n\s+if: always\(\)\n/);
        assert.match(shard, /PROPR_EVIDENCE_LABEL: shard \$\{\{ matrix\.shard \}\}\/4\n/);
        const stages = shard.slice(shard.indexOf('- name: Record shard stage outcomes'), shard.indexOf('- name: Sanitize test output'));
        assert.match(stages, /const runner = \{ name: env\.RUNNER_NAME, environment: env\.RUNNER_ENVIRONMENT \};/);
        assert.match(stages, /\{ shard: Number\(env\.SHARD\), runAttempt: Number\(env\.GITHUB_RUN_ATTEMPT\), runner, stages \}/);
        assert.match(jobBlock(fullSuite, 'comment'), /\$\{shard\.runner\.name\}/, 'the failure comment names each shard\'s worker');
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
        // The workflow-level shard count must not reach this unsharded run.
        assert.match(electron, /PROPR_TEST_SHARD_COUNT: ''\n/);
    });

    test('fails the required gate closed on the selected route', () => {
        const gate = jobBlock(fullSuite, 'test');
        assert.match(gate, /name: Run Full Test Suite\n/);
        assert.match(gate, /needs: \[shard, docs, native-electron\]/);
        assert.ok(gate.includes(`ROUTE: \${{ (${TRUSTED}) && 'self-hosted' || 'hosted' }}`));
        const enforce = extractRunBlock(gate, 'Enforce shard and docs results');
        const runGate = env => spawnSync('bash', ['-e', '-c', enforce], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, COVERAGE_RESULT: 'success', ...env },
        });
        const selfHosted = { ROUTE: 'self-hosted', SHARD_RESULT: 'success', DOCS_RESULT: 'success', ELECTRON_RESULT: 'success' };
        const hosted = { ROUTE: 'hosted', SHARD_RESULT: 'success', DOCS_RESULT: 'success', ELECTRON_RESULT: 'skipped' };
        assert.equal(runGate(selfHosted).status, 0);
        assert.equal(runGate(hosted).status, 0);
        for (const [env, message] of [
            [{ ...selfHosted, SHARD_RESULT: 'failure' }, /shards finished with result 'failure'/],
            [{ ...selfHosted, SHARD_RESULT: 'cancelled' }, /shards finished with result 'cancelled'/],
            [{ ...selfHosted, SHARD_RESULT: 'skipped' }, /shards finished with result 'skipped'/],
            [{ ...selfHosted, DOCS_RESULT: 'skipped' }, /docs validation finished with result 'skipped'/],
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
        assert.ok(validate.includes(`\n    ${ROUTED_RUNS_ON}\n`));
        assert.equal(validate.split('./scripts/ci-install-chromium.sh').length - 1, 2);
        const toolContainers = validate.match(/docker run [^\n]*\n[^\n]*\n/g);
        assert.equal(toolContainers.length, 2);
        for (const container of toolContainers) {
            assert.match(container, /--rm/);
            assert.match(container, /--network none --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256/, 'tool containers run outside the runner cgroup, so they carry their own limits');
        }
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
        for (const [name, block] of selfHostedJobs()) {
            assert.doesNotMatch(block, /--with-deps/, name);
        }
    });
});
