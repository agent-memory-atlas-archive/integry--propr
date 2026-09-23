import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import {
    RENDERER_INPUT_PATHS,
    RENDERER_WORKSPACES,
    STAMP_PATH,
    buildCommand,
    computeInputKey,
    listSourceFiles,
    missingOutputs,
    prepareRenderer,
    readStamp,
    toolchainKey,
} from './prepare-renderer.mjs';

const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });

function write(root, relative, contents) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

// A repository double: one source file per built workspace, and the declared
// outputs produced by the fake builds rather than by tsc.
function createFixture() {
    const root = mkdtempSync(join(tmpdir(), 'propr-prepare-renderer-'));
    scratch.push(root);
    for (const workspace of RENDERER_WORKSPACES) write(root, `${workspace.directory}/src/index.ts`, `// ${workspace.name}\n`);
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
    const sources = () => [
        ...RENDERER_WORKSPACES.map(workspace => `${workspace.directory}/src/index.ts`),
        'package-lock.json',
        'package.json',
    ].sort((a, b) => a.localeCompare(b));
    const calls = [];
    const run = (buildRoot, name) => {
        calls.push(name);
        const workspace = RENDERER_WORKSPACES.find(candidate => candidate.name === name);
        for (const output of workspace.outputs) write(buildRoot, output, `built ${name}\n`);
        return 0;
    };
    return {
        root,
        calls,
        prepare: (overrides = {}) => prepareRenderer({
            root,
            run,
            log: () => {},
            listFiles: sources,
            ...overrides,
        }),
        sources,
    };
}

