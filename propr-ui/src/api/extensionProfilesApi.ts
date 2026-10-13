import type { ExtensionProfileInput, ExtensionProfileRevision, ExtensionSelection, ExtensionSkillBundle } from '@propr/shared';
import { API_BASE_URL, apiFetch } from './apiClient';
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}/api/instance/extensions/v1${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ProPR-Extensions': '1' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'A current durable instance administrator is required.' : response.status === 409 ? 'The profile changed. Refresh and select its current revision.' : 'Extension operation unavailable. Check the configuration and try again.');
  return response.json();
}
export const listExtensionProfiles = () => request<{ instanceId: string; profiles: ExtensionProfileRevision[] }>('');
export const saveExtensionProfile = (input: ExtensionProfileInput, secrets: Record<string, string | null>, expected?: ExtensionSelection) => request<{ profile: ExtensionProfileRevision }>('/profiles', { input, secrets, expected });
export const deleteExtensionProfile = (selection: ExtensionSelection) => request('/delete', { selection });
export const extensionProfileHistory = (profileId: string) => request<{ revisions: ExtensionProfileRevision[] }>(`/profiles/${encodeURIComponent(profileId)}/history`);
export const validateExtensionProfile = (selection: ExtensionSelection) => request<{ results: { name: string; reachable: boolean }[] }>('/validate', { selection });
export const importGithubSkill = (repository: string, commit: string, directory: string) => request<{ bundle: ExtensionSkillBundle }>('/skills/github', { repository, commit, directory });
export async function importArchiveSkill(file: File): Promise<{ bundle: ExtensionSkillBundle }> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Skill archives must be at most 5 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoded = ''; for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return request('/skills/archive', { filename: file.name, archive: btoa(encoded) });
}
