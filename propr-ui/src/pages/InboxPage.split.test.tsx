import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import { ToastProvider } from '../components/ui/Toast';
import InboxPage from './InboxPage';
import { dismissNotification, listNotifications } from '../api/notificationApi';
import { getFileChanges } from '../api/fileChangesApi';
import { postTaskFollowup } from '../api/proprApi';

vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({
    unreadCount: 3,
    commitUnreadCount: vi.fn(),
    refreshUnreadCount: vi.fn(async () => undefined),
    isActiveIdentity: () => true,
  }),
}));
vi.mock('../api/notificationApi', () => ({
  listNotifications: vi.fn(),
  dismissAllNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../api/fileChangesApi', () => ({ getFileChanges: vi.fn() }));
vi.mock('../api/proprApi', () => ({ postTaskFollowup: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: true, onNotificationUpdate: () => () => undefined }),
}));
// The verdict card must never be the task workbench; if anything mounts it, this says so.
vi.mock('../components/TaskDetails', () => ({
  default: () => <div data-testid="task-details">TaskDetails</div>,
}));

const at = (minutes: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') - minutes * 60_000).toISOString();

function item(id: string, minutes: number, overrides: Record<string, unknown>): Notification {
  return notificationSchema.parse({
    id,
    deduplicationKey: `${id}-key`,
    severity: 'success',
    title: id,
    body: '',
    occurredAt: at(minutes),
    createdAt: at(minutes),
    readAt: at(0),
    dismissedAt: null,
    actions: ['follow_up', 'open_pr', 'dismiss'],
    ...overrides,
  });
}

const review = item('review-3057', 18, {
  kind: 'review',
  target: { type: 'review', repository: 'integry/propr', prNumber: 3057, taskId: 'task-3057' },
  title: 'Draft validation: integrate Linux fixes',
  body: 'Score 6/10 · 2 issues found: packages/cli/test/model.test.ts:42 Uncaught layout expectation; Clear expiry feedback',
  action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/3057' },
});
const ready = item('ready-3063', 20, {
  kind: 'pull_request', severity: 'info',
  target: { type: 'pull_request', repository: 'integry/propr', prNumber: 3063 },
  metadata: { completedImplementationTaskId: 'task-3063' },
  title: 'Mobile footer and menu redesign',
  body: '1 preview available',
});
const failed = item('failed-3049', 28, {
  kind: 'task', severity: 'error',
  target: { type: 'task', repository: 'integry/propr', taskId: 'task-3049', issueNumber: 3049 },
  title: 'GraphQL denied issue creation',
  body: 'Work did not complete.',
  actions: ['dismiss'],
});
const queue = [review, ready, failed];

const Location = () => <output data-testid="location">{useLocation().search}</output>;
const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '');

function renderInbox(entry = '/inbox') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inbox" element={<><InboxPage /><Location /></>} />
          <Route path="/tasks/:id" element={<div>Task page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

function mockViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

const row = (title: string) => within(screen.getByRole('article', { name: title })).getByRole('button', { name: title });
const pane = () => screen.queryByRole('region', { name: 'Triage verdict' });

describe('Inbox triage console', () => {
  beforeEach(() => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: queue, unreadCount: 0, nextCursor: null });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: { ...queue.find(entry => entry.id === id)!, dismissedAt: at(0) } as Notification, unreadCount: 0,
    }));
    vi.mocked(getFileChanges).mockResolvedValue({
      taskId: 'task-3057', lastUpdated: at(0),
      files: [{
        path: 'packages/cli/test/model.test.ts', status: 'modified', linesAdded: 1, linesRemoved: 1,
        diff: "--- a/x\n+++ b/x\n@@ -42 +42 @@\n-expect(model).toBe('default');\n+expect(model).toBe('claude-opus-5.5');",
      }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('keeps the queue full width until a row is selected', async () => {
    mockViewport(true);
    renderInbox();
    await screen.findByRole('article', { name: review.title });
    expect(screen.getByTestId('inbox-split-workspace')).toBeInTheDocument();
    expect(pane()).not.toBeInTheDocument();
  });

  test('a click opens the verdict beside the queue and writes ?notification= without a list read', async () => {
    mockViewport(true);
    renderInbox('/inbox?repository=integry%2Fpropr');
    await screen.findByRole('article', { name: review.title });
    expect(listNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(row(review.title));

    expect(search().get('notification')).toBe(review.id);
    expect(search().get('repository')).toBe('integry/propr');
    expect(row(review.title)).toHaveAttribute('aria-current', 'true');
    const card = within(pane()!);
    expect(card.getByRole('heading', { name: /Review verdict: 2 findings \(Score 6\/10\)/ })).toBeInTheDocument();
    expect(card.getByText('packages/cli/test/model.test.ts:42')).toBeInTheDocument();
    expect(card.getByText('Uncaught layout expectation')).toBeInTheDocument();
    expect(card.getByText('Clear expiry feedback')).toBeInTheDocument();
    expect(card.queryByText(/more findings? in Tasks/)).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: 'PR #3057 on GitHub' })).toHaveAttribute('href', 'https://github.com/integry/propr/pull/3057');
    expect(card.getByRole('link', { name: /Inspect in Tasks/ })).toHaveAttribute('href', '/tasks/task-3057');
    expect(card.getByRole('button', { name: 'Send /fix to PR #3057' })).toBeInTheDocument();
    expect(await card.findByText(/claude-opus-5\.5/)).toBeInTheDocument();
    expect(getFileChanges).toHaveBeenCalledTimes(1);
    expect(getFileChanges).toHaveBeenCalledWith('task-3057');
    expect(screen.queryByTestId('task-details')).not.toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  test('restores the selection from the URL, shows the body without findings, and omits Inspect without a task', async () => {
    mockViewport(true);
    const plan = item('plan-1', 30, {
      kind: 'plan', target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-1' },
      title: 'Improve the Inbox', body: 'Ready for review with 4 planned tasks.', actions: ['dismiss'],
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [...queue, plan], unreadCount: 0, nextCursor: null });
    renderInbox('/inbox?notification=plan-1');
    await screen.findByRole('article', { name: plan.title });
    const card = within(pane()!);
    expect(card.getByText('Ready for review with 4 planned tasks.')).toBeInTheDocument();
    expect(card.queryByRole('link', { name: /Inspect in Tasks/ })).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(getFileChanges).not.toHaveBeenCalled();
  });

  test('the verdict heading counts every issue the recap reports, not just the titles it lists', async () => {
    mockViewport(true);
    const truncated = item('review-2519', 32, {
      kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2519, taskId: 'task-2519' },
      title: 'Retry webhook deliveries', body: 'Score 3/10 · 4 issues found: Retries never back off; Delivery ids are reused',
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [...queue, truncated], unreadCount: 0, nextCursor: null });
    renderInbox('/inbox?notification=review-2519');
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(card.getByRole('heading', { name: 'Review verdict: 4 findings (Score 3/10)' })).toBeInTheDocument();
    expect(card.getAllByRole('listitem')).toHaveLength(2);
    expect(card.getByText('2 more findings in Tasks')).toBeInTheDocument();
  });

  test('a failed diff read still shows the verdict and the buttons', async () => {
    mockViewport(true);
    vi.mocked(getFileChanges).mockRejectedValue(new Error('unavailable'));
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    await waitFor(() => expect(getFileChanges).toHaveBeenCalled());
    expect(card.getByText('Uncaught layout expectation')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Inspect in Tasks/ })).toBeInTheDocument();
    expect(card.queryByText(/Visual diff/)).not.toBeInTheDocument();
  });

  test('j/k and the arrows step through the queue, Esc closes the pane, and fields keep their keys', async () => {
    mockViewport(true);
    renderInbox();
    await screen.findByRole('article', { name: review.title });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(pane()).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j' });
    expect(search().get('notification')).toBe(review.id);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(search().get('notification')).toBe(failed.id);
    fireEvent.keyDown(window, { key: 'j' });
    expect(search().get('notification')).toBe(failed.id);
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(search().get('notification')).toBe(review.id);

    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'j' });
    expect(search().get('notification')).toBe(review.id);
    field.remove();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(search().get('notification')).toBeNull();
    expect(pane()).not.toBeInTheDocument();
  });

  test('dismissing opens the next item, the last one opens the previous, and an empty queue closes the pane', async () => {
    mockViewport(true);
    renderInbox(`/inbox?notification=${ready.id}`);
    await screen.findByRole('article', { name: ready.title });
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(search().get('notification')).toBe(failed.id));
    expect(screen.queryByRole('article', { name: ready.title })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Dismiss ${failed.title}` }));
    await waitFor(() => expect(search().get('notification')).toBe(review.id));

    fireEvent.keyDown(window, { key: 'x' });
    await waitFor(() => expect(pane()).not.toBeInTheDocument());
    expect(search().get('notification')).toBeNull();
    expect(screen.getByText('You’re all caught up')).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  test('sending a follow-up command dismisses the card and opens the next item', async () => {
    mockViewport(true);
    vi.mocked(postTaskFollowup).mockResolvedValue(undefined as never);
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    await act(async () => {
      fireEvent.click(within(pane()!).getByRole('button', { name: 'Send /fix to PR #3057' }));
    });
    expect(postTaskFollowup).toHaveBeenCalledWith('task-3057', '/fix', 'pull_request');
    await waitFor(() => expect(search().get('notification')).toBe(ready.id));
    expect(dismissNotification).toHaveBeenCalledWith(review.id);
  });

  test('narrow viewports keep the single column and rows navigate', async () => {
    mockViewport(false);
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    expect(screen.queryByTestId('inbox-split-workspace')).not.toBeInTheDocument();
    expect(pane()).not.toBeInTheDocument();
    const link = within(screen.getByRole('article', { name: failed.title })).getByRole('link', { name: failed.title });
    expect(link).toHaveAttribute('href', '/tasks/task-3049');
    fireEvent.keyDown(window, { key: 'j' });
    expect(pane()).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(await screen.findByText('Task page')).toBeInTheDocument();
  });
});
