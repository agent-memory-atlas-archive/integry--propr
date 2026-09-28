import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSummary } from './DashboardSummary';
import { SUMMARY_COALESCE_MS } from './useDashboardSummary';
import { getDashboardNarrative } from '../../api/dashboardApi';

vi.mock('../../api/dashboardApi', () => ({ getDashboardNarrative: vi.fn() }));
const narrative = vi.mocked(getDashboardNarrative);
const response = { repository: 'all', enabled: true, summary: 'Retry handling is running. A review needs your attention.' };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS); }); };
const visible = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
const mount = async () => {
  const result = render(<DashboardSummary repository="all" activityToken={0} />);
  await act(async () => {});
  return result;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  visible('visible');
  narrative.mockReset().mockResolvedValue(response);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('dashboard narrative', () => {
  it('coalesces activity updates and does not regenerate on a timer', async () => {
    const view = await mount();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    for (const token of [1, 2, 3]) view.rerender(<DashboardSummary repository="all" activityToken={token} />);
    expect(narrative).toHaveBeenCalledTimes(1);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(narrative).toHaveBeenCalledTimes(2);
  });

  it('defers hidden activity updates to one request when visible, including a timer scheduled before hiding', async () => {
    const view = await mount();
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    visible('hidden');
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    visible('hidden');
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
  });

  it('does not generate on a hidden initial mount', async () => {
    visible('hidden');
    await mount();
    await tick();
    expect(narrative).not.toHaveBeenCalled();
    visible('visible');
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
  });

  it('persists pause across mounts, suppresses automatic updates, and permits forced refresh', async () => {
    const view = await mount();
    expect(screen.getByRole('button', { name: 'Pause automatic summary updates' })).toHaveAttribute('title', 'Pause automatic summary updates');
    expect(screen.getByRole('button', { name: 'Refresh activity summary' })).toHaveAttribute('title', 'Refresh activity summary');
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic summary updates' }));
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity summary' }));
    await act(async () => {});
    expect(narrative).toHaveBeenLastCalledWith('all', true);
    view.unmount();
    const reloaded = await mount();
    expect(screen.getByRole('button', { name: 'Resume automatic summary updates' })).toHaveAttribute('aria-pressed', 'true');
    narrative.mockClear();
    reloaded.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic summary updates' }));
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
  });

  it('retains prose on model or network failure, but hides everything when disabled', async () => {
    const view = await mount();
    narrative.mockResolvedValueOnce({ ...response, summary: null });
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    narrative.mockRejectedValueOnce(new Error('Network unavailable'));
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    await tick();
    expect(screen.getByText(response.summary)).toBeInTheDocument();
    narrative.mockResolvedValue({ ...response, enabled: false, summary: null });
    view.rerender(<DashboardSummary repository="all" activityToken={3} />);
    await tick();
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<DashboardSummary repository="all" activityToken={4} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(4);
  });

  it('shows quiet unavailability without a model and renders output as text', async () => {
    narrative.mockResolvedValueOnce({ ...response, summary: null });
    const view = await mount();
    expect(screen.getByText('Summary unavailable')).toBeInTheDocument();
    narrative.mockResolvedValueOnce({ ...response, summary: '<img src=x onerror=alert(1)>' });
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('changes repository scope immediately and ignores late results from the old scope', async () => {
    let resolveOld!: (value: typeof response) => void;
    narrative.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = await mount();
    narrative.mockResolvedValueOnce({ ...response, repository: 'acme/web', summary: 'Web work is running.' });
    view.rerender(<DashboardSummary repository="acme/web" activityToken={0} />);
    await act(async () => {});
    expect(narrative).toHaveBeenLastCalledWith('acme/web', false);
    await act(async () => { resolveOld(response); });
    expect(screen.getByText('Web work is running.')).toBeInTheDocument();
    expect(screen.queryByText(response.summary)).not.toBeInTheDocument();
  });

  it('remembers activity updates during an in-flight request and cleans up on unmount', async () => {
    let resolve!: (value: typeof response) => void;
    narrative.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = await mount();
    view.rerender(<DashboardSummary repository="all" activityToken={1} />);
    await tick();
    expect(narrative).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(response); });
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
    view.rerender(<DashboardSummary repository="all" activityToken={2} />);
    view.unmount();
    await tick();
    expect(narrative).toHaveBeenCalledTimes(2);
  });
});
