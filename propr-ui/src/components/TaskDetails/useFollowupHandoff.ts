import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { API_BASE_URL, getDesktopConnectionScope, subscribeDesktopConnectionScope } from '../../api/apiClient';
import { getTaskFollowupRuns, type PostFollowupResponse } from '../../api/proprApi';
import { useCurrentUser } from '../../contexts/AuthContext';

/** A run the accepted follow-up started, as the page shows it. */
export interface FollowupHandoffRun {
  taskId: string;
  status: string;
}

/**
 * What the page that sent an issue follow-up knows of the run it requested:
 * accepted and waiting for that run to start, or the run(s) it started.
 */
export type FollowupHandoff =
  | { phase: 'starting'; issueNumber?: number }
  | { phase: 'started'; runs: FollowupHandoffRun[]; issueNumber?: number };

interface StoredHandoff {
  sourceTaskId: string;
  commentId: number;
  issueNumber?: number;
  acceptedAt: number;
  runs?: FollowupHandoffRun[];
}

const STORAGE_PREFIX = 'propr.followupHandoff.v1';
/** A request older than this is no longer this page's to hand off. */
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the run is looked for while it starts and works; slower once it has waited a while. */
export const HANDOFF_POLL_MS = 3_000;
export const HANDOFF_SLOW_POLL_MS = 15_000;
const HANDOFF_SLOW_AFTER_MS = 60_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export const isTerminalRunStatus = (status: string) => TERMINAL_STATUSES.has(status.toLowerCase());

/**
 * The instance and account a follow-up was sent from: the desktop profile and
 * transport (or the browser), the instance URL and the signed-in user. A
 * handoff recorded under one scope is never shown, polled or followed in
 * another, so a response that lands after a switch cannot cross it.
 */
export const followupHandoffScope = (userId: string | null | undefined): string | null => {
  if (!userId) return null;
  const connection = getDesktopConnectionScope();
  const instance = connection ? `${connection.profileId}\u0000${connection.transportScope ?? ''}` : 'browser';
  return JSON.stringify([instance, API_BASE_URL || window.location.origin, userId]);
};

export const followupHandoffKey = (scope: string, sourceTaskId: string) => `${STORAGE_PREFIX}:${JSON.stringify([scope, sourceTaskId])}`;

const CHANGE_EVENT = 'propr:followup-handoff';

