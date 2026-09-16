import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const timestamp = '2026-09-16T20:00:00.000Z';
const user = {
  id: 'inbox-preview-user', login: 'operator', username: 'operator',
  displayName: 'Inbox operator', email: null, avatarUrl: null, role: 'admin',
  permissions: ['instance.manage_settings'], authorizationSource: 'local',
};

const notifications = [
  {
    id: 'review-81', deduplicationKey: 'review-81', kind: 'review', severity: 'success',
    target: { type: 'review', repository: 'integry/propr', prNumber: 81, taskId: 'review-task-81' },
    title: 'Review completed for PR #81',
    body: 'Score 8/10 · 2 issues found: Restore unread count on undo; Ignore vertical touch movement',
    actions: ['follow_up', 'open_pr', 'dismiss'],
    action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/81' },
    occurredAt: timestamp, createdAt: timestamp, readAt: null, dismissedAt: null,
  },
  {
    id: 'fix-81', deduplicationKey: 'fix-81', kind: 'pull_request', severity: 'info',
    target: { type: 'pull_request', repository: 'integry/propr', prNumber: 81 },
    metadata: { completedImplementationTaskId: 'fix-task-81', completionType: 'fix' },
    title: 'Fix run completed for PR #81',
    body: 'Corrected the unread-count race and added touch gesture regression coverage.',
    actions: ['open_pr', 'dismiss'],
    action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/81' },
    occurredAt: '2026-09-16T19:55:00.000Z', createdAt: '2026-09-16T19:55:00.000Z',
    readAt: '2026-09-16T19:56:00.000Z', dismissedAt: null,
  },
  {
    id: 'plan-inbox', deduplicationKey: 'plan-inbox', kind: 'plan', severity: 'success',
    target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-inbox' },
    title: 'Plan ready for review',
    body: '“Improve Inbox notifications” is ready with 4 planned tasks.',
    actions: ['refine', 'approve_execute', 'dismiss'],
    occurredAt: '2026-09-16T19:45:00.000Z', createdAt: '2026-09-16T19:45:00.000Z',
    readAt: null, dismissedAt: null,
  },
];

async function stubInbox(page: Page): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const restoreMatch = path.match(/^\/api\/notifications\/([^/]+)\/restore$/);
    const dismissMatch = path.match(/^\/api\/notifications\/([^/]+)\/dismiss$/);
    if (restoreMatch) {
      const notification = notifications.find(item => item.id === decodeURIComponent(restoreMatch[1]))!;
      return route.fulfill({ json: { notification, unreadCount: 2 } });
    }
    if (dismissMatch) {
      const notification = notifications.find(item => item.id === decodeURIComponent(dismissMatch[1]))!;
      return route.fulfill({ json: {
        notification: { ...notification, dismissedAt: '2026-09-16T20:01:00.000Z' },
        unreadCount: 1,
      } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/notifications': { notifications, unreadCount: 2, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 2 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': {
        preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false,
      },
      '/api/instance/catalog': { repositories: [], agents: [] },
      '/api/status': { status: 'ok' },
    };
    return route.fulfill(path in responses
      ? { json: responses[path] }
      : { status: 503, json: { error: 'Optional API unavailable in Inbox fixture' } });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}` });
}

test('touch swipe reveals the dismissal affordance beside a rich review recap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubInbox(page);
  await page.goto('/inbox');
  const card = page.getByRole('article', { name: 'Review completed for PR #81' });
  await expect(card.getByText('Score 8/10 · 2 issues found', { exact: false })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const surface = card.locator('..');
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await surface.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', clientX: box!.x + 16, clientY: box!.y + 80,
  });
  await surface.dispatchEvent('pointermove', {
    pointerId: 1, pointerType: 'touch', clientX: box!.x + 150, clientY: box!.y + 82,
  });
  await expect(page.getByText('Release')).toBeVisible();
  await capture(page, 'inbox-swipe-mobile.png');
  await surface.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'touch' });
});

test('desktop dismissal keeps rich recaps visible and offers Undo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubInbox(page);
  await page.goto('/inbox');
  const dismissButton = page.getByRole('button', { name: 'Dismiss Fix run completed for PR #81' });
  await expect(dismissButton).toBeVisible();
  await dismissButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Fix run completed for PR #81' })).toHaveCount(0);
  await expect(page.getByText('Score 8/10 · 2 issues found', { exact: false })).toBeVisible();
  await capture(page, 'inbox-undo-desktop.png');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('article', { name: 'Fix run completed for PR #81' })).toBeVisible();
});
