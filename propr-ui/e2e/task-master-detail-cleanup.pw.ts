import { expect, test } from '@playwright/test';
import { capture, fixture, selectedRun, detailsEvents, detailsHistory } from './task-list-desktop.fixture';

for (const width of [1333, 1584]) {
  test(`master-detail keeps filters, telemetry and terminal visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.route(`**/api/task/${selectedRun}/live-details`, route => route.fulfill({ json: {
      events: detailsEvents.map(event => event.type === 'thought' ? { ...event, content: `**Result:** ${event.content}` } : event),
      todos: [], currentTask: null,
    } }));
    await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
      history: detailsHistory.map(event => ({ ...event, metadata: { model: 'gpt-6-astra' } })),
      taskInfo: { title: 'Task master-detail cleanup', type: 'issue', number: 3016, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
    } }));
    await page.goto(`/tasks?repository=integry%2Fpropr&assignee=octocat&task=${selectedRun}`);
    const list = page.getByTestId('task-split-list');
    await expect(list.locator('.task-repo-filter > button')).toContainText('propr');
    await expect(list.locator('.task-assignee-filter-label')).toBeVisible();
    await expect(list.locator('.task-assignee-filter-label')).toHaveText('@octocat');
    const repoLabel = list.locator('.task-repo-filter > button > :nth-child(2)');
    expect(await repoLabel.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(40);
    const consumption = page.getByRole('group', { name: 'Consumption' });
    await expect(consumption).toContainText('↑0↓0');
    await expect(consumption).toContainText('Quota unavailable');
    const trace = page.locator('#thinking-log-section');
    await expect(trace).toContainText('Linting flagged the withdrawal handler');
    await expect(trace).not.toContainText('Result:');
    const terminal = page.locator('#execution-event-log-section');
    await expect(terminal).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    await expect(terminal.getByRole('button').first()).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `master-detail-filtered-${width}`);
    await terminal.getByRole('button', { name: /EXECUTION LOG/ }).click();
    await expect(page.locator('#execution-event-log-content')).toHaveCSS('background-color', 'rgb(9, 9, 11)');
    await capture(page, `master-detail-terminal-${width}`);
    await page.goto(`/tasks?task=${selectedRun}`);
    await expect(list.locator('.task-repo-filter > button')).toContainText('All Repos');
    await expect(list.locator('.task-assignee-filter-label')).toBeVisible();
    await expect(list.locator('.task-assignee-filter-label')).toHaveText('All assignees');
  });
}
