import { useEffect, useState } from 'react';
import { getAgentTankHistory, type AgentTankHistorySeries } from '../../api/revertApi';
import { twoPeriodWindow } from './usageHistoryModel';

/** Re-hovering a row within this long reuses the answer instead of refetching. */
const CACHE_TTL_MS = 60_000;

interface CachedHistory {
  fetchedAt: number;
  since: number;
  until: number;
  series: AgentTankHistorySeries | null;
  enabled: boolean;
}

const cache = new Map<string, CachedHistory>();

/** Set once the backend reports history is off, so rows stop offering it. */
let historyDisabled = false;

export function isUsageHistoryDisabled(): boolean {
  return historyDisabled;
}

/** Test-only seam. */
export function resetUsageMetricHistoryCache(): void {
  cache.clear();
  historyDisabled = false;
}

export type UsageMetricHistoryState =
  | { status: 'loading'; since: number; until: number; periodMs: number }
  | { status: 'error'; since: number; until: number; periodMs: number; message: string }
  | { status: 'ready'; since: number; until: number; periodMs: number; series: AgentTankHistorySeries | null; enabled: boolean };

/**
 * One metric's history over its last two periods, read when `active` turns on.
 * The request is aborted if the overlay closes first.
 */
export function useUsageMetricHistory(
  agent: string,
  historyKey: string,
  cycle: string | undefined,
  active: boolean,
): UsageMetricHistoryState | null {
  const [state, setState] = useState<UsageMetricHistoryState | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const { since, until, periodMs } = twoPeriodWindow(cycle);
    const cacheKey = `${agent}\u0000${historyKey}`;
    const cached = cache.get(cacheKey);
    if (cached && until - cached.fetchedAt < CACHE_TTL_MS) {
      setState({ status: 'ready', since: cached.since, until: cached.until, periodMs, series: cached.series, enabled: cached.enabled });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading', since, until, periodMs });
    getAgentTankHistory({ since, until, agents: [agent], metric: historyKey, signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const series = response.agents
          .find(entry => entry.agent === agent)?.series
          .find(entry => entry.key === historyKey) ?? null;
        if (!response.enabled) historyDisabled = true;
        cache.set(cacheKey, { fetchedAt: until, since, until, series, enabled: response.enabled });
        setState({ status: 'ready', since, until, periodMs, series, enabled: response.enabled });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error', since, until, periodMs,
          message: error instanceof Error && error.message ? error.message : 'Could not load usage history',
        });
      });
    return () => controller.abort();
  }, [agent, historyKey, cycle, active]);

  return active ? state : null;
}
