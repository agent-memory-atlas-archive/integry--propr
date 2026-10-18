/** The shared creation shell (New Task, New Goal) stays inside the visible area while an on-screen keyboard shrinks and pans the visual viewport. */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { fixture } from './new-task.fixture';
import { captureVisible, expectFieldVisible, expectShown, expectUnframed, expectVisible, installKeyboardViewport, listenerCount, setKeyboard, type Band } from './keyboard-viewport.fixture';

// Measured on a Samsung phone in Chrome: the layout viewport stays 384×692 while the
// keyboard leaves a 382px visual viewport panned 186px down to the focused prompt.
const layout = { width: 384, height: 692 };
const keyboard = { height: 382.133, offsetTop: 186.133 };
const draft = 'Disposable draft typed above the keyboard';

// Measured on a Samsung SM-S908B (Android 16) in landscape: the layout viewport is 748×298 and
// the keyboard (not an OS fullscreen editor) leaves an 89px band 208px down.
const landscapeLayout = { width: 748, height: 298 };
const landscapeKeyboard: Band = { height: 89.333, offsetTop: 208.533 };

const shells = [
  { name: 'New task', path: '/tasks/new', close: 'Close task creation', actions: ['Cancel', 'Plan first', 'Run task'], preview: 'new-task', agent: 'codex',
    description: 'Describe the change you want. Run task creates an issue and starts implementation.' },
  { name: 'Start a goal', path: '/goals?new=1', close: 'Close goal creation', actions: ['Cancel', 'Start goal'], preview: 'new-goal', agent: 'agent-1',
    description: 'Your reusable session settings are remembered after creation.' },
];

test.use({ viewport: layout, isMobile: true, hasTouch: true });

async function stubGoals(page: Page) {
  await page.route('**/api/goals', route => route.request().method() === 'GET' ? route.fulfill({ json: { goals: [] } }) : route.fallback());
  await page.route('**/api/goals/capabilities', route => route.fulfill({ json: { agents: [{
    agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
    lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
    controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
    models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra',
  }] } }));
}

for (const shell of shells) {
  test(`${shell.name} keeps its header, prompt and actions above a panned keyboard and restores after it closes`, async ({ page }) => {
    await installKeyboardViewport(page, layout);
    const requests = await fixture(page);
    await stubGoals(page);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    const before = (await close.boundingBox())!;
    const full = { height: layout.height, offsetTop: 0 };
    await expectShown([heading, close], full);
    await expectVisible([prompt], full);

    await setKeyboard(page, keyboard);
    await prompt.pressSequentially(draft);
    await expectShown([heading, close], keyboard);
    await expectVisible([layer], keyboard);
    await expectFieldVisible(prompt, keyboard);
    await expect(prompt).toBeFocused();
    await captureVisible(page, `${shell.preview}-keyboard-open`, keyboard);

    // The form body still scrolls to every action inside the shortened pane.
    for (const name of shell.actions) {
      const action = dialog.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await expectShown([action], keyboard);
    }
    await expectShown([heading, close], keyboard);

    // A pan without a resize (the browser following the caret) is followed too, and so is
    // a resize alone (the keyboard's suggestion strip closing) at the same offset.
    const panned = { height: keyboard.height, offsetTop: 96 };
    await setKeyboard(page, panned, ['scroll']);
    await expectShown([heading, close], panned);
    await expectVisible([layer], panned);
    const taller = { height: 430, offsetTop: 96 };
    await setKeyboard(page, taller, ['resize']);
    await expectShown([heading, close], taller);
    await expectVisible([layer], taller);

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
  await installKeyboardViewport(page, layout);
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
  await expectShown([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], landscape);

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
  await expectShown([dialog.getByRole('heading', { name: 'New task' }), dialog.getByRole('button', { name: 'Close task creation' })], keyboard);
});

/** The part of `target` the reader sees: inside the band, below the pane's sticky header, and not clipped by a scroll area. */
const uncovered = async (target: Locator, header: Locator, band: Band) => header.evaluate((head, [element, { offsetTop, height }]) => {
  let low = Math.max(offsetTop, head.getBoundingClientRect().bottom);
  let high = offsetTop + height;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
    const clip = parent.getBoundingClientRect();
    low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
  }
  const box = element.getBoundingClientRect();
  return { top: box.top - low, bottom: high - box.bottom, shown: Math.min(high, box.bottom) - Math.max(low, box.top) };
}, [await target.elementHandle(), band] as const);

/**
 * Brings `target` wholly into view below the pane's sticky header, then checks it is drawn
 * there and is what a tap at its centre reaches. Chromium scrolls with trusted touch drags on
 * the pane, as a finger would; Playwright has no trusted touch or wheel input for mobile WebKit,
 * so there the browser's own scroll-into-view (which honours the pane's scroll padding) moves it.
 */
