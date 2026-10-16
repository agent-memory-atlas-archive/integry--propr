import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDashboard } from './dashboard-sections.fixture';

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

const cases = [
  { name: 'narrow-320', viewport: { width: 320, height: 568 }, textScale: 1 },
  { name: 'phone-390', viewport: { width: 390, height: 844 }, textScale: 1 },
  { name: 'short-390', viewport: { width: 390, height: 480 }, textScale: 1 },
  // Browser text zoom: rem-sized type and controls grow together.
  { name: 'enlarged-text-320', viewport: { width: 320, height: 568 }, textScale: 1.5 },
];

for (const { name, viewport, textScale } of cases) {
  test(`the More sheet is headed ProPR with its logo at ${name}`, async ({ page }) => {
    await openDashboard(page, viewport);
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}%; }` });
    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    const moreButton = navigation.getByRole('button', { name: 'More' });
    await moreButton.click();

    const sheet = page.getByRole('dialog', { name: 'ProPR', exact: true });
    await expect(sheet).toBeVisible();
    const heading = sheet.getByRole('heading', { level: 2, name: 'ProPR', exact: true });
    const logo = heading.locator('img');
    const close = sheet.getByRole('button', { name: 'Close ProPR menu' });
    await expect(logo).toHaveAttribute('alt', '');
    await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const layout = await sheet.evaluate(dialog => {
      const box = (element: Element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const header = dialog.querySelector('h2')!.parentElement!;
      const image = dialog.querySelector('h2 img') as HTMLImageElement;
      const title = dialog.querySelector('h2 span')!;
      const closeButton = dialog.querySelector('[aria-label="Close ProPR menu"]')!;
      return {
        header: box(header), logo: box(image), title: box(title), close: box(closeButton),
        ratio: image.naturalWidth / image.naturalHeight,
        titleClipped: title.scrollWidth > title.clientWidth,
      };
    });
    // Logo, then title, then close: inside the header, never overlapping.
    for (const part of [layout.logo, layout.title, layout.close]) {
      expect(part.left).toBeGreaterThanOrEqual(layout.header.left);
      expect(part.right).toBeLessThanOrEqual(layout.header.right);
      expect(part.top).toBeGreaterThanOrEqual(layout.header.top);
      expect(part.bottom).toBeLessThanOrEqual(layout.header.bottom);
    }
    expect(layout.logo.right).toBeLessThanOrEqual(layout.title.left);
    expect(layout.title.right).toBeLessThanOrEqual(layout.close.left);
    expect(layout.titleClipped).toBe(false);
    // The existing mark keeps its own proportions.
    expect(layout.logo.width / layout.logo.height).toBeCloseTo(layout.ratio, 1);
    expect(layout.close.width).toBeGreaterThanOrEqual(36);
    expect(layout.close.height).toBeGreaterThanOrEqual(36);
    await expect(sheet.getByRole('link', { name: 'Goals' })).toBeVisible();
    await capture(page, `mobile-propr-menu-${name}`);

    // Keyboard: focus is inside the sheet, close is reachable, Escape returns focus.
    await expect(sheet.locator(':focus')).toHaveCount(1);
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(moreButton).toBeFocused();
  });
}