describe('desktop renderer preparation reuse', () => {
    test('builds every workspace in dependency order and records a stamp', () => {
        const fixture = createFixture();
        const result = fixture.prepare();

        assert.equal(result.reused, false);
        assert.deepEqual(fixture.calls, ['@propr/shared', '@propr/local-setup', '@propr/cli', '@propr/client']);
        assert.deepEqual(missingOutputs(fixture.root), []);
        assert.equal(readStamp(fixture.root).key, result.key);
        assert.deepEqual(readStamp(fixture.root).toolchain, toolchainKey());
    });

    test('reuses a build whose inputs and outputs are all unchanged', () => {
        const fixture = createFixture();
        const first = fixture.prepare();
        fixture.calls.length = 0;

        const second = fixture.prepare();
        assert.equal(second.reused, true);
        assert.equal(second.key, first.key);
        assert.deepEqual(fixture.calls, [], 'no workspace is rebuilt');
    });

    test('rebuilds when any source byte changes', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/src/index.ts', '// changed\n');
        const result = fixture.prepare();
        assert.equal(result.reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds when the lockfile changes even though no workspace source did', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
        assert.equal(fixture.prepare().reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds for a different toolchain', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        const result = fixture.prepare({ runtime: { version: 'v24.0.0', platform: process.platform, arch: process.arch } });
        assert.equal(result.reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds when a declared output is missing despite a matching stamp', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        rmSync(join(fixture.root, 'packages/cli/dist/skill/propr/SKILL.md'));
        assert.equal(fixture.prepare().reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.deepEqual(missingOutputs(fixture.root), []);
    });

    test('never reuses when the source list cannot be determined', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        const result = fixture.prepare({ listFiles: () => null });
        assert.equal(result.reused, false);
        assert.equal(result.key, null);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.equal(readStamp(fixture.root), null, 'an unkeyed build writes no stamp');
    });

    test('fails closed and leaves no stamp when a build fails', () => {
        const fixture = createFixture();
        fixture.prepare();
        assert.ok(existsSync(join(fixture.root, STAMP_PATH)));
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/src/index.ts', '// changed\n');
        assert.throws(() => fixture.prepare({
            run: (_root, name) => {
                fixture.calls.push(name);
                return name === '@propr/cli' ? 2 : 0;
            },
        }), /building @propr\/cli failed with exit code 2/);
        assert.deepEqual(fixture.calls, ['@propr/shared', '@propr/local-setup', '@propr/cli'], 'stops at the failure');
        assert.equal(readStamp(fixture.root), null);
        assert.ok(!existsSync(join(fixture.root, STAMP_PATH)));
    });

    test('fails closed when a build reports success without producing its outputs', () => {
        const fixture = createFixture();
        assert.throws(() => fixture.prepare({ run: () => 0 }), /expected build output is missing/);
        assert.equal(readStamp(fixture.root), null);
    });

    test('--force rebuilds an otherwise reusable tree', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        assert.equal(fixture.prepare({ force: true }).reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('keys the same inputs identically and different inputs differently', () => {
        const fixture = createFixture();
        const files = fixture.sources();
        const toolchain = toolchainKey();
        const key = computeInputKey(fixture.root, files, toolchain);

        assert.equal(computeInputKey(fixture.root, files, toolchain), key);
        assert.notEqual(computeInputKey(fixture.root, files, { ...toolchain, arch: 'other' }), key);
        write(fixture.root, 'packages/client/src/index.ts', '// different\n');
        assert.notEqual(computeInputKey(fixture.root, files, toolchain), key);
    });

    test('keeps the stamp inside node_modules so installs and clean checkouts discard it', () => {
        assert.match(STAMP_PATH.replaceAll('\\', '/'), /^node_modules\//);
    });

    test('runs the workspace build through npm on every platform', () => {
        assert.deepEqual(buildCommand('@propr/shared', 'linux'), ['npm', ['run', 'build', '-w', '@propr/shared']]);
        assert.deepEqual(buildCommand('@propr/shared', 'win32'), ['npm.cmd', ['run', 'build', '-w', '@propr/shared']]);
    });
});

describe('desktop renderer preparation inputs', () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));

    test('covers every built workspace plus the assets the CLI build copies in', () => {
        for (const workspace of RENDERER_WORKSPACES) assert.ok(RENDERER_INPUT_PATHS.includes(workspace.directory), workspace.name);
        for (const asset of ['docker/launcher', '.env.example', 'package.json', 'package-lock.json']) {
            assert.ok(RENDERER_INPUT_PATHS.includes(asset), asset);
        }
    });

    test('omits generated output that a build writes back into the source tree', () => {
        // packages/cli/scripts/copy-assets.mjs writes into packages/cli/src and
        // tsc leaves .tsbuildinfo beside each tsconfig. Including either would
        // change the key on every build and make reuse impossible.
        const files = listSourceFiles(repository);
        assert.ok(Array.isArray(files) && files.length > 0);
        for (const generated of [
            'packages/cli/src/orchestrator/orchestrator.mjs',
            'packages/cli/src/orchestrator/manifest.json',
            'packages/cli/src/assets/env.example.txt',
        ]) {
            assert.ok(!files.includes(generated), generated);
        }
        assert.ok(!files.some(file => file.endsWith('.tsbuildinfo')), 'no incremental build state');
        assert.ok(!files.some(file => file.includes('/dist/') || file.includes('node_modules/')));
        assert.ok(files.includes('packages/shared/package.json'));
        assert.ok(files.includes('docker/launcher/orchestrator.mjs'));
    });

    test('declares the packaged CLI assets the desktop build depends on', () => {
        const cli = RENDERER_WORKSPACES.find(workspace => workspace.name === '@propr/cli');
        assert.ok(cli.outputs.includes('packages/cli/dist/skill/propr/SKILL.md'));
        for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
            assert.ok(cli.outputs.includes(`packages/cli/dist/native/prebuilds/${target}/directory-operations.node`), target);
        }
    });

    test('matches the entry point each built workspace publishes', () => {
        for (const workspace of RENDERER_WORKSPACES) {
            const manifest = JSON.parse(readFileSync(join(repository, workspace.directory, 'package.json'), 'utf8'));
            assert.ok(workspace.outputs.includes(`${workspace.directory}/${manifest.main}`), workspace.name);
            assert.ok(workspace.outputs.includes(`${workspace.directory}/${manifest.types}`), workspace.name);
        }
    });
});
