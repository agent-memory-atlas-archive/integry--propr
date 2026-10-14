import type { Request, RequestHandler } from 'express';
import { Octokit } from '@octokit/core';
import { db } from '@propr/core';
import { EXTENSION_PROFILE_CONTRACT, EXTENSION_LIMITS, type ExtensionSkillBundle } from '@propr/shared';
import { ExtensionError, ExtensionProfileStore } from '../../core/src/extensions/extensionProfileStore.js';
import { extensionGatewayCall } from '../../core/src/extensions/mcpGateway.js';
import { requestExtensionMcp } from '../../core/src/extensions/endpointPolicy.js';
import { readSkillArchive, skillPath, type SkillFile } from '../../core/src/extensions/skillBundles.js';
import { resolveGitHubMetadataToken, verifyGitHubRepositoryAccess } from '../githubMetadataAuth.js';

export function createExtensionProfileRoutes(store = new ExtensionProfileStore(db)) {
  const handle = (run: (req: Request, actor: string) => Promise<unknown>): RequestHandler => async (req, res) => {
    try {
      if (!req.user?.id) throw new ExtensionError(401, 'Authentication required');
      if (req.authorization?.role !== 'admin' || !req.authorization.permissions.includes('instance.manage_settings')) throw new ExtensionError(403, 'Instance settings administration is required');
      await store.authorize(req.user.id);
      if (req.method !== 'GET' && (req.get('X-ProPR-Extensions') !== '1' || !req.is('application/json'))) throw new ExtensionError(403, 'Extensions require the preflight-protected JSON contract');
      res.set('Cache-Control', 'no-store').json(await run(req, req.user.id));
    } catch (error) { res.status(error instanceof ExtensionError ? error.status : 400).json({ error: error instanceof ExtensionError ? error.message : 'Extension operation unavailable or invalid' }); }
  };
  const exact = (req: Request, keys: string[]) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => !keys.includes(k))) throw new ExtensionError(400, 'Invalid extension request');
  };
  return {
    list: handle(async (_req, actor) => ({ contract: EXTENSION_PROFILE_CONTRACT, instanceId: await store.instanceId(), profiles: await store.list(actor), bundles: await store.listSkillBundles(actor), catalog: await store.catalog.publicEntries() })),
    save: handle(async (req, actor) => { exact(req, ['input', 'secrets', 'expected']); return { profile: await store.save(actor, req.body.input, req.body.secrets, req.body.expected) }; }),
    history: handle(async (req, actor) => ({ revisions: await store.history(actor, String(req.params.profileId)) })),
    remove: handle(async (req, actor) => { exact(req, ['selection']); await store.delete(actor, req.body.selection); return { deleted: true }; }),
    validate: handle(async (req, actor) => {
      exact(req, ['selection']); const profile = await store.read(actor, req.body.selection);
      const row = await store.database('extension_profile_revisions').where({ profile_id: profile.profileId, revision: profile.revision }).first();
      const { unsealExtensionSecrets } = await import('../../core/src/extensions/privateSecrets.js');
      const secrets = row.secrets_encrypted === '' ? {} : unsealExtensionSecrets(row.secrets_encrypted, `${profile.instanceId}/${profile.profileId}/${profile.revision}`, store.environment);
      const results = [];
      for (const server of profile.mcpServers.filter(s => s.enabled)) {
        let reachable = false;
        if (server.kind === 'catalog') { results.push({ name: server.name, reachable: null, status: 'not_validated' }); continue; }
        try {
          const response = await requestExtensionMcp(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'propr-validation', version: '1' } } }, secrets[server.name]) as { result?: unknown };
          reachable = Boolean(response?.result);
        } catch { /* No response content or error from upstream is disclosed. */ }
        results.push({ name: server.name, reachable, status: reachable ? 'reachable' : 'unavailable' });
      }
      await store.authorize(actor); return { results };
    }),
    importArchive: handle(async (req, actor) => {
      exact(req, ['archive', 'filename']);
      if (typeof req.body.archive !== 'string' || req.body.archive.length > Math.ceil(EXTENSION_LIMITS.archiveBytes / 3) * 4 || typeof req.body.filename !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(req.body.filename)) throw new ExtensionError(400, 'Invalid skill archive');
      return { bundle: await store.importSkill(actor, readSkillArchive(Buffer.from(req.body.archive, 'base64')), { kind: 'archive', filename: req.body.filename }) };
    }),
    importGithub: handle(async (req, actor) => {
      exact(req, ['repository', 'commit', 'directory']);
      const { repository, commit, directory } = req.body;
      if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit) || typeof directory !== 'string') throw new ExtensionError(400, 'An authorized repository, exact commit and relative directory are required');
      skillPath(directory);
      const token = await resolveGitHubMetadataToken(req); await verifyGitHubRepositoryAccess(repository, token);
      const [owner, repo] = repository.split('/'); const github = new Octokit({ auth: token, request: { timeout: EXTENSION_LIMITS.timeoutMs } });
      const pinned = (await github.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: commit })).data;
      if (pinned.sha !== commit) throw new ExtensionError(400, 'Git source must resolve to the exact commit');
      const tree = (await github.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner, repo, tree_sha: pinned.tree.sha, recursive: '1' })).data;
      if (tree.truncated || tree.tree.length > 10_000) throw new ExtensionError(400, 'Repository tree is too large');
      const entries = tree.tree.filter(e => e.path?.startsWith(directory + '/') && e.type !== 'tree');
      if (!entries.length || entries.length > EXTENSION_LIMITS.files || entries.some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode ?? '') || !e.sha || (e.size ?? EXTENSION_LIMITS.bytes + 1) > EXTENSION_LIMITS.bytes) || entries.reduce((n, e) => n + (e.size ?? 0), 0) > EXTENSION_LIMITS.bytes) throw new ExtensionError(400, 'Repository skill bundle is invalid or oversized');
      const files: SkillFile[] = [];
      for (const entry of entries) {
        const blob = (await github.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner, repo, file_sha: entry.sha! })).data;
        if (blob.encoding !== 'base64') throw new ExtensionError(400, 'Invalid Git skill blob');
        files.push({ path: entry.path!.slice(directory.length + 1), content: blob.content.replace(/\s/g, '') });
      }
      return { bundle: await store.importSkill(actor, files, { kind: 'github', repository, commit, directory } satisfies ExtensionSkillBundle['source']) };
    }),
    gateway: (async (req, res) => {
      try {
        const token = req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        if (!token) throw new ExtensionError(401, 'Extension grant required');
        const result = await extensionGatewayCall(store, token, String(req.params.serverName), req.body);
        if (result === null) { res.status(202).end(); return; }
        res.set('Cache-Control', 'no-store').json(result);
      } catch (error) { res.status(error instanceof ExtensionError ? error.status : 502).json({ error: 'Extension MCP unavailable' }); }
    }) as RequestHandler,
  };
}
