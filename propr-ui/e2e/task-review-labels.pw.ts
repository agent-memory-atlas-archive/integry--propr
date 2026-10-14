import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture, tasks, selectedRun, detailsHistory } from './task-list-desktop.fixture';

test('a running review with a follow-up title is marked Review throughout the task workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  const title = 'Follow-up PR #2664: Check withdrawal handling';
  await page.route('**/api/tasks?**', route => route.fulfill({ json: {
    tasks: tasks.filter(task => task.id.startsWith('pr-2664-')).map(task => task.id === selectedRun
      ? { ...task, title, subtitle: 'Follow-up requested without additional context', commandMode: 'review' }
      : task), total: 1,
  } }));
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: detailsHistory.map(item => ({ ...item, metadata: { model: 'gpt-6-astra' } })),
    taskInfo: { title, subtitle: 'Follow-up requested without additional context', commandMode: 'review',
      type: 'pr', number: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
  } }));
  await page.route(`**/api/task/${selectedRun}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.goto(`/tasks?task=${selectedRun}`);
  const card = page.getByTestId('task-card').first();
  await expect(card.getByText('Review', { exact: true }).first()).toBeVisible();
  await expect(card.getByText('Implementing', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('task-status-badge')).toHaveText('Review');
  await expect(page.getByText('Reviewing', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Implementing Changes', { exact: true })).toHaveCount(0);
  if (process.env.PROPR_CAPTURE_PREVIEWS === '1') {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ path: '../.propr/previews/review-task-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    await expect(page.getByTestId('task-card').first().getByText('Review', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: '../.propr/previews/review-task-mobile.png' });
  }
});
