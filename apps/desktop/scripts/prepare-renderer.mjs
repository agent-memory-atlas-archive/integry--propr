#!/usr/bin/env node

// Build the workspace packages the desktop main process and renderer consume,
// at most once per identical source state.
//
// `prepare:renderer` is a pre-script of `package`, `typecheck`, `test`, `make`
// and `test:native-durability`, so a single packaging job ran these four `tsc`
// builds up to four times over byte-identical sources. This records a stamp
// keyed to the exact inputs and skips the rebuild only when that key still
// matches and every declared output is present.
//
// The key is content-derived, never a timestamp: it covers the source files of
// every built workspace (as git reports them, so generated and ignored output
// is excluded), the assets the CLI build copies in, the root manifest and
// lockfile, and the running toolchain. Any changed byte, a different Node
// major or a different platform/arch produces a different key and rebuilds.
//
// The stamp lives under node_modules/.cache, so `npm ci`, a clean checkout and
// the self-hosted `git clean -ffdxq` all discard it. It is never uploaded,
// downloaded or shared: reuse is confined to one job on one machine.
//
//   node scripts/prepare-renderer.mjs           reuse a matching build
//   node scripts/prepare-renderer.mjs --force   always rebuild

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_SCHEMA_VERSION = 1;
export const STAMP_PATH = join('node_modules', '.cache', 'propr', 'prepare-renderer.json');

// Built in dependency order. `outputs` are the files a later step actually
// loads, so a reused build is refused when any of them is missing.
export const RENDERER_WORKSPACES = [
    {
        name: '@propr/shared',
        directory: 'packages/shared',
        outputs: ['packages/shared/dist/index.js', 'packages/shared/dist/index.d.ts'],
    },
    {
        name: '@propr/local-setup',
        directory: 'packages/local-setup',
        outputs: ['packages/local-setup/dist/index.js', 'packages/local-setup/dist/index.d.ts'],
    },
    {
        name: '@propr/cli',
        directory: 'packages/cli',
        outputs: [
            'packages/cli/dist/index.js',
            'packages/cli/dist/index.d.ts',
            // Copied in by packages/cli/scripts/copy-assets.mjs, not by tsc.
            'packages/cli/dist/assets/env.example.txt',
            'packages/cli/dist/orchestrator/orchestrator.mjs',
            'packages/cli/dist/orchestrator/manifest.json',
            'packages/cli/dist/skill/propr/SKILL.md',
            'packages/cli/dist/native/prebuilds/darwin-arm64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/darwin-x64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/linux-arm64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/linux-x64/directory-operations.node',
        ],
    },
    {
        name: '@propr/client',
        directory: 'packages/client',
        outputs: ['packages/client/dist/index.js', 'packages/client/dist/index.d.ts'],
    },
];

// Everything the four builds read. `docker/launcher` and `.env.example` are
// copied into the CLI package at build time, so they are inputs too.
export const RENDERER_INPUT_PATHS = [
    ...RENDERER_WORKSPACES.map(workspace => workspace.directory),
    'docker/launcher',
    '.env.example',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
];

export function buildCommand(workspaceName, platform = process.platform) {
    return [platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', workspaceName]];
}

export function toolchainKey(runtime = process) {
    return {
        node: runtime.version,
        platform: runtime.platform,
        arch: runtime.arch,
    };
}

// tsc's incremental state is build output, not a build input, and it is
// rewritten by every build. Hashing it would tie the key to the previous
// build's bookkeeping instead of to the sources.
const DERIVED_FILE_PATTERN = /\.tsbuildinfo$/;

// git is the authority on what is source: `--cached --others --exclude-standard`
// lists tracked files plus new untracked ones while omitting every ignored
// path. That matters because the CLI build writes generated assets back into
// packages/cli/src; hashing those would change the key on every build and
// defeat reuse entirely.
export function listSourceFiles(root, paths = RENDERER_INPUT_PATHS, runGit = defaultGit) {
    const result = runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]);
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout
        .split('\0')
        .filter(entry => entry !== '' && !DERIVED_FILE_PATTERN.test(entry))
        .sort((a, b) => a.localeCompare(b));
}

function defaultGit(root, args) {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function computeInputKey(root, files, toolchain) {
    const digest = createHash('sha256');
    digest.update(`schema:${STAMP_SCHEMA_VERSION}\n`);
    digest.update(`toolchain:${JSON.stringify(toolchain)}\n`);
    digest.update(`workspaces:${RENDERER_WORKSPACES.map(workspace => workspace.name).join(',')}\n`);
    for (const file of files) {
        digest.update(`${file}\0`);
        digest.update(createHash('sha256').update(readFileSync(join(root, file))).digest());
        digest.update('\n');
    }
    return digest.digest('hex');
}

export function missingOutputs(root, workspaces = RENDERER_WORKSPACES) {
    return workspaces.flatMap(workspace => workspace.outputs).filter(output => !existsSync(join(root, output)));
}

export function readStamp(root) {
    try {
        const stamp = JSON.parse(readFileSync(join(root, STAMP_PATH), 'utf8'));
        return stamp?.schemaVersion === STAMP_SCHEMA_VERSION ? stamp : null;
    } catch {
        return null;
    }
}

function clearStamp(root) {
    rmSync(join(root, STAMP_PATH), { force: true });
}

function writeStamp(root, key, toolchain) {
    const path = join(root, STAMP_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schemaVersion: STAMP_SCHEMA_VERSION, key, toolchain }, null, 2)}\n`);
}

function defaultRun(root, workspaceName) {
    const [command, args] = buildCommand(workspaceName);
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1;
}

// Returns { reused, key, built }. Throws when a build fails, leaving no stamp
// behind, so a partially built tree can never be mistaken for a complete one.
export function prepareRenderer({
    root,
    force = false,
    run = defaultRun,
    log = console.log,
    runtime = process,
    listFiles = listSourceFiles,
} = {}) {
    const toolchain = toolchainKey(runtime);
    const files = listFiles(root);
    const key = files === null ? null : computeInputKey(root, files, toolchain);

    if (!force && key !== null) {
        const stamp = readStamp(root);
        const absent = missingOutputs(root);
        if (stamp?.key === key && absent.length === 0) {
            log(`prepare-renderer: reusing the build already made from these exact sources (${key.slice(0, 12)}).`);
            return { reused: true, key, built: [] };
        }
        if (stamp?.key === key && absent.length > 0) {
            log(`prepare-renderer: rebuilding, ${absent.length} declared output(s) are missing, first: ${absent[0]}.`);
        }
    } else if (key === null) {
        log('prepare-renderer: rebuilding, the source file list could not be determined.');
    }

    // Removed before the first build so an interrupted run cannot leave a
    // stamp that claims outputs which were never produced.
    clearStamp(root);

    const built = [];
    for (const workspace of RENDERER_WORKSPACES) {
        const status = run(root, workspace.name);
        if (status !== 0) {
            throw new Error(`prepare-renderer: building ${workspace.name} failed with exit code ${status}`);
        }
        built.push(workspace.name);
    }

    const absent = missingOutputs(root);
    if (absent.length > 0) {
        throw new Error(`prepare-renderer: expected build output is missing: ${absent.join(', ')}`);
    }
    if (key !== null) writeStamp(root, key, toolchain);
    return { reused: false, key, built };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    try {
        prepareRenderer({ root, force: process.argv.includes('--force') });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
