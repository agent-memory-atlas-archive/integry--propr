/**
 * Dashboard responsive layout rules.
 *
 * Every assertion here is about geometry and DOM order rather than about data,
 * because these are the rules that regress silently: a row that overflows a
 * 320px viewport, a supporting panel that drifts into the main column, an
 * empty score column reserved on a phone, a title cut off mid-word.
 *
 * The suite runs against stubbed HTTP and a closed socket, so it needs no
 * backend, no Redis, no credentials and no network.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const now = Date.parse('2026-09-23T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

/** Widths the dashboard has to survive: two phones, a small laptop, a desktop. */
const NARROW_WIDTHS = [320, 390] as const;
const WIDE_WIDTHS = [1024, 1440] as const;

/**
 * A title that needs two lines at 320px and a progress line that needs more
 * than one. Together they are the wrap rule: the title wraps rather than being
 * cut off, and the secondary line is the one that gives way.
 */
const LONG_TITLE = 'Keep the retry budget from leaking into post-processing';
const LONG_PROGRESS_LINE =
  'Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx and re-running the dashboard section suite';
/** The same line with the directories collapsed, which is what a phone shows. */
const SHORT_PROGRESS_LINE = 'Editing …/HappeningNowSection.tsx and re-running the dashboard section suite';

const running = [
  { id: 'task:run-1', taskId: 'run-1', repository: 'example/workspace', issueNumber: 2480, prNumber: null, title: LONG_TITLE, state: 'claude_execution', phase: 'Implementing', progressLine: LONG_PROGRESS_LINE, createdAt: minutesAgo(26), updatedAt: minutesAgo(1) },
  { id: 'task:run-2', taskId: 'run-2', repository: 'example/design-system', issueNumber: 118, prNumber: 119, title: 'Align the score badge with the outcome feed', state: 'post_processing', phase: 'Finishing up', progressLine: 'Pushing branch', createdAt: minutesAgo(9), updatedAt: minutesAgo(2) },
];

const attention = [
  { id: 'task:blocked-1', category: 'blocked', kind: 'task_failed', taskId: 'blocked-1', repository: 'example/workspace', issueNumber: 2470, prNumber: null, title: 'Retry budget never applies to post-processing', state: 'failed', detail: 'Lint failed', since: minutesAgo(190) },
  { id: 'plan-issue:31', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/docs', issueNumber: 58, prNumber: 59, title: null, state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(20) },
];

/** The first outcome carries a score; the second deliberately does not. */
const outcomes = [
  { id: 'task:done-1:completed', kind: 'completed', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, title: 'Show corrective operator messages in the goal timeline', detail: null, planIssueStatus: null, score: 9, occurredAt: minutesAgo(46) },
  { id: 'task:done-2:failed', kind: 'failed', taskId: 'done-2', repository: 'example/design-system', issueNumber: 115, prNumber: null, title: 'Tighten the reference chip contrast', detail: 'Typecheck failed', planIssueStatus: null, score: null, occurredAt: minutesAgo(88) },
];

const SCORED_OUTCOMES = outcomes.filter(outcome => outcome.score !== null).length;

/**
 * A plain member on purpose: the admin-only banners (onboarding, missing
 * default model, Agent Tank detection) would otherwise push the dashboard down
 * the page and change the DOM order the layout tests read.
 */
const user = {
  id: 'responsive-user',
  login: 'operator',
  username: 'operator',
  displayName: 'Dana Okonkwo',
  email: null,
  avatarUrl: null,
  role: 'member',
  permissions: [],
  authorizationSource: 'local',
};

const dashboardResponses = (attentionItems: typeof attention): Record<string, unknown> => ({
  '/api/dashboard/summary': {
    repository: 'all',
    needsAttention: attentionItems.length,
    running: running.length,
    queued: 1,
    completedRecently: 2,
    recentWindowHours: 24,
  },
  '/api/dashboard/attention': {
    repository: 'all',
    items: attentionItems,
    counts: {
      blocked: attentionItems.filter(item => item.category === 'blocked').length,
      decisions: attentionItems.filter(item => item.category === 'decision').length,
      total: attentionItems.length,
    },
  },
  '/api/dashboard/active': {
    repository: 'all',
    running,
    queued: [],
    queue: { queuedCount: 1, reason: 'All agents are busy' },
    counts: { running: running.length, queued: 1 },
  },
  '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: outcomes },
  '/api/stats/dashboard': {
    period: '7d',
    repository: 'all',
    completed: 34,
    successRate: 87.5,
    recordedSpend: 12.42,
    dailyCompleted: [
      { date: '2026-09-17', count: 4 }, { date: '2026-09-18', count: 7 }, { date: '2026-09-19', count: 3 },
      { date: '2026-09-20', count: 6 }, { date: '2026-09-21', count: 2 }, { date: '2026-09-22', count: 8 },
      { date: '2026-09-23', count: 4 },
    ],
    previous: { completed: 29, successRate: 81.2, recordedSpend: 9.8 },
  },
});

async function fixture(page: Page, attentionItems: typeof attention = attention): Promise<void> {
  await page.clock.install({ time: now });
  // No live socket: the layout rules are about rendered geometry, not updates.
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/auth/user': user,
      '/api/config/agent-tank/usage': { enabled: false, agents: {} },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/instance/catalog': {
        agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }],
        repositories: [
          { name: 'example/workspace', enabled: true, baseBranch: 'main' },
          { name: 'example/design-system', enabled: true, baseBranch: 'main' },
          { name: 'example/docs', enabled: true, baseBranch: 'main' },
        ],
      },
      '/api/queue/stats': { active: 2, waiting: 1, completed: 34, failed: 3 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      '/api/status': { status: 'ok' },
      ...dashboardResponses(attentionItems),
    };
    return pathname in responses
      ? route.fulfill({ json: responses[pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in the dashboard responsive fixture' } });
  });
}

