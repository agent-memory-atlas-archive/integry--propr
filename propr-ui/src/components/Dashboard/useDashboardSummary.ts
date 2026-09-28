import { useCallback, useEffect, useRef, useState } from 'react';
import { getDashboardNarrative } from '../../api/dashboardApi';

const PAUSE_KEY = 'dashboard-summary-paused';
export const SUMMARY_COALESCE_MS = 300;

export function useDashboardSummary(repository: string, activityToken: number) {
  const [paused, setPaused] = useState(() => {
    try { return localStorage.getItem(PAUSE_KEY) === 'true'; } catch { return false; }
  });
  const [summary, setSummary] = useState<string | null>(null);
  // Wait for the enable flag before drawing anything, including a skeleton.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [available, setAvailable] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const controller = useRef<{ changed: () => void; schedule: () => void; refresh: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let dirty = true;
    let initial = true;
    let disabled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSummary(null);
    setEnabled(null);
    setLoading(false);
    setUpdatedAt(null);
    setAvailable(false);

    const visible = () => document.visibilityState === 'visible';
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const run = async (force = false) => {
      if (disposed || disabled || !visible() || inFlight) return;
      if (!force && !initial && pausedRef.current) return;
      clear();
      dirty = false;
      initial = false;
      inFlight = true;
      setLoading(true);
      try {
        const response = await getDashboardNarrative(repository, force);
        if (disposed) return;
        disabled = !response.enabled;
        setEnabled(response.enabled);
        setAvailable(response.enabled && response.summary !== null);
        // Unavailability/failure must not erase a previous successful summary.
        if (!response.enabled) {
          setSummary(null);
          setUpdatedAt(null);
        } else if (response.summary !== null) {
          setSummary(response.summary);
          // Receipt time of the latest successful read, including a cached response.
          setUpdatedAt(Date.now());
        }
      } catch {
        if (!disposed) {
          setEnabled(current => current ?? true);
          setAvailable(false);
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          schedule();
        }
      }
    };
    const schedule = () => {
      clear();
      if (disposed || disabled || inFlight || !dirty || !visible() || (!initial && pausedRef.current)) return;
      // Only a coalescing window after events; never recurring polling.
      timer = setTimeout(() => { void run(); }, SUMMARY_COALESCE_MS);
    };
    controller.current = {
      changed: () => { dirty = true; schedule(); },
      schedule,
      refresh: () => { void run(true); },
    };
    const visibilityChanged = () => { if (visible()) schedule(); else clear(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    void run();
    return () => {
      disposed = true;
      clear();
      controller.current = null;
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [repository]);

  const lastToken = useRef(activityToken);
  useEffect(() => {
    if (lastToken.current === activityToken) return;
    lastToken.current = activityToken;
    controller.current?.changed();
  }, [activityToken]);

  useEffect(() => {
    try { localStorage.setItem(PAUSE_KEY, String(paused)); } catch { /* Storage may be unavailable. */ }
    controller.current?.schedule();
  }, [paused]);

  const togglePaused = useCallback(() => setPaused(value => !value), []);
  const refresh = useCallback(() => controller.current?.refresh(), []);
  return { summary, enabled, loading, paused, updatedAt, available, togglePaused, refresh };
}
