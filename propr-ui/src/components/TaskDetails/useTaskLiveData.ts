import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaskLiveDetails } from '../../api/proprApi';
import { useSocket } from '../../contexts/useSocket';
import type { TaskLiveUpdatePayload } from '@propr/shared';
import type { LiveDetails } from './types';
import { isFinishedTask } from './liveDetailsMerge';
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

  useEffect(() => {
    setLiveDetails({ events: [], todos: [], currentTask: null });
    return () => { requestSequence.current += 1; pendingRead.current = null; };
  }, [taskId]);

  const refresh = useCallback(async () => {
    if (!taskId) return null;
    const sequence = ++requestSequence.current;
    const updates: TaskLiveUpdatePayload[] = [];
    pendingRead.current = updates;
    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      if (activeTaskId.current !== taskId || sequence !== requestSequence.current) return data;
      // Replay only socket updates received during this read, including explicit
      // metadata clears and full-state execution resets, over the older snapshot.
      const received = [...updates];
      setLiveDetails(previous => {
        if (activeTaskId.current !== taskId || sequence !== requestSequence.current) return previous;
        return received.reduce((state, update) => applyTaskLiveUpdate(state, update, liveSelection.current),
          mergeFullLiveDetails(previous, data, liveSelection.current));
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