async function scrollToShow(page: Page, touch: CDPSession | null, header: Locator, target: Locator, band: Band) {
  if (touch) {
    // The finger rests in the pane's side padding, below the header, so no drag starts on a control.
    const headerBox = (await header.boundingBox())!;
    const x = Math.round(headerBox.x + 8);
    const y = Math.round((headerBox.y + headerBox.height + band.offsetTop + band.height) / 2);
    for (let step = 0; step < 40; step++) {
      const { top, bottom } = await uncovered(target, header, band);
      if (top >= -0.5 && bottom >= -0.5) break;
      // A finger moving up reveals what is below, and down what is above. Chromium starts scrolling only
      // past its 15px touch slop (a shorter drag is a tap), and slow drags do not fling.
      const need = Math.min(Math.ceil(top < 0 ? -top : -bottom) + 1, 30);
      const distance = (top < 0 ? 1 : -1) * (15 + need);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y - distance / 2 }] });
      for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
      await page.waitForTimeout(50);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  } else {
    await target.scrollIntoViewIfNeeded();
  }
  const { top, bottom } = await uncovered(target, header, band);
  expect(top, `${target} starts below the sticky header`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends above the keyboard`).toBeGreaterThanOrEqual(-0.5);
  await expectShown([target], band);
}

for (const shell of shells) {
  test(`${shell.name} stays usable in the measured 89px landscape keyboard band, then restores in portrait`, async ({ page, browserName }) => {
    await installKeyboardViewport(page, layout);
    const requests = await fixture(page);
    await stubGoals(page);
    await page.goto(shell.path);
    const dialog = page.getByRole('dialog', { name: shell.name });
    const header = dialog.locator('header');
    const heading = dialog.getByRole('heading', { name: shell.name });
    const close = dialog.getByRole('button', { name: shell.close });
    const prompt = dialog.getByLabel('Prompt', { exact: true });
    const layer = page.locator('body > .app-modal-layer');
    await expect(prompt).toBeFocused();
    // Scrolling a pane this short by touch takes many drags.
    test.setTimeout(90_000);
    const touch = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;

    // A draft with a repository and a model, made in portrait.
    const repository = dialog.getByText('Select a repository', { exact: true });
    if (await repository.isVisible()) {
      await repository.click();
      await page.getByRole('button', { name: /acme.*billing/ }).click();
    }
    await prompt.fill(draft);
    await dialog.locator('summary', { hasText: 'Advanced Options' }).click();
    const agent = dialog.getByLabel('Agent', { exact: true });
    const model = dialog.getByLabel('Model', { exact: true });
    await agent.selectOption(shell.agent);
    await model.selectOption('gpt-6-astra');
    const run = dialog.getByRole('button', { name: shell.actions.at(-1), exact: true });
    await expect(run).toBeEnabled();

    // Rotating dismisses the keyboard; the reader focuses Prompt again and it reopens.
    await page.setViewportSize(landscapeLayout);
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await prompt.focus();
    await setKeyboard(page, landscapeKeyboard);
    await expectVisible([layer], landscapeKeyboard);
    await expectShown([heading, close], landscapeKeyboard);
    expect((await close.boundingBox())!.height).toBe(40);
    await expect(prompt).toBeFocused();
    // The focused prompt shows its start below the header rather than under it.
    const field = await uncovered(prompt, header, landscapeKeyboard);
    expect(field.shown, 'visible prompt height').toBeGreaterThanOrEqual(24);
    await captureVisible(page, `${shell.preview}-landscape-keyboard`, landscapeKeyboard);

    // Every field and action is reached by scrolling the pane, down to the actions and back
    // up to the repository, while the close control stays where it is.
    const targets = [model, ...shell.actions.map(name => dialog.getByRole('button', { name, exact: true })), agent, dialog.getByRole('button', { name: /billing/ }).first()];
    for (const target of targets) {
      await scrollToShow(page, touch, header, target, landscapeKeyboard);
      await expectShown([heading, close], landscapeKeyboard);
    }
    await expect(prompt).toBeFocused();

    // Dismissing the keyboard and reopening it frames the pane again; nothing was lost.
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await expectUnframed(layer);
    await prompt.focus();
    await setKeyboard(page, landscapeKeyboard);
    await expectShown([heading, close], landscapeKeyboard);
    await scrollToShow(page, touch, header, run, landscapeKeyboard);
    await captureVisible(page, `${shell.preview}-landscape-keyboard-actions`, landscapeKeyboard);

    // Back in portrait with the keyboard closed, the shell lays out as before with the draft intact.
    await setKeyboard(page, { height: landscapeLayout.height, offsetTop: 0 });
    await page.setViewportSize(layout);
    await setKeyboard(page, { height: layout.height, offsetTop: 0 });
    await expectUnframed(layer);
    const portrait = { height: layout.height, offsetTop: 0 };
    await expectShown([heading, close, dialog.getByText(shell.description, { exact: true })], portrait);
    await expect(prompt).toHaveValue(draft);
    await expect(agent).toHaveValue(shell.agent);
    await expect(model).toHaveValue('gpt-6-astra');
    await expect(dialog.getByRole('button', { name: /billing/ }).first()).toBeVisible();
    for (const name of shell.actions) await expectShown([dialog.getByRole('button', { name, exact: true })], portrait);
    expect(await dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden');
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}
