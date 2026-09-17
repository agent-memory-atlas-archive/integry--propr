import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { notificationSchema } from '@propr/shared';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { postTaskFollowup } from '../../api/proprApi';
import { ToastProvider } from '../ui/Toast';
import { notificationFollowupCommand } from '../../pages/inboxUtils';
import NotificationActions from './NotificationActions';

vi.mock('../../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
}));

function notification(overrides: Record<string, unknown>) {
  return notificationSchema.parse({
    id: 'event-1',
    deduplicationKey: 'key-1',
    kind: 'task',
    severity: 'success',
    target: { type: 'task', repository: 'integry/propr', taskId: 'task-1', issueNumber: 7 },
    title: 'Task',
    body: 'Task lifecycle update.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    actions: ['follow_up', 'stop', 'open_pr', 'dismiss'],
    ...overrides,
  });
}

const review = notification({
  kind: 'review',
  title: 'Review completed for PR #12',
  target: { type: 'review', repository: 'integry/propr', prNumber: 12, taskId: 'task-review' },
});

describe('Notification follow-up commands', () => {
  beforeEach(() => {
    vi.mocked(postTaskFollowup).mockReset();
  });

  test('offers commands only for finished reviews and pull-request runs', () => {
    expect(notificationFollowupCommand(notification({}))).toBeNull();
    expect(notificationFollowupCommand(review)?.commands).toEqual(['/fix']);
    expect(notificationFollowupCommand(notification({ ...review, actions: ['dismiss'] }))).toBeNull();
    expect(notificationFollowupCommand(notification({
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 12 },
      metadata: { completedImplementationTaskId: 'task-implementation' },
    }))).toEqual({ taskId: 'task-implementation', prNumber: 12, commands: ['/review', '/ultrafix'] });
    expect(notificationFollowupCommand(notification({
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 12 },
    }))).toBeNull();
  });

  test('sends the command to the pull request and hands the finished card back for removal', async () => {
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, message: 'Posted' });
    const onCommandSent = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <NotificationActions notification={review} mutationsEnabled onCommandSent={onCommandSent} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #12' }));

    await waitFor(() => expect(onCommandSent).toHaveBeenCalledTimes(1));
    expect(postTaskFollowup).toHaveBeenCalledWith('task-review', '/fix', 'pull_request');
    expect(screen.getByText('Sent /fix to PR #12.')).toBeInTheDocument();
  });

  test('renders nothing in read-only mode', () => {
    render(
      <ToastProvider>
        <NotificationActions notification={review} mutationsEnabled={false} onCommandSent={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
