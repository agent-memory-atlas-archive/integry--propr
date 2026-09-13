import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('useLiveRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst and performs one trailing refresh for an in-flight invalidation', async () => {
    const first = deferred();
    const refresh = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveRefreshScheduler({ isConnected: true, refresh }));

    act(() => {
      result.current();
      result.current();
      result.current();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      result.current();
      result.current();
    });
    await act(async () => first.resolve());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does no hidden work, then coalesces visibility and focus recovery', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveRefreshScheduler({ isConnected: true, refresh }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      result.current();
      result.current();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refresh).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('recovers on reconnect and retains a disconnected polling fallback', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    let connected = false;
    const { rerender } = renderHook(() => useLiveRefreshScheduler({ isConnected: connected, refresh }));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });
    expect(refresh).toHaveBeenCalledOnce();

    connected = true;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
