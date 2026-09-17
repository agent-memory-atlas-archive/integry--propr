/* eslint-disable max-lines */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import { ToastProvider } from '../components/ui/Toast';
import InboxPage from './InboxPage';
import {
  dismissAllNotifications,
  dismissNotification,
  listNotifications,
  markNotificationRead,
} from '../api/notificationApi';
import { postTaskFollowup } from '../api/proprApi';

const commitUnreadCount = vi.fn();
const refreshUnreadCount = vi.fn(async () => undefined);
const demoState = { isDemoMode: false };
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({
    unreadCount: 3,
    commitUnreadCount,
    refreshUnreadCount,
    isActiveIdentity: () => true,
  }),
}));
vi.mock('../api/notificationApi', () => ({
  listNotifications: vi.fn(),
  dismissAllNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
}));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => demoState }));

function item(
  id: string,
  title: string,
  readAt: string | null = null,
  overrides: Record<string, unknown> = {},
): Notification {
  return notificationSchema.parse({
    id,
    deduplicationKey: `${id}-key`,
    kind: 'task',
    severity: 'error',
    target: { type: 'task', repository: 'integry/propr', taskId: `task-${id}` },
    title,
    body: 'Work did not complete.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt,
    dismissedAt: null,
    actions: ['dismiss'],
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const Location = () => <div data-testid="location">{useLocation().search}</div>;

function renderInbox(entry = '/inbox') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inbox" element={<><InboxPage /><Location /></>} />
          <Route path="/tasks/:id" element={<div>Task details</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Inbox page', () => {
  beforeEach(() => {
    vi.mocked(listNotifications).mockReset();
    vi.mocked(dismissAllNotifications).mockReset();
    vi.mocked(dismissNotification).mockReset();
    vi.mocked(markNotificationRead).mockReset();
    vi.mocked(postTaskFollowup).mockReset();
    commitUnreadCount.mockReset();
    refreshUnreadCount.mockClear();
    demoState.isDemoMode = false;
  });

  test('renders notifications in the four operational groups with System collapsed by default', async () => {
    const attention = item('event-attention', 'Task needs attention');
    const review = item('event-plan', 'Plan ready', null, {
      kind: 'plan',
      severity: 'info',
      target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-1' },
    });
    const completed = item('event-completed', 'Task completed', null, { severity: 'success' });
    const system = item('event-system', 'System failure', null, {
      kind: 'system_failure',
      severity: 'error',
      target: { type: 'system_failure', component: 'dispatcher' },
    });
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [attention, review, completed, system],
      unreadCount: 4,
      nextCursor: null,
    });

    renderInbox();

    await screen.findByRole('heading', { level: 2, name: 'Needs attention' });
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map(heading => heading.textContent)).toEqual([
      'Needs attention',
      'Ready for review',
      'Completed',
      'System',
    ]);
    expect(screen.getByRole('heading', { level: 3, name: 'Task needs attention' }).closest('section'))
      .toHaveAccessibleName('Needs attention');
    expect(screen.getByRole('heading', { level: 3, name: 'Plan ready' }).closest('section'))
      .toHaveAccessibleName('Ready for review');
    expect(screen.getByRole('heading', { level: 3, name: 'Task completed' }).closest('section'))
      .toHaveAccessibleName('Completed');
    expect(screen.queryByRole('heading', { level: 3, name: 'System failure' })).not.toBeInTheDocument();

    const systemToggle = screen.getByRole('button', { name: /System/ });
    expect(systemToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(systemToggle);
    expect(screen.getByRole('heading', { level: 3, name: 'System failure' }).closest('section'))
      .toHaveAccessibleName('System');
  });

  test('keeps cards free of generic buttons apart from the always-visible dismiss control', async () => {
    const notification = item('event-stalled', 'Stalled task', null, {
      severity: 'warning',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-event-stalled', prNumber: 1724 },
      actions: ['stop', 'follow_up', 'open_pr', 'dismiss'],
      action: {
        type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1724',
      },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    renderInbox();

    const card = await screen.findByRole('article', { name: 'Stalled task' });
    expect(Array.from(card.querySelectorAll('button')).map(button => button.getAttribute('aria-label')))
      .toEqual(['Dismiss Stalled task']);
    expect(screen.getByRole('link', { name: /Stalled task/ })).toHaveAttribute('href', '/tasks/task-event-stalled');
  });

  test('sends /fix from a completed review to its pull request and clears the card', async () => {
    const notification = item('event-review', 'Review completed for PR #1724', null, {
      kind: 'review',
      severity: 'success',
      target: { type: 'review', repository: 'integry/propr', prNumber: 1724, taskId: 'task-review' },
      actions: ['follow_up', 'open_pr', 'dismiss'],
    });
    const request = deferred<Awaited<ReturnType<typeof postTaskFollowup>>>();
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(postTaskFollowup).mockReturnValue(request.promise);
    vi.mocked(dismissNotification).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox();

    const fix = await screen.findByRole('button', { name: 'Send /fix to PR #1724' });
    expect(screen.queryByRole('button', { name: /Send \/review/ })).not.toBeInTheDocument();
    fireEvent.click(fix);
    fireEvent.click(fix);
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
    expect(postTaskFollowup).toHaveBeenCalledWith('task-review', '/fix', 'pull_request');

    await act(async () => request.resolve({ success: true, message: 'Posted' }));
    expect(await screen.findByText('Sent /fix to PR #1724.')).toBeInTheDocument();
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-review'));
    expect(screen.queryByRole('article', { name: 'Review completed for PR #1724' })).not.toBeInTheDocument();
  });

  test('offers /review and /ultrafix after a PR run and opens the pull request on click', async () => {
    const notification = item('event-pr', 'Fix run completed for PR #1724', null, {
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 1724 },
      metadata: { completedImplementationTaskId: 'task-fix', completionType: 'fix' },
      actions: ['follow_up', 'open_pr', 'dismiss'],
      action: {
        type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1724',
      },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(postTaskFollowup).mockRejectedValue(new Error('GitHub unavailable'));
    renderInbox();

    const link = await screen.findByRole('link', { name: /Fix run completed for PR #1724/ });
    expect(link).toHaveAttribute('href', 'https://github.com/integry/propr/pull/1724');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Send /review to PR #1724' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send /ultrafix to PR #1724' }));

    await waitFor(() => expect(postTaskFollowup).toHaveBeenCalledWith('task-fix', '/ultrafix', 'pull_request'));
    expect(await screen.findByText(/Couldn't send \/ultrafix to PR #1724.*GitHub unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Fix run completed for PR #1724' })).toBeInTheDocument();
    expect(dismissNotification).not.toHaveBeenCalled();
  });

  test('expands a system notification in place instead of navigating', async () => {
    const notification = item('event-system', 'System component unhealthy: redis', null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'redis' },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: /System/ }));
    const card = screen.getByRole('button', { name: /System component unhealthy: redis/, expanded: false });
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(markNotificationRead).toHaveBeenCalledWith('event-system');
  });

  test('optimistically dismisses and restores an item advertising dismiss when the request fails', async () => {
    const notification = item('event-1', 'Task one failed', null, { actions: ['dismiss'] });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockRejectedValue(new Error('Network unavailable'));
    renderInbox();

    expect(await screen.findByText('Task one failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Task one failed' }));
    expect(screen.queryByText('Task one failed')).not.toBeInTheDocument();
    expect(await screen.findByText('Task one failed')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't dismiss the notification/)).toBeInTheDocument();
    expect(refreshUnreadCount).toHaveBeenCalledTimes(1);
  });

  test('dismisses silently without an undo toast', async () => {
    const notification = item('event-silent', 'Kick this out');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        dismissedAt: '2026-08-24T12:01:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Kick this out' }));
    expect(screen.queryByText('Kick this out')).not.toBeInTheDocument();
    await waitFor(() => expect(commitUnreadCount).toHaveBeenCalledWith(0));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText(/dismissed/i)).not.toBeInTheDocument();
  });

  test('does not reinsert a dismissed notification when an older refresh finishes afterward', async () => {
    const notification = item('event-refresh-race', 'Stay dismissed');
    const staleRefresh = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: null })
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        dismissedAt: '2026-08-24T12:01:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    await screen.findByText('Stay dismissed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Stay dismissed' }));
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-refresh-race'));

    await act(async () => staleRefresh.resolve({ notifications: [notification], unreadCount: 1, nextCursor: null }));
    expect(screen.queryByText('Stay dismissed')).not.toBeInTheDocument();
  });

  test('swipes a card out in either direction past the threshold without extra affordances', async () => {
    const first = item('event-swipe-right', 'Swipe right');
    const second = item('event-swipe-left', 'Swipe left');
    const short = item('event-swipe-short', 'Short swipe');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [first, second, short], unreadCount: 3, nextCursor: null });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: [first, second].find(candidate => candidate.id === id)!,
      unreadCount: 1,
    }));
    renderInbox();

    const swipe = async (name: string, toX: number) => {
      const surface = (await screen.findByRole('article', { name })).parentElement!;
      fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 20 });
      fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'touch', clientX: toX, clientY: 22 });
      expect(surface.textContent).not.toMatch(/Release|Dismiss/);
      fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'touch', clientX: toX, clientY: 22 });
    };

    await swipe('Swipe right', 270);
    await swipe('Swipe left', 30);
    await swipe('Short swipe', 200);

    expect(screen.queryByText('Swipe right')).not.toBeInTheDocument();
    expect(screen.queryByText('Swipe left')).not.toBeInTheDocument();
    expect(screen.getByText('Short swipe')).toBeInTheDocument();
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledTimes(2));
    expect(dismissNotification).not.toHaveBeenCalledWith('event-swipe-short');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  test('confirms and clears all notifications, including unloaded pages', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [first, second],
      unreadCount: 8,
      nextCursor: 'cursor-with-more-items',
    });
    const clearRequest = deferred<Awaited<ReturnType<typeof dismissAllNotifications>>>();
    vi.mocked(dismissAllNotifications).mockReturnValue(clearRequest.promise);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderInbox();

    const clearAll = await screen.findByRole('button', { name: 'Clear all' });
    fireEvent.click(clearAll);
    expect(dismissAllNotifications).not.toHaveBeenCalled();

    fireEvent.click(clearAll);
    expect(dismissAllNotifications).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Clearing…' })).toBeDisabled();
    await act(async () => clearRequest.resolve({ unreadCount: 0 }));

    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('All notifications cleared.')).toBeInTheDocument();
    expect(commitUnreadCount).toHaveBeenCalledWith(0);
    expect(refreshUnreadCount).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  test('keeps notifications visible when clearing the Inbox fails', async () => {
    const notification = item('event-1', 'Task remains visible');
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [notification], unreadCount: 1, nextCursor: null,
    });
    vi.mocked(dismissAllNotifications).mockRejectedValue(new Error('Network unavailable'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));

    expect(await screen.findByText(/Couldn't clear the Inbox.*Network unavailable/)).toBeInTheDocument();
    expect(screen.getByText('Task remains visible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled();
    confirm.mockRestore();
  });

  test('marks an unread card read while following its deep link', async () => {
    const notification = item('event-1', 'Open this task');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockResolvedValue({
      notification: item('event-1', 'Open this task', '2026-08-24T12:01:00.000Z'),
      unreadCount: 0,
    });
    renderInbox();

    fireEvent.click(await screen.findByRole('link', { name: /Open this task/ }));
    expect(await screen.findByText('Task details')).toBeInTheDocument();
    expect(markNotificationRead).toHaveBeenCalledWith('event-1');
    await waitFor(() => expect(commitUnreadCount).toHaveBeenCalledWith(0));
    await waitFor(() => expect(refreshUnreadCount).toHaveBeenCalledTimes(1));
  });

  test('shows a read failure toast after an internal detail link unmounts the Inbox', async () => {
    const notification = item('event-read-failure', 'Read failure notification');
    const readRequest = deferred<Awaited<ReturnType<typeof markNotificationRead>>>();
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockReturnValue(readRequest.promise);
    renderInbox();

    fireEvent.click(await screen.findByRole('link', { name: /Read failure notification/ }));
    expect(await screen.findByText('Task details')).toBeInTheDocument();
    await act(async () => readRequest.reject(new Error('Read state unavailable')));

    expect(await screen.findByText(/Couldn't mark the notification read.*Read state unavailable/)).toBeInTheDocument();
  });

  test('merges cursor pages without duplicating notifications', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [first, second], unreadCount: 2, nextCursor: null });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second task')).toBeInTheDocument();
    expect(screen.getAllByText('First task')).toHaveLength(1);
  });

  test('keeps cursor pagination available after dismissing every loaded item', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first, second], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [], unreadCount: 0, nextCursor: null });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: id === first.id ? first : second,
      unreadCount: id === first.id ? 1 : 0,
    }));
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss First task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Second task' }));
    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    expect(screen.queryByText('You’re all caught up')).not.toBeInTheDocument();

    fireEvent.click(loadMore);
    await waitFor(() => expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 25 }));
  });

  test('consumes a service-worker dismissal intent', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: item('event-9', 'Dismissed task', '2026-08-24T12:01:00.000Z'),
      unreadCount: 0,
    });
    renderInbox('/inbox?flow=kept&intent=dismiss&notification=event-9');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-9'));
    expect(screen.getByTestId('location')).toHaveTextContent('?flow=kept');
  });

  test('does not reinsert an intent-dismissed item from an older page response', async () => {
    const notification = item('event-race', 'Already dismissed');
    let resolveList!: (value: Awaited<ReturnType<typeof listNotifications>>) => void;
    vi.mocked(listNotifications).mockReturnValue(new Promise(resolve => { resolveList = resolve; }));
    vi.mocked(dismissNotification).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox('/inbox?intent=dismiss&notification=event-race');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-race'));
    resolveList({ notifications: [notification], unreadCount: 1, nextCursor: null });
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    expect(screen.queryByText('Already dismissed')).not.toBeInTheDocument();
    expect(commitUnreadCount).not.toHaveBeenCalledWith(1);
  });

  test('restores an intent-dismissed item when the request fails after the list arrives', async () => {
    const notification = item('event-race', 'Restore this notification');
    const listRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    const dismissRequest = deferred<Awaited<ReturnType<typeof dismissNotification>>>();
    vi.mocked(listNotifications).mockReturnValue(listRequest.promise);
    vi.mocked(dismissNotification).mockReturnValue(dismissRequest.promise);
    renderInbox('/inbox?intent=dismiss&notification=event-race');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-race'));
    await act(async () => listRequest.resolve({ notifications: [notification], unreadCount: 1, nextCursor: null }));
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    await act(async () => dismissRequest.reject(new Error('Dismiss failed')));

    expect(await screen.findByText('Restore this notification')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't dismiss the notification/)).toBeInTheDocument();
  });

  test('reconciles an older refresh response with a completed read mutation', async () => {
    const notification = notificationSchema.parse({
      ...item('event-read-race', 'Read race notification'),
      createdAt: '2026-08-24T12:05:00.000Z',
      action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1937' },
    });
    const staleRefresh = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: null })
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(markNotificationRead).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        readAt: '2026-08-24T12:06:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    await screen.findByText('Read race notification');
    commitUnreadCount.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('link', { name: /Read race notification/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('event-read-race'));
    await act(async () => staleRefresh.resolve({ notifications: [notification], unreadCount: 9, nextCursor: null }));

    await waitFor(() => expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument());
    expect(commitUnreadCount).not.toHaveBeenCalledWith(9);
  });

  test('ignores an error from load-more after a refresh supersedes it', async () => {
    const first = item('event-first', 'First page item');
    const refreshed = item('event-refreshed', 'Refreshed item');
    const final = item('event-final', 'New cursor item');
    const loadMoreRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    const newLoadMoreRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 1, nextCursor: 'cursor-1' })
      .mockReturnValueOnce(loadMoreRequest.promise)
      .mockResolvedValueOnce({ notifications: [refreshed], unreadCount: 2, nextCursor: 'cursor-2' })
      .mockReturnValueOnce(newLoadMoreRequest.promise);
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    expect(await screen.findByText('Refreshed item')).toBeInTheDocument();
    const refreshedLoadMore = screen.getByRole('button', { name: 'Load more' });
    expect(refreshedLoadMore).toBeEnabled();
    fireEvent.click(refreshedLoadMore);
    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    await act(async () => loadMoreRequest.reject(new Error('Superseded page failed')));

    expect(screen.queryByText(/Superseded page failed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    await act(async () => newLoadMoreRequest.resolve({ notifications: [final], unreadCount: 2, nextCursor: null }));
    expect(await screen.findByText('New cursor item')).toBeInTheDocument();
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 });
  });

  test('keeps demo Inbox navigation read-only and hides dismissal', async () => {
    demoState.isDemoMode = true;
    const notification = item('event-demo', 'Demo notification');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    renderInbox();

    expect(await screen.findByText('Demo notification')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss Demo notification' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Demo notification/ }));

    expect(await screen.findByText('Task details')).toBeInTheDocument();
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(dismissNotification).not.toHaveBeenCalled();
  });
});
