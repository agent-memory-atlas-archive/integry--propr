/**
 * Follow Up on Task, the Logs viewer and the mobile Create sheet's New To-do form keep
 * their header and close control inside the visible area while an on-screen keyboard
 * shrinks and pans the visual viewport, and restore their layout once it closes.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, fixture as taskFixture } from './task-list-desktop.fixture';
import { fixture as todoFixture } from './quick-add-todo.fixture';
import { captureVisible, expectFieldVisible, expectShown, expectUnframed, installKeyboardViewport, listenerCount, setKeyboard, type Band } from './keyboard-viewport.fixture';

// Measured on a Samsung SM-S908B in Chrome 155: the layout viewport stays 384×692 while
// the keyboard leaves these visible bands for each dialog's focused field.
const layout = { width: 384, height: 692 };
const full: Band = { height: layout.height, offsetTop: 0 };
const followupBand: Band = { height: 382.133, offsetTop: 146.4 };
const logsBand: Band = { height: 318.133, offsetTop: 185.333 };
const todoBand: Band = { height: 382.133, offsetTop: 310.667 };
// Rotated to 692×384 with the keyboard still open.
const landscape: Band = { height: 180, offsetTop: 204 };

test.use({ viewport: layout, isMobile: true, hasTouch: true });

const taskId = 'issue-3243-run-0';
const sessionId = 'session-issue-3243-run-0';
const eventsName = 'issue-3243-execution-events.log';
const conversationName = 'issue-3243-conversation.json';
const eventLines = Array.from({ length: 80 }, (_, line) => line % 13 === 4 ? `[INFO] step ${line}: acceptance check passed` : `[INFO] step ${line}: working`);

async function stubTask(page: Page, posts: string[]) {
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
    sessionId, files: { events: `/var/log/propr/${eventsName}`, conversation: `/var/log/propr/${conversationName}` },
  } }));
  await page.route(`**/api/execution/${sessionId}/logs/events`, route => route.fulfill({ contentType: 'text/plain', body: eventLines.join('\n') }));
  await page.route(`**/api/execution/${sessionId}/logs/conversation`, route => route.fulfill({ contentType: 'text/plain', body: JSON.stringify({ message: 'acceptance' }) }));
  // The comment posts but its dispatch fails: the dialog shows the receipt instead of closing.
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 202, json: { success: false, state: 'failed', posted: true, commentId: 4243001, sourceTaskId: taskId, message: 'Comment posted, but the command failed before submission.' } });
  });
}

/** Opens a task header action, directly or from the phone's action sheet; returns the control focus returns to. */
async function openTaskAction(page: Page, title: string, label: string): Promise<Locator> {
  const direct = page.locator(`button[title^="${title}"]`).filter({ visible: true });
  const more = page.getByRole('button', { name: /more (task )?actions/i }).filter({ visible: true });
  await expect(direct.or(more).first()).toBeVisible();
  if (await direct.count()) { await direct.first().click(); return direct.first(); }
  await more.first().click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return more.first();
}

const layerOf = (dialog: Locator) => dialog.locator('xpath=ancestor::div[contains(@class, "app-modal-layer")]');

test('Follow Up on Task keeps its heading and close above the keyboard, keeps the draft and destination, and shows the receipt', async ({ page }) => {
  const posts: string[] = [];
  await installKeyboardViewport(page, layout);
  await stubTask(page, posts);
  await page.goto(`/tasks/${taskId}`);
  const idle = await listenerCount(page);
  await openTaskAction(page, 'Follow Up', 'Follow Up');
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  const heading = dialog.getByRole('heading', { name: 'Follow Up on Task' });
  const close = dialog.getByRole('button', { name: 'Close follow-up dialog' });
  const comment = dialog.getByRole('textbox', { name: 'Comment' });
  const post = dialog.getByRole('button', { name: 'Post Comment' });
  const layer = layerOf(dialog);
  await expect(comment).toBeFocused();
  const before = (await close.boundingBox())!;
  await comment.fill('');

  await setKeyboard(page, followupBand);
  await comment.pressSequentially('Short follow-up draft');
  await expectShown([heading, close, dialog.getByRole('button', { name: 'Cancel' }), post], followupBand);
  await expectFieldVisible(comment, followupBand);
  await expect(comment).toBeFocused();
  await expect(dialog).toHaveAccessibleDescription('Post a comment to Issue integry/propr#3243');
  await captureVisible(page, 'followup-keyboard-open', followupBand);

  // The caret pans the band without a resize, then the phone rotates with the keyboard open.
  await setKeyboard(page, { height: followupBand.height, offsetTop: 60 });
  await expectShown([heading, close], { height: followupBand.height, offsetTop: 60 });
  await page.setViewportSize({ width: layout.height, height: layout.width });
  await setKeyboard(page, landscape);
  await expectShown([heading, close], landscape);
  await page.setViewportSize(layout);

  // Dismissing the keyboard restores the stylesheet layout, the draft and the field's focus.
  await setKeyboard(page, full);
  await expectUnframed(layer);
  expect((await close.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await expect(comment).toHaveValue('Short follow-up draft');
  await expect(comment).toBeFocused();
  expect(posts).toEqual([]);

  // Posting with the keyboard open: the receipt takes focus inside the visible band.
  await setKeyboard(page, followupBand);
  await post.click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeFocused();
  await expect(alert).toContainText('4243001');
  await expectShown([heading, close, alert.getByText('Comment posted, but the command was not submitted')], followupBand);
  expect(posts).toEqual(['Short follow-up draft']);
  await expect(post).toBeDisabled();

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await listenerCount(page)).toBe(idle);

  // Reopened while the keyboard band is still offset: placed from the current viewport.
  await openTaskAction(page, 'Follow Up', 'Follow Up');
  await expect(comment).toBeFocused();
  await expectShown([heading, close], followupBand);
});

test('Logs keeps its close, search and match controls above the keyboard and restores after it closes', async ({ page }) => {
  await installKeyboardViewport(page, layout);
  await stubTask(page, []);
  await page.goto(`/tasks/${taskId}`);
  const idle = await listenerCount(page);
  const opener = await openTaskAction(page, 'View Logs', 'Logs');
  const dialog = page.getByRole('dialog', { name: 'Log Files' });
  const title = dialog.getByRole('heading', { name: 'Log Files' });
  const close = dialog.getByRole('button', { name: 'Close log files' });
  const search = dialog.getByRole('textbox', { name: 'Search log' });
  const status = dialog.getByRole('status');
  const content = dialog.getByTestId('log-file-content');
  const layer = layerOf(dialog);
  await expect(close).toBeFocused();
  const before = (await close.boundingBox())!;
  await dialog.getByRole('button', { name: new RegExp(eventsName) }).click();
  await expect(content).toContainText('step 79');

  await search.focus();
  await setKeyboard(page, logsBand);
  await search.pressSequentially('acceptance');
  const matches = eventLines.filter(line => line.includes('acceptance')).length;
  await expect(status).toHaveText(`1 / ${matches}`);
  const prev = dialog.getByRole('button', { name: 'Previous match' });
  const next = dialog.getByRole('button', { name: 'Next match' });
  const clear = dialog.getByRole('button', { name: 'Clear log search' });
  await expectShown([title, close, search, status, prev, next, clear], logsBand);
  await expectFieldVisible(content, logsBand, 40);
  await expect(search).toBeFocused();
  await captureVisible(page, 'logs-search-keyboard-open', logsBand);

  // Match navigation scrolls the log to each match inside the shortened pane.
  await next.click();
  await expect(status).toHaveText(`2 / ${matches}`);
  const current = content.locator('mark[aria-current="true"]');
  await expect.poll(async () => { try { await expectShown([current], logsBand); return true; } catch { return false; } }).toBe(true);
  await prev.click();
  await expect(status).toHaveText(`1 / ${matches}`);
  await expectShown([title, close], logsBand);

  // Clearing and switching files keep working above the keyboard.
  await clear.click();
  await expect(search).toHaveValue('');
  const other = dialog.getByRole('button', { name: new RegExp(conversationName) });
  await other.scrollIntoViewIfNeeded();
  await expectShown([other], logsBand);
  await other.click();
  await expect(other).toHaveAttribute('aria-current', 'true');
  await search.fill('acceptance');
  await expect(status).toHaveText('1 / 1');

  await page.setViewportSize({ width: layout.height, height: layout.width });
  await setKeyboard(page, landscape);
  await expectShown([title, close], landscape);
  await page.setViewportSize(layout);

  await setKeyboard(page, full);
  await expectUnframed(layer);
  expect((await close.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await expect(search).toHaveValue('acceptance');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await listenerCount(page)).toBe(idle);

  // Reopened with the keyboard band still offset: placed from the current viewport.
  await setKeyboard(page, logsBand);
  await openTaskAction(page, 'View Logs', 'Logs');
  await expectShown([title, close], logsBand);
});

async function openTodoForm(page: Page) {
  await page.getByRole('button', { name: 'Create', exact: true }).tap();
  const sheet = page.getByRole('dialog', { name: 'Create' });
  await sheet.getByRole('button', { name: 'New To-do' }).tap();
  await expect(sheet.getByRole('textbox')).toBeFocused();
  return sheet;
}

test('the Create sheet\'s New To-do keeps its title and close above the keyboard, keeps the draft and repository, and submits', async ({ page }) => {
  await installKeyboardViewport(page, layout);
  const submissions = await todoFixture(page);
  await page.goto('/inbox');
  const idle = await listenerCount(page);
  const sheet = await openTodoForm(page);
  const title = sheet.getByRole('heading', { name: 'Create' });
  const close = sheet.getByRole('button', { name: 'Close Create menu' });
  const field = sheet.getByRole('textbox');
  const add = sheet.getByRole('button', { name: 'Add To-Do' });
  const layer = sheet.locator('..');
  await sheet.getByRole('button', { name: 'acme/alpha' }).tap();
  await sheet.getByRole('button', { name: 'acme/billing' }).tap();
  await field.focus();
  const before = (await close.boundingBox())!;

  await setKeyboard(page, todoBand);
  await field.pressSequentially('Short to-do draft');
  await expectShown([title, close], todoBand);
  await expectFieldVisible(field, todoBand, 40);
  await add.scrollIntoViewIfNeeded();
  await expectShown([add], todoBand);
  await expect(field).toBeFocused();
  await captureVisible(page, 'todo-sheet-keyboard-open', todoBand);

  await page.setViewportSize({ width: layout.height, height: layout.width });
  await setKeyboard(page, landscape);
  await expectShown([title, close], landscape);
  await page.setViewportSize(layout);

  await setKeyboard(page, full);
  await expectUnframed(layer);
  expect((await close.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await expect(field).toHaveValue('Short to-do draft');
  await expect(sheet.getByRole('button', { name: 'acme/billing' })).toBeVisible();
  expect(submissions).toEqual([]);

  await setKeyboard(page, todoBand);
  await add.scrollIntoViewIfNeeded();
  await add.tap();
  await expect(sheet.getByText('To-Do added')).toBeVisible();
  expect(submissions).toEqual([{ repository: 'acme/billing', content: 'Short to-do draft', categoryId: null }]);
  await expectShown([title, close], todoBand);

  await close.tap();
  await expect(sheet).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/inbox');
  expect(await listenerCount(page)).toBe(idle);
});

test('the Create sheet opened with the keyboard already up starts inside it, and its creation links still navigate', async ({ page }) => {
  await installKeyboardViewport(page, layout);
  const submissions = await todoFixture(page);
  await page.goto('/inbox');
  await setKeyboard(page, todoBand);
  const sheet = await openTodoForm(page);
  await expectShown([sheet.getByRole('heading', { name: 'Create' }), sheet.getByRole('button', { name: 'Close Create menu' })], todoBand);
  await sheet.getByRole('textbox').pressSequentially('Never submitted');
  const link = sheet.getByRole('link', { name: 'New Task' });
  await link.scrollIntoViewIfNeeded();
  await expectShown([link], todoBand);
  await link.tap();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(sheet).toBeHidden();
  expect(submissions).toEqual([]);
});
