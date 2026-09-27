import { useCallback, useEffect, useState } from 'react';
import { getTaskLiveDetails } from '../../api/proprApi';
import { useSocket } from '../../contexts/useSocket';
import type { TaskLiveUpdatePayload } from '@propr/shared';
import type { LiveDetails } from './types';
import { applyTaskLiveUpdate, mergeFullLiveDetails } from './useTaskData';

export function useTaskLiveData(taskId: string | undefined, pollIntervalMs = 5_000) {
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const {
    subscribeToTaskLive,
    unsubscribeFromTaskLive,
    onTaskLiveUpdate,
    isConnected,
  } = useSocket();

  const refresh = useCallback(async () => {
    if (!taskId) return null;
    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      // Merge, never replace: events gathered over the socket since this read started are kept.
      setLiveDetails(previous => mergeFullLiveDetails(previous, data));
      return data;
    } catch {
      return null;
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
    if (!taskId || pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh, taskId]);

  useEffect(() => {
    if (!taskId || !isConnected) return;
    subscribeToTaskLive(taskId);
    const unsubscribe = onTaskLiveUpdate((payload: TaskLiveUpdatePayload) => {
      if (payload.taskId !== taskId) return;
      setLiveDetails(previous => applyTaskLiveUpdate(previous, payload));
    });
    return () => {
      unsubscribe();
      unsubscribeFromTaskLive(taskId);
    };
  }, [isConnected, onTaskLiveUpdate, subscribeToTaskLive, taskId, unsubscribeFromTaskLive]);

  return { liveDetails, refreshLiveDetails: refresh };
}
