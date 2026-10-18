import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankHistory, type AgentTankHistoryResponse } from '../../api/revertApi';
import AgentUsageHistory from './AgentUsageHistory';
import { USAGE_SERIES_COLORS } from '../usageHistory/usageHistoryModel';
import {
  UNPLOTTED_SERIES_COLOR,
  buildChartRows,
  parseUsageHistoryView,
  planPlottedSeries,
  toPlottedSeries,
  writeUsageHistoryView,
} from './usageHistoryView';

vi.mock('../../api/revertApi', () => ({ getAgentTankHistory: vi.fn() }));

const mockHistory = vi.mocked(getAgentTankHistory);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function series(key: string, label: string, percents: number[]) {
  const now = Date.now();
  return {
    key, label, model: null, cycle: 'session',
    points: percents.map((percent, index) => ({ t: new Date(now - (percents.length - index) * HOUR).toISOString(), percent })),
  };
}

const response = (): AgentTankHistoryResponse => ({
  enabled: true,
  source: 'propr',
  agents: [
    { agent: 'codex', series: [series('fiveHour', '5h limit', [3, 9, 12]), series('weekly', 'Weekly limit', [40, 41, 42])] },
    { agent: 'claude', series: [series('session', 'Current session', [10, 30, 17]), series('weeklyAll', 'Current week (all models)', [50, 55, 58])] },
    { agent: 'antigravity', series: [series('model:Gemini 4 Argon Weekly Limit', 'Gemini 4 Argon Weekly Limit', [20, 25, 30])] },
  ],
});

let location = '';
const LocationProbe = () => {
  location = useLocation().search;
  return null;
};

