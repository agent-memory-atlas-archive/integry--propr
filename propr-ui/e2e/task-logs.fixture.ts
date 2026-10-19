/** A completed task with a long output log and a follow-up destination, as the Logs and Follow Up dialogs read it. */
import { expect, type Locator, type Page } from '@playwright/test';
import { ago, fixture as taskFixture } from './task-list-desktop.fixture';

export const taskId = 'issue-3243-run-0';
const sessionId = 'session-issue-3243-run-0';
// The files a run writes, named as production names them: the selected output file's
// name wraps to two lines on the phone.
export const outputName = 'issue-28-2026-10-17T21-15-00-788Z-output.txt';
export const conversationName = 'issue-28-2026-10-17T21-15-00-788Z-conversation.json';
// A long output with six matches, the last a few lines from its end.
export const outputLines = Array.from({ length: 400 }, (_, line) => line % 79 === 0 && line > 0 || line === 396
  ? `[INFO] step ${line}: acceptance check passed for the changed files` : `[INFO] step ${line}: running npm test --workspace propr-ui -- --reporter=dot`);

export async function stubTask(page: Page, posts: string[]) {
  await taskFixture(page);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51), logsPath: `/api/execution/${sessionId}/logs` },
    ],
    taskInfo: { title: 'Keep mobile dialog controls visible', type: 'issue', number: 3243, issueNumber: 3243, repoOwner: 'integry', repoName: 'propr',
      followupTarget: { taskId, repository: 'integry/propr', kind: 'issue', number: 3243 } },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/execution/${sessionId}/logs`, route => route.fulfill({ json: {
    sessionId, files: { conversation: `/var/log/propr/${conversationName}`, output: `/var/log/propr/${outputName}` },
  } }));
  await page.route(`**/api/execution/${sessionId}/logs/output`, route => route.fulfill({ contentType: 'text/plain', body: outputLines.join('\n') }));
  await page.route(`**/api/execution/${sessionId}/logs/conversation`, route => route.fulfill({ contentType: 'text/plain', body: JSON.stringify({ message: 'acceptance' }) }));
  // The comment posts but its dispatch fails: the dialog shows the receipt instead of closing.
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 202, json: { success: false, state: 'failed', posted: true, commentId: 4243001, sourceTaskId: taskId, message: 'Comment posted, but the command failed before submission.' } });
  });
}

/** Opens a task header action, directly or from the phone's action sheet; returns the control focus returns to. */
export async function openTaskAction(page: Page, title: string, label: string): Promise<Locator> {
  const direct = page.locator(`button[title^="${title}"]`).filter({ visible: true });
  const more = page.getByRole('button', { name: /more (task )?actions/i }).filter({ visible: true });
  await expect(direct.or(more).first()).toBeVisible();
  if (await direct.count()) { await direct.first().click(); return direct.first(); }
  await more.first().click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return more.first();
}

/** The full-screen layer a task dialog is framed in. */
export const layerOf = (dialog: Locator) => dialog.locator('xpath=ancestor::div[contains(@class, "app-modal-layer")]');
