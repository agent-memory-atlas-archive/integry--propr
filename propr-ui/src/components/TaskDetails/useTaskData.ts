import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getTaskHistory,
  getTaskAnalysis,
  getTaskLiveDetails,
  stopTaskExecution,
  StopExecutionResponse,
  deleteTask
} from '../../api/proprApi';
import {
  HistoryItem,
  TaskInfo,
  LiveDetails,
  LiveEvent,
  TodoItem,
  AnalysisData,
  UsageMetricRecord
} from './types';
import { useToast } from '../ui/useToast';
import { useSocket } from '../../contexts/useSocket';
import { trustedPreviewMedia, type PublishedVisualPreview, type TaskUpdatePayload, type TaskLiveUpdatePayload } from '@propr/shared';
import { isAnalysisData, normalizeAnalysisData } from './apiDataGuards';
import { useLiveRefreshScheduler } from '../../hooks/useLiveRefreshScheduler';
import { useCurrentUser } from '../../contexts/AuthContext';
import { getDesktopSocketConfigurationKey } from '../../api/apiClient';

interface TaskHistoryData {
  history?: HistoryItem[];
  taskInfo?: TaskInfo | null;
  usageMetricRecords?: UsageMetricRecord[];
  previewMedia?: PublishedVisualPreview[];
}

const normalizeTodoStatus = (status: string): TodoItem['status'] => {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
};

const stableTodoContentId = (content: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `todo-${(hash >>> 0).toString(36)}`;
};

export const normalizeLiveTodos = (todos: TaskLiveUpdatePayload['todos']): TodoItem[] => {
  const occurrences = new Map<string, number>();
  return todos.map(todo => {
    const baseId = todo.id?.trim() || stableTodoContentId(todo.content);
    const occurrence = occurrences.get(baseId) ?? 0;
    occurrences.set(baseId, occurrence + 1);
    return {
      id: occurrence === 0 ? baseId : `${baseId}-${occurrence}`,
      content: todo.content,
      status: normalizeTodoStatus(todo.status)
    };
  });
};

const legacyEventFingerprint = (event: LiveDetails['events'][number]) => {
  // A tool use and its result intentionally share toolUseId, so retain the
  // event type while still distinguishing otherwise identical tool calls.
  if (event.toolUseId) return `tool:${JSON.stringify({
    type: event.type,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    toolName: event.toolName,
    input: event.input,
    result: event.result,
    isError: event.isError,
  })}`;
  return `legacy:${JSON.stringify({
    type: event.type,
    content: event.content,
    timestamp: event.timestamp,
    toolName: event.toolName,
    input: event.input,
    result: event.result,
    isError: event.isError,
  })}`;
};

/** Raw terminal events kept in a live view; readable (`thought`) events are always kept. */
export const MAX_LIVE_RAW_EVENTS = 500;

/** Keeps every readable event and only the most recent raw ones. */
export const capLiveEvents = (events: LiveEvent[], maxRawEvents = MAX_LIVE_RAW_EVENTS): { events: LiveEvent[]; dropped: number } => {
  let raw = 0;
  for (const event of events) if (event.type !== 'thought') raw += 1;
  let skip = Math.max(0, raw - maxRawEvents);
  const dropped = skip;
  if (skip === 0) return { events, dropped };
  return {
    events: events.filter(event => {
      if (event.type === 'thought' || skip === 0) return true;
      skip -= 1;
      return false;
    }),
    dropped,
  };
};

/**
 * Appends events not seen yet and updates events whose content changed (a
 * buffered assistant message keeps its ID while it grows).
 */
const appendUniqueEvents = (
  currentEvents: LiveDetails['events'],
  newEvents: LiveDetails['events']
) => {
  if (newEvents.length === 0) return currentEvents;
  const indexById = new Map<string, number>();
  currentEvents.forEach((event, index) => { if (event.id) indexById.set(event.id, index); });
  const existingLegacyOccurrences = new Map<string, number>();
  for (const event of currentEvents) {
    if (event.id) continue;
    const fingerprint = legacyEventFingerprint(event);
    existingLegacyOccurrences.set(fingerprint, (existingLegacyOccurrences.get(fingerprint) ?? 0) + 1);
  }
  let updated: LiveDetails['events'] | null = null;
  const incomingLegacyOccurrences = new Map<string, number>();
  const uniqueNewEvents = newEvents.filter(event => {
    if (event.id) {
      const existing = indexById.get(event.id);
      if (existing === undefined) {
        indexById.set(event.id, -1);
        return true;
      }
      if (existing >= 0 && currentEvents[existing] !== event) {
        updated ??= [...currentEvents];
        updated[existing] = event;
      }
      return false;
    }
    const fingerprint = legacyEventFingerprint(event);
    const occurrence = incomingLegacyOccurrences.get(fingerprint) ?? 0;
    incomingLegacyOccurrences.set(fingerprint, occurrence + 1);
    if (occurrence < (existingLegacyOccurrences.get(fingerprint) ?? 0)) return false;
    return true;
  });
  const base = updated ?? currentEvents;
  return uniqueNewEvents.length > 0 ? [...base, ...uniqueNewEvents] : base;
};

