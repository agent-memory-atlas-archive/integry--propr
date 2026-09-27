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
