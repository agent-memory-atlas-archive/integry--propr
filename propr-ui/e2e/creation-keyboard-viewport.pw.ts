/** The shared creation shell (New Task, New Goal) stays inside the visible area while an on-screen keyboard shrinks and pans the visual viewport. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixture } from './new-task.fixture';

// Measured on a Samsung phone in Chrome: the layout viewport stays 384×692 while the
// keyboard leaves a 382px visual viewport panned 186px down to the focused prompt.
const layout = { width: 384, height: 692 };
const keyboard = { height: 382.133, offsetTop: 186.133 };
const draft = 'Disposable draft typed above the keyboard';

/**
 * Headless browsers never open an OS keyboard, so `window.visualViewport` is replaced
 * by one the test drives with the measured geometry. Everything else is the production
 * build: its stylesheet, layout and the browser's real `resize`/`scroll` delivery.
 */
async function installKeyboardViewport(page: Page) {
  await page.addInitScript(({ width, height }) => {
    const target = new EventTarget();
    const state = { width, height, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
    let listeners = 0;
    const viewport = Object.assign(target, {
      addEventListener: (...args: Parameters<EventTarget['addEventListener']>) => { listeners++; EventTarget.prototype.addEventListener.apply(target, args); },
      removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>) => { listeners--; EventTarget.prototype.removeEventListener.apply(target, args); },
    });
    for (const key of Object.keys(state) as Array<keyof typeof state>) Object.defineProperty(viewport, key, { get: () => state[key] });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    Object.assign(window, {
      __keyboard(next: { height: number; offsetTop: number }) {
        Object.assign(state, next, { pageTop: next.offsetTop });
        target.dispatchEvent(new Event('resize'));
        target.dispatchEvent(new Event('scroll'));
      },
      __viewportListeners: () => listeners,
    });
  }, layout);
}

const setKeyboard = (page: Page, next: { height: number; offsetTop: number }) =>
  page.evaluate(value => (window as unknown as { __keyboard(v: typeof value): void }).__keyboard(value), next);
const listenerCount = (page: Page) => page.evaluate(() => (window as unknown as { __viewportListeners(): number }).__viewportListeners());

/** Every target lies fully within the visible band `[offsetTop, offsetTop + height]`. */
async function expectVisible(targets: Locator[], band: { height: number; offsetTop: number }) {
  for (const target of targets) {
    const box = (await target.boundingBox())!;
    expect(box.y, `${target} starts inside the visible area`).toBeGreaterThanOrEqual(band.offsetTop - 0.5);
    expect(box.y + box.height, `${target} ends inside the visible area`).toBeLessThanOrEqual(band.offsetTop + band.height + 0.5);
  }
}

/** The focused prompt shows at least a few lines inside both its scroll area and the visible band. */
async function expectPromptVisible(prompt: Locator, band: { height: number; offsetTop: number }) {
  const shown = await prompt.evaluate((element, { top, bottom }) => {
    let rect = element.getBoundingClientRect();
    let low = Math.max(rect.top, top); let high = Math.min(rect.bottom, bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
      rect = parent.getBoundingClientRect();
      low = Math.max(low, rect.top); high = Math.min(high, rect.bottom);
    }
    return high - low;
  }, { top: band.offsetTop, bottom: band.offsetTop + band.height });
  expect(shown, 'visible prompt height').toBeGreaterThanOrEqual(72);
}

async function captureVisible(page: Page, name: string, band: { height: number; offsetTop: number }) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const { mkdir } = await import('node:fs/promises');
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, animations: 'disabled',
    clip: { x: 0, y: band.offsetTop, width: layout.width, height: band.height } });
}

const shells = [
  { name: 'New task', path: '/tasks/new', close: 'Close task creation', actions: ['Cancel', 'Plan first', 'Run task'], preview: 'new-task' },
  { name: 'Start a goal', path: '/goals?new=1', close: 'Close goal creation', actions: ['Cancel', 'Start goal'], preview: 'new-goal' },
];

test.use({ viewport: layout, isMobile: true, hasTouch: true });

for (const shell of shells) {
  test(`${shell.name} keeps its header, prompt and actions above a panned keyboard and restores after it closes`, async ({ page }) => {
    await installKeyboardViewport(page);
    const requests = await fixture(page);
    await page.route('**/api/goals', route => route.request().method() === 'GET' ? route.fulfill({ json: { goals: [] } }) : route.fallback());
    await page.route('**/api/goals/capabilities', route => route.fulfill({ json: { agents: [{
      agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
      lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
      controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
      models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra',
    }] } }));
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    const before = (await close.boundingBox())!;
    const full = { height: layout.height, offsetTop: 0 };
    await expectVisible([heading, close, prompt], full);

    await setKeyboard(page, keyboard);
    await prompt.pressSequentially(draft);
    await expectVisible([heading, close, layer], keyboard);
    await expectPromptVisible(prompt, keyboard);
    await expect(prompt).toBeFocused();
    await captureVisible(page, `${shell.preview}-keyboard-open`, keyboard);

    // The form body still scrolls to every action inside the shortened pane.
    for (const name of shell.actions) {
      const action = dialog.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await expectVisible([action], keyboard);
    }
    await expectVisible([heading, close], keyboard);

    // A pan without a resize (the browser following the caret) is followed too.
    const panned = { height: keyboard.height, offsetTop: 96 };
    await setKeyboard(page, panned);
    await expectVisible([heading, close, layer], panned);

    // Dismissing the keyboard restores the stylesheet geometry and keeps the draft.
    await setKeyboard(page, full);
    await expect(layer).toHaveAttribute('style', /^(?![\s\S]*(top|height|bottom))/);
    const after = (await close.boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.height).toBe(40);
    await expect(prompt).toHaveValue(draft);
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}

test('New task opened with the keyboard up is placed from the current viewport, and closing removes its listeners', async ({ page }) => {
  await installKeyboardViewport(page);
  await fixture(page);
  await page.goto('/tasks');
  const idle = await listenerCount(page);
  await page.goto('/tasks/new');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByLabel('Prompt', { exact: true })).toBeFocused();
  expect(await listenerCount(page)).toBeGreaterThan(idle);

  // Rotate with the keyboard still open: the window resizes and the visible band moves.
  await page.setViewportSize({ width: layout.height, height: layout.width });
  const landscape = { height: 180, offsetTop: 204 };
  await setKeyboard(page, landscape);
  await expectVisible([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], landscape);

  await dialog.getByRole('button', { name: 'Close task creation' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(dialog).toBeHidden();
  expect(await listenerCount(page)).toBe(idle);

  // Reopening while the keyboard band is still offset starts inside it, not at the stale or default position.
  await page.setViewportSize(layout);
  await setKeyboard(page, keyboard);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('navigation', { name: 'Create' }).getByRole('link', { name: 'New Task' }).click();
  await expect(dialog).toBeVisible();
  await expectVisible([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], keyboard);
});
