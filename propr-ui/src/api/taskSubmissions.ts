import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
export interface TaskSubmission {
  id: string;
  state: 'prepared' | 'creating' | 'issue_created' | 'queued' | 'failed';
  issueNumber: number | null;
  issueUrl: string | null;
  taskId: string | null;
  error: string | null;
}
export interface TaskRequest {
  repository: string;
  instruction: string;
  agentAlias?: string;
  model?: string;
  todoIds?: string[];
}
async function request(path: string, options?: RequestInit): Promise<TaskSubmission> {
  const response = await apiFetch(`${API_BASE_URL}/api/task-submissions${path}`, { credentials: 'include', ...options });
  try { await handleApiResponse(response); }
  catch (error) { throw Object.assign(error as Error, { status: response.status }); }
  return response.json();
}
export async function submitTask(key: string, payload: TaskRequest, files: File[]): Promise<TaskSubmission> {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  files.forEach(file => form.append('files', file));
  return request('', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form });
}
export const getTaskSubmission = (key: string) => request(`/${encodeURIComponent(key)}`);
export const retryTaskSubmission = (key: string) => request(`/${encodeURIComponent(key)}/retry`, { method: 'POST' });

export interface TaskSnapshot { key: string; payload: TaskRequest; files: File[] }
/** Structured cloning preserves File bytes for lost-response/reload recovery. */
export async function taskSnapshotStorage(scope: string, value?: TaskSnapshot | null): Promise<TaskSnapshot | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('propr-task-launcher', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('submissions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('submissions', value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('submissions');
      const request = value === undefined ? store.get(scope) : value === null ? store.delete(scope) : store.put(value, scope);
      transaction.oncomplete = () => resolve(value === undefined ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
