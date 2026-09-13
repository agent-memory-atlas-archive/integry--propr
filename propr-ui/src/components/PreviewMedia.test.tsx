import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { parseISO8601Timestamp, type Notification } from '@propr/shared';
import { PreviewThumbnails } from './PreviewMedia';
import { ParentTaskRow, ChildTaskRow } from './TaskList/TaskRows';
import { MobileTaskCard } from './TaskList/MobileTaskCard';
import { InboxCard } from '../pages/InboxPageComponents';

vi.mock('./Inbox/NotificationActions', () => ({ default: () => null }));
const media = Array.from({ length: 5 }, (_, i) => ({ title: `Published screen ${i}`, type: 'image' as const, url: `https://github.com/user-attachments/assets/screen-${i}` }));
const task = { id: 'task-1', status: 'completed', title: 'Ship media', createdAt: '2026-09-13', previewMedia: media };
const group = { key: 'one', repoOwner: 'acme', repoName: 'web', tasks: [task] };

describe('preview thumbnails', () => {
  it('limits trusted images, provides alt text and handles unavailable images', () => {
    render(<PreviewThumbnails media={[{ ...media[0], url: 'https://evil.test/image.png' }, ...media]} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByAltText('Published screen 0')).toHaveAttribute('loading', 'lazy');
    fireEvent.error(screen.getByAltText('Published screen 0'));
    expect(screen.getByRole('img', { name: /screen 0 — image unavailable/ })).toBeInTheDocument();
  });
  it('renders nothing for legacy or disabled projections', () => {
    const { container } = render(<PreviewThumbnails />);
    expect(container).toBeEmptyDOMElement();
  });
  it('uses explicit video treatment without video playback in compact rows', () => {
    const { container } = render(<PreviewThumbnails media={[{ ...media[0], type: 'video' }]} />);
    expect(screen.getByRole('img', { name: /Video preview: Published screen 0/ })).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });
  it.each([false, true])('renders 3 previews in parent and child rows (desktop=%s)', desktopLayout => {
    render(<table><tbody><ParentTaskRow group={group} task={task} desktopLayout={desktopLayout} onRowClick={vi.fn()} /><ChildTaskRow task={task} desktopLayout={desktopLayout} onRowClick={vi.fn()} /></tbody></table>);
    for (const row of screen.getAllByRole('row')) expect(within(row).getAllByRole('img', { name: /Published screen/ })).toHaveLength(3);
  });
  it('renders 3 previews in the mobile task layout', () => {
    render(<MobileTaskCard group={group} expandedGroups={new Set()} onRowClick={vi.fn()} onToggleGroup={vi.fn()} />);
    expect(screen.getAllByRole('img', { name: /Published screen/ })).toHaveLength(3);
  });
  it.each([['task', 'success', 1], ['task', 'error', 0], ['task', 'warning', 0], ['review', 'success', 0], ['plan', 'success', 0]])('Inbox %s/%s shows %s previews', (kind, severity, count) => {
    const notification = { id: 'n-1', kind, severity, target: { type: kind, repository: 'acme/web', taskId: 'task-1' }, readAt: null,
      title: 'Task completed', body: 'Ready to review', occurredAt: '2026-09-13', previewMedia: media } as Notification;
    render(<MemoryRouter><InboxCard notification={notification} onDismiss={vi.fn()} onOpen={vi.fn()} onChanged={vi.fn()} mutationsEnabled={false} /></MemoryRouter>);
    expect(screen.queryAllByRole('img', { name: /Published screen/ })).toHaveLength(count);
  });
  it.each([
    { completion: true, enabled: true, count: 1 },
    { completion: true, enabled: false, count: 0 },
    { completion: false, enabled: true, count: 0 },
  ])('PR Inbox completion=$completion enabled=$enabled shows $count previews', ({ completion, enabled, count }) => {
    const onOpen = vi.fn();
    const notification: Notification = {
      id: 'pr-completion', deduplicationKey: 'pr-completion', kind: 'pull_request', severity: 'info',
      target: { type: 'pull_request', repository: 'acme/web', prNumber: 42 },
      title: 'Implement repository media', body: 'PR #42 is ready for review.',
      actions: ['open_pr', 'dismiss'],
      action: { type: 'external_link', label: 'Open PR', href: 'https://github.com/acme/web/pull/42' },
      occurredAt: parseISO8601Timestamp('2026-09-13T12:00:00.000Z'), createdAt: parseISO8601Timestamp('2026-09-13T12:00:00.000Z'),
      readAt: null, dismissedAt: null,
      ...(completion ? { metadata: { completedImplementationTaskId: 'implementation-1' } } : {}),
      ...(enabled ? { previewMedia: media } : {}),
    };
    render(<MemoryRouter><InboxCard notification={notification} onDismiss={vi.fn()} onOpen={onOpen} onChanged={vi.fn()} mutationsEnabled={false} /></MemoryRouter>);
    expect(screen.queryAllByRole('img', { name: /Published screen/ })).toHaveLength(count);
    const details = screen.getByRole('link', { name: 'View details' });
    expect(details).toHaveAttribute('href', '/repositories');
    fireEvent.click(details);
    expect(onOpen).toHaveBeenCalledWith(notification.id);
  });
});
