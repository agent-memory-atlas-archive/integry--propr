#!/usr/bin/env node

// Runs the full-suite shards concurrently on one self-hosted runner worker.
//
//   node scripts/run-local-shards.mjs run --source DIR --work-root DIR --output DIR
//   node scripts/run-local-shards.mjs cleanup --source DIR --work-root DIR
//
// Each shard gets its own copy of the prepared checkout (node_modules and
// build output included), its own HOME/TMPDIR, its own Redis container and its
// own output directory. Files still run sequentially inside a shard through
// scripts/run-test-suite.mjs. Output per shard matches the hosted matrix
// artifacts: summary.json, stages.json and test_output.sanitized.txt.
//
// Every child carries PROPR_LOCAL_SHARD_OWNER so `cleanup` (run from an
// always() step, including on cancellation) can kill exactly this run's
// processes and Redis containers and nothing else on the shared host.

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeCiOutputFile } from './sanitize-ci-output.mjs';

export const MAX_LOCAL_CONCURRENCY = 4;
const WORK_ROOT_MARKER = '.propr-local-shards';
const TERMINATION_GRACE_MS = 5_000;
const SHARD_STAGES = ['Workspace copy', 'Redis startup', 'Test shard'];
// Job-scoped GitHub files and redaction secrets must not reach test code, and
// a shard must never inherit another shard's (or the job's) Redis or shard
// settings.
const JOB_ONLY_ENVIRONMENT = [
    /^GITHUB_(?:ENV|OUTPUT|PATH|STATE|STEP_SUMMARY)$/,
    /^ACTIONS_(?:RUNTIME|ID_TOKEN_REQUEST|CACHE)_/,
    /_TO_REDACT$/,
];
const STRIPPED_ENVIRONMENT = [
    ...JOB_ONLY_ENVIRONMENT,
    /^REDIS_/,
    /^PROPR_TEST_/,
    /^CI_REDIS_/,
    /^PROPR_LOCAL_SHARD_/,
    /^LOCAL_SHARD_/,
];

function withoutEnvironment(env, patterns) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !patterns.some(pattern => pattern.test(key))));
}

function positiveInteger(value, name) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return Number(value);
}

export function parseArguments(argv, env = process.env) {
    const [command, ...rest] = argv;
    if (command !== 'run' && command !== 'cleanup') {
        throw new Error('Usage: run-local-shards.mjs run|cleanup --source DIR --work-root DIR [--output DIR]');
    }
    const options = {};
    for (const argument of rest) {
        const match = /^--(source|work-root|output|concurrency)=(.+)$/.exec(argument);
        if (!match) throw new Error(`Unknown or malformed option ${argument}`);
        options[match[1]] = match[2];
    }
    for (const required of command === 'run' ? ['source', 'work-root', 'output'] : ['source', 'work-root']) {
        if (!options[required]) throw new Error(`--${required} is required`);
    }
    for (const name of ['source', 'work-root', 'output']) {
        if (options[name] !== undefined && !isAbsolute(options[name])) {
            throw new Error(`--${name} must be an absolute path`);
        }
    }
    const shardCount = positiveInteger(env.PROPR_TEST_SHARD_COUNT, 'PROPR_TEST_SHARD_COUNT');
    const concurrency = options.concurrency === undefined
        ? Math.min(shardCount, MAX_LOCAL_CONCURRENCY)
        : positiveInteger(options.concurrency, '--concurrency');
    if (concurrency > MAX_LOCAL_CONCURRENCY) {
        throw new Error(`--concurrency must not exceed ${MAX_LOCAL_CONCURRENCY} on the shared host, got ${concurrency}`);
    }
    const sourceDir = resolve(options.source);
    const workRoot = resolve(options['work-root']);
    const outputDir = options.output === undefined ? undefined : resolve(options.output);
    for (const [name, directory] of [['--work-root', workRoot], ['--output', outputDir]]) {
        if (directory === undefined) continue;
        const nested = relative(sourceDir, directory);
        if (nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))) {
            // Copying the checkout would otherwise copy other shards' state.
            throw new Error(`${name} must be outside the source checkout`);
        }
    }
    return { command, sourceDir, workRoot, outputDir, shardCount, concurrency };
}

export function ownerKey(env = process.env) {
    const part = (value, fallback) => String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, '-');
    return `${part(env.GITHUB_RUN_ID, 'local')}-${part(env.GITHUB_RUN_ATTEMPT, '1')}-${part(env.GITHUB_JOB, 'job')}`;
}

export function shardOwner(env, shard) {
    return `${ownerKey(env)}:shard-${shard}`;
}

