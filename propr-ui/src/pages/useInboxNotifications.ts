import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notification } from '@propr/shared';
import {
  dismissAllNotifications,
  dismissNotification,
  listNotifications,
  markNotificationRead,
} from '../api/notificationApi';
import { useNotificationCenter } from '../contexts/NotificationCenterContext';
import { useToast } from '../components/ui/useToast';
import { useDemoMode } from '../contexts/DemoModeContext';
import { isSystemNotification, mergeNotifications, replaceNotificationRange } from './inboxUtils';

const PAGE_SIZE = 25;
/** Most pages fetched in one go while looking past system-only pages for activity. */
const MAX_AUTO_PAGE_LOOKAHEAD = 4;
const AUTO_REFRESH_INTERVAL_MS = 60_000;

/** Background refreshes run silently: no busy state, and errors stay until one succeeds. */
type FirstPageLoad = 'initial' | 'refresh' | 'background';

export interface InboxNotificationsState {
  notifications: Notification[];
  initialLoading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  isOnline: boolean;
  hasMore: boolean;
  mutationsEnabled: boolean;
  clearing: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  open: (id: string) => void;
}

const hasActivity = (notifications: readonly Notification[]) => notifications.some(
  notification => !isSystemNotification(notification),
);

interface LookaheadPages {
  notifications: Notification[];
  nextCursor: string | null;
  unreadCount: number;
  pagesLoaded: number;
}

/**
 * Keeps following the cursor while the pages read so far hold only System
 * events, so the activity feed is not left blank. Resolves null once superseded.
 */
async function readPastSystemPages(
  pages: LookaheadPages,
  isCurrent: () => boolean,
): Promise<LookaheadPages | null> {
  const result = { ...pages, notifications: [...pages.notifications] };
  while (
    result.nextCursor !== null
    && result.pagesLoaded < MAX_AUTO_PAGE_LOOKAHEAD
    && !hasActivity(result.notifications)
  ) {
    result.pagesLoaded += 1;
    const page = await listNotifications({ cursor: result.nextCursor, limit: PAGE_SIZE });
    if (!isCurrent()) return null;
    result.notifications.push(...page.notifications);
    result.nextCursor = page.nextCursor;
    result.unreadCount = page.unreadCount;
  }
  return result;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'The Inbox could not be loaded.';
}