/** Both live sections have landed, so nothing is still a skeleton. */
async function openDashboard(page: Page, width: number, attentionItems = attention): Promise<void> {
  await page.setViewportSize({ width, height: 1200 });
  await fixture(page, attentionItems);
  await page.goto('/');
  await expect(page.getByTestId('summary-strip')).toBeVisible();
  await expect(page.getByTestId('happening-now-list')).toBeVisible();
  await expect(page.getByTestId('recent-outcomes-list')).toBeVisible();
  await expect(page.getByTestId('historical-stats-section')).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  // The daily chart draws only once its container has been measured.
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' }).catch(() => undefined);
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(directory, `${name}.png`) });
}

/** Every element wider than the viewport, named well enough to fix. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    wide: [...document.querySelectorAll('main *')]
      .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
      .map(node => ({
        className: String(node.className).slice(0, 80),
        text: (node.textContent || '').slice(0, 40),
        right: Math.round(node.getBoundingClientRect().right),
      }))
      .slice(0, 5),
  }));
}

/** The dashboard's five sections, in the order the document lists them. */
async function sectionOrder(page: Page): Promise<string[]> {
  const sections = ['summary-strip', 'needs-attention-panel', 'happening-now-section', 'recent-outcomes-section', 'historical-stats-section'];
  return page.evaluate(ids => [...document.querySelectorAll('[data-testid]')]
    .map(node => node.getAttribute('data-testid') as string)
    .filter(id => ids.includes(id)), sections);
}

for (const width of [...NARROW_WIDTHS, ...WIDE_WIDTHS]) {
  test(`the dashboard has no horizontal overflow at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const overflow = await horizontalOverflow(page);
    expect(overflow.wide).toEqual([]);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  });
}

for (const width of NARROW_WIDTHS) {
  test(`sections read top to bottom in priority order at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    // What needs a person first, then what is running, then what happened,
    // then the background numbers.
    expect(await sectionOrder(page)).toEqual([
      'summary-strip',
      'needs-attention-panel',
      'happening-now-section',
      'recent-outcomes-section',
      'historical-stats-section',
    ]);

    // One column: every section starts on the same left edge and spans it.
    const boxes = await page.evaluate(() => ['summary-strip', 'needs-attention-panel', 'happening-now-section', 'recent-outcomes-section', 'historical-stats-section']
      .map(id => {
        const rect = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
        return { id, left: Math.round(rect.left), width: Math.round(rect.width) };
      }));
    expect(new Set(boxes.map(box => box.left)).size).toBe(1);
    expect(new Set(boxes.map(box => box.width)).size).toBe(1);

    await capture(page, `dashboard-responsive-${width}`);
  });
}