export function shardPaths(workRoot, outputDir, shard) {
    const root = join(workRoot, `shard-${shard}`);
    return {
        root,
        workspace: join(root, 'workspace'),
        home: join(root, 'home'),
        tmp: join(root, 'tmp'),
        redisEnv: join(root, 'redis.env'),
        rawOutput: join(root, 'test_output.txt'),
        output: outputDir === undefined ? undefined : join(outputDir, `shard-${shard}`),
    };
}

export function buildShardEnvironment({ baseEnv, paths, shard, shardCount, redis }) {
    return {
        ...withoutEnvironment(baseEnv, STRIPPED_ENVIRONMENT),
        HOME: paths.home,
        TMPDIR: paths.tmp,
        TMP: paths.tmp,
        TEMP: paths.tmp,
        XDG_CONFIG_HOME: join(paths.home, '.config'),
        XDG_CACHE_HOME: join(paths.home, '.cache'),
        XDG_DATA_HOME: join(paths.home, '.local', 'share'),
        XDG_STATE_HOME: join(paths.home, '.local', 'state'),
        npm_config_cache: join(paths.home, '.npm'),
        NODE_ENV: 'test',
        PROPR_TEST_SHARD_INDEX: String(shard),
        PROPR_TEST_SHARD_COUNT: String(shardCount),
        PROPR_TEST_SUMMARY_FILE: join(paths.output, 'summary.json'),
        PROPR_LOCAL_SHARD_OWNER: shardOwner(baseEnv, shard),
        ...redis,
    };
}

export function parseEnvFile(content) {
    const values = {};
    for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        const separator = line.indexOf('=');
        if (separator <= 0) throw new Error(`Malformed Redis environment line: ${JSON.stringify(line)}`);
        values[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return values;
}

function redisEnvironment(baseEnv, workRoot, shard, extra = {}) {
    const env = withoutEnvironment(baseEnv, [...JOB_ONLY_ENVIRONMENT, /^CI_REDIS_/, /^REDIS_/]);
    if (baseEnv.CI_REDIS_IMAGE) env.CI_REDIS_IMAGE = baseEnv.CI_REDIS_IMAGE;
    return {
        ...env,
        CI_REDIS_INSTANCE: `shard-${shard}`,
        CI_REDIS_STATE_DIR: join(workRoot, 'redis-state'),
        ...extra,
    };
}

// Resolves with { status, signal, error } when the command exits. Anything
// the command left running in its own process group is killed then, so a
// finished shard cannot leak servers into later shards or jobs.
function runProcess(command, args, options, track) {
    return new Promise((resolveProcess) => {
        let child;
        try {
            child = spawn(command, args, { ...options, detached: true });
        } catch (error) {
            resolveProcess({ status: null, signal: null, error });
            return;
        }
        track?.(child, true);
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            signalGroup(child, 'SIGKILL');
            track?.(child, false);
            resolveProcess(result);
        };
        child.once('error', error => finish({ status: null, signal: null, error }));
        child.once('close', (status, signal) => finish({ status, signal, error: null }));
    });
}

function signalGroup(child, signal) {
    if (!child.pid) return;
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
    }
}

function describeFailure(result) {
    if (result.error) return result.error.message;
    if (result.signal) return `terminated by ${result.signal}`;
    return `exit ${result.status}`;
}

export function formatCoordinatorReport(report) {
    const lines = [
        `### Self-hosted full suite: ${report.shards.filter(shard => shard.status === 'passed').length}/${report.shards.length} shards passed in ${(report.durationMs / 1000).toFixed(1)}s`,
        '',
        `Runner: \`${report.runnerName}\` · concurrency ${report.concurrency}`,
        '',
        '| Shard | Status | Wall time | Units | Failed stage |',
        '| ---: | --- | ---: | ---: | --- |',
    ];
    for (const shard of report.shards) {
        const failedStage = Object.entries(shard.stages).find(([, outcome]) => outcome !== 'success')?.[0] ?? '';
        lines.push(`| ${shard.shard}/${report.shards.length} | ${shard.status} | ${(shard.durationMs / 1000).toFixed(1)}s | ${shard.units ?? '-'} | ${failedStage} |`);
    }
    return `${lines.join('\n')}\n`;
}

