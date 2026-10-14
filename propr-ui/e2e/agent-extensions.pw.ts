import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

test('instance extension editor shows capability boundaries, immutable provenance and write-only authentication', async ({ page }) => {
  await installSettingsFixture(page);
  const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289'; const profileId = '5b14d6d6-9357-4b56-9eb3-31e5f921d125';
  const profile = {
    version: 1, instanceId, profileId, revision: 3, name: 'Documentation assistant', enabled: true,
    agentScope: ['claude-main', 'codex-main'], repositoryScope: ['example/docs'],
    mcpServers: [{ kind: 'https', name: 'documentation', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search', 'read_document'], capability: 'read', authentication: 'bearer' }],
    skillBundleIds: ['075bb20e-4156-4f6c-a7e2-20fd6c8ba84e'],
    secrets: { documentation: { fields: ['bearerToken'], configured: true } },
    skillBundles: [{ id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId, name: 'documentation-review', digest: 'd853bea9e15d14bc3881f84dd19a2cb940624fda943e677e6b6ac9cc31ff1009', files: 3, bytes: 8120, requirements: ['documentation.search'], source: { kind: 'github', repository: 'example/skills', commit: 'd66d0ad62a789374f81f7e1c4f5dbcc43319e1a6', directory: 'skills/documentation-review' }, createdAt: 1791907200000, auditActor: '1' }],
    createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1',
  };
  await page.route('**/api/instance/extensions/v1**', route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { revisions: [profile] } });
    if (url.pathname.endsWith('/validate')) return route.fulfill({ json: { results: [{ name: 'documentation', reachable: true, status: 'reachable' }, { name: 'operator-documentation', reachable: null, status: 'not_validated' }] } });
    if (request.method() === 'POST') {
      expect(request.headers()['x-propr-extensions']).toBe('1');
      return route.fulfill({ json: { profile: { ...profile, ...request.postDataJSON().input, revision: 4 } } });
    }
    return route.fulfill({ json: { instanceId, profiles: [profile], catalog: [{ id: 'operator-documentation', digest: 'a'.repeat(64), tools: ['lookup', 'update_document'], capability: 'write', secrets: { count: 1, configured: true } }] } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=integrations');
  const section = page.getByRole('region', { name: 'Agent extensions', exact: true });
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Edit profile' }).click();
  await expect(section.getByText('Capability and security boundary')).toBeVisible();
  await expect(section.getByText(/Codex profile runs use/)).toContainText('--ignore-user-config');
  await expect(section.getByText(/Codex profile runs use/)).toContainText('CODEX_HOME/config.toml');
  await expect(section.getByText(/Codex profile runs use/)).toContainText('.codex/config.toml');
  const password = section.getByLabel(/Replace bearer token/);
  await expect(password).toHaveValue('');
  await expect(section.getByText('(configured; write-only)', { exact: true })).toBeVisible();
  await expect(section.getByText(/SHA-256 d853bea/)).toBeVisible();
  await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
  await expect(section.getByRole('status')).toHaveText('documentation: reachable · operator-documentation: not validated');
  await section.getByRole('button', { name: 'Revision history' }).click();
  await expect(section.getByText(/Revision 3.*administrator 1/)).toBeVisible();
  await section.getByLabel('Add operator catalog entry').selectOption('operator-documentation');
  await expect(section.getByText('Operator catalog entry: operator-documentation')).toBeVisible();
  await expect(section.getByText('Operator secrets: configured', { exact: true })).toBeVisible();
  const catalogServer = section.getByText('Operator catalog entry: operator-documentation').locator('..').locator('..').locator('..');
  await expect(catalogServer.getByLabel('lookup', { exact: true })).toBeChecked();
  await expect(catalogServer.getByLabel('update_document', { exact: true })).toBeChecked();
  await expect(catalogServer.getByLabel(/^Capability/)).toHaveValue('write');
  await expect(catalogServer.getByLabel(/^Capability/)).toBeDisabled();
  await catalogServer.getByLabel('update_document', { exact: true }).uncheck();
  const saveRequest = page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/instance/extensions/v1'));
  await section.getByRole('button', { name: 'Save revision' }).click();
  const descriptor = (await saveRequest).postDataJSON().input.mcpServers[1];
  expect(descriptor).toEqual({ kind: 'catalog', name: 'server-2', catalogId: 'operator-documentation', digest: 'a'.repeat(64), enabled: true, tools: ['lookup'], capability: 'write' });
  await expect(section.getByRole('status')).toHaveText('Profile revision saved.');
  expect(await section.textContent()).not.toMatch(/API_KEY|OPERATOR_DOCS_KEY|UNMISTAKABLE|CATALOG_ARGUMENT_SENTINEL|CATALOG_PATH_SENTINEL|\/usr\/bin\/env/);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.setViewportSize({ width: 1280, height: 1900 });
    await section.scrollIntoViewIfNeeded();
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
    await expect(section.getByRole('status')).toContainText('operator-documentation: not validated');
    await section.getByRole('status').screenshot({ path: path.join(directory, 'extension-validation-status.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-validation-status.png', title: 'Catalog validation status', description: 'Saved MCP validation distinguishes catalog entries that have not been validated from unavailable endpoints.' },
    ], toolSuggestions: [] }));
  }
});


