import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDetails } from './types';
import { useTaskLiveData } from './useTaskLiveData';
import { useTaskData, applyTaskLiveUpdate, mergeFullLiveDetails } from './useTaskData';

const apiMocks = vi.hoisted(() => ({
  getTaskHistory: vi.fn(),
  getTaskAnalysis: vi.fn(),
  getTaskLiveDetails: vi.fn(),
  stopTaskExecution: vi.fn(),
  deleteTask: vi.fn(),
}));

const socketMocks = vi.hoisted(() => {
  const value = {
    isConnected: true,
    taskUpdateHandler: null as ((payload: { taskId: string; state?: string }) => void) | null,
    liveUpdateHandler: null as ((payload: unknown) => void) | null,
    subscribeToTask: vi.fn(),
    unsubscribeFromTask: vi.fn(),
    subscribeToTaskLive: vi.fn(),
    unsubscribeFromTaskLive: vi.fn(),
    onTaskUpdate: (handler: ((payload: { taskId: string; state?: string }) => void) | null) => {
      value.taskUpdateHandler = handler;
      return () => {
        if (value.taskUpdateHandler === handler) value.taskUpdateHandler = null;
      };
    },
    onTaskLiveUpdate: (handler: ((payload: unknown) => void) | null) => {
      value.liveUpdateHandler = handler;
      return () => {
        if (value.liveUpdateHandler === handler) value.liveUpdateHandler = null;
      };
    },
  };
  return value;
});

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../api/proprApi', () => apiMocks);
vi.mock('../ui/useToast', () => ({ useToast: () => toastMocks }));
vi.mock('../../contexts/useSocket', () => ({
  useSocket: () => socketMocks,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const raw = (index: number) => ({ id: `live:task:redis:1:${index}:0`, type: 'tool_use' as const, toolName: 'Bash', timestamp: '2026-09-27T00:00:00Z' });
const details = (start: number, count: number, omittedEventCount = start): LiveDetails => ({
  events: Array.from({ length: count }, (_, index) => raw(start + index)), todos: [], currentTask: null, omittedEventCount,
});

describe('full history follow-up regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMocks.isConnected = true;
    socketMocks.liveUpdateHandler = null;
    socketMocks.taskUpdateHandler = null;
    apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state: 'COMPLETED' }], taskInfo: null });
    apiMocks.getTaskAnalysis.mockResolvedValue({ analysis: null });
    apiMocks.getTaskLiveDetails.mockResolvedValue(details(0, 510));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('counts rolling HTTP omissions once and retains readable prefixes and newer increments', () => {
    const thought = { id: 'live:task:redis:1:thought:0', type: 'thought' as const, content: 'Earlier reasoning' };
    const previous = { ...details(100, 502), events: [thought, ...details(100, 502).events] };
    const full = details(101, 500);
    const merged = mergeFullLiveDetails(previous, full);
    expect(merged.events).toEqual([thought, ...details(102, 500).events]);
    expect(merged.omittedEventCount).toBe(102); // 101 from HTTP, plus event 101 displaced by increment 601.
    const polling = mergeFullLiveDetails(details(100, 500), full);
    expect(polling.events).toEqual(full.events);
    expect(polling.omittedEventCount).toBe(101);
    expect(mergeFullLiveDetails(polling, full).omittedEventCount).toBe(101);
    const noOverlap = mergeFullLiveDetails(details(0, 500), details(500, 500));
    expect(noOverlap.omittedEventCount).toBe(500);
    expect(noOverlap.events).toEqual(details(500, 500).events);
    const newerWithoutOverlap = mergeFullLiveDetails(details(601, 1), full);
    expect(newerWithoutOverlap.events).toEqual(details(102, 500).events);
    expect(newerWithoutOverlap.omittedEventCount).toBe(102);
  });

  it('does not mistake omitted raw suffixes after an old shared thought for newer increments', () => {
    const thought = { id: 'live:task:redis:1:thought:0', type: 'thought' as const, content: 'Earlier reasoning' };
    const old = { ...details(100, 1), events: [thought, raw(100)] };
    const full = { ...details(101, 500), events: [thought, ...details(101, 500).events] };
    expect(mergeFullLiveDetails(old, full)).toEqual({ ...full, tokenUsage: null });
  });

  it('preserves completed HTTP history and socket increments arriving during that read', async () => {
    const pending = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useTaskData('task'));
    await act(async () => {});
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    await act(async () => { pending.resolve(details(0, 510)); await pending.promise; });
    expect(result.current.liveDetails.events).toEqual(details(0, 511).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('keeps uncapped HTTP history in the task hook for %s', async state => {
    apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state }], taskInfo: null });
    const { result, unmount } = renderHook(() => useTaskData('task'));
    await act(async () => {});
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    expect(result.current.liveDetails.events).toHaveLength(511);
    // A delayed live full-state payload must not discard already loaded completed history.
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', ...details(11, 500) }));
    expect(result.current.liveDetails.events).toHaveLength(511);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  it('refetches completed history after a task transitions from live to finished', async () => {
    vi.useFakeTimers();
    apiMocks.getTaskHistory.mockResolvedValueOnce({ history: [{ state: 'CLAUDE_EXECUTION' }] });
    apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(10, 500));
    const { result, unmount } = renderHook(() => useTaskData('task'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.liveDetails.events).toHaveLength(500);
    act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  it('refetches if the task finishes while its initial live HTTP read is pending', async () => {
    vi.useFakeTimers();
    const liveRead = deferred<LiveDetails>();
    apiMocks.getTaskHistory.mockResolvedValueOnce({ history: [{ state: 'CLAUDE_EXECUTION' }] });
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(liveRead.promise);
    const { result, unmount } = renderHook(() => useTaskData('task'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { liveRead.resolve(details(10, 500)); await liveRead.promise; });
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('keeps uncapped completed goal history through HTTP, socket updates, and polling', async () => {
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0, 'completed'));
    await act(async () => {});
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    await act(async () => { await result.current.refreshLiveDetails(); });
    expect(result.current.liveDetails.events).toHaveLength(511);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  it('uses current goal lifecycle across pending reads and refetches on completion', async () => {
    const stale = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(stale.promise);
    const { result, rerender, unmount } = renderHook(({ state }) => useTaskLiveData('task', 0, state), { initialProps: { state: 'claude_execution' } });
    rerender({ state: 'completed' });
    await act(async () => {});
    await act(async () => { stale.resolve(details(10, 500)); await stale.promise; });
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  it('keeps the live goal polling omission count accurate without socket delivery', async () => {
    apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(100, 500)).mockResolvedValue(details(101, 500));
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0, 'claude_execution'));
    await act(async () => {});
    await act(async () => { await result.current.refreshLiveDetails(); });
    expect(result.current.liveDetails.events).toEqual(details(101, 500).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(101);
    unmount();
  });

  it('keeps output discarded by retention disclosed across increments until full state says otherwise', async () => {
    const truncated = applyTaskLiveUpdate(details(0, 0), { taskId: 'task', events: [raw(900)], omittedEventCount: 0, historyTruncated: true });
    expect(truncated.omittedEventCount).toBe(0);
    expect(truncated.historyTruncated).toBe(true);
    const increment = applyTaskLiveUpdate(truncated, { taskId: 'task', events: [raw(901)] });
    expect(increment.historyTruncated).toBe(true);
    expect(mergeFullLiveDetails(increment, { ...details(900, 2, 0), historyTruncated: true }).historyTruncated).toBe(true);
    expect(applyTaskLiveUpdate(increment, { taskId: 'task', events: [raw(0)], omittedEventCount: 0 }).historyTruncated).toBeUndefined();

    apiMocks.getTaskLiveDetails.mockResolvedValue({ ...details(900, 2, 0), historyTruncated: true });
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0, 'running'));
    await act(async () => {});
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    expect(result.current.liveDetails.historyTruncated).toBe(true);
    unmount();
  });

  it('merges large full histories, including unshared prefixes and suffixes, without positional arguments', () => {
    const events = Array.from({ length: 150_000 }, (_, index) => ({ ...raw(index), type: 'thought' as const, content: 'x' }));
    const full = { ...details(0, 0), events };
    const empty = details(0, 0);
    expect(mergeFullLiveDetails(empty, full).events).toEqual(events);
    const last = { ...full, events: [events.at(-1)!] };
    const first = { ...full, events: [events[0]] };
    expect(mergeFullLiveDetails(full, last).events).toEqual(events);
    expect(mergeFullLiveDetails(full, first).events).toEqual(events);
    const next = { ...full, events: [{ ...events[0], id: 'live:task:redis:1:new:0' }] };
    expect(mergeFullLiveDetails(full, next).events).toHaveLength(events.length + 1);
    expect(applyTaskLiveUpdate(empty, { taskId: 'task', events, omittedEventCount: 0 }).events).toEqual(events);
  });

  it('replays a pending goal read increment larger than the raw window once and in order', async () => {
    const read = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(0, 100, 0)).mockReturnValueOnce(read.promise);
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0, 'claude_execution'));
    await act(async () => {});
    expect(result.current.liveDetails.events).toEqual(details(0, 100).events);
    let refresh!: Promise<LiveDetails | null>;
    act(() => { refresh = result.current.refreshLiveDetails(); });
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: details(100, 600).events }));
    expect(result.current.liveDetails.events).toEqual(details(200, 500).events);
    // The snapshot predates most of the increment, which evicted events 100-199.
    await act(async () => { read.resolve(details(0, 150, 0)); await refresh; });
    expect(result.current.liveDetails.events).toEqual(details(200, 500).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(200);
    unmount();
  });

  it('replays a large increment once when the task finishes during its live read', async () => {
    vi.useFakeTimers();
    const read = deferred<LiveDetails>();
    apiMocks.getTaskHistory.mockResolvedValueOnce({ history: [{ state: 'CLAUDE_EXECUTION' }] });
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(read.promise).mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(() => useTaskData('task'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: details(100, 600).events }));
    expect(result.current.liveDetails.events).toEqual(details(200, 500).events);
    act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { read.resolve(details(0, 100, 0)); await read.promise; });
    expect(result.current.liveDetails.events).toEqual(details(0, 700).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    unmount();
  });

  const message = (content: string) => ({ id: 'live:task:redis:gen%3A1:40:0', type: 'thought' as const, content });
  const at = (offset: number) => ({ epoch: 'gen:1', offset });
  const growing = (content: string, offset: number): LiveDetails => ({
    events: [message(content)], todos: [], currentTask: null, omittedEventCount: 0, liveOutputPosition: at(offset),
  });

  for (const [ordering, socketOffset, expected] of [
    ['an HTTP read past the socket update keeps its newer message', 60, 'Checking the parser'],
    ['a socket update past the HTTP read still replaces its older message', 140, 'Checking the parser and tests'],
  ] as const) {
    it(`goal page: ${ordering}`, async () => {
      const read = deferred<LiveDetails>();
      apiMocks.getTaskLiveDetails.mockResolvedValueOnce(growing('Check', 50)).mockReturnValueOnce(read.promise);
      const { result, unmount } = renderHook(() => useTaskLiveData('task', 0, 'claude_execution'));
      await act(async () => {});
      let refresh!: Promise<LiveDetails | null>;
      act(() => { refresh = result.current.refreshLiveDetails(); });
      const socketContent = socketOffset > 100 ? 'Checking the parser and tests' : 'Checking';
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message(socketContent)], liveOutputPosition: at(socketOffset) }));
      // The server read more of the log than the socket update did (or less, in the reverse ordering).
      await act(async () => { read.resolve(growing('Checking the parser', 100)); await refresh; });
      expect(result.current.liveDetails.events).toEqual([message(expected)]);
      unmount();
    });

    it(`finished task page: ${ordering}`, async () => {
      vi.useFakeTimers();
      const read = deferred<LiveDetails>();
      apiMocks.getTaskHistory.mockResolvedValueOnce({ history: [{ state: 'CLAUDE_EXECUTION' }] });
      apiMocks.getTaskLiveDetails.mockReturnValueOnce(read.promise).mockReturnValue(new Promise(() => {}));
      const { result, unmount } = renderHook(() => useTaskData('task'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const socketContent = socketOffset > 100 ? 'Checking the parser and tests' : 'Checking';
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message(socketContent)], liveOutputPosition: at(socketOffset) }));
      act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      await act(async () => { read.resolve(growing('Checking the parser', 100)); await read.promise; });
      expect(result.current.liveDetails.events).toEqual([message(expected)]);
      unmount();
    });
  }
});
