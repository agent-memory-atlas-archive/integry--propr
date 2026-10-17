/**
 * Shared vocabulary for the Agent Tank usage charts: the Analytics usage chart
 * and the sidebar's per-metric overlay read history through the same helpers so
 * a series has one identity, one label and one color wherever it is drawn.
 */

import { agentTankCyclePeriodMs } from '@propr/shared';
import type { AgentTankHistoryAgent, AgentTankHistorySeries } from '../../api/revertApi';
import { getProviderDisplayName, getProviderRank } from '../agentTankMetrics';
import { stripRemainingSuffix } from '../../utils/usageMetricLabels';

/**
 * Categorical slots in fixed order (validated: adjacent CVD ΔE ≥ 9.1, normal
 * vision ≥ 19.6 on the white surface). Aqua, yellow and magenta sit under 3:1
 * contrast, so every chart that uses them ships a legend with values and a
 * table view. A ninth series reuses no hue; callers fold it away instead.
 */
export const USAGE_SERIES_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

export const MAX_USAGE_SERIES = USAGE_SERIES_COLORS.length;

/** Stable identity of one agent's metric series. */
export function usageSeriesId(agent: string, key: string): string {
  return `${agent}:${key}`;
}

// Claude's and Codex's metric keys read better as the sidebar's short names.
const METRIC_LABELS: Record<string, string> = {
  session: 'Session',
  weeklyAll: 'Weekly',
  weeklyFable: 'Fable',
  weeklySonnet: 'Sonnet',
  weekly: 'Weekly',
  fiveHour: 'Session',
};

/** Short label of a series within its agent ("Session", "Gemini 4 Argon · Weekly"). */
export function usageMetricLabel(series: Pick<AgentTankHistorySeries, 'key' | 'label'>): string {
  if (METRIC_LABELS[series.key]) return METRIC_LABELS[series.key];
  return stripRemainingSuffix(series.label || series.key).replace(/\s+Limit$/i, '');
}

/** Full label naming the agent too ("Claude · Session"). */
export function usageSeriesLabel(agent: string, series: Pick<AgentTankHistorySeries, 'key' | 'label'>): string {
  return `${getProviderDisplayName(agent)} · ${usageMetricLabel(series)}`;
}

export interface FlatUsageSeries extends AgentTankHistorySeries {
  id: string;
  agent: string;
  displayLabel: string;
}

/** Every series of a history answer, flattened in provider order. */
export function flattenUsageHistory(agents: AgentTankHistoryAgent[]): FlatUsageSeries[] {
  return [...agents]
    .sort((a, b) => getProviderRank(a.agent) - getProviderRank(b.agent))
    .flatMap(entry => entry.series.map(series => ({
      ...series,
      id: usageSeriesId(entry.agent, series.key),
      agent: entry.agent,
      displayLabel: usageSeriesLabel(entry.agent, series),
    })));
}

/**
 * Colors keyed by series id, assigned from a stable ordering of every known id
 * (not of the visible ones), so hiding a series never repaints the others.
 */
export function assignUsageSeriesColors(ids: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  ids.forEach((id, index) => {
    if (index < USAGE_SERIES_COLORS.length) colors.set(id, USAGE_SERIES_COLORS[index]);
  });
  return colors;
}

/** The overlay's range: the last two periods of the metric's cycle, ending now. */
export function twoPeriodWindow(cycle: string | null | undefined, now: number = Date.now()): {
  since: number; until: number; periodMs: number;
} {
  const periodMs = agentTankCyclePeriodMs(cycle);
  return { since: now - 2 * periodMs, until: now, periodMs };
}