test('the wide layout keeps live work in the main column and the supporting panels beside it', async ({ page }) => {
  await openDashboard(page, 1440);

  const columns = await page.evaluate(() => Object.fromEntries(
    ['needs-attention-panel', 'happening-now-section', 'recent-outcomes-section', 'historical-stats-section'].map(id => {
      const rect = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
      return [id, { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }];
    }),
  ));

  // Running work and outcomes share the wide column, stacked.
  expect(columns['happening-now-section'].left).toBe(columns['recent-outcomes-section'].left);
  expect(columns['happening-now-section'].width).toBe(columns['recent-outcomes-section'].width);

  // Attention and stats share the narrow column, to the right of it.
  expect(columns['needs-attention-panel'].left).toBe(columns['historical-stats-section'].left);
  expect(columns['needs-attention-panel'].width).toBe(columns['historical-stats-section'].width);
  expect(columns['needs-attention-panel'].left).toBeGreaterThanOrEqual(columns['happening-now-section'].right);
  expect(columns['happening-now-section'].width).toBeGreaterThan(columns['needs-attention-panel'].width);

  await capture(page, 'dashboard-responsive-1440');
});

test('an empty attention list holds the right column instead of collapsing it', async ({ page }) => {
  await openDashboard(page, 1440, []);

  // Drawn, not removed: the section that triages work is the top module of the
  // right column at every count, including zero.
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Needs attention/ })).toHaveText('Needs attention (0)');
  await expect(page.getByTestId('needs-attention-empty')).toBeVisible();
  await expect(page.getByTestId('summary-needs-attention')).toHaveAttribute('data-emphasis', 'false');

  const boxes = await page.evaluate(() => Object.fromEntries(
    ['needs-attention-panel', 'happening-now-section', 'recent-outcomes-section', 'historical-stats-section'].map(id => {
      const rect = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
      return [id, { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left) }];
    }),
  ));

  // One horizon per row across both columns: attention beside running work,
  // stats beside the outcome feed.
  expect(boxes['needs-attention-panel'].top).toBe(boxes['happening-now-section'].top);
  expect(boxes['historical-stats-section'].top).toBe(boxes['recent-outcomes-section'].top);
  // The supporting column is still one column, and stats are still under it.
  expect(boxes['historical-stats-section'].left).toBe(boxes['needs-attention-panel'].left);
  expect(boxes['historical-stats-section'].top).toBeGreaterThan(boxes['needs-attention-panel'].top);

  const overflow = await horizontalOverflow(page);
  expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  await capture(page, 'dashboard-responsive-1440-no-attention');
});

test('an outcome without a score reserves no score column on mobile', async ({ page }) => {
  await openDashboard(page, 390);

  // The badge is rendered only where a score exists.
  await expect(page.getByTestId('outcome-score')).toHaveCount(SCORED_OUTCOMES);

  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="recent-outcomes-list"] > li')]
    .map(row => {
      const link = row.querySelector('a') as HTMLElement;
      const content = link.firstElementChild as HTMLElement;
      // The row's inner edge: where text may run to once padding is removed.
      const innerRight = link.getBoundingClientRect().right
        - parseFloat(window.getComputedStyle(link).paddingRight);
      return {
        scored: row.querySelector('[data-testid="outcome-score"]') !== null,
        contentRight: Math.round(content.getBoundingClientRect().right),
        innerRight: Math.round(innerRight),
      };
    }));

  const scored = rows.find(row => row.scored);
  const unscored = rows.find(row => !row.scored);
  expect(scored).toBeDefined();
  expect(unscored).toBeDefined();

  // The unscored row's text runs all the way to the row's own inner edge; the
  // scored row's stops short to make room for the badge. A reserved but empty
  // score column would make the two stop on the same line.
  expect(unscored!.contentRight).toBe(unscored!.innerRight);
  expect(scored!.contentRight).toBeLessThan(scored!.innerRight);
  expect(unscored!.contentRight).toBeGreaterThan(scored!.contentRight);
});