function readStored(key: string | null, now = Date.now()): StoredHandoff | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredHandoff;
    if (typeof stored?.commentId !== 'number' || typeof stored.acceptedAt !== 'number' || now - stored.acceptedAt > HANDOFF_TTL_MS) return null;
    return stored;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredHandoff | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the handoff then lasts as long as the page.
  } finally {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

const subscribeStored = (listener: () => void) => {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
};

/** Whether the receipt confirms a fresh issue run was queued for this task, which is the only receipt handed off. */
export const isAcceptedIssueRetry = (receipt: PostFollowupResponse, sourceTaskId: string): receipt is PostFollowupResponse & { commentId: number } =>
  receipt.success === true && receipt.state === 'queued' && receipt.intent === 'issue' && receipt.posted === true
  && typeof receipt.commentId === 'number' && (receipt.sourceTaskId === undefined || receipt.sourceTaskId === sourceTaskId);

const sameRuns = (a: FollowupHandoffRun[] | undefined, b: FollowupHandoffRun[]) =>
  a?.length === b.length && a.every((run, index) => run.taskId === b[index].taskId && run.status === b[index].status);

/**
 * Hands an accepted issue follow-up off to the run it started. The request is
 * remembered for this tab under the instance and account that sent it, so a
 * reload or reconnect keeps waiting for the same run, and only a read-only
 * lookup by the request's own comment is repeated: nothing is posted again.
 * The run is never guessed from the issue's latest task, and the page never
 * navigates on its own; it offers the run once the lookup names it.
 */
export function useFollowupHandoff(sourceTaskId: string | undefined) {
  const user = useCurrentUser();
  const userId = user?.id ?? null;
  // Republished with the desktop connection, so a profile or transport switch moves the scope with it.
  const connection = useSyncExternalStore(subscribeDesktopConnectionScope, getDesktopConnectionScope);
  const scope = useMemo(() => followupHandoffScope(userId), [userId, connection]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = scope && sourceTaskId ? followupHandoffKey(scope, sourceTaskId) : null;
  const raw = useSyncExternalStore(subscribeStored, () => {
    try { return key ? sessionStorage.getItem(key) : null; } catch { return null; }
  });
  // Without storage, the request is held for this page only.
  const [memory, setMemory] = useState<{ key: string; value: StoredHandoff } | null>(null);
  const stored = useMemo(() => {
    const fromStorage = raw ? readStored(key) : null;
    return fromStorage ?? (memory && memory.key === key ? memory.value : null);
  }, [raw, key, memory]);

  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const keyRef = useRef(key);
  keyRef.current = key;

  const save = useCallback((targetKey: string, value: StoredHandoff | null) => {
    writeStored(targetKey, value);
    setMemory(value ? { key: targetKey, value } : null);
  }, []);

  /** The scope a submission starts in; `accept` records its receipt only while that scope is current. */
  const captureScope = useCallback(() => scopeRef.current, []);

  const accept = useCallback((receipt: PostFollowupResponse, sentScope: string | null): boolean => {
    if (!sourceTaskId || !sentScope || sentScope !== scopeRef.current || !isAcceptedIssueRetry(receipt, sourceTaskId)) return false;
    save(followupHandoffKey(sentScope, sourceTaskId), {
      sourceTaskId, commentId: receipt.commentId, issueNumber: receipt.issueNumber, acceptedAt: Date.now(),
    });
    return true;
  }, [sourceTaskId, save]);

  const dismiss = useCallback(() => {
    if (keyRef.current) save(keyRef.current, null);
  }, [save]);

  const runs = stored?.runs;
  const waiting = Boolean(stored) && (!runs || runs.length === 0 || runs.some(run => !isTerminalRunStatus(run.status)));
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    if (!stored || !waiting || !key || !sourceTaskId) return;
    const requestScope = scope;
    const requestKey = key;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const delay = Date.now() - stored.acceptedAt > HANDOFF_SLOW_AFTER_MS ? HANDOFF_SLOW_POLL_MS : HANDOFF_POLL_MS;
    const lookup = async () => {
      try {
        const result = await getTaskFollowupRuns(sourceTaskId, stored.commentId, { signal: controller.signal });
        // A response that lands after the account, instance or task changed belongs to none of them.
        if (cancelled || scopeRef.current !== requestScope || keyRef.current !== requestKey) return;
        if (result.sourceTaskId !== sourceTaskId || result.commentId !== stored.commentId || !Array.isArray(result.runs)) return;
        const found = result.runs
          .filter(run => typeof run?.taskId === 'string' && run.taskId !== sourceTaskId)
          .map(run => ({ taskId: run.taskId, status: String(run.status ?? 'queued').toLowerCase() }));
        if (found.length > 0 && !sameRuns(stored.runs, found)) save(requestKey, { ...stored, runs: found });
      } catch {
        // A failed read is retried; the request itself was accepted and is never sent again.
      } finally {
        if (!cancelled) timer = setTimeout(() => setPollTick(tick => tick + 1), delay);
      }
    };
    void lookup();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [stored, waiting, key, scope, sourceTaskId, save, pollTick]);

  // A reconnect or a return to the tab looks again at once rather than at the next interval.
  useEffect(() => {
    if (!waiting) return;
    const again = () => { if (document.visibilityState !== 'hidden') setPollTick(tick => tick + 1); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [waiting]);

  const handoff: FollowupHandoff | null = !stored
    ? null
    : stored.runs && stored.runs.length > 0
      ? { phase: 'started', runs: stored.runs, issueNumber: stored.issueNumber }
      : { phase: 'starting', issueNumber: stored.issueNumber };

  return { handoff, captureScope, accept, dismiss };
}
