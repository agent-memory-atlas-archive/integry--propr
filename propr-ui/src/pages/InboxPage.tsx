import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { InboxList, InboxState, InboxSystemSection } from './InboxPageComponents';
import { isSystemNotification } from './inboxUtils';
import { useInboxNotifications, type InboxNotificationsState } from './useInboxNotifications';

const InboxClearAllButton: React.FC<{ inbox: InboxNotificationsState }> = ({ inbox }) => {
  if (inbox.notifications.length === 0 || !inbox.mutationsEnabled) return null;
  const clearAll = () => {
    if (window.confirm('Clear all notifications from your Inbox?')) void inbox.clearAll();
  };

  return (
    <button
      type="button"
      onClick={clearAll}
      disabled={inbox.clearing || inbox.refreshing || inbox.loadingMore}
      className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-wait disabled:opacity-60"
      aria-label="Clear all"
      title="Clear all"
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </button>
  );
};

const InboxPage: React.FC = () => {
  useDocumentTitle('Inbox');
  const location = useLocation();
  const navigate = useNavigate();
  const processedIntentsRef = useRef(new Set<string>());
  const inbox = useInboxNotifications();
  const dismiss = inbox.dismiss;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('intent') !== 'dismiss') return;
    const notificationId = params.get('notification');
    params.delete('intent');
    params.delete('notification');
    const nextSearch = params.toString();
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`, { replace: true });
    if (!notificationId || processedIntentsRef.current.has(notificationId)) return;
    processedIntentsRef.current.add(notificationId);
    void dismiss(notificationId);
  }, [dismiss, location.hash, location.pathname, location.search, navigate]);

  const [activity, system] = useMemo(() => [
    inbox.notifications.filter(notification => !isSystemNotification(notification)),
    inbox.notifications.filter(isSystemNotification),
  ], [inbox.notifications]);
  const listProps = {
    onDismiss: inbox.dismiss,
    onOpen: inbox.open,
    mutationsEnabled: inbox.mutationsEnabled && !inbox.clearing,
  };

  const showState = inbox.initialLoading && inbox.notifications.length === 0
    ? 'loading'
    : inbox.notifications.length === 0 && inbox.error
      ? (inbox.isOnline ? 'error' : 'offline')
      : inbox.notifications.length === 0 && !inbox.hasMore
        ? 'empty'
        : null;

  return (
    <div className="min-h-full w-full min-w-0 bg-white p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3 sm:mb-6">
        <h1 className="min-w-0 text-xl font-bold text-slate-950 sm:text-2xl">Inbox</h1>
        <InboxClearAllButton inbox={inbox} />
      </div>

      {!inbox.isOnline && inbox.notifications.length > 0 && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <WifiOff className="h-4 w-4 flex-none" aria-hidden="true" />
          You’re offline. Showing the notifications already loaded.
        </div>
      )}
      {inbox.error && inbox.notifications.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {inbox.error} Retrying automatically.
        </div>
      )}

      {showState ? (
        <InboxState kind={showState} message={inbox.error ?? undefined} onRefresh={() => void inbox.refresh()} />
      ) : (
        <div className="space-y-4">
          <InboxList notifications={activity} {...listProps} />
          {inbox.hasMore && (
            <button
              type="button"
              onClick={() => void inbox.loadMore()}
              disabled={inbox.loadingMore || inbox.clearing}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
            >
              {inbox.loadingMore && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {inbox.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          <InboxSystemSection notifications={system} {...listProps} />
        </div>
      )}
    </div>
  );
};

export default InboxPage;
