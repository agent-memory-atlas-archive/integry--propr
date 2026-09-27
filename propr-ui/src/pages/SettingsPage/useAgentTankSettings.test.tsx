import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getAgentTankStatus: vi.fn(),
  updateAgentTankSettings: vi.fn(),
}));

vi.mock('../../api/revertApi', () => apiMocks);

import { useAgentTankSettings } from './useAgentTankSettings';

beforeEach(() => {
  apiMocks.getAgentTankStatus.mockReset().mockResolvedValue({ available: true });
  apiMocks.updateAgentTankSettings.mockReset().mockResolvedValue(undefined);
});

test('a rejected mode change is reported and the shown mode goes back to what is persisted', async () => {
  // An older backend cannot store bundled mode, so the client refuses the
  // write. Leaving "bundled" selected would claim a change that never happened.
  apiMocks.updateAgentTankSettings.mockRejectedValue(new Error('Backend too old'));
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: 'http://legacy:3456' }));

  await waitFor(() => expect(reportError).toHaveBeenCalledWith('Backend too old'));
  expect(result.current.settings.mode).toBe('external');
});

test('an accepted mode change sticks and clears any previous error', async () => {
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));

  await waitFor(() => expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledWith({ mode: 'bundled', url: '' }));
  expect(reportError).toHaveBeenCalledWith(null);
  expect(reportError).not.toHaveBeenCalledWith(expect.any(String));
  expect(result.current.settings.mode).toBe('bundled');
});

test('a slow bundled write cannot overtake a later "disabled" selection', async () => {
  // Turning tracking off is the write that must win: a bundled POST landing
  // after it would let usage requests start containers the operator declined.
  // The bundled write is held open the way the real compatibility GET holds it.
  const persisted: string[] = [];
  let releaseBundled = () => {};
  const bundledGate = new Promise<void>(resolve => { releaseBundled = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') await bundledGate;
    persisted.push(mode);
  });
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'disabled', enabled: false, url: '' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));
  act(() => result.current.change({ mode: 'disabled', enabled: false, url: '' }));

  // The queued "disabled" write must wait behind the bundled one rather than
  // racing ahead of it and being overwritten when it finally completes.
  expect(persisted).toEqual([]);
  await act(async () => { releaseBundled(); });

  await waitFor(() => expect(persisted).toEqual(['bundled', 'disabled']));
  expect(result.current.settings.mode).toBe('disabled');
});

test('an older failed write does not replace a newer successful selection', async () => {
  let releaseBundled = () => {};
  const bundledGate = new Promise<void>(resolve => { releaseBundled = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') { await bundledGate; throw new Error('Backend too old'); }
  });
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: 'http://legacy:3456' }));
  act(() => result.current.change({ mode: 'disabled', enabled: false, url: 'http://legacy:3456' }));
  await act(async () => { releaseBundled(); });

  await waitFor(() => expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledTimes(2));
  // The rollback belongs to the bundled selection, which the operator replaced;
  // restoring "external" would resurrect a mode nobody selected.
  expect(result.current.settings.mode).toBe('disabled');
  expect(reportError).not.toHaveBeenCalledWith('Backend too old');
});