/**
 * A full-state read (HTTP snapshot or a socket full-state payload) sets the
 * order; events already held that are newer than anything it shares with the
 * current list (socket increments that raced the read) stay after it.
 */
export const mergeFullLiveDetails = (previous: LiveDetails, full: LiveDetails): LiveDetails => {
  const fullEvents = full.events || [];
  const fullIds = new Set(fullEvents.flatMap(event => event.id ? [event.id] : []));
  let lastShared = -1;
  previous.events.forEach((event, index) => { if (event.id && fullIds.has(event.id)) lastShared = index; });
  const newer = lastShared >= 0 ? previous.events.slice(lastShared + 1).filter(event => !event.id || !fullIds.has(event.id)) : [];
  const capped = capLiveEvents(newer.length > 0 ? [...fullEvents, ...newer] : fullEvents);
  return {
    events: capped.events,
    todos: full.todos || [],
    currentTask: full.currentTask || null,
    tokenUsage: full.tokenUsage || null,
    omittedEventCount: (full.omittedEventCount ?? 0) + capped.dropped,
  };
};

export type IncrementalTaskLiveUpdatePayload = Pick<TaskLiveUpdatePayload, 'taskId'>
  & Partial<Omit<TaskLiveUpdatePayload, 'taskId'>>;

const hasUpdateField = (
  payload: IncrementalTaskLiveUpdatePayload,
  field: keyof TaskLiveUpdatePayload
): boolean =>
  Object.prototype.hasOwnProperty.call(payload, field);

export const mergeIncrementalLiveDetails = (
  previous: LiveDetails,
  payload: IncrementalTaskLiveUpdatePayload
): LiveDetails => {
  const newEvents: LiveEvent[] = payload.events || [];
  const capped = capLiveEvents(appendUniqueEvents(previous.events, newEvents));
  const omitted = previous.omittedEventCount !== undefined || capped.dropped > 0
    ? { omittedEventCount: (previous.omittedEventCount ?? 0) + capped.dropped }
    : {};
  return {
    events: capped.events,
    ...omitted,
    todos: hasUpdateField(payload, 'todos')
      ? normalizeLiveTodos(payload.todos ?? [])
      : previous.todos,
    currentTask: hasUpdateField(payload, 'currentTask')
      ? payload.currentTask ?? null
      : previous.currentTask,
    tokenUsage: hasUpdateField(payload, 'tokenUsage')
      ? payload.tokenUsage ?? null
      : previous.tokenUsage,
  };
};

/** A socket payload carrying `omittedEventCount` is full state (initial, or after a resync); others are increments. */
export const applyTaskLiveUpdate = (previous: LiveDetails, payload: IncrementalTaskLiveUpdatePayload): LiveDetails => {
  if (payload.omittedEventCount === undefined) return mergeIncrementalLiveDetails(previous, payload);
  return mergeFullLiveDetails(previous, {
    events: payload.events || [],
    todos: normalizeLiveTodos(payload.todos || []),
    currentTask: payload.currentTask || null,
    tokenUsage: payload.tokenUsage || null,
    omittedEventCount: payload.omittedEventCount,
  });
};

