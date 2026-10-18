/** The shared creation shell (New Task, New Goal) stays inside the visible area while an on-screen keyboard shrinks and pans the visual viewport. */
import { expect, test } from '@playwright/test';
import { fixture } from './new-task.fixture';
import { captureVisible, expectFieldVisible, expectVisible, installKeyboardViewport, listenerCount, setKeyboard } from './keyboard-viewport.fixture';

// Measured on a Samsung phone in Chrome: the layout viewport stays 384×692 while the
// keyboard leaves a 382px visual viewport panned 186px down to the focused prompt.
const layout = { width: 384, height: 692 };
const keyboard = { height: 382.133, offsetTop: 186.133 };
const draft = 'Disposable draft typed above the keyboard';

const shells = [
  { name: 'New task', path: '/tasks/new', close: 'Close task creation', actions: ['Cancel', 'Plan first', 'Run task'], preview: 'new-task' },
  { name: 'Start a goal', path: '/goals?new=1', close: 'Close goal creation', actions: ['Cancel', 'Start goal'], preview: 'new-goal' },
];

test.use({ viewport: layout, isMobile: true, hasTouch: true });

for (const shell of shells) {
  test(`${shell.name} keeps its header, prompt and actions above a panned keyboard and restores after it closes`, async ({ page }) => {
    await installKeyboardViewport(page, layout);
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
    await expectFieldVisible(prompt, keyboard);
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