export async function runLocalShards({
    sourceDir,
    workRoot,
    outputDir,
    shardCount,
    concurrency,
    env = process.env,
    redisScript = join(sourceDir, 'scripts', 'ci-redis.sh'),
    suiteCommand = ['npm', ['run', 'test:full:prepared']],
    copyCommand = (source, destination) => ['cp', ['-a', '--reflink=auto', `${source}/.`, destination]],
    log = message => console.log(message),
    terminationGraceMs = TERMINATION_GRACE_MS,
}) {
    if (concurrency < 1 || concurrency > MAX_LOCAL_CONCURRENCY) {
        throw new Error(`Concurrency must be between 1 and ${MAX_LOCAL_CONCURRENCY}`);
    }
    if (!existsSync(join(sourceDir, 'node_modules'))) {
        throw new Error(`${sourceDir} has no node_modules; install and build it before starting shards`);
    }
    if (existsSync(workRoot) && readdirSync(workRoot).length > 0) {
        throw new Error(`${workRoot} already exists and is not empty`);
    }
    mkdirSync(join(workRoot, 'redis-state'), { recursive: true });
    writeFileSync(join(workRoot, WORK_ROOT_MARKER), `${ownerKey(env)}\n`);
    mkdirSync(outputDir, { recursive: true });

    const active = new Set();
    let cancelled = null;
    let killTimer = null;
    const track = (child, running) => {
        if (running) active.add(child);
        else active.delete(child);
        if (running && cancelled) signalGroup(child, 'SIGTERM');
    };
    const cancel = (signal) => {
        if (cancelled) return;
        cancelled = signal;
        log(`Received ${signal}; stopping every running shard.`);
        for (const child of active) signalGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => {
            for (const child of active) signalGroup(child, 'SIGKILL');
        }, terminationGraceMs);
    };
    const onSigint = () => cancel('SIGINT');
    const onSigterm = () => cancel('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const startedAt = Date.now();
    const runShard = async (shard) => {
        const paths = shardPaths(workRoot, outputDir, shard);
        const stages = Object.fromEntries(SHARD_STAGES.map(stage => [stage, 'skipped']));
        const shardStartedAt = Date.now();
        let failure = null;
        let redisStarted = false;
        mkdirSync(paths.output, { recursive: true });
        const record = (stage, result) => {
            stages[stage] = cancelled ? 'cancelled' : result.status === 0 && !result.signal && !result.error ? 'success' : 'failure';
            if (stages[stage] !== 'success' && !failure) failure = `${stage}: ${cancelled ? `cancelled by ${cancelled}` : describeFailure(result)}`;
            return stages[stage] === 'success';
        };

        try {
            if (cancelled) return;
            for (const directory of [paths.workspace, paths.home, paths.tmp]) mkdirSync(directory, { recursive: true });
            const [copy, copyArgs] = copyCommand(sourceDir, paths.workspace);
            log(`[shard ${shard}] copying the prepared checkout into ${paths.workspace}`);
            if (!record('Workspace copy', await runProcess(copy, copyArgs, { stdio: 'inherit' }, track))) return;

            if (cancelled) return;
            redisStarted = true;
            const redisResult = await runProcess('bash', [redisScript, 'start'], {
                cwd: paths.workspace,
                env: redisEnvironment(env, workRoot, shard, { CI_REDIS_ENV_FILE: paths.redisEnv }),
                stdio: 'inherit',
            }, track);
            if (!record('Redis startup', redisResult)) return;
            const redis = parseEnvFile(readFileSync(paths.redisEnv, 'utf8'));
            for (const key of ['REDIS_HOST', 'REDIS_PORT', 'PROPR_TEST_REDIS_ISOLATION']) {
                if (!redis[key]) throw new Error(`Redis startup for shard ${shard} did not report ${key}`);
            }

            if (cancelled) return;
            const shardEnv = buildShardEnvironment({ baseEnv: env, paths, shard, shardCount, redis });
            log(`[shard ${shard}] running shard ${shard}/${shardCount} (Redis ${redis.REDIS_HOST}:${redis.REDIS_PORT})`);
            const outputFd = openSync(paths.rawOutput, 'w');
            try {
                const [command, args] = suiteCommand;
                record('Test shard', await runProcess(command, args, {
                    cwd: paths.workspace,
                    env: shardEnv,
                    stdio: ['ignore', outputFd, outputFd],
                }, track));
            } finally {
                closeSync(outputFd);
            }
        } catch (error) {
            const stage = SHARD_STAGES.find(name => stages[name] === 'skipped') ?? 'Test shard';
            stages[stage] = 'failure';
            failure ??= `${stage}: ${error.message}`;
        } finally {
            if (redisStarted) {
                // Stop is scoped to this shard's instance; it cannot match another
                // shard's container.
                const stopResult = await runProcess('bash', [redisScript, 'stop'], {
                    cwd: sourceDir,
                    env: redisEnvironment(env, workRoot, shard),
                    stdio: 'inherit',
                });
                if (stopResult.status !== 0) log(`[shard ${shard}] Redis stop failed: ${describeFailure(stopResult)}`);
            }
            for (const stage of SHARD_STAGES) {
                if (cancelled && stages[stage] === 'skipped') stages[stage] = 'cancelled';
            }
            sanitizeCiOutputFile(paths.rawOutput, join(paths.output, 'test_output.sanitized.txt'), env);
            rmSync(paths.rawOutput, { force: true });
            writeFileSync(join(paths.output, 'stages.json'), `${JSON.stringify({
                shard,
                runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
                stages,
            }, null, 2)}\n`);
            // Free disk as soon as the shard finishes; its outputs live elsewhere.
            rmSync(paths.workspace, { recursive: true, force: true });
        }
        let units;
        try {
            units = JSON.parse(readFileSync(join(paths.output, 'summary.json'), 'utf8')).results?.length;
        } catch {}
        const passed = SHARD_STAGES.every(stage => stages[stage] === 'success');
        const status = passed ? 'passed' : cancelled ? 'cancelled' : 'failed';
        log(`[shard ${shard}] ${status} in ${((Date.now() - shardStartedAt) / 1000).toFixed(1)}s${failure ? ` (${failure})` : ''}`);
        return { shard, status, stages, durationMs: Date.now() - shardStartedAt, units, failure };
    };

    const results = new Array(shardCount);
    let next = 1;
    const worker = async () => {
        while (next <= shardCount) {
            const shard = next;
            next += 1;
            results[shard - 1] = await runShard(shard);
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(concurrency, shardCount) }, worker));
    } finally {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        if (killTimer) clearTimeout(killTimer);
    }

    const report = {
        schemaVersion: 1,
        runnerName: env.RUNNER_NAME || 'local',
        concurrency,
        durationMs: Date.now() - startedAt,
        cancelled,
        shards: results.map((result, index) => result ?? {
            shard: index + 1,
            status: 'cancelled',
            stages: Object.fromEntries(SHARD_STAGES.map(stage => [stage, 'cancelled'])),
            durationMs: 0,
        }),
    };
    writeFileSync(join(outputDir, 'coordinator.json'), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = formatCoordinatorReport(report);
    log(`\n${markdown}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);

    if (cancelled) return cancelled === 'SIGINT' ? 130 : 143;
    return report.shards.every(shard => shard.status === 'passed') ? 0 : 1;
}

// Kills processes whose environment carries this run's owner marker. Scanning
// /proc also catches daemons a test detached from its shard's process group.
export function findOwnedProcesses(owner, procRoot = '/proc') {
    if (!existsSync(procRoot)) return [];
    const needle = `PROPR_LOCAL_SHARD_OWNER=${owner}:shard-`;
    const owned = [];
    for (const entry of readdirSync(procRoot)) {
        if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
        let environ;
        try {
            environ = readFileSync(join(procRoot, entry, 'environ'), 'latin1');
        } catch {
            continue;
        }
        if (environ.split('\0').some(variable => variable.startsWith(needle))) owned.push(Number(entry));
    }
    return owned;
}

export async function cleanupLocalShards({
    sourceDir,
    workRoot,
    shardCount,
    env = process.env,
    redisScript = join(sourceDir, 'scripts', 'ci-redis.sh'),
    procRoot = '/proc',
    log = message => console.log(message),
}) {
    const owner = ownerKey(env);
    let problems = 0;
    for (const pid of findOwnedProcesses(owner, procRoot)) {
        try {
            process.kill(pid, 'SIGKILL');
            log(`Killed leftover shard process ${pid}`);
        } catch (error) {
            if (error?.code !== 'ESRCH') {
                problems += 1;
                log(`Could not kill ${pid}: ${error.message}`);
            }
        }
    }
    if (existsSync(join(workRoot, 'redis-state'))) {
        for (let shard = 1; shard <= shardCount; shard += 1) {
            const result = await runProcess('bash', [redisScript, 'stop'], {
                cwd: sourceDir,
                env: redisEnvironment(env, workRoot, shard),
                stdio: 'inherit',
            });
            if (result.status !== 0) {
                problems += 1;
                log(`Redis stop for shard ${shard} failed: ${describeFailure(result)}`);
            }
        }
    }
    const marker = join(workRoot, WORK_ROOT_MARKER);
    if (existsSync(marker)) {
        if (readFileSync(marker, 'utf8').trim() !== owner) {
            log(`Refusing to remove ${workRoot}: it belongs to another run`);
            return 1;
        }
        rmSync(workRoot, { recursive: true, force: true });
    }
    return problems === 0 ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const options = parseArguments(argv, env);
    if (options.command === 'cleanup') return cleanupLocalShards({ ...options, env });
    return runLocalShards({ ...options, env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
        .then(exitCode => { process.exitCode = exitCode; })
        .catch(error => {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        });
}
