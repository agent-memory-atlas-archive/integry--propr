import { z } from 'zod';

export const EXTENSION_PROFILE_VERSION = 1 as const;
export const EXTENSION_LIMITS = { servers: 8, tools: 64, bundles: 8, files: 256, bytes: 4 * 1024 * 1024, archiveBytes: 5 * 1024 * 1024, responseBytes: 1024 * 1024, calls: 256, egressBytes: 16 * 1024 * 1024, timeoutMs: 10_000 } as const;
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).refine(v => v !== 'propr', 'Reserved server name');
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const extensionSelectionSchema = z.strictObject({ instanceId: z.uuid(), profileId: z.uuid(), revision: z.number().int().positive() });
export type ExtensionSelection = z.infer<typeof extensionSelectionSchema>;
export const remoteMcpSchema = z.strictObject({
  kind: z.literal('https'), name, url: z.string().max(2048), enabled: z.boolean(),
  tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(EXTENSION_LIMITS.tools),
  capability: z.enum(['read', 'write']), authentication: z.enum(['none', 'bearer']),
});
export type ExtensionMcpDescriptor = z.infer<typeof remoteMcpSchema>;
export const extensionProfileInputSchema = z.strictObject({
  version: z.literal(EXTENSION_PROFILE_VERSION), name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  agentScope: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(64),
  repositoryScope: z.array(repository).max(64),
  mcpServers: z.array(remoteMcpSchema).max(EXTENSION_LIMITS.servers),
  skillBundleIds: z.array(z.uuid()).max(EXTENSION_LIMITS.bundles),
}).superRefine((v, ctx) => {
  if (new Set(v.mcpServers.map(s => s.name)).size !== v.mcpServers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate server names' });
  if (new Set(v.skillBundleIds).size !== v.skillBundleIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate bundles' });
});
export type ExtensionProfileInput = z.infer<typeof extensionProfileInputSchema>;
export interface ExtensionSkillBundle {
  id: string; instanceId: string; digest: string; name: string; files: number; bytes: number;
  source: { kind: 'archive'; filename: string } | { kind: 'github'; repository: string; commit: string; directory: string };
  requirements: string[]; createdAt: number; auditActor: string;
}
export interface ExtensionProfileRevision extends ExtensionSelection, ExtensionProfileInput {
  createdAt: number; updatedAt: number; auditActor: string;
  secrets: Record<string, { fields: ['bearerToken']; configured: boolean }>;
  skillBundles: ExtensionSkillBundle[];
}
export const EXTENSION_PROFILE_CONTRACT = {
  version: EXTENSION_PROFILE_VERSION, limits: EXTENSION_LIMITS, runtimes: ['claude', 'codex'],
  transports: ['https'], localStdio: 'unsupported: operator catalog runner required',
  skills: ['tar', 'tar.gz', 'github-exact-commit'], permission: 'instance.manage_settings',
} as const;
