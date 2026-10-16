import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const TITLEBAR = 44;
const CHROME_CONTAINERS = '#root, .desktop-app, .desktop-shell, .desktop-shell-content';

/** Rendered chrome edges: toolbar (when shown), drag strip, control group and every control. */
const measureChrome = page => page.evaluate(containers => {
  const edges = element => {
    if (!element || !element.getClientRects().length) return null;
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  };
  return {
    toolbar: edges(document.querySelector('header[aria-label="Application toolbar"]')),
    drag: edges(document.querySelector('.desktop-connected-drag-region')),
    controls: edges(document.querySelector('.desktop-window-controls')),
    buttons: [...document.querySelectorAll('.desktop-window-controls button')].map(edges),
    scrolled: [document.scrollingElement, ...document.querySelectorAll(containers)].map(element => element.scrollTop),
    width: innerWidth,
  };
}, CHROME_CONTAINERS);

const expectFlush = (chrome, label) => {
  const rows = { drag: chrome.drag, controls: chrome.controls, ...(chrome.toolbar ? { toolbar: chrome.toolbar } : {}) };
  chrome.buttons.forEach((button, index) => { rows[`control ${index}`] = button; });
  for (const [name, box] of Object.entries(rows)) {
    expect(box, `${label}: ${name} rendered`).not.toBeNull();
    expect({ name, top: box.top, bottom: box.bottom }, label).toEqual({ name, top: 0, bottom: TITLEBAR });
  }
  expect(chrome.controls.right, label).toBe(chrome.width);
  expect(chrome.scrolled.every(value => value === 0), `${label}: no chrome container scrolled ${chrome.scrolled}`).toBe(true);
};

/**
 * Ways content can scroll the chrome containers, each from an unscrolled
 * layout. On the published build a `100vh` app inside the frame-inset root let
 * scrollIntoView of the content's end (or any programmatic scroll) move the
 * toolbar and drag strip to y -3 while the fixed controls stayed at 0.
 */
const SCROLL_TRIGGERS = ['focus', 'scrollIntoView', 'programmatic'];

const triggerScroll = (page, trigger) => page.evaluate(({ trigger, containers }) => {
  const scrollers = [document.scrollingElement, ...document.querySelectorAll(containers)];
  for (const element of scrollers) element.scrollTop = 0;
  if (trigger === 'focus') [...document.querySelectorAll('.desktop-sidebar :is(a, button)')].at(-1)?.focus();
  if (trigger === 'scrollIntoView') document.querySelector('main').scrollIntoView({ block: 'end' });
  if (trigger === 'programmatic') {
    for (const element of scrollers) element.scrollTop = 50;
    window.scrollTo(0, 50);
  }
}, { trigger, containers: CHROME_CONTAINERS });

/**
 * The Linux frame allowance makes #root three pixels shorter than the viewport.
 * Restored/maximized and focused/unfocused windows at the supported sizes and
 * at 200% zoom must keep toolbar, drag strip and controls on the same edges.
 */
const expectAlignedChrome = async (page, capture) => {
  const cdp = await page.context().newCDPSession(page);
  const sizes = [[880, 620, 1], [1280, 820, 1], [1390, 820, 1], [880, 620, 2], [1280, 820, 2], [1390, 820, 2]];
  for (const [width, height, zoom] of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: width / zoom, height: height / zoom, deviceScaleFactor: zoom, mobile: false });
    for (const expanded of ['false', 'true']) {
      for (const focused of ['true', 'false']) {
        await page.evaluate(state => Object.assign(document.documentElement.dataset, state), { windowExpanded: expanded, windowFocused: focused });
        const label = `${width}x${height} @${zoom * 100}% ${expanded === 'true' ? 'maximized' : 'restored'} ${focused === 'true' ? 'focused' : 'unfocused'}`;
        expectFlush(await measureChrome(page), label);
        for (const trigger of SCROLL_TRIGGERS) {
          await triggerScroll(page, trigger);
          expectFlush(await measureChrome(page), `${label} after ${trigger} scroll trigger`);
        }
      }
    }
    if ((zoom === 1 && width === 1280) || (zoom === 2 && width === 880)) {
      await page.evaluate(() => Object.assign(document.documentElement.dataset, { windowExpanded: 'false', windowFocused: 'true' }));
      // Let the sidebar finish sliding into (or out of) its drawer first.
      await page.waitForFunction(() => document.getAnimations().length === 0);
      // Playwright's own screenshot resets the CDP zoom emulation; capture through CDP.
      const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await capture(`chrome-aligned-${width}-${zoom * 100}`, window, `Linux ${width}×${height} at ${zoom * 100}% zoom, restored: toolbar/drag strip and window controls share their upper and lower edges`);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => Object.assign(document.documentElement.dataset, { windowExpanded: 'false', windowFocused: 'true' }));
};

