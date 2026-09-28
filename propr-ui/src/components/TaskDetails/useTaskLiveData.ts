import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaskLiveDetails } from '../../api/proprApi';
import { useSocket } from '../../contexts/useSocket';
import type { TaskLiveUpdatePayload } from '@propr/shared';
import type { LiveDetails } from './types';
import { executionSupersededByRead, isFinishedTask, isSupersededUpdate } from './liveDetailsMerge';
import { applyTaskLiveUpdate, mergeFullLiveDetails } from './useTaskData';

export function useTaskLiveData(taskId: string | undefined, pollIntervalMs = 5_000, taskState?: string) {
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const {
    subscribeToTaskLive,
    unsubscribeFromTaskLive,
    onTaskLiveUpdate,
    isConnected,
  } = useSocket();

  const activeTaskId = useRef(taskId);
  activeTaskId.current = taskId;
  const isLive = !isFinishedTask(taskState);
  const liveSelection = useRef(isLive);
  liveSelection.current = isLive;
  const requestSequence = useRef(0);
  const pendingRead = useRef<TaskLiveUpdatePayload[] | null>(null);
  // Executions a read proved were replaced; the watcher can still deliver their updates late.
  const supersededExecutions = useRef(new Set<string>());

  useEffect(() => {
    setLiveDetails({ events: [], todos: [], currentTask: null });
    return () => { requestSequence.current += 1; pendingRead.current = null; supersededExecutions.current = new Set(); };
  }, [taskId]);

  const refresh = useCallback(async () => {
    if (!taskId) return null;
    const sequence = ++requestSequence.current;
    const updates: TaskLiveUpdatePayload[] = [];
    pendingRead.current = updates;
    // State updates apply in order, so this captures exactly the state the buffer
    // starts from: every update applied before the read and none buffered during it.
    const atRequest: { state?: LiveDetails } = {};
    setLiveDetails(previous => { atRequest.state = previous; return previous; });
    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      if (activeTaskId.current !== taskId || sequence !== requestSequence.current) return data;
      // Replay only socket updates received during this read, including explicit
      // metadata clears and full-state execution resets, over the older snapshot.
      // They are replayed over the pre-request state, not the current one, which
      // already applied them: raw events a large increment evicted there would
      // otherwise be appended again after newer ones. Updates the snapshot already
      // contains are skipped (see applyTaskLiveUpdate): they could hold an older
      // version of a growing event, or belong to an earlier execution than the
      // read's, even one first received during it. Updates of the execution the
      // read replaced are dropped: they were buffered before the response and are
      // not newer than it.
      setLiveDetails(previous => {
        if (activeTaskId.current !== taskId || sequence !== requestSequence.current) return previous;
        const superseded = executionSupersededByRead(atRequest.state ?? previous, data);
        if (superseded) supersededExecutions.current.add(superseded);
        return updates.filter(update => !isSupersededUpdate(supersededExecutions.current, update))
          .reduce((state, update) => applyTaskLiveUpdate(state, update, liveSelection.current),
            mergeFullLiveDetails(atRequest.state ?? previous, data, liveSelection.current));
      });
      return data;
    } catch {
      return null;
    } finally {
      if (pendingRead.current === updates) pendingRead.current = null;
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
    if (!taskId || pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [isLive, pollIntervalMs, refresh, taskId]);

  useEffect(() => {
    if (!taskId || !isConnected) return;
    subscribeToTaskLive(taskId);
    const unsubscribe = onTaskLiveUpdate((payload: TaskLiveUpdatePayload) => {
      if (payload.taskId !== taskId || activeTaskId.current !== taskId) return;
      if (isSupersededUpdate(supersededExecutions.current, payload)) return;
      pendingRead.current?.push(payload);
      setLiveDetails(previous => applyTaskLiveUpdate(previous, payload, liveSelection.current));
    });
    return () => {
      unsubscribe();
      unsubscribeFromTaskLive(taskId);
    };
  }, [isConnected, onTaskLiveUpdate, subscribeToTaskLive, taskId, unsubscribeFromTaskLive]);

  return { liveDetails, refreshLiveDetails: refresh };
}
