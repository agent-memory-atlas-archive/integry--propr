import { expect, test } from '@playwright/test';
import { ago, detailsHistory, fixture, selectedRun, tasks } from './task-list-desktop.fixture';

test('a laptop-width task pane keeps a long repository name readable beside its actions', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await fixture(page, 'linux');
  await page.route('**/api/tasks', route => route.fulfill({ json: {
    tasks: tasks.map(task => task.id === selectedRun ? { ...task, status: 'completed' } : task),
    total: 1842, totalRuns: 14769,
  } }));
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0), promptPath: '/tmp/acceptance-prompt.md', logsPath: '/tmp/acceptance.log' }],
    taskInfo: {
      title: 'Review the desktop acceptance task', type: 'pr', number: 2664, issueNumber: 2664,
      repoOwner: 'propr-ultrafix', repoName: 'propr-desktop-acceptance-20260909', modelName: 'gpt-6-astra',
    },
  } }));
  await page.goto('/tasks');
  await page.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  const identity = page.getByTestId('task-split-details').getByTestId('task-header-identity');
  const repository = identity.getByRole('link', { name: 'propr-ultrafix/propr-desktop-acceptance-20260909' });
  await expect(repository).toBeVisible();
  await expect(identity.getByRole('button', { name: 'Prompt', exact: true })).toBeVisible();
  await expect(identity.getByRole('button', { name: 'Logs', exact: true })).toBeVisible();
  await expect(identity.getByRole('button', { name: /Follow Up/ })).toBeVisible();
  await expect(identity.getByRole('button', { name: 'Close task details' })).toBeVisible();
  const widths = await identity.evaluate(element => ({
    context: element.firstElementChild!.getBoundingClientRect().width,
    repository: element.querySelector('a[href*="propr-desktop-acceptance"]')!.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(widths.context).toBeGreaterThanOrEqual(192);
  expect(widths.repository).toBeGreaterThanOrEqual(192);
  expect(widths.overflow).toBe(false);
});
