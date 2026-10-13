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
    if (url.pathname.endsWith('/validate')) return route.fulfill({ json: { results: [{ name: 'documentation', reachable: true }] } });
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
  await expect(section.getByText(/SHA-256 d853bea/)).toBeVisible();
  await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
  await expect(section.getByRole('status')).toHaveText('documentation: reachable');
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
    await section.getByText('Capability and security boundary').locator('..').screenshot({ path: path.join(directory, 'agent-extensions-codex-boundary.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/agent-extensions-codex-boundary.png', title: 'Codex extension limitations', description: 'Editor boundary note explains ignored user provider configuration and refusal of repository Codex configuration.' },
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