export function useInboxNotifications(): InboxNotificationsState {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [clearing, setClearing] = useState(false);
  const requestGenerationRef = useRef(0);
  const loadMoreGenerationRef = useRef(0);
  const notificationsRef = useRef(notifications);
  const dismissingRef = useRef(new Set<string>());
  const hiddenIdsRef = useRef(new Set<string>());
  const dismissSnapshotsRef = useRef(new Map<string, Notification>());
  const readOverridesRef = useRef(new Map<string, Notification>());
  const mutationEpochRef = useRef(0);
  const clearEpochRef = useRef(0);
  const clearingRef = useRef(false);
  const mountedRef = useRef(true);
  const extraPagesLoadedRef = useRef(false);
  const {
    unreadCount,
    commitUnreadCount,
    refreshUnreadCount,
    isActiveIdentity,
  } = useNotificationCenter();
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();
  notificationsRef.current = notifications;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reconcileIncoming = useCallback((incoming: readonly Notification[]) => incoming.flatMap(notification => {
    if (hiddenIdsRef.current.has(notification.id)) {
      if (dismissingRef.current.has(notification.id)) {
        dismissSnapshotsRef.current.set(notification.id, notification);
      }
      return [];
    }
    return [readOverridesRef.current.get(notification.id) ?? notification];
  }), []);

  const loadFirstPage = useCallback(async (mode: FirstPageLoad) => {
    const generation = ++requestGenerationRef.current;
    loadMoreGenerationRef.current += 1;
    const mutationEpoch = mutationEpochRef.current;
    // Keep pages the user already scrolled through; only replace the newest page.
    const keepLoadedPages = mode !== 'initial' && extraPagesLoadedRef.current;
    setLoadingMore(false);
    if (mode === 'refresh') setRefreshing(true);
    if (mode === 'initial') setInitialLoading(true);
    if (mode !== 'background') setError(null);
    try {
      const response = await listNotifications({ limit: PAGE_SIZE });
      if (generation !== requestGenerationRef.current) return;
      const firstPage = { ...response, pagesLoaded: 1 };
      // Older loaded pages that already show activity make reading ahead pointless.
      const pages = keepLoadedPages && hasActivity(notificationsRef.current)
        ? firstPage
        : await readPastSystemPages(firstPage, () => generation === requestGenerationRef.current);
      if (!pages) return;
      const {
        notifications: rawNotifications,
        nextCursor: latestNextCursor,
        unreadCount: latestUnreadCount,
      } = pages;
      if (pages.pagesLoaded > 1) extraPagesLoadedRef.current = true;
      const incoming = reconcileIncoming(rawNotifications);
      const settled = mutationEpoch === mutationEpochRef.current;
      const boundary = latestNextCursor === null ? null : rawNotifications.at(-1);
      setNotifications(current => {
        if (!settled || (keepLoadedPages && boundary === undefined)) return mergeNotifications(current, incoming);
        return keepLoadedPages
          ? replaceNotificationRange(current, incoming, boundary ?? null)
          : mergeNotifications([], incoming);
      });
      if (!keepLoadedPages || (settled && boundary === null)) setNextCursor(latestNextCursor);
      if (settled) commitUnreadCount(latestUnreadCount);
      setError(null);
    } catch (loadError) {
      if (generation === requestGenerationRef.current) setError(messageFrom(loadError));
    } finally {
      if (generation === requestGenerationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [commitUnreadCount, reconcileIncoming]);

  useEffect(() => {
    void loadFirstPage('initial');
    return () => { requestGenerationRef.current += 1; };
  }, [loadFirstPage]);

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  const refresh = useCallback(() => loadFirstPage('refresh'), [loadFirstPage]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || clearingRef.current) return;
      void loadFirstPage('background');
    };
    const interval = window.setInterval(refreshWhenVisible, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || refreshing || initialLoading) return;
    const cursor = nextCursor;
    // Supersede any silent background refresh so its first page cannot replace
    // the list (and cursor) after this page lands.
    const generation = ++requestGenerationRef.current;
    const loadMoreGeneration = ++loadMoreGenerationRef.current;
    const mutationEpoch = mutationEpochRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const rawNewNotifications: Notification[] = [];
      let currentCursor: string | null = cursor;
      let latestUnreadCount: number | null = null;
      let pagesLoaded = 0;
      // Skip past pages of only System events so Load more always surfaces activity
      // when there is some within the lookahead bound.
      while (currentCursor !== null && pagesLoaded < MAX_AUTO_PAGE_LOOKAHEAD) {
        pagesLoaded += 1;
        const response = await listNotifications({ cursor: currentCursor, limit: PAGE_SIZE });
        if (generation !== requestGenerationRef.current) return;
        rawNewNotifications.push(...response.notifications);
        currentCursor = response.nextCursor;
        latestUnreadCount = response.unreadCount;
        if (hasActivity(rawNewNotifications)) break;
      }
      setNotifications(current => mergeNotifications(
        current,
        reconcileIncoming(rawNewNotifications),
      ));
      setNextCursor(currentCursor);
      extraPagesLoadedRef.current = true;
      if (latestUnreadCount !== null && mutationEpoch === mutationEpochRef.current) {
        commitUnreadCount(latestUnreadCount);
      }
    } catch (loadError) {
      if (generation === requestGenerationRef.current) setError(messageFrom(loadError));
    } finally {
      if (loadMoreGeneration === loadMoreGenerationRef.current) setLoadingMore(false);
    }
  }, [commitUnreadCount, initialLoading, loadingMore, nextCursor, reconcileIncoming, refreshing]);

  const dismiss = useCallback(async (id: string) => {
    if (isDemoMode || dismissingRef.current.has(id)) return;
    const clearEpoch = clearEpochRef.current;
    mutationEpochRef.current += 1;
    dismissingRef.current.add(id);
    hiddenIdsRef.current.add(id);
    const removed = notificationsRef.current.find(notification => notification.id === id);
    if (removed) dismissSnapshotsRef.current.set(id, removed);
    const priorUnreadCount = unreadCount;
    setNotifications(current => current.filter(notification => notification.id !== id));
    if (removed?.readAt === null && priorUnreadCount !== null) {
      commitUnreadCount(Math.max(0, priorUnreadCount - 1));
    }
    try {
      const response = await dismissNotification(id);
      // Notifications are disposable: dismissal is silent and final.
      if (clearEpoch === clearEpochRef.current) commitUnreadCount(response.unreadCount);
    } catch (dismissError) {
      if (clearEpoch !== clearEpochRef.current) return;
      hiddenIdsRef.current.delete(id);
      const rollback = removed ?? dismissSnapshotsRef.current.get(id);
      if (mountedRef.current && rollback) {
        setNotifications(current => mergeNotifications(current, [rollback]));
      }
      if (priorUnreadCount !== null) commitUnreadCount(priorUnreadCount);
      if (isActiveIdentity()) {
        addToast({
          type: 'error',
          message: `Couldn't dismiss the notification. ${messageFrom(dismissError)}`,
        });
      }
    } finally {
      mutationEpochRef.current += 1;
      dismissingRef.current.delete(id);
      dismissSnapshotsRef.current.delete(id);
      void refreshUnreadCount().catch(() => undefined);
    }
  }, [addToast, commitUnreadCount, isActiveIdentity, isDemoMode, refreshUnreadCount, unreadCount]);

  const clearAll = useCallback(async () => {
    if (isDemoMode || clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    mutationEpochRef.current += 1;
    try {
      const response = await dismissAllNotifications();
      clearEpochRef.current += 1;
      requestGenerationRef.current += 1;
      loadMoreGenerationRef.current += 1;
      setNotifications([]);
      setNextCursor(null);
      extraPagesLoadedRef.current = false;
      setLoadingMore(false);
      commitUnreadCount(response.unreadCount);
      if (isActiveIdentity()) {
        addToast({ type: 'success', message: 'All notifications cleared.' });
      }
    } catch (clearError) {
      if (isActiveIdentity()) {
        addToast({
          type: 'error',
          message: `Couldn't clear the Inbox. ${messageFrom(clearError)}`,
        });
      }
    } finally {
      mutationEpochRef.current += 1;
      clearingRef.current = false;
      if (mountedRef.current) setClearing(false);
      void refreshUnreadCount().catch(() => undefined);
    }
  }, [addToast, commitUnreadCount, isActiveIdentity, isDemoMode, refreshUnreadCount]);

  const open = useCallback((id: string) => {
    const current = notificationsRef.current.find(notification => notification.id === id);
    if (isDemoMode || !current || current.readAt !== null) return;
    mutationEpochRef.current += 1;
    const clearEpoch = clearEpochRef.current;
    const priorUnreadCount = unreadCount;
    const optimistic = { ...current, readAt: current.createdAt };
    readOverridesRef.current.set(id, optimistic);
    setNotifications(items => items.map(notification => notification.id === id
      ? optimistic
      : notification));
    if (priorUnreadCount !== null) commitUnreadCount(Math.max(0, priorUnreadCount - 1));
    void markNotificationRead(id).then(response => {
      if (clearEpoch !== clearEpochRef.current) return;
      if (mountedRef.current) {
        readOverridesRef.current.set(id, response.notification);
        setNotifications(items => items.map(notification => notification.id === id
          ? response.notification
          : notification));
      }
      commitUnreadCount(response.unreadCount);
    }).catch(readError => {
      if (clearEpoch !== clearEpochRef.current) return;
      readOverridesRef.current.delete(id);
      if (mountedRef.current) {
        setNotifications(items => items.map(notification => notification.id === id
          ? current
          : notification));
      }
      if (priorUnreadCount !== null) commitUnreadCount(priorUnreadCount);
      if (isActiveIdentity()) {
        addToast({
          type: 'error',
          message: `Couldn't mark the notification read. ${messageFrom(readError)}`,
        });
      }
    }).finally(() => {
      mutationEpochRef.current += 1;
      void refreshUnreadCount().catch(() => undefined);
    });
  }, [addToast, commitUnreadCount, isActiveIdentity, isDemoMode, refreshUnreadCount, unreadCount]);

  return {
    notifications,
    initialLoading,
    refreshing,
    loadingMore,
    error,
    isOnline,
    hasMore: nextCursor !== null,
    mutationsEnabled: !isDemoMode,
    clearing,
    refresh,
    loadMore,
    dismiss,
    clearAll,
    open,
  };
}