/** Every File creation entry opens its existing form and never submits, creates or enables anything. */
const expectCreationForms = async (page, click, capture, mutations) => {
  await click('New Goal');
  const goal = page.getByRole('dialog', { name: 'Start a goal' });
  await expect(goal).toBeVisible();
  await expect(page).toHaveURL(/#\/goals$/);
  await goal.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Draft objective that must not start');
  await capture('new-goal', goal, 'File → New Goal opens the goal creation dialog');
  // Cancelling a typed draft asks first; declining keeps it, accepting closes it.
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(goal.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Draft objective that must not start');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(goal).toHaveCount(0);
  await click('New Automation');
  await expect(page).toHaveURL(/#\/automations\/new$/);
  await expect(page.getByRole('heading', { name: 'New automation', exact: true })).toBeVisible();
  await capture('new-automation', page.locator('main'), 'File → New Automation opens the automation editor');
  await click('Tasks');
  await expect(page).toHaveURL(/#\/tasks$/);
  await click('New To-do');
  const idea = page.getByPlaceholder('Describe your idea...');
  await expect(idea).toBeVisible();
  await expect(idea).toBeFocused();
  await idea.fill('Quick idea that is not saved');
  await expect(page).toHaveURL(/#\/tasks$/);
  await capture('new-todo', page.locator('.desktop-toolbar-popover'), 'File → New To-do opens the toolbar quick add');
  await page.locator('main').click({ position: { x: 20, y: 200 } });
  await expect(idea).toHaveCount(0);
  // A second request after closing opens a fresh form rather than the old draft.
  await click('New To-do');
  await expect(page.getByPlaceholder('Describe your idea...')).toHaveValue('');
  await page.locator('main').click({ position: { x: 20, y: 200 } });
  // Last, because leaving Plan Studio asks to discard the draft.
  await click('New Plan');
  await expect(page).toHaveURL(/#\/studio\/new$/);
  expect(mutations).toEqual([]);
};

it('Linux/macOS menu dispatch reaches actual search, sidebar, every creation form, connection editor and diagnostics', async context => {
  const executablePath = [chromium.executablePath(), '/usr/bin/chromium'].find(existsSync);
  if (!executablePath) { context.skip('Install Playwright Chromium to exercise actual renderer commands'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-menu-'));
  let browser, server;
  const previews = [];
  try {
    await build({
      entryPoints: [join(desktop, 'scripts/fixtures/desktop-native-menu/renderer.tsx')],
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.platform': 'window.__FIXTURE_PLATFORM__', 'import.meta.env': '{}', __APP_VERSION__: '"0.8.15"', __PROPR_DESKTOP__: 'true' },
    });
    await mkdir(join(directory, 'media'));
    await copyFile(join(root, 'propr-ui/public/media/logo-and-name-transparent.png'), join(directory, 'media/logo-and-name-transparent.png'));
    const compiled = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    await writeFile(join(directory, 'base.css'), compiled.css);
    await writeFile(join(directory, 'renderer.html'), '<!doctype html><html><head><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    server = createServer(async (request, response) => {
      const asset = new URL(request.url, 'http://fixture').pathname.slice(1);
      if (!['renderer.html', 'renderer.js', 'renderer.css', 'base.css', 'media/logo-and-name-transparent.png'].includes(asset)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.png') ? 'image/png' : 'text/html');
      response.end(await readFile(join(directory, asset)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // The managed path requires chromium-headless-shell: install with
    // `playwright install chromium` (without --no-shell), as CI and setup do.
    // chromium.executablePath() above checks full Chromium, not shell presence;
    // an incomplete managed installation must fail loudly at launch.
    // Shell and system Chromium exercise different rendering paths. This fixture
    // choice does not establish the cause of the prior Back-click timeout or
    // the reported concurrent-stress crash; native Electron evidence is separate.
    context.diagnostic(executablePath === chromium.executablePath()
      ? 'Renderer: Playwright managed chromium-headless-shell'
      : `Renderer: full system Chromium (${executablePath})`);
    browser = await chromium.launch({
      executablePath: executablePath === chromium.executablePath() ? undefined : executablePath,
      args: ['--no-sandbox'],
    });
    context.diagnostic(`Browser version: ${browser.version()}`);
    for (const platform of ['darwin', 'linux']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript(platform => {
        window.__FIXTURE_PLATFORM__ = platform;
        Object.defineProperty(navigator, 'platform', { value: platform === 'darwin' ? 'MacIntel' : 'Linux x86_64' });
        // Mirror the Linux preload's frame styling state (installWindowFrameStyles).
        const frame = () => Object.assign(document.documentElement.dataset, { desktopWindow: 'linux', windowFocused: 'true', windowExpanded: 'false' });
        if (platform === 'linux') document.addEventListener('DOMContentLoaded', frame);
      }, platform);
      await page.route('http://127.0.0.1:3000/**', route => route.fulfill({ status: 503, json: { error: 'Isolated renderer fixture' } }));
      page.on('pageerror', error => context.diagnostic(error.stack));
      // Opening a creation form must never write: record every mutating API call.
      const mutations = [];
      page.on('request', request => { if (request.url().startsWith('http://127.0.0.1:3000/') && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`); });
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer.html`);
      const click = label => page.evaluate(({ label, platform }) => window.nativeMenu.click(label, platform), { label, platform });
      const capture = async (name, locator, title) => {
        if (!process.env.PROPR_DESKTOP_MENU_PREVIEWS) return;
        const output = resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS);
        await mkdir(output, { recursive: true });
        const filename = `${platform}-${name}.png`;
        if (typeof locator === 'function') await writeFile(join(output, filename), await locator());
        else await locator.screenshot({ path: join(output, filename) });
        previews.push({ path: `.propr/previews/${filename}`, title, description: 'Production renderer reached through the application menu template, dispatcher and preload bridge. Isolated fixture account; Chromium does not render native OS menus.' });
      };
      await expect(page.getByRole('heading', { name: 'Choose an instance' })).toBeVisible();
      const menuButton = page.getByRole('button', { name: 'Application menu', exact: true });
      const popup = () => page.evaluate(() => window.nativeMenu.popup());
      if (platform === 'linux') {
        // Entry surface: the same main-owned template, before any instance.
        await capture('application-menu-entry', page.locator('#root'), 'Linux: Application menu control on the instance chooser');
        await menuButton.click();
        await expect.poll(popup).toMatchObject({ menus: ['ProPR', 'File', 'Edit', 'View', 'Navigate', 'Window', 'Help'], sourceType: 'mouse' });
        expect((await popup()).file.slice(0, 5)).toEqual([
          { label: 'New Task', accelerator: 'CmdOrCtrl+Shift+T' }, { label: 'New Plan', accelerator: 'CmdOrCtrl+N' },
          { label: 'New Goal', accelerator: 'CmdOrCtrl+Shift+G' }, { label: 'New Automation', accelerator: 'CmdOrCtrl+Shift+A' },
          { label: 'New To-do', accelerator: 'CmdOrCtrl+Shift+D' },
        ]);
        await page.evaluate(() => window.nativeMenu.dismiss());
      } else {
        await expect(menuButton).toHaveCount(0);
      }
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'This computer Local instance' }).click();
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await expect(page.locator('.desktop-sidebar footer')).toHaveCount(0);
      await expect(page.locator('.desktop-sidebar')).not.toContainText('v0.8.15');
      const iconRails = await page.locator('.desktop-sidebar').evaluate(sidebar => {
        const selectors = ['.desktop-instance-icon svg', 'a[href="#/"] svg', 'a[href="#/inbox"] svg'];
        return selectors.map(selector => {
          const box = sidebar.querySelector(selector).getBoundingClientRect();
          return box.x + box.width / 2;
        });
      });
      expect(new Set(iconRails).size).toBe(1);
      await capture('sidebar', page.locator('.desktop-sidebar'), 'Desktop sidebar without version metadata');
      if (platform === 'linux') {
        // Actual Linux minimum and a shorter supported window: the control stays
        // a separate no-drag hit target beside the native controls, never over
        // search/new-task, and the toolbar drag strip remains.
        for (const viewport of [{ width: 880, height: 620 }, { width: 880, height: 480 }]) {
          await page.setViewportSize(viewport);
          const layout = await page.evaluate(() => {
            const box = element => { const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom }; };
            const menu = document.querySelector('[aria-label="Application menu"]');
            const toolbar = document.querySelector('header[aria-label="Application toolbar"]');
            const minimize = document.querySelector('[aria-label="Minimize window"]');
            const toolbarControls = [...toolbar.querySelectorAll('button, input, a, [role="combobox"]')]
              .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(box);
            return {
              menu: box(menu), minimize: box(minimize), group: box(menu.parentElement),
              toolbarControls, appRegion: getComputedStyle(menu).getPropertyValue('-webkit-app-region') || getComputedStyle(menu).getPropertyValue('app-region'),
              toolbarRegion: getComputedStyle(toolbar).getPropertyValue('-webkit-app-region') || getComputedStyle(toolbar).getPropertyValue('app-region'),
              hit: document.elementFromPoint((menu.getBoundingClientRect().left + menu.getBoundingClientRect().right) / 2, 22) === menu
                || menu.contains(document.elementFromPoint((menu.getBoundingClientRect().left + menu.getBoundingClientRect().right) / 2, 22)),
              width: innerWidth,
            };
          });
          expect(layout.hit).toBe(true);
          expect(layout.appRegion).toBe('no-drag');
          expect(layout.toolbarRegion).toBe('drag');
          expect(layout.group.right).toBe(layout.width);
          expect(layout.menu.right).toBeLessThanOrEqual(layout.minimize.left);
          expect(layout.menu.top).toBe(layout.minimize.top);
          expect(layout.menu.bottom).toBe(layout.minimize.bottom);
          expect(layout.group.bottom).toBe(44);
          expect(layout.toolbarControls.length).toBeGreaterThan(0);
          for (const control of layout.toolbarControls) expect(control.right).toBeLessThanOrEqual(layout.group.left);
        }
        await capture('application-menu-control', page.locator('header[aria-label="Application toolbar"]'), 'Linux: Application menu control beside the window controls at 880px');
        await page.setViewportSize({ width: 1280, height: 820 });
        await expectAlignedChrome(page, capture);

        // Pointer: popup anchored under the control, then a real command.
        const menuBox = await menuButton.boundingBox();
        await menuButton.click();
        await expect.poll(popup).toMatchObject({ x: Math.round(menuBox.x), y: Math.round(menuBox.y + menuBox.height), sourceType: 'mouse' });
        expect((await popup()).roles).toEqual(expect.arrayContaining(['undo', 'cut', 'copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'minimize', 'close']));
        await page.evaluate(() => window.nativeMenu.choose('Settings…'));
        await expect(page).toHaveURL(/#\/settings$/);
        // Keyboard: Tab-reachable button with Enter, and F10 from a focused field
        // (focus stays in the field, so Edit roles act on it).
        await menuButton.focus();
        await page.keyboard.press('Enter');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await page.evaluate(() => window.nativeMenu.choose('Dashboard'));
        await expect(page).toHaveURL(/#\/$/);
        const search = page.getByRole('combobox', { name: 'Search', exact: true });
        await search.focus();
        await page.keyboard.press('F10');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
        await page.keyboard.press('Alt+f');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
        // Pointer activation must not take focus from the field either.
        await menuButton.click();
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
      } else {
        await expect(menuButton).toHaveCount(0);
      }
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toHaveCount(0);
      await capture('sidebar-hidden', page.locator('.desktop-shell'), 'View → Toggle Sidebar: content expands');
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await click('Switch Account / Instance…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
      await click('Search / Go To…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toBeFocused();
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await capture('connect', page.getByRole('dialog', { name: 'Manage instances' }), 'File → Connect Instance opens the connection editor');
      await page.getByRole('button', { name: 'Close instance manager' }).click();
      await click('Connection Diagnostics…');
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toContainText('connected');
      await capture('diagnostics', page.getByRole('dialog', { name: 'Connection Diagnostics' }), 'Help → Connection Diagnostics');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await click('New Task');
      await expect(page).toHaveURL(/#\/tasks\/new$/);
      const launcher = page.getByRole('dialog', { name: 'New task', exact: true });
      await expect(launcher).toBeVisible();
      await expect(launcher.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();
      await expect(launcher.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible();
      await expect(launcher.getByRole('textbox', { name: 'Prompt', exact: true })).toBeFocused();
      await expect(launcher.getByRole('button', { name: 'Run task', exact: true })).toBeVisible();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
      await launcher.getByText('Advanced Options', { exact: false }).click();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeVisible();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await launcher.getByText('Advanced Options', { exact: false }).click();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await capture('new-task', launcher, 'File → New Task opens the GitHub issue task launcher');
      await expectCreationForms(page, click, capture, mutations);
      await page.close();
    }
    if (process.env.PROPR_DESKTOP_MENU_PREVIEWS) await writeFile(resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: [{ name: 'macOS Electron runner', reason: 'Verify native menu appearance, accelerator handling and About copy action using the next signed Mac build; retain the existing test login.' }] }, null, 2));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
