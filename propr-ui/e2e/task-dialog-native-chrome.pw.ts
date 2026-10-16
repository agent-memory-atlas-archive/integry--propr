/** Follow-up (inline) and diff (portaled) dialogs stay below the desktop titlebar and leave its window controls usable. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';

const taskId = 'issue-3183-run-0';
const draft = 'Please keep the dialog clear of the window controls.\nThis draft must survive a resize.';
const controlNames = ['Application menu', 'Minimize window', 'Maximize or restore window', 'Close window'] as const;

interface Shell { platform?: 'linux' | 'macos'; expanded?: boolean }

async function stubTask(page: Page, shell: Shell, posts: string[]) {
  await fixture(page, shell.platform);
  if (shell.platform) await page.addInitScript(({ platform, expanded }) => {
    // The native bridge's window actions, recorded instead of moving a real window.
    const calls: string[] = [];
    Object.assign(window, { __windowCalls: calls });
    const record = (name: string) => async () => { calls.push(name); };
    Object.assign(window.__PROPR_DESKTOP__!.app, {
      minimize: record('minimize'), toggleMaximize: record('toggleMaximize'), closeWindow: record('closeWindow'),
      showApplicationMenu: async () => { calls.push('showApplicationMenu'); },
    });
    // The Linux preload's frame state: the production frame CSS keys off these attributes.
    if (platform === 'linux') document.addEventListener('DOMContentLoaded', () => {
      Object.assign(document.documentElement.dataset, { desktopWindow: 'linux', windowFocused: 'true', windowExpanded: String(expanded) });
    });
  }, { platform: shell.platform, expanded: Boolean(shell.expanded) });
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51) },
    ],
    taskInfo: { title: 'Keep follow-up and diff dialogs clear of native window controls', type: 'issue', number: 3183, issueNumber: 3183, repoOwner: 'integry', repoName: 'propr' },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/task/${taskId}/file-changes`, route => route.fulfill({ json: {
    taskId, lastUpdated: ago(51),
    files: [{ path: 'propr-ui/src/components/TaskDetails/DiffViewer.tsx', linesAdded: 3, linesRemoved: 3, status: 'modified', diff: '@@ -1,3 +1,3 @@\n-<div className="fixed inset-0">\n+<div className="app-modal-layer fixed inset-0">' }],
  } }));
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 500, json: { error: 'No follow-up may be posted by this test' } });
  });
}

async function openFollowup(page: Page): Promise<Locator> {
  const direct = page.locator('button[title^="Follow Up"]').filter({ visible: true });
  const more = page.getByRole('button', { name: /more actions/i }).filter({ visible: true });
  await expect(direct.or(more).first()).toBeVisible();
  if (await direct.count()) await direct.first().click();
  else {
    await more.first().click();
    await page.getByRole('menuitem', { name: /Follow Up/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Every sampled point of the element (corners, edge midpoints, centre) hit-tests to the element itself. Corners are
 * sampled just inside its rounded shape (hit testing follows border-radius) or `minInset` px in, whichever is deeper.
 */
async function strayPoints(locator: Locator, minInset = 1): Promise<string[]> {
  return locator.evaluate((element, minInset) => {
    const box = element.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const inset = Math.max(minInset, Math.ceil(radius * (1 - Math.SQRT1_2)) + 1);
    const xs = [box.left + inset, box.left + box.width / 2, box.right - inset];
    const ys = [box.top + inset, box.top + box.height / 2, box.bottom - inset];
    const stray: string[] = [];
    for (const x of xs) for (const y of ys) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !element.contains(hit)) {
        const owner = hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? (hit ? `${hit.tagName}.${hit.className}` : 'nothing');
        stray.push(`${Math.round(x)},${Math.round(y)} -> ${owner}`);
      }
    }
    return stray;
  }, minInset);
}

/**
 * The app's own inert regions (a hidden pane or sheet). Closing a dialog leaves no part of the app inert that was not
 * already; the app may show one of its own (the phone's compact bar after a scroll) meanwhile.
 */
const inertRegions = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('[inert]'), element => element.outerHTML.slice(0, 120)));

