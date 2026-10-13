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
    return route.fulfill({ json: { instanceId, profiles: [profile] } });
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=integrations');
  const section = page.getByRole('region', { name: 'Agent extensions', exact: true });
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Edit profile' }).click();
  await expect(section.getByText('Capability and security boundary')).toBeVisible();
  const password = section.getByLabel(/Replace bearer token/);
  await expect(password).toHaveValue('');
  await expect(section.getByText(/SHA-256 d853bea/)).toBeVisible();
  await section.getByRole('button', { name: 'Validate saved MCP connectivity' }).click();
  await expect(section.getByRole('status')).toHaveText('documentation: reachable');
  await section.getByRole('button', { name: 'Revision history' }).click();
  await expect(section.getByText(/Revision 3.*administrator 1/)).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.setViewportSize({ width: 1280, height: 1900 });
    await section.scrollIntoViewIfNeeded();
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await section.getByText('Capability and security boundary').locator('..').screenshot({ path: path.join(directory, 'agent-extensions-security.png'), animations: 'disabled' });
    await section.getByLabel('Stable server name').locator('..').locator('..').locator('..').screenshot({ path: path.join(directory, 'agent-extensions-mcp.png'), animations: 'disabled' });
    await section.getByText(/SHA-256 d853bea/).locator('..').screenshot({ path: path.join(directory, 'agent-extensions-skill.png'), animations: 'disabled' });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/agent-extensions-security.png', title: 'Extension security boundary', description: 'Supported runtime, transport and isolation limits in Instance Settings.' },
      { path: '.propr/previews/agent-extensions-mcp.png', title: 'MCP capability editor', description: 'HTTPS server with explicitly allowed tools and a blank write-only token replacement field.' },
      { path: '.propr/previews/agent-extensions-skill.png', title: 'Immutable skill provenance', description: 'Validated skill digest, exact Git commit and separately authorized requirements.' },
    ], toolSuggestions: [] }));
  }
});