test('New Task makes write authority an explicit per-run choice and resets it on reselection', async ({ page }) => {
  await installSettingsFixture(page);
  const selection = { instanceId: 'c63a25da-fd5e-4a46-8fe1-566136e12289', profileId: '5b14d6d6-9357-4b56-9eb3-31e5f921d125', revision: 3 };
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [{ id: 'claude', kind: 'direct', alias: 'claude', enabled: true, supportedModels: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5' }], repositories: [{ name: 'example/docs', enabled: true }] } }));
  await page.route('**/api/instance/extensions/v1', route => route.fulfill({ json: { profiles: [{ ...selection, name: 'Documentation tools', enabled: true }] } }));
  await page.goto('/tasks/new');
  await page.getByRole('button', { name: 'Select a repository' }).click();
  await page.getByRole('button', { name: 'example/docs' }).click();
  await page.getByLabel('Prompt').fill('Review and update the selected documentation.');
  await page.getByLabel('Agent extension profile').selectOption(selection.profileId);
  const grant = page.getByLabel('Allow selected MCP write capabilities for this run');
  await expect(grant).not.toBeChecked();
  await grant.check(); await expect(grant).toBeChecked();
  await page.getByLabel('Agent extension profile').selectOption(''); await expect(grant).toHaveCount(0);
  await page.getByLabel('Agent extension profile').selectOption(selection.profileId); await expect(grant).not.toBeChecked();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await page.getByRole('dialog', { name: 'New task' }).screenshot({ path: path.join(directory, 'extension-write-grant.png'), animations: 'disabled' });
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    manifest.previews.push({ path: '.propr/previews/extension-write-grant.png', title: 'Explicit write grant', description: 'Selected extension profile with write capability opt-in unchecked by default and reset on reselection.' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
});


test('extension profile configuration uses selections and keeps unlisted values editable', async ({ page }) => {
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
    agents: [{ alias: 'claude-main', enabled: true, supportedModels: [] }, { alias: 'codex-main', enabled: true, supportedModels: [] }],
    repositories: [{ name: 'example/docs', enabled: true }, { name: 'example/app', enabled: true }],
  } }));
  const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289';
  const bundle = { id: '075bb20e-4156-4f6c-a7e2-20fd6c8ba84e', instanceId, name: 'Documentation review', digest: 'd'.repeat(64), files: 3, bytes: 8120, requirements: [], source: { kind: 'archive', filename: 'review.tar.gz' }, createdAt: 1791907200000, auditActor: '1' };
  const profile = {
    version: 1, instanceId, profileId: '5b14d6d6-9357-4b56-9eb3-31e5f921d125', revision: 1,
    name: 'Documentation assistant', enabled: true, agentScope: ['claude-main', 'retired-agent'], repositoryScope: ['example/docs'],
    mcpServers: [{ kind: 'https', name: 'docs', url: 'https://tools.example.com/mcp', enabled: true, tools: ['search', 'read_document'], capability: 'read', authentication: 'none' }],
    skillBundleIds: [bundle.id], skillBundles: [bundle], secrets: {}, createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1',
  };
  let saved: typeof profile;
  await page.route('**/api/instance/extensions/v1**', route => {
    if (route.request().method() === 'POST') {
      saved = { ...profile, ...route.request().postDataJSON().input };
      return route.fulfill({ json: { profile: saved } });
    }
    return route.fulfill({ json: { profiles: [profile], catalog: [] } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=integrations');
  const section = page.getByRole('region', { name: 'Agent extensions', exact: true });
  await section.getByRole('button', { name: 'Edit profile' }).click();
  await expect(section.getByLabel('retired-agent', { exact: true })).toBeChecked();
  await section.getByLabel('retired-agent', { exact: true }).uncheck();
  await section.getByLabel('codex-main', { exact: true }).check();
  await section.getByLabel('example/app', { exact: true }).check();
  await section.getByLabel('read_document', { exact: true }).uncheck();
  await section.getByRole('button', { name: 'Save revision' }).click();
  await expect(section.getByRole('status')).toHaveText('Profile revision saved.');
  expect(saved!.agentScope).toEqual(['claude-main', 'codex-main']);
  expect(saved!.repositoryScope).toEqual(['example/docs', 'example/app']);
  expect(saved!.mcpServers[0].tools).toEqual(['search']);
  await section.getByRole('button', { name: 'New profile' }).click();
  await section.getByLabel('Profile name', { exact: true }).fill('Selected tools and skills');
  await section.getByLabel('claude-main', { exact: true }).check();
  await section.getByLabel('example/docs', { exact: true }).check();
  await section.getByLabel('Add an existing validated skill').selectOption(bundle.id);
  await expect(section.getByText('Documentation review · 3 files · 8120 bytes')).toBeVisible();
  await expect(section.getByLabel('Add an existing validated skill')).toBeDisabled();
  await section.getByRole('button', { name: 'Add HTTPS server' }).click();
  await section.getByLabel('Use a saved HTTPS endpoint').selectOption('https://tools.example.com/mcp');
  await expect(section.getByLabel('search', { exact: true })).not.toBeChecked();
  await section.getByLabel('search', { exact: true }).check();
  const tools = section.getByRole('group', { name: 'Allowed tools', exact: true });
  await tools.getByText('Advanced: add an unlisted item', { exact: true }).click();
  await tools.getByLabel('Unlisted allowed tools item').fill('read_document');
  await tools.getByRole('button', { name: 'Add item' }).click();
  await expect(section.getByLabel('read_document', { exact: true })).toBeChecked();
  await tools.getByText('Advanced: add an unlisted item', { exact: true }).click();
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  await section.getByLabel('Repository', { exact: true }).selectOption('example/docs');
  await expect(section.getByLabel('Repository', { exact: true })).toHaveValue('example/docs');
  await section.getByText('Import from an authorized GitHub repository', { exact: true }).click();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    const scopes = section.getByRole('group', { name: 'Agents', exact: true }).locator('..');
    await scopes.screenshot({ path: path.join(directory, 'extension-scope-selections.png'), animations: 'disabled' });
    await tools.screenshot({ path: path.join(directory, 'extension-tool-selections.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/extension-scope-selections.png', title: 'Select profile scope', description: 'Agent and repository scopes can be configured with checkboxes, with manual entry available under Advanced.' },
      { path: '.propr/previews/extension-tool-selections.png', title: 'Select allowed tools', description: 'Known HTTPS tool names can be selected with checkboxes rather than entered as a comma-separated list.' },
    ], toolSuggestions: [] }));
  }
  await section.getByRole('button', { name: 'Save revision' }).click();
  await expect(section.getByRole('status')).toHaveText('Profile revision saved.');
  expect(saved!.skillBundleIds).toEqual([bundle.id]);
  expect(saved!.mcpServers[0].tools).toEqual(['search', 'read_document']);
});