test('a long title wraps to two lines while the secondary line gives way first', async ({ page }) => {
  await openDashboard(page, 320);

  const row = page.getByTestId('happening-now-list').locator('li').first();
  const title = row.getByText(LONG_TITLE);
  await expect(title).toBeVisible();

  const measured = await title.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const style = window.getComputedStyle(node);
    return {
      lines: range.getClientRects().length,
      text: (node.textContent || '').trim(),
      clipped: node.scrollHeight > node.clientHeight + 1,
      // Truncation to a single line would show up as either of these.
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
    };
  });

  // It wrapped rather than being cut off on one line, and nothing was clipped.
  expect(measured.lines).toBeGreaterThan(1);
  expect(measured.lines).toBeLessThanOrEqual(2);
  expect(measured.text).toBe(LONG_TITLE);
  expect(measured.clipped).toBe(false);
  expect(measured.whiteSpace).not.toBe('nowrap');
  expect(measured.textOverflow).not.toBe('ellipsis');

  // The progress line is secondary, so it is the one held to a single line
  // even though its text is longer than the title's — and on a phone it is the
  // path inside it that gives way first, down to the file it names.
  await expect(row.getByText(SHORT_PROGRESS_LINE)).toBeVisible();
  await expect(row.getByText(LONG_PROGRESS_LINE)).toBeHidden();
  const detail = row.getByText(SHORT_PROGRESS_LINE).locator('xpath=..');
  expect(LONG_PROGRESS_LINE.length).toBeGreaterThan(LONG_TITLE.length);
  await expect(detail).toHaveClass(/line-clamp-1/);
  const detailBox = await detail.evaluate(node => ({
    height: node.getBoundingClientRect().height,
    lineHeight: parseFloat(window.getComputedStyle(node).lineHeight),
  }));
  // One line on screen, however many the text would take unclamped: the clamp
  // has to actually clip, which it does not if `block` wins the `display` it
  // is fighting the clamp for.
  expect(detailBox.height).toBeLessThanOrEqual(detailBox.lineHeight + 1);
  expect(measured.lines).toBeGreaterThan(1);

  const overflow = await horizontalOverflow(page);
  expect(overflow.wide).toEqual([]);
});

for (const width of NARROW_WIDTHS) {
  test(`a running item spends two metadata lines, not four, at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const row = page.getByTestId('happening-now-list').locator('li').first();

    // Row one: what it is on the left, how long it has been on the right. Row
    // two: the entities. A naive wrap used to spread the same four facts over
    // three lines before the title was even reached.
    const geometry = await row.evaluate(node => {
      const box = (selector: string) => {
        const rect = (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right) };
      };
      return {
        status: box('[class*="sm:order-1"]'),
        elapsed: box('[class*="sm:order-3"]'),
        entities: box('[class*="sm:order-2"]'),
        title: (node.querySelector('.line-clamp-2') as HTMLElement).getBoundingClientRect().top,
      };
    });

    // Status and elapsed share a line; the elapsed time is flush right of it.
    expect(geometry.status.top).toBe(geometry.elapsed.top);
    expect(geometry.elapsed.left).toBeGreaterThan(geometry.status.right);
    // The entities are the next line down, and the title follows them.
    expect(geometry.entities.top).toBeGreaterThan(geometry.status.top);
    expect(geometry.title).toBeGreaterThan(geometry.entities.top);
    // Both metadata lines start on the row's own left edge.
    expect(geometry.entities.left).toBe(geometry.status.left);

    // The owner is dropped here for the same reason it is in the right rail.
    // `useInnerText` because the full slug is still in the DOM for wider
    // viewports, hidden by CSS rather than removed.
    await expect(row.getByTitle('example/workspace')).toHaveText('workspace', { useInnerText: true });

    // No typed separator survives to wrap onto a line of its own.
    expect(await page.getByTestId('happening-now-section').textContent()).not.toContain('•');
    expect(await page.getByTestId('recent-outcomes-section').textContent()).not.toContain('•');
  });

  test(`the four summary counts hold one row as a micro-grid at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const counts = await page.evaluate(() => ['summary-needs-attention', 'summary-running', 'summary-queued', 'summary-completed']
      .map(id => {
        const node = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
        const rect = node.getBoundingClientRect();
        // innerText, so the labels CSS hides at this width are not counted.
        return { id, top: Math.round(rect.top), width: Math.round(rect.width), text: node.innerText.trim() };
      }));

    // One row of four equal columns: "Completed today" used to wrap onto an
    // orphaned second line with nothing beside it.
    expect(new Set(counts.map(count => count.top)).size).toBe(1);
    expect(new Set(counts.map(count => count.width)).size).toBe(1);
    // One word per column on a phone, and never the phrase that would not fit.
    // The labels are uppercased by CSS, which `innerText` reports as rendered.
    const spoken = counts.map(count => count.text.toLowerCase());
    for (const [index, word] of ['attention', 'running', 'queued', 'done'].entries()) {
      expect(spoken[index]).toContain(word);
    }
    expect(spoken[0]).not.toContain('needs attention');
    expect(spoken[3]).not.toContain('completed today');
  });
}
