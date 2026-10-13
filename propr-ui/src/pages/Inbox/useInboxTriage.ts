import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { Notification } from '@propr/shared';
import { isDialogOpen, isTypingTarget } from '../../components/TaskList/keyboardOwnership';
import { useInboxSelection } from '../../hooks/useInboxSelection';
import { triageTaskId } from './triageVerdict';

/** Marks the verdict pane; arrow keys pressed inside it scroll it rather than step the queue. */
export const VERDICT_PANE_ATTRIBUTE = 'data-inbox-verdict-pane';

const inVerdictPane = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${VERDICT_PANE_ATTRIBUTE}]`) !== null;

/**
 * The item to open once `removedId` leaves the queue: the next one below it,
 * or the one above when it was last; null when the queue is empty.
 */
function nextInQueue(previous: readonly Notification[], current: readonly Notification[], removedId: string): string | null {
  const remaining = new Set(current.map(notification => notification.id));
  const index = previous.findIndex(notification => notification.id === removedId);
  const after = previous.slice(index + 1).find(notification => remaining.has(notification.id));
  const before = previous.slice(0, Math.max(index, 0)).reverse().find(notification => remaining.has(notification.id));
  return (after ?? before ?? current[0])?.id ?? null;
}

const NEXT_KEYS = new Set(['j', 'ArrowDown']);
const PREVIOUS_KEYS = new Set(['k', 'ArrowUp']);

interface QueueKeyboard {
  queue: readonly Notification[];
  selectedId: string | null;
  /** Null outside the split, where rows navigate and the keys stay the browser's. */
  select: ((id: string) => void) | null;
  /** Dismisses the open item with x, or null when it cannot be dismissed. */
  dismissSelected: (() => void) | null;
}

/**
 * j/ArrowDown and k/ArrowUp step through the activity queue and x dismisses
 * the open item. With nothing open, j and k start at the top or bottom; the
 * arrows keep scrolling the page, and scroll the verdict while focus is in it.
 */
function useQueueKeyboard({ queue, selectedId, select, dismissSelected }: QueueKeyboard) {
  useEffect(() => {
    if (!select || queue.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || isDialogOpen()) return;
      if (event.key === 'x' && dismissSelected) {
        event.preventDefault();
        dismissSelected();
        return;
      }
      const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
      if (!step) return;
      const index = selectedId ? queue.findIndex(notification => notification.id === selectedId) : -1;
      if (event.key.startsWith('Arrow') && (index === -1 || inVerdictPane(event.target))) return;
      const next = index === -1
        ? (step > 0 ? 0 : queue.length - 1)
        : Math.min(Math.max(index + step, 0), queue.length - 1);
      event.preventDefault();
      if (queue[next].id !== selectedId) select(queue[next].id);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [queue, selectedId, select, dismissSelected]);
}

interface InboxTriageOptions {
  /** The activity queue, newest first; System rows are not part of it. */
  queue: readonly Notification[];
  dismiss: (id: string) => Promise<void>;
  open: (id: string) => void;
  mutationsEnabled: boolean;
  /** The first page has settled, so a selection it does not hold never will. */
  loaded: boolean;
}

export interface InboxTriage {
  /** The notification open beside the queue; always null below the split breakpoint. */
  selected: Notification | null;
  select: (id: string | null) => void;
  closePane: () => void;
  isSplitViewport: boolean;
}

/**
 * The Inbox's triage console state: which queue item is open beside the list,
 * the keys that step through and dismiss it, and the instant progression to
 * the next item once the open one leaves the queue. Only items backed by a
 * task open a verdict; the rest open their destination directly. Nothing here
 * reads the list again; it only follows the notifications already loaded.
 */
export function useInboxTriage({ queue: activity, dismiss, open, mutationsEnabled, loaded }: InboxTriageOptions): InboxTriage {
  const queue = useMemo(() => activity.filter(notification => triageTaskId(notification) !== null), [activity]);
  const location = useLocation();
  const selection = useInboxSelection();
  const { select, isSplitViewport } = selection;
  // A push notification's dismiss intent also names the notification; it is not a selection.
  const selectedId = new URLSearchParams(location.search).get('intent') === 'dismiss' ? null : selection.selectedId;

  // Wide screens triage beside the queue; narrower ones navigate as rows always have.
  const selected = isSplitViewport && selectedId
    ? queue.find(notification => notification.id === selectedId) ?? null
    : null;
  const closePane = useCallback(() => select(null), [select]);
  const selectedForDismiss = selected && mutationsEnabled && selected.actions.includes('dismiss') ? selected.id : null;
  const dismissSelected = useCallback(() => {
    if (selectedForDismiss) void dismiss(selectedForDismiss);
  }, [dismiss, selectedForDismiss]);
  useQueueKeyboard({
    queue,
    selectedId: selected?.id ?? null,
    select: isSplitViewport ? select : null,
    dismissSelected: selectedForDismiss ? dismissSelected : null,
  });

  // Opening a verdict reads the notification, as opening its destination does.
  // Once per item, so a failed read does not retry in a loop.
  const openedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!selected || selected.readAt !== null || openedRef.current.has(selected.id)) return;
    openedRef.current.add(selected.id);
    open(selected.id);
  }, [open, selected]);

  // Instant queue progression: when the open item leaves the queue (dismissed,
  // a command sent, or dismissed elsewhere), the next one opens in its place.
  // If it comes back, its dismissal failed and was rolled back, so it opens
  // again unless the user has moved on. A selection the loaded queue never
  // held (dismissed in another tab, a System row, a plan) is dropped.
  const previousQueueRef = useRef(queue);
  const advancedRef = useRef<{ from: string; to: string | null } | null>(null);
  useEffect(() => {
    const previous = previousQueueRef.current;
    previousQueueRef.current = queue;
    if (!isSplitViewport) return;
    const advanced = advancedRef.current;
    if (advanced && advanced.to !== selectedId) advancedRef.current = null;
    else if (advanced && queue.some(notification => notification.id === advanced.from)) {
      advancedRef.current = null;
      select(advanced.from);
      return;
    }
    if (!selectedId || queue.some(notification => notification.id === selectedId)) return;
    if (previous.some(notification => notification.id === selectedId)) {
      const next = nextInQueue(previous, queue, selectedId);
      advancedRef.current = { from: selectedId, to: next };
      select(next);
    } else if (loaded) {
      select(null);
    }
  }, [queue, isSplitViewport, select, selectedId, loaded]);

  return { selected, select, closePane, isSplitViewport };
}
