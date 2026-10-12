import { API_BASE_URL, apiFetch } from './apiClient';
import type { DatabaseExportStatus, RepositoryStorageInventory, StorageCapabilities, StorageCleanupPreview, StorageCleanupResult } from '@propr/shared';

const base = () => `${API_BASE_URL}/api/instance/storage/v1`;
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await apiFetch(base() + route, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Current instance administrator access is required.'
    : response.status === 404 ? 'This runtime does not support instance storage management.'
    : 'Storage operation unavailable or expired. Refresh and try again.');
  return response.json() as Promise<T>;
}
export const storageCapabilities = () => request<StorageCapabilities>('/capabilities');
export const storageInventory = () => request<RepositoryStorageInventory>('/repositories');
export const storagePreview = (instanceId: string) => request<StorageCleanupPreview>('/cleanup/preview', { instanceId, categories: ['repository_caches'] });
export const storageExecute = (preview: StorageCleanupPreview) => request<StorageCleanupResult>('/cleanup/execute', { instanceId: preview.instanceId, confirmation: preview.confirmation });
export const startDatabaseExport = (capabilities: StorageCapabilities) => request<DatabaseExportStatus>('/exports', { instanceId: capabilities.instanceId, generation: capabilities.generation });
export const databaseExportStatus = (job: DatabaseExportStatus) => request<DatabaseExportStatus>(`/exports/${encodeURIComponent(job.operationId)}?${new URLSearchParams({ instanceId: job.instanceId, generation: job.generation })}`);
export const cancelDatabaseExport = (job: DatabaseExportStatus) => request(`/exports/${encodeURIComponent(job.operationId)}/cancel`, { instanceId: job.instanceId, generation: job.generation });
export async function downloadDatabaseExport(job: DatabaseExportStatus): Promise<Blob> {
  const response = await apiFetch(base() + `/exports/${encodeURIComponent(job.operationId)}/download`, {
    method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' },
    body: JSON.stringify({ instanceId: job.instanceId, generation: job.generation }),
  });
  if (!response.ok) throw new Error('Download denied, expired or already used. Create a new export.');
  return response.blob();
}
/** Detect a changed browser account before displaying or redeeming sensitive results. */
export async function verifyStorageActor(actor: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/user`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Current instance administrator access is required.');
  const user = await response.json();
  if (user.id !== actor || user.role !== 'admin' || !user.permissions?.includes('instance.manage_settings')) throw new Error('Account or instance authority changed. Reload Settings.');
}
