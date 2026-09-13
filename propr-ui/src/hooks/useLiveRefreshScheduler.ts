import { useCallback, useEffect, useRef } from 'react';

interface LiveRefreshSchedulerOptions {
  isConnected: boolean;
  refresh: () => void | Promise<void>;
  coalesceMs?: number;
  fallbackPollMs?: number;
}

/**
 * Coalesces live invalidations, serializes refreshes, and lets hidden tabs
 * recover once when visible. While the socket is down, a bounded visible-tab
 * poll remains as a freshness fallback.
 */
export function useLiveRefreshScheduler({
  isConnected,
  refresh,
  coalesceMs = 100,
  fallbackPollMs = 30_000,
}: LiveRefreshSchedulerOptions): () => void {
  const documentIsHidden = () => document.visibilityState === 'hidden';
  const mountedRef = useRef(true);
  const connectedRef = useRef(isConnected);
  const refreshRef = useRef(refresh);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const previousConnectedRef = useRef<boolean | null>(null);
  connectedRef.current = isConnected;
  refreshRef.current = refresh;

  const schedule = useCallback(() => {
    pendingRef.current = true;
    if (documentIsHidden() || timerRef.current !== null || inFlightRef.current) return;
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      if (!mountedRef.current || !pendingRef.current || documentIsHidden()) return;
      pendingRef.current = false;
      inFlightRef.current = true;
      try {
        await refreshRef.current();
      } catch (error) {
        console.error('Live refresh failed:', error);
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current && pendingRef.current && !documentIsHidden()) schedule();
      }
    }, coalesceMs);
  }, [coalesceMs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (previous === false && isConnected) schedule();
  }, [isConnected, schedule]);

  useEffect(() => {
    const recoverVisible = () => {
      if (!documentIsHidden()) schedule();
    };
    const fallback = window.setInterval(() => {
      if (!connectedRef.current && !documentIsHidden()) schedule();
    }, fallbackPollMs);
    document.addEventListener('visibilitychange', recoverVisible);
    window.addEventListener('focus', recoverVisible);
    return () => {
      window.clearInterval(fallback);
      document.removeEventListener('visibilitychange', recoverVisible);
      window.removeEventListener('focus', recoverVisible);
    };
  }, [fallbackPollMs, schedule]);

  return schedule;
}