const inert = (locator: Locator) => locator.evaluate(element => element.matches('[inert], [inert] *'));

/** The dialog keeps clear of the titlebar row and of every window control; its close control owns all of its points. */
async function expectClearOfChrome(page: Page, dialog: Locator, close: Locator, shell: Shell) {
  await expect(close).toBeVisible();
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  expect(await strayPoints(close)).toEqual([]);
  const layerTop = await dialog.evaluate(element => element.parentElement!.getBoundingClientRect().top);
  const dialogTop = (await dialog.boundingBox())!.y;
  if (!shell.platform) {
    // Ordinary web/mobile UI reserves no titlebar.
    expect(layerTop).toBe(0);
    return;
  }
  // The native titlebar row (Linux controls, macOS traffic lights) belongs to the window, not the dialog.
  expect(layerTop).toBe(44);
  expect(dialogTop).toBeGreaterThanOrEqual(44);
  expect(closeBox.y).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, 22);
    return Boolean(hit?.closest('[role="dialog"]'));
  })).toBe(false);
  if (shell.platform !== 'linux') return;

  const controls = page.getByRole('group', { name: 'Window controls' });
  await expect(controls).toBeVisible();
  expect(await inert(controls)).toBe(false);
  const controlsBox = (await controls.boundingBox())!;
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(closeBox.y);
  for (const name of controlNames) {
    const control = controls.getByRole('button', { name });
    await expect(control).toBeVisible();
    expect(await inert(control), name).toBe(false);
    // The restored frame rounds the window's top-right corner, so its last pixels belong to the desktop.
    expect(await strayPoints(control, 3), name).toEqual([]);
  }
}

/** Each window control dispatches its own native action while the dialog stays open; nothing reaches the dialog. */
async function expectControlsDispatch(page: Page, dialog: Locator) {
  const controls = page.getByRole('group', { name: 'Window controls' });
  await page.evaluate(() => { (window as unknown as { __windowCalls: string[] }).__windowCalls.length = 0; });
  for (const name of controlNames) await controls.getByRole('button', { name }).click();
  expect(await page.evaluate(() => (window as unknown as { __windowCalls: string[] }).__windowCalls))
    .toEqual(['showApplicationMenu', 'minimize', 'toggleMaximize', 'closeWindow']);
  await expect(dialog).toBeVisible();
}

/** The task workspace behind the dialog is inert, and keyboard focus never reaches it. */
async function expectWorkspaceInert(page: Page, dialog: Locator) {
  for (const part of [page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }), page.getByRole('navigation').first()]) {
    expect(await inert(part.first())).toBe(true);
  }
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const active = document.activeElement;
      return !active || active === document.body
        || Boolean(active.closest('[role="dialog"], [data-window-chrome]'));
    })).toBe(true);
  }
  await expect(dialog).toBeVisible();
}

/** A preview of the open dialog, with the pointer resting on its backdrop rather than hovering a window control. */
async function preview(page: Page, name: string) {
  await page.mouse.move(4, page.viewportSize()!.height - 8);
  await capture(page, name);
}

const shells: Array<{ name: string } & Shell> = [
  { name: 'linux-restored', platform: 'linux' },
  { name: 'linux-maximized', platform: 'linux', expanded: true },
  { name: 'macos', platform: 'macos' },
];
const sizes = [{ width: 880, height: 620 }, { width: 1280, height: 820 }];

