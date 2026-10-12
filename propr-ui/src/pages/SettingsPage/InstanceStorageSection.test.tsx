import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import InstanceStorageSection from './InstanceStorageSection';
import * as api from '../../api/instanceStorageApi';
vi.mock('../../api/instanceStorageApi', () => ({ storageCapabilities: vi.fn(), storageInventory: vi.fn(), storagePreview: vi.fn(), storageExecute: vi.fn(), startDatabaseExport: vi.fn(), databaseExportStatus: vi.fn(), downloadDatabaseExport: vi.fn(), cancelDatabaseExport: vi.fn(), verifyStorageActor: vi.fn() }));
const user = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_settings'] } as CurrentUser;
const capabilities = { version: 1 as const, instanceId: 'instance', generation: 'generation', features: ['repository_inventory', 'repository_cleanup', 'database_export'] as const };
const inventory = { version: 1 as const, instanceId: 'instance', state: 'partial' as const, observedAt: new Date().toISOString(), lastUseAt: null, repositories: [{ id: 'repo', name: 'example/project', category: 'repository_caches' as const, estimatedBytes: null, protectedReasons: [] }] };
const view = (actor = user) => <AuthProvider user={actor}><InstanceStorageSection /></AuthProvider>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.verifyStorageActor).mockResolvedValue(undefined);
  vi.mocked(api.storageCapabilities).mockResolvedValue({ ...capabilities, features: [...capabilities.features] });
  vi.mocked(api.storageInventory).mockResolvedValue(inventory);
  vi.mocked(api.storagePreview).mockResolvedValue({ version: 1, instanceId: 'instance', confirmation: 'confirmation', expiresAt: new Date(Date.now() + 60_000).toISOString(), categories: ['repository_caches'], candidates: inventory.repositories, impact: 'Caches will be refetched.' });
  vi.mocked(api.storageExecute).mockResolvedValue({ version: 1, instanceId: 'instance', operationId: 'confirmation', state: 'completed', deleted: ['repo'], retained: [] });
});
afterEach(cleanup);
describe('native instance storage', () => {
  it('hides controls for ordinary members even if repository access or stale permissions exist', () => {
    render(view({ ...user, role: 'member' }));
    expect(screen.queryByText('Instance data')).not.toBeInTheDocument();
    expect(api.storageCapabilities).not.toHaveBeenCalled();
  });
  it('shows self-hosted inventory with unknown sizes and requires explicit cleanup confirmation', async () => {
    render(view());
    expect(await screen.findByText('example/project')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm cleanup' });
    expect(confirm).toBeDisabled(); expect(api.storageExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    expect(await screen.findByText('Cleanup completed: 1 deleted, 0 retained.')).toBeInTheDocument();
    expect(api.storageExecute).toHaveBeenCalledTimes(1);
  });
  it('old/offline runtime clears authority without fabricating an empty inventory', async () => {
    vi.mocked(api.storageCapabilities).mockRejectedValue(new Error('Runtime unsupported'));
    render(view());
    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime unsupported');
    expect(screen.getByRole('button', { name: 'Create database export' })).toBeDisabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('server account switch clears a pending confirmation before execution', async () => {
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Preview cache cleanup' }));
    await screen.findByRole('button', { name: 'Confirm cleanup' });
    fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(api.verifyStorageActor).mockRejectedValue(new Error('Account changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cleanup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Account changed');
    expect(api.storageExecute).not.toHaveBeenCalled();
    expect(screen.queryByText('example/project')).not.toBeInTheDocument();
  });
  it('account change unmounts old results; a late inventory cannot repopulate them', async () => {
    let resolve!: (value: typeof inventory) => void;
    vi.mocked(api.storageInventory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const rendered = render(view());
    await waitFor(() => expect(api.storageInventory).toHaveBeenCalled());
    rendered.rerender(view({ ...user, id: 'member', role: 'member', permissions: [] }));
    resolve(inventory);
    await waitFor(() => expect(screen.queryByText('example/project')).not.toBeInTheDocument());
    expect(screen.queryByText('Instance data')).not.toBeInTheDocument();
  });
  it('creates an export without a Connect account and presents a server failure safely', async () => {
    vi.mocked(api.startDatabaseExport).mockResolvedValue({ version: 1, instanceId: 'instance', generation: 'generation', operationId: 'job', scope: 'customer_database', state: 'failed', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    render(view()); await screen.findByText('example/project');
    fireEvent.click(screen.getByRole('button', { name: 'Create database export' }));
    expect(await screen.findByText('Export failed; no download is available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download once' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard export' }));
    await waitFor(() => expect(api.cancelDatabaseExport).toHaveBeenCalled());
  });
});
