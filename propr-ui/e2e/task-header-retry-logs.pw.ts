import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, historicalRun, selectedRun } from './task-list-desktop.fixture';

const execution = (session: string, minutes: number) => ({
  state: 'CLAUDE_EXECUTION', timestamp: ago(minutes),
  promptPath: `/api/execution/${session}/prompt`, logsPath: `/api/execution/${session}/logs`,
  metadata: { model: 'gpt-6-astra', description: `Execution ${session}` },
});
// One queue job: the first attempt fails, the job retries, and the retry completes.
const retriedHistory = [
  { state: 'PENDING', timestamp: ago(10), metadata: { model: 'gpt-6-astra' } },
  execution('failed-attempt', 9.8),
  { state: 'FAILED', timestamp: ago(6), reason: 'Agent container interrupted' },
  { state: 'PENDING', timestamp: ago(5.9) },
  execution('successful-retry', 5.8),
  { state: 'COMPLETED', timestamp: ago(1) },
];
const taskInfo = { title: 'Review the desktop acceptance task', type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' };

/** Opens a run's task page and records which executions the header reads. */
const openRun = async (page: Page, run: string) => {
  await fixture(page, 'linux');
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: { history: retriedHistory, taskInfo } }));
  await page.route(`**/api/task/${historicalRun}/history`, route => route.fulfill({ json: {
    history: [{ state: 'PENDING', timestamp: ago(40) }, execution('earlier-run', 39.8), { state: 'COMPLETED', timestamp: ago(36) }],
    taskInfo: { ...taskInfo, title: 'Review an earlier run' },
  } }));
  const sessions: string[] = [];
  await page.route('**/api/execution/*/*', route => {
    const [, , , session, kind] = new URL(route.request().url()).pathname.split('/');
    sessions.push(`${session}/${kind}`);
    return kind === 'logs'
      ? route.fulfill({ json: { sessionId: session, logFiles: [{ name: `${session}.log`, path: `/api/execution/${session}/logs/${session}.log`, size: 512, type: 'log' }] } })
      : route.fulfill({ json: { prompt: `Prompt of ${session}` } });
  });
  await page.goto(`/tasks/${run}`);
  return sessions;
};

/** The header's Logs: a button on wide layouts, an item of the task's action sheet on phones. */
const openLogs = async (page: Page) => {
  const details = page.getByTestId('task-details');
  await expect(details.getByRole('heading', { level: 2 }).filter({ visible: true }).first()).toBeVisible();
  const logs = details.getByRole('button', { name: 'Logs', exact: true }).filter({ visible: true });
  if (await logs.count()) return logs.first().click();
  await details.getByRole('button', { name: 'More task actions' }).filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Logs' }).click();
};

for (const width of [1280, 390, 320]) {
  test(`at ${width}px the header opens the successful retry's logs, not the failed attempt's`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    const sessions = await openRun(page, selectedRun);
    await openLogs(page);
    await expect(page.getByRole('heading', { name: 'Log Files' })).toBeVisible();
    await expect(page.getByText('successful-retry.log')).toBeVisible();
    expect(sessions).toEqual(['successful-retry/logs']);
    await capture(page, `task-header-retry-logs-${width}`);
  });
}

test('an earlier run keeps its own execution in the header', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const sessions = await openRun(page, historicalRun);
  await openLogs(page);
  await expect(page.getByText('earlier-run.log')).toBeVisible();
  expect(sessions).toEqual(['earlier-run/logs']);
});