for (const shell of shells) {
  for (const size of sizes) {
    for (const text of ['default', 'enlarged'] as const) {
      const label = `${shell.name} ${size.width}x${size.height} ${text} text`;
      test(`${label}: follow-up and diff dialogs keep clear of the native titlebar`, async ({ page }) => {
        const posts: string[] = [];
        await page.setViewportSize(size);
        await stubTask(page, shell, posts);
        await page.goto(`/tasks/${taskId}`);
        if (text === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
        await expect(page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }).first()).toBeVisible();
        const baseline = await inertRegions(page);

        // Inline follow-up dialog, rendered inside the desktop root.
        const followup = await openFollowup(page);
        const followupClose = followup.getByRole('button', { name: 'Close follow-up dialog' });
        await expectClearOfChrome(page, followup, followupClose, shell);
        const textarea = followup.getByRole('textbox', { name: 'Comment' });
        await textarea.fill(draft);
        if (shell.platform === 'linux') await expectControlsDispatch(page, followup);
        await textarea.focus();
        await expectWorkspaceInert(page, followup);
        // An OS resize keeps the unsent draft and the layout.
        await page.setViewportSize(size.width === 880 ? { width: 1280, height: 820 } : { width: 880, height: 620 });
        await expect(textarea).toHaveValue(draft);
        await expectClearOfChrome(page, followup, followupClose, shell);
        await page.setViewportSize(size);
        await expect(textarea).toHaveValue(draft);
        if (shell.name === 'linux-restored' && size.width === 880 && text === 'default') await preview(page, 'native-followup-dialog-linux-880x620');
        await followupClose.click();
        await expect(followup).toHaveCount(0);
        expect(posts).toEqual([]);
        expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));

        // Portaled diff dialog, rendered on <body> outside the desktop root.
        await page.getByText('DiffViewer.tsx', { exact: true }).first().click();
        const diff = page.getByRole('dialog', { name: 'DiffViewer.tsx' });
        const diffClose = diff.getByRole('button', { name: 'Close diff view' });
        await expectClearOfChrome(page, diff, diffClose, shell);
        await expect(diff).toContainText('app-modal-layer');
        if (shell.platform === 'linux') {
          // Restored, the portaled layer also keeps inside the frame's left/bottom allowance.
          const inset = shell.expanded ? 0 : 3;
          const layer = await diff.evaluate(element => {
            const box = element.parentElement!.getBoundingClientRect();
            return { left: box.left, bottom: window.innerHeight - box.bottom };
          });
          expect(layer).toEqual({ left: inset, bottom: inset });
          await expectControlsDispatch(page, diff);
        }
        await diffClose.focus();
        await expectWorkspaceInert(page, diff);
        if (shell.name === 'linux-restored' && size.width === 880 && text === 'default') await preview(page, 'native-diff-dialog-linux-880x620');
        if (shell.name === 'linux-maximized' && size.width === 1280 && text === 'enlarged') await preview(page, 'native-diff-dialog-linux-maximized-1280x820-enlarged');
        await page.keyboard.press('Escape');
        await expect(diff).toHaveCount(0);
        expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
        expect(posts).toEqual([]);
      });
    }
  }
}

for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 390, height: 380 }]) {
  for (const text of ['default', 'enlarged'] as const) {
    test(`web ${size.width}x${size.height} ${text} text: dialogs reserve no titlebar and stay reachable`, async ({ page }) => {
      const posts: string[] = [];
      await page.setViewportSize(size);
      await stubTask(page, {}, posts);
      await page.goto(`/tasks/${taskId}`);
      if (text === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
      await expect(page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }).first()).toBeVisible();
      const baseline = await inertRegions(page);

      const followup = await openFollowup(page);
      await expectClearOfChrome(page, followup, followup.getByRole('button', { name: 'Close follow-up dialog' }), {});
      const textarea = followup.getByRole('textbox', { name: 'Comment' });
      await textarea.fill(draft);
      const cancel = followup.getByRole('button', { name: 'Cancel' });
      const post = followup.getByRole('button', { name: 'Post Comment' });
      for (const target of [textarea, cancel, post]) {
        await target.scrollIntoViewIfNeeded();
        await expect(target).toBeInViewport();
      }
      expect(await strayPoints(cancel)).toEqual([]);
      await cancel.click();
      await expect(followup).toHaveCount(0);
      expect(posts).toEqual([]);

      await page.getByText('DiffViewer.tsx', { exact: true }).first().click();
      const diff = page.getByRole('dialog', { name: 'DiffViewer.tsx' });
      await expectClearOfChrome(page, diff, diff.getByRole('button', { name: 'Close diff view' }), {});
      await diff.getByRole('button', { name: 'Close diff view' }).click();
      await expect(diff).toHaveCount(0);
      expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
    });
  }
}
