/** A stand-in `window.visualViewport` for headless browsers, driven with geometry measured under a real on-screen keyboard. */
import { expect, type Locator, type Page } from '@playwright/test';

export interface Band { height: number; offsetTop: number }

/**
 * Headless browsers never open an OS keyboard, so `window.visualViewport` is replaced
 * by one the test drives with the measured geometry. Everything else is the production
 * build: its stylesheet, layout and the browser's real `resize`/`scroll` delivery.
 */
export async function installKeyboardViewport(page: Page, layout: { width: number; height: number }) {
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

export const setKeyboard = (page: Page, next: Band) =>
  page.evaluate(value => (window as unknown as { __keyboard(v: typeof value): void }).__keyboard(value), next);
export const listenerCount = (page: Page) => page.evaluate(() => (window as unknown as { __viewportListeners(): number }).__viewportListeners());

/** Every target lies fully within the visible band `[offsetTop, offsetTop + height]`. */
export async function expectVisible(targets: Locator[], band: Band) {
  for (const target of targets) {
    const box = (await target.boundingBox())!;
    expect(box.y, `${target} starts inside the visible area`).toBeGreaterThanOrEqual(band.offsetTop - 0.5);
    expect(box.y + box.height, `${target} ends inside the visible area`).toBeLessThanOrEqual(band.offsetTop + band.height + 0.5);
  }
}

/**
 * Every target is drawn inside the visible band, not clipped by a scrolling ancestor,
 * and is the element hit at its centre. The hit test alone is not enough: it also
 * reports controls the keyboard's pan has moved above the visible area.
 */
export async function expectShown(targets: Locator[], band: Band) {
  await expectVisible(targets, band);
  for (const target of targets) {
    const shown = await target.evaluate(element => {
      const box = element.getBoundingClientRect();
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
        const clip = parent.getBoundingClientRect();
        if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5) return false;
      }
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(shown, `${target} is drawn unclipped and receives a tap at its centre`).toBe(true);
  }
}

/** The focused field shows at least `min` px inside both its scroll areas and the visible band. */
export async function expectFieldVisible(field: Locator, band: Band, min = 72) {
  const shown = await field.evaluate((element, { top, bottom }) => {
    let rect = element.getBoundingClientRect();
    let low = Math.max(rect.top, top); let high = Math.min(rect.bottom, bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
      rect = parent.getBoundingClientRect();
      low = Math.max(low, rect.top); high = Math.min(high, rect.bottom);
    }
    return high - low;
  }, { top: band.offsetTop, bottom: band.offsetTop + band.height });
  expect(shown, 'visible field height').toBeGreaterThanOrEqual(min);
}

/** The layer's inline frame is gone, so the stylesheet geometry applies again. */
export const expectUnframed = (layer: Locator) => expect(layer).toHaveAttribute('style', /^(?![\s\S]*(top|height|bottom))/);

/** Screenshot of only the visible band, i.e. what the phone shows above the keyboard. */
export async function captureVisible(page: Page, name: string, band: Band) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const { mkdir } = await import('node:fs/promises');
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, animations: 'disabled',
    clip: { x: 0, y: band.offsetTop, width: page.viewportSize()!.width, height: band.height } });
}
