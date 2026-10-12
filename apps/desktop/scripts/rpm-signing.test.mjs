import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { inspectSignedPreviewPayload } from './rpm-preview-payload.mjs';
import { requireRpmIdentity, rpmContentDigest, signRpm, verifyRpm } from './rpm-signing.mjs';
import { linuxPreviewTag, prepareLinuxPreview, readLinuxPreviewBundle, signLinuxPreviewBundle, stageLinuxPreviewDraft, publishLinuxPreviewDraft } from './linux-preview-release.mjs';
import { createDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tools = ['gpg', 'rpm', 'rpmsign', 'rpmkeys', 'rpmdb', 'rpmbuild', 'rpm2cpio', 'cpio', 'dpkg-deb'];
const missing = tools.filter(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
if (process.env.PROPR_REQUIRE_RPM_TESTS === '1' && missing.length) throw new Error(`Missing required RPM test tools: ${missing}`);
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function key(root, name) {
  const home = join(root, name);
  await mkdir(home, { mode: 0o700 });
  const args = ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0'];
  const passphrase = 'disposable-test-passphrase';
  run('gpg', [...args, '--quick-generate-key', `${name} <${name}@example.invalid>`, 'rsa2048', 'sign', '1d'], { input: passphrase });
  const listing = run('gpg', ['--homedir', home, '--with-colons', '--list-keys']);
  const fingerprint = listing.split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
  const publicKey = run('gpg', ['--homedir', home, '--armor', '--export', fingerprint]);
  const privateKey = run('gpg', [...args, '--armor', '--export-secret-keys', fingerprint], { input: passphrase });
  run('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
  return { identity: { fingerprint, publicKey }, privateKey, passphrase };
}

// Real format fixtures: ELF architecture headers, canonical layout, source-pinned
// native addons, runtime binding and sandbox metadata, with no executable launch.
async function packages(root, arch, manifest) {
  const build = join(root, arch);
  const tree = join(build, 'tree');
  const app = join(tree, 'usr/lib/propr-desktop');
  const resources = join(app, 'resources');
  const native = `.vite/native/prebuilds/linux-${arch}/directory-operations.node`;
  await mkdir(join(resources, 'app.asar.unpacked', dirname(native)), { recursive: true });
  await mkdir(join(tree, 'usr/bin'), { recursive: true });
  const elf = Buffer.alloc(128);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  await writeFile(join(app, 'propr-desktop'), elf, { mode: 0o755 });
  await writeFile(join(app, 'chrome-sandbox'), elf, { mode: 0o4755 });
  await chmod(join(app, 'chrome-sandbox'), 0o4755);
  await symlink('../lib/propr-desktop/propr-desktop', join(tree, 'usr/bin/propr-desktop'));
  await writeFile(join(resources, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(join(repositoryRoot, 'packages/cli/native/prebuilds', `linux-${arch}`, 'directory-operations.node'),
    join(resources, 'app.asar.unpacked', native));
  await chmod(join(resources, 'app.asar.unpacked', native), 0o644);
  await mkdir(join(tree, 'DEBIAN'));
  await writeFile(join(tree, 'DEBIAN/control'), `Package: propr-desktop\nVersion: 1.2.3\nArchitecture: ${arch === 'x64' ? 'amd64' : 'arm64'}\nMaintainer: Test <test@example.invalid>\nDescription: Disposable signing test\n`);
  const deb = join(build, 'fixture.deb');
  run('dpkg-deb', ['--build', '--root-owner-group', tree, deb]);
  const rpmArch = arch === 'x64' ? 'x86_64' : 'aarch64';
  const spec = join(build, 'fixture.spec');
  await writeFile(spec, `Name: propr-desktop
Version: 1.2.3
Release: 1
Summary: Disposable signing test
License: MIT
AutoReqProv: no
%description
Disposable signing test
%install
mkdir -p %{buildroot}
cp -a ${tree}/usr %{buildroot}/
%files
%defattr(-,root,root,-)
/usr/bin/propr-desktop
/usr/lib/propr-desktop
%attr(4755,root,root) /usr/lib/propr-desktop/chrome-sandbox
`);
  run('rpmbuild', ['-bb', '--target', rpmArch, '--define', `_topdir ${build}`, '--define', '__os_install_post %{nil}', spec]);
  return { deb, rpm: join(build, 'RPMS', rpmArch, `propr-desktop-1.2.3-1.${rpmArch}.rpm`) };
}

// In-memory GitHub transport exercises the production retry/download/publication
// paths with real signed RPM bytes. No network or release credentials are used.
function github(sourceRevision) {
  const state = { release: undefined, assets: [], publications: 0 };
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  state.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/repos/integry/propr', '');
    const method = options.method || 'GET';
    if (path.startsWith('/git/ref/tags/')) return new Response('', { status: 404 });
    if (path.startsWith('/commits/')) return json({ sha: sourceRevision });
    if (path === '/releases' && method === 'GET') return json(state.release ? [state.release] : []);
    if (path === '/releases' && method === 'POST') {
      state.release = { ...JSON.parse(options.body), id: 7, published_at: null,
        upload_url: 'https://uploads.github.com/releases/7/assets{?name,label}' };
      return json(state.release);
    }
    if (parsed.hostname === 'uploads.github.com') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const asset = { id: state.assets.length + 1, name: parsed.searchParams.get('name'),
        state: 'uploaded', size: bytes.length, digest: `sha256:${sha256(bytes)}`, bytes };
      asset.url = `https://api.github.com/assets/${asset.id}`;
      state.assets.push(asset);
      return json(asset);
    }
    if (path === '/releases/7/assets') return json(state.assets);
    if (path.startsWith('/assets/')) return new Response(state.assets.find(a => a.url === url).bytes);
    if (path === '/releases/7' && method === 'PATCH') {
      const change = JSON.parse(options.body);
      assert.deepEqual(change, { draft: false, prerelease: true, make_latest: 'false' });
      state.publications++;
      Object.assign(state.release, change, { published_at: new Date().toISOString() });
    }
    if (path === '/releases/7') return json(state.release);
    throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
  };
  return state;
}

test('signed mode requires exact public identity inputs', async () => {
  for (const identity of [undefined, {}, { fingerprint: 'A'.repeat(16), publicKey: 'x' },
    { fingerprint: 'a'.repeat(40), publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----' },
    { fingerprint: 'A'.repeat(40), publicKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----' }]) {
    assert.throws(() => requireRpmIdentity(identity), /exact uppercase OpenPGP fingerprint/);
    await assert.rejects(verifyRpm({ path: '/unused', identity }), /exact uppercase OpenPGP fingerprint/);
  }
});

test('real RPM signatures and signed preview bundles fail closed and preserve frozen payloads', {
  skip: missing.length ? `Missing tools: ${missing.join(', ')}` : false,
  timeout: 180_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const correct = await key(root, 'correct');
  const wrong = await key(root, 'wrong');
  const sourceRevision = '1'.repeat(40);
  const version = '1.2.3';
  const repository = 'integry/propr';
  const runtimeAppImage = `propr/app:${sourceRevision}@sha256:${'a'.repeat(64)}`;
  const runtimeUiImage = `propr/ui:${sourceRevision}@sha256:${'b'.repeat(64)}`;
  const runtimeAgentImage = `propr/agent:${sourceRevision}@sha256:${'c'.repeat(64)}`;
  const runtime = createDesktopRuntimeManifest({}, { sourceRevision, distribution: 'published',
    appImage: runtimeAppImage, uiImage: runtimeUiImage, agentImage: runtimeAgentImage, apiCompatibility: '2026-06-27' });
  const input = join(root, 'input');
  await mkdir(input);
  const artifacts = [];
  for (const arch of ['x64', 'arm64']) {
    const built = await packages(root, arch, runtime);
    for (const kind of ['deb', 'rpm']) {
      const fileName = `ProPR-Desktop-${version}-linux-${arch}.${kind}`;
      const bytes = await readFile(built[kind]);
      await copyFile(built[kind], join(input, fileName));
      artifacts.push({ platform: 'linux', arch, kind, fileName, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  artifacts.sort((a, b) => a.fileName.localeCompare(b.fileName));
  await writeFile(join(input, 'desktop-release.json'), JSON.stringify({ releaseProfile: 'linux-preview-v1', version, channel: 'validation', artifacts }));
  await writeFile(join(input, 'SHA256SUMS'), artifacts.map(a => `${a.sha256}  ${a.fileName}\n`).join(''));
  const directory = join(root, 'unsigned');
  const options = { version, sourceRevision, repository };
  await prepareLinuxPreview({ ...options, inputDirectory: input, outputDirectory: directory,
    runtimeAppImage, runtimeUiImage, runtimeAgentImage, workflowRunId: '123' });
  const unsignedRpm = join(directory, artifacts.find(a => a.kind === 'rpm').fileName);
  await assert.rejects(verifyRpm({ path: unsignedRpm, identity: correct.identity }), /signatures/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, passphrase: '' }), /passphrase/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, passphrase: 'wrong-password' }), /tool failed/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, identity: wrong.identity }), /private key/);
  await assert.rejects(verifyRpm({ path: unsignedRpm,
    identity: { ...correct.identity, fingerprint: wrong.identity.fingerprint } }), /pinned/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory, rpmIdentity: correct.identity }), /schema/);

  const signed = join(root, 'signed');
  const manifest = await signLinuxPreviewBundle({ ...options, directory, outputDirectory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot, ...correct });
  assert.equal(manifest.tag, `${linuxPreviewTag(version, sourceRevision)}-rpm-signed`);
  assert.equal(manifest.trust, 'rpm-signed-preview');
  const bundle = await readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot });
  assert.equal(bundle.assets.size, 7);
  assert.match(bundle.notes, /sudo zypper install/);
  assert.match(bundle.notes, /NOKEY/);
  assert.match(bundle.notes, /Standalone DEBs are not authenticated by RPM signatures/);
  assert.doesNotMatch(bundle.notes, /--allow-unsigned-rpm|--nogpgcheck|--no-gpg-checks/);
  const publicPath = join(root, 'public.asc');
  await writeFile(publicPath, correct.identity.publicKey);
  const cli = ['apps/desktop/scripts/rpm-signing.mjs', 'verify', '--rpm',
    join(signed, manifest.artifacts.find(a => a.kind === 'rpm').fileName),
    '--public-key', publicPath, '--fingerprint', correct.identity.fingerprint];
  assert.match(run(process.execPath, cli, { cwd: repositoryRoot }), /header and package signatures verified/);

  const inspected = manifest.artifacts.find(a => a.kind === 'rpm');
  await assert.rejects(inspectSignedPreviewPayload({ path: join(signed, inspected.fileName), artifact: inspected,
    manifest: { ...manifest, runtime: { ...manifest.runtime, appImage: `propr/app:${sourceRevision}@sha256:${'d'.repeat(64)}` } },
    sourceDirectory: repositoryRoot }), /runtime digests/);
  const alteredSource = join(root, 'altered-source');
  const nativePath = `packages/cli/native/prebuilds/linux-${inspected.arch}/directory-operations.node`;
  await mkdir(dirname(join(alteredSource, nativePath)), { recursive: true });
  await mkdir(join(alteredSource, 'packages/cli/src/utils'), { recursive: true });
  await copyFile(join(repositoryRoot, 'packages/cli/src/utils/directoryDescriptor.ts'), join(alteredSource, 'packages/cli/src/utils/directoryDescriptor.ts'));
  await writeFile(join(alteredSource, nativePath), 'wrong native bytes');
  await assert.rejects(inspectSignedPreviewPayload({ path: join(signed, inspected.fileName), artifact: inspected,
    manifest, sourceDirectory: alteredSource }), /native addon/);

  for (const artifact of manifest.artifacts) {
    const original = join(directory, artifact.fileName);
    const final = join(signed, artifact.fileName);
    if (artifact.kind === 'deb') assert.deepEqual(await readFile(final), await readFile(original));
    else {
      assert.notEqual(sha256(await readFile(final)), sha256(await readFile(original)));
      assert.equal(await rpmContentDigest(final), await rpmContentDigest(original));
      await verifyRpm({ path: final, identity: correct.identity });
      await assert.rejects(verifyRpm({ path: final, identity: wrong.identity }), /failed|signatures/);
    }
  }
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed }), /schema/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: wrong.identity, sourceDirectory: repositoryRoot }), /identity/);
  const remote = github(sourceRevision);
  const publication = { ...options, directory: signed, rpmIdentity: correct.identity,
    sourceDirectory: repositoryRoot, token: 'disposable-test-token', fetchImpl: remote.fetchImpl };
  await stageLinuxPreviewDraft(publication);
  await stageLinuxPreviewDraft(publication); // exact-byte upload retry
  const remoteRpm = remote.assets.find(a => a.name.endsWith('.rpm'));
  const originalRemote = { ...remoteRpm };
  remoteRpm.bytes = await readFile(join(directory, remoteRpm.name));
  remoteRpm.size = remoteRpm.bytes.length;
  remoteRpm.digest = `sha256:${sha256(remoteRpm.bytes)}`;
  await assert.rejects(stageLinuxPreviewDraft(publication), /metadata mismatch|digest mismatch/);
  await assert.rejects(publishLinuxPreviewDraft(publication), /metadata mismatch|digest mismatch/);
  assert.equal(remote.publications, 0);
  Object.assign(remoteRpm, originalRemote);
  await publishLinuxPreviewDraft(publication);
  assert.equal(remote.publications, 1);

  const target = manifest.artifacts.find(a => a.kind === 'rpm');
  const path = join(signed, target.fileName);
  const bytes = await readFile(path);
  const changedHeader = Buffer.from(bytes);
  const headerText = changedHeader.indexOf('Disposable signing test');
  assert.ok(headerText > 112);
  changedHeader[headerText] ^= 1;
  await writeFile(path, changedHeader);
  await assert.rejects(verifyRpm({ path, identity: correct.identity }), /failed|signatures/);
  bytes[bytes.length - 10] ^= 0xff;
  await writeFile(path, bytes);
  await assert.rejects(verifyRpm({ path, identity: correct.identity }), /failed|signatures/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot }), /digest mismatch/);

  // Even coherently rehashed unsigned substitution must fail cryptographic checks.
  await copyFile(join(directory, target.fileName), path);
  target.sha256 = sha256(await readFile(path));
  target.size = (await readFile(path)).length;
  await writeFile(join(signed, 'linux-preview.json'), JSON.stringify(manifest));
  const names = [...manifest.artifacts.map(a => a.fileName), 'INSTALL.md', 'linux-preview.json'].sort();
  await writeFile(join(signed, 'SHA256SUMS'), (await Promise.all(names.map(async name =>
    `${sha256(await readFile(join(signed, name)))}  ${name}\n`))).join(''));
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot }), /signatures/);
});