export const useTaskData = (taskId: string | undefined) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [usageMetricRecords, setUsageMetricRecords] = useState<UsageMetricRecord[]>([]);
  const [previewMedia, setPreviewMedia] = useState<PublishedVisualPreview[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState<boolean>(true);
  const [stoppingExecution, setStoppingExecution] = useState<boolean>(false);
  const [stopFailed, setStopFailed] = useState<boolean>(false);
  const [deletingTask, setDeletingTask] = useState<boolean>(false);
  const { addToast } = useToast();
  const currentUser = useCurrentUser();
  const { subscribeToTask, unsubscribeFromTask, onTaskUpdate, isConnected, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskLiveUpdate } = useSocket();
  // Track the last notified terminal state to avoid duplicate toasts
  const lastNotifiedStateRef = useRef<string | null>(null);
  const hasReceivedSocketStateRef = useRef<boolean>(false);
  // Track if we've received initial data from WebSocket (to distinguish initial vs incremental updates)
  // A route parameter can change without unmounting this hook. Late responses
  // from the previous task must never replace the newly selected task's data.
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;
  const requestScopeKey = `${getDesktopSocketConfigurationKey()}\0${currentUser?.id ?? ''}\0${taskId ?? ''}`;
  const activeRequestScopeRef = useRef(requestScopeKey);
  activeRequestScopeRef.current = requestScopeKey;
  const latestHistoryRef = useRef(history);
  latestHistoryRef.current = history;

  // Fetch task history data
  const fetchTaskHistory = useCallback(async () => {
    if (!taskId) return;
    const requestedScope = requestScopeKey;

    try {
      const data = await getTaskHistory(taskId) as TaskHistoryData;
      if (activeRequestScopeRef.current !== requestedScope) return data;
      const nextHistory = data.history || [];
      latestHistoryRef.current = nextHistory;
      setHistory(nextHistory);
      setTaskInfo(data.taskInfo || null);
      setUsageMetricRecords(data.usageMetricRecords || []);
      // Only trusted GitHub attachment URLs may become media sources.
      setPreviewMedia(trustedPreviewMedia(data.previewMedia || data.taskInfo?.previewMedia, 8));
      return data;
    } catch (err) {
      console.error('Error fetching task history:', err);
      throw err;
    }
  }, [requestScopeKey, taskId]);

  const fetchPersistedLiveDetails = useCallback(async () => {
    if (!taskId) return null;
    const requestedScope = requestScopeKey;

    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      if (activeRequestScopeRef.current !== requestedScope) return data;
      // The socket subscription runs in parallel with this read, and its first
      // payload is already full state. Never let an older HTTP snapshot replace
      // newer socket state that arrived while the request was pending.
      if (!hasReceivedSocketStateRef.current) setLiveDetails(previous => mergeFullLiveDetails(previous, data));
      return data;
    } catch (err) {
      console.error('Error fetching persisted live details:', err);
      return null;
    }
  }, [requestScopeKey, taskId]);

  const scheduleTaskHistoryRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: fetchTaskHistory,
    scopeKey: requestScopeKey,
  });

  useEffect(() => {
    lastNotifiedStateRef.current = null;
    hasReceivedSocketStateRef.current = false;
  }, [requestScopeKey]);

  // Handle task update from WebSocket
  const handleTaskUpdate = useCallback((payload: TaskUpdatePayload) => {
    if (payload.taskId !== activeTaskIdRef.current) return;

    console.log('[useTaskData] Received task update via WebSocket:', payload);

    // A task can emit several state/progress notifications close together.
    // Coalesce those invalidations and serialize a trailing read when a newer
    // update arrives while the current request is pending.
    scheduleTaskHistoryRefresh();

    // Check for terminal states and show toast notifications
    const state = payload.state?.toUpperCase() || '';
    if (state === 'COMPLETED' && lastNotifiedStateRef.current !== 'COMPLETED') {
      lastNotifiedStateRef.current = 'COMPLETED';
      addToast({
        type: 'success',
        message: 'Task completed successfully',
      });
    } else if (state === 'FAILED' && lastNotifiedStateRef.current !== 'FAILED') {
      lastNotifiedStateRef.current = 'FAILED';
      addToast({
        type: 'error',
        message: 'Task execution failed',
      });
    }
  }, [scheduleTaskHistoryRefresh, addToast]);

  // Handle task live update from WebSocket
  // This updates the terminal output directly from WebSocket data - no HTTP calls needed
  // WebSocket sends full state on initial subscription, then only new events on updates
  const handleTaskLiveUpdate = useCallback((payload: TaskLiveUpdatePayload) => {
    if (payload.taskId !== activeTaskIdRef.current) return;

    hasReceivedSocketStateRef.current = true;
    setLiveDetails(previous => applyTaskLiveUpdate(previous, payload));
  }, []);

  // Initial data fetch
  useEffect(() => {
    let active = true;
    const fetchInitialData = async () => {
      if (!taskId) return;

      try {
        setLoading(true);
        setError(null);
        // Initial reads are immediate, but use the same coordinator as socket
        // invalidations so an update during this request becomes one trailing
        // authoritative read instead of an overlapping request.
        await scheduleTaskHistoryRefresh.refreshNow();
        if (!active) return;
        await fetchPersistedLiveDetails();
      } catch (err) {
        if (!active) return;
        setError((err as Error).message);
        console.error('Error fetching task history:', err);
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchInitialData();
    return () => { active = false; };
  }, [taskId, scheduleTaskHistoryRefresh, fetchPersistedLiveDetails]);

  // Subscribe to WebSocket events for this task
  useEffect(() => {
    if (!taskId || !isConnected) return;

    // Subscribe to this specific task's room for state updates
    subscribeToTask(taskId);

    // Subscribe to live task updates (Claude log streaming)
    subscribeToTaskLive(taskId);

    // Listen for task updates
    const unsubscribeTask = onTaskUpdate(handleTaskUpdate);

    // Listen for live task updates (terminal output)
    const unsubscribeLive = onTaskLiveUpdate(handleTaskLiveUpdate);

    return () => {
      unsubscribeFromTask(taskId);
      unsubscribeFromTaskLive(taskId);
      unsubscribeTask();
      unsubscribeLive();
      // Reset initial data flag on cleanup so re-subscription gets fresh state
      hasReceivedSocketStateRef.current = false;
    };
  }, [requestScopeKey, taskId, isConnected, subscribeToTask, unsubscribeFromTask, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskUpdate, onTaskLiveUpdate, handleTaskUpdate, handleTaskLiveUpdate]);

  // Fetch analysis data (separate from task updates, typically only needed once)
  useEffect(() => {
    const fetchAnalysis = async () => {
      if (!taskId) return;

      try {
        setAnalysisLoading(true);
        const analysisData = await getTaskAnalysis(taskId);
        const nextAnalysis = analysisData.analysis;
        setAnalysis(
          isAnalysisData(nextAnalysis)
            ? normalizeAnalysisData(nextAnalysis)
            : typeof nextAnalysis === 'string'
              ? { analysis: nextAnalysis }
              : null
        );
      } catch (err) {
        console.error('Error fetching analysis:', err);
      } finally {
        setAnalysisLoading(false);
      }
    };

    fetchAnalysis();
  }, [taskId]);

  // Live details are now delivered entirely via WebSocket
  // Initial data is sent when subscribing to task:live, then only new events on updates
  // No HTTP fallback needed

  const handleStopExecution = async () => {
    if (!taskId) return;

    const confirmed = window.confirm('Are you sure you want to stop this execution? This action cannot be undone.');
    if (!confirmed) return;

    try {
      setStoppingExecution(true);
      const result: StopExecutionResponse = await stopTaskExecution(taskId);

      // Immediately refresh task history to show the new state
      await scheduleTaskHistoryRefresh.refreshNow();

      // If container was stopped successfully, clear stopping state immediately
      // Otherwise, poll a couple more times to wait for state to update
      if (result.containerStopped) {
        setStoppingExecution(false);
      } else {
        // Container might still be stopping, poll for updates
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          await scheduleTaskHistoryRefresh.refreshNow();

          // Check if task is now in a terminal state
          const latestHistory = latestHistoryRef.current;
          const latestState = latestHistory[latestHistory.length - 1]?.state?.toUpperCase();
          const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(latestState || '');

          if (isTerminal || pollCount >= 5) {
            clearInterval(pollInterval);
            setStoppingExecution(false);
          }
        }, 1500);
      }
    } catch (err) {
      console.error('Error stopping execution:', err);
      alert(`Failed to stop execution: ${(err as Error).message || 'Unknown error'}. The task may have already stopped. You can now delete it.`);
      setStoppingExecution(false);
      setStopFailed(true);
    }
  };

  const handleDeleteTask = async (): Promise<boolean> => {
    if (!taskId) return false;

    const confirmed = window.confirm('Are you sure you want to delete this task? This action cannot be undone.');
    if (!confirmed) return false;

    try {
      setDeletingTask(true);
      // Use force=true if stop operation previously failed (task may be stuck but not running)
      await deleteTask(taskId, stopFailed);
      return true; // Indicates successful deletion
    } catch (err) {
      console.error('Error deleting task:', err);
      alert(`Failed to delete task: ${(err as Error).message || 'Unknown error'}`);
      return false;
    } finally {
      setDeletingTask(false);
    }
  };

  return {
    history,
    taskInfo,
    usageMetricRecords,
    previewMedia,
    loading,
    error,
    liveDetails,
    analysis,
    analysisLoading,
    stoppingExecution,
    stopFailed,
    handleStopExecution,
    deletingTask,
    handleDeleteTask
  };
};