function renderPane(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/analytics${search}`]}>
      <AgentUsageHistory />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  mockHistory.mockReset();
  mockHistory.mockResolvedValue(response());
});

describe('AgentUsageHistory', () => {
  it('plots every agent and metric by default, over the last 7 days', async () => {
    renderPane();

    expect(await screen.findByTestId('agent-usage-history-chart')).toBeInTheDocument();
    const query = mockHistory.mock.calls[0][0];
    expect((query.until ?? 0) - query.since).toBe(7 * DAY);
    expect(query.agents).toBeUndefined();

    const filters = screen.getByRole('group', { name: 'Filter usage history' });
    // Providers in sidebar order, then one chip per series with its latest value.
    for (const name of ['Claude', 'Codex', 'Antigravity']) {
      expect(within(filters).getByRole('button', { name, pressed: true })).toBeInTheDocument();
    }
    expect(within(filters).getByRole('button', { name: /Claude · Session 17%/, pressed: true })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /Antigravity · Gemini 4 Argon Weekly 30%/ })).toBeInTheDocument();
  });

  it('hides an agent and a metric, and keeps the choice in the URL', async () => {
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    fireEvent.click(within(filters).getByRole('button', { name: 'Codex' }));
    expect(within(filters).queryByRole('button', { name: /Codex · Session/ })).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: /Claude · Weekly/ }));
    expect(within(filters).getByRole('button', { name: /Claude · Weekly/, pressed: false })).toBeInTheDocument();

    expect(new URLSearchParams(location).get('usageHideAgents')).toBe('codex');
    expect(new URLSearchParams(location).get('usageHide')).toBe('claude:weeklyAll');

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(location).toBe('');
  });

  it('reads a new range and restores filters from the URL', async () => {
    renderPane('?usageRange=24h&usageHide=claude:session');
    await screen.findByTestId('agent-usage-history-chart');
    expect((mockHistory.mock.calls[0][0].until ?? 0) - mockHistory.mock.calls[0][0].since).toBe(DAY);
    expect(screen.getByRole('button', { name: /Claude · Session/, pressed: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quota usage, last 14 days' }));
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    expect((mockHistory.mock.calls[1][0].until ?? 0) - mockHistory.mock.calls[1][0].since).toBe(14 * DAY);
  });

  it('offers the numbers as a table', async () => {
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Table' }));

    const table = screen.getByTestId('agent-usage-history-table');
    const row = within(table).getByRole('row', { name: /Claude · Session/ });
    expect(row).toHaveTextContent('17%');
    expect(row).toHaveTextContent('10%');
    expect(row).toHaveTextContent('30%');
  });

  it('names model-derived series by display name, keeping quota pool wording', async () => {
    mockHistory.mockResolvedValue({
      enabled: true,
      source: 'propr',
      agents: [
        {
          agent: 'antigravity',
          series: [
            series('model:gemini-2.5-pro', 'gemini-2.5-pro', [10, 20]),
            series('model:Claude and GPT · Weekly Limit Remaining', 'Claude and GPT · Weekly Limit Remaining', [5, 6]),
            series('model:Gemini 4 Argon Weekly Limit', 'Gemini 4 Argon Weekly Limit', [20, 30]),
          ],
        },
        { agent: 'codex', series: [{ ...series('gpt-5.3-codex:weekly', 'gpt-5.3-codex Weekly limit', [7, 8]), model: 'gpt-5.3-codex' }] },
      ],
    });
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    const gemini = within(filters).getByRole('button', { name: /^Antigravity · Gemini 2\.5 Pro 20%/ });
    expect(gemini).toHaveTextContent('Gemini 2.5 Pro');
    expect(gemini).toHaveAttribute('title', 'Gemini 2.5 Pro');
    const codex = within(filters).getByRole('button', { name: /^Codex · GPT-5\.3 Codex Weekly 8%/ });
    expect(codex).toHaveAttribute('title', 'GPT-5.3 Codex Weekly limit');
    expect(within(filters).getByRole('button', { name: /^Antigravity · Claude and GPT · Weekly 6%/ }))
      .toHaveAttribute('title', 'Claude and GPT · Weekly Limit');
    expect(within(filters).getByRole('button', { name: /^Antigravity · Gemini 4 Argon Weekly 30%/ })).toBeInTheDocument();
    expect(filters.innerHTML).not.toMatch(/gemini-2\.5-pro|gpt-5\.3-codex/);

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByTestId('agent-usage-history-table');
    expect(within(table).getByRole('row', { name: /Antigravity · Gemini 2\.5 Pro/ })).toBeInTheDocument();
    expect(table.innerHTML).not.toMatch(/gemini-2\.5-pro|gpt-5\.3-codex/);
  });

  it('renders nothing when Agent Tank is off or usage is not readable', async () => {
    mockHistory.mockResolvedValueOnce({ enabled: false, agents: [] });
    const { container, unmount } = renderPane();
    await waitFor(() => expect(container.querySelector('[data-testid="analytics-usage-history"]')).toBeNull());
    unmount();

    mockHistory.mockRejectedValueOnce(new Error('This action requires the instance.manage_agents permission'));
    const second = renderPane();
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.container.querySelector('[data-testid="analytics-usage-history"]')).toBeNull());
  });

  it('keeps metrics past the eight-line limit selectable and swaps them onto the chart', async () => {
    const many = Array.from({ length: 10 }, (_, index) => series(`model:Pool ${index + 1}`, `Pool ${index + 1}`, [index, index + 1]));
    mockHistory.mockResolvedValue({ enabled: true, source: 'propr', agents: [{ agent: 'antigravity', series: many }] });
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    // Every metric has a chip; the two past the palette are selected but not drawn.
    expect(within(filters).getAllByRole('button', { name: /Antigravity · Pool/ })).toHaveLength(10);
    expect(within(filters).getByRole('button', { name: /Pool 9 9%, not plotted/, pressed: true })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /Pool 10 10%, not plotted/, pressed: true })).toBeInTheDocument();
    expect(screen.getByText(/2 selected metrics are not plotted/)).toBeInTheDocument();

    // Hiding a drawn metric hands its line to the next selected one.
    fireEvent.click(within(filters).getByRole('button', { name: /Pool 1 1%/ }));
    expect(within(filters).getByRole('button', { name: /^Antigravity · Pool 9 9%$/, pressed: true })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /Pool 10 10%, not plotted/ })).toBeInTheDocument();
    expect(screen.getByText(/1 selected metric is not plotted/)).toBeInTheDocument();

    // The table lists every selected metric, drawn or not.
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByTestId('agent-usage-history-table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 9);
    expect(within(table).getByRole('row', { name: /Pool 10/ })).toHaveTextContent('10%');
  });

  it('explains an empty history', async () => {
    mockHistory.mockResolvedValue({ enabled: true, agents: [] });
    renderPane();
    expect(await screen.findByText(/No usage history yet/)).toBeInTheDocument();
  });
});

describe('usage history view', () => {
  it('round-trips the view through the URL, omitting defaults', () => {
    const view = parseUsageHistoryView(new URLSearchParams('usageRange=3d&usageHideAgents=codex'));
    expect(view.range).toBe('3d');
    expect([...view.hiddenAgents]).toEqual(['codex']);
    expect(parseUsageHistoryView(new URLSearchParams('usageRange=1y')).range).toBe('7d');
    expect(writeUsageHistoryView(new URLSearchParams('period=7d'), { ...view, range: '7d', hiddenAgents: new Set() }).toString())
      .toBe('period=7d');
  });

  it('gives a series past the palette a color no drawn series is using', () => {
    const make = (index: number, color: string) => toPlottedSeries({
      ...series(`k${index}`, `k${index}`, [1]), id: `x:k${index}`, agent: 'x', displayLabel: `k${index}`,
    }, color);
    const palette = [...USAGE_SERIES_COLORS];
    const all = [...palette.map((color, index) => make(index, color)), make(8, UNPLOTTED_SERIES_COLOR), make(9, UNPLOTTED_SERIES_COLOR)];

    const full = planPlottedSeries(all);
    expect(full.drawn.map(entry => entry.color)).toEqual(palette);
    expect(full.undrawn.map(entry => entry.id)).toEqual(['x:k8', 'x:k9']);

    const swapped = planPlottedSeries(all.filter(entry => entry.id !== 'x:k2'));
    expect(swapped.drawn.map(entry => entry.color)).toEqual([...palette.filter((_, index) => index !== 2), palette[2]]);
    expect(swapped.undrawn.map(entry => [entry.id, entry.color])).toEqual([['x:k9', UNPLOTTED_SERIES_COLOR]]);
  });

  it('carries each series forward between its own readings and not past them', () => {
    const a = toPlottedSeries({ ...series('a', 'a', []), id: 'x:a', agent: 'x', displayLabel: 'a',
      points: [{ t: new Date(1000).toISOString(), percent: 10 }, { t: new Date(3000).toISOString(), percent: 30 }] }, '#000');
    const b = toPlottedSeries({ ...series('b', 'b', []), id: 'x:b', agent: 'x', displayLabel: 'b',
      points: [{ t: new Date(2000).toISOString(), percent: 50 }] }, '#111');
    expect(buildChartRows([a, b])).toEqual([
      { t: 1000, 'x:a': 10, 'x:b': null },
      { t: 2000, 'x:a': 10, 'x:b': 50 },
      { t: 3000, 'x:a': 30, 'x:b': null },
    ]);
  });
});
