import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, historicalHistory, historicalRun, tag } from './task-list-desktop.fixture';

// PR #2664's review scores over its ultrafix cycles, and its merge.
const scores = [4, 6, 8].map((score, index) => ({
  cycle_number: index + 1, source: 'ultrafix', score, goal: 8, blocker_count: 0, suggestion_count: 0,
  reviewer_agent: 'codex', reviewer_model: 'gpt-6-astra', implementer_model: 'gpt-6-astra',
  head_sha: `${index + 1}a2b3c4d5e6f`, task_id: historicalRun, created_at: ago(40 - index * 10),
}));

async function taskScreen(page: Page, width: number) {
  await fixture(page);
  await page.route('**/api/pull-requests/2664/scores**', route => route.fulfill({ json: {
    repository: 'integry/propr', pr_number: 2664, outcome: 'merged', merged_at: ago(0.2), closed_at: null, scores,
  } }));
  // A review of a PR, as the API names it, so the task reads the PR's scores and outcome.
  await page.route(`**/api/task/${historicalRun}/history`, route => route.fulfill({ json: {
    history: historicalHistory,
    taskInfo: {
      title: `Review PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Found 2 issues',
      type: 'pr-comment', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
    },
  } }));
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  // An earlier review run: its readable log has reasoning to lay out.
  await page.goto(`/tasks/${historicalRun}`);
  await expect(page.getByRole('list', { name: 'Runs' }).getByTestId('run-timeline-run')).toHaveCount(8);
}

for (const width of [390, 1280]) {
  const phone = width < 640;
  test(`${width}px task screen: merge status ends the timeline, scores in sequence, ${phone ? 'one-column log without' : 'two-column log with'} the raw switch`, async ({ page }) => {
    await taskScreen(page, width);

    // 1. The merge status is the timeline's own last entry, after every run and review.
    const entries = page.getByRole('list', { name: 'Runs' }).locator(':scope > li');
    await expect(entries).toHaveCount(9);
    await expect(entries.last()).toHaveAttribute('data-testid', 'pr-outcome-entry');
    await expect(entries.last()).toContainText('Merged');
    await expect(entries.last()).toContainText('PR #2664');
    // The scores read as a connected progression, not a chart.
    const sequence = page.getByRole('list', { name: 'Review scores: 4, 6, 8 out of 10' });
    await expect(sequence.getByRole('listitem')).toHaveText(['4', '6', '8']);
    await expect(page.getByTestId('review-score-history').locator('svg')).toHaveCount(0);
    await expect(page.getByTestId('review-score-history')).not.toContainText('Merged');

    // 2. The raw log switch is a desktop control.
    const logView = page.getByRole('group', { name: 'Log view' });
    if (phone) await expect(logView).toBeHidden();
    else await expect(logView).toBeVisible();

    // 3. Each readable entry is one column on a phone: its label sits above the text, which keeps the full width.
    const entry = page.getByText('The label check also matches unrelated labels', { exact: false });
    await entry.scrollIntoViewIfNeeded();
    const layout = await entry.evaluate(element => {
      const content = element.closest('.flex-1')!;
      const row = content.parentElement!;
      const gutter = row.firstElementChild!;
      return { row: row.getBoundingClientRect().toJSON(), gutter: gutter.getBoundingClientRect().toJSON(), content: content.getBoundingClientRect().toJSON() };
    });
    if (phone) {
      expect(layout.content.top).toBeGreaterThanOrEqual(layout.gutter.bottom - 1);
      expect(layout.content.width).toBeCloseTo(layout.row.width, 0);
    } else {
      expect(layout.gutter.width).toBe(100);
      expect(layout.content.left).toBeGreaterThan(layout.gutter.right);
      expect(layout.content.top).toBe(layout.gutter.top);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.getByTestId('run-timeline-scroll').evaluate(list => { list.scrollTop = list.scrollHeight; });
      if (phone) {
        await page.getByTestId('review-score-history').scrollIntoViewIfNeeded();
        await capture(page, `task-timeline-merge-status-${width}`);
        await page.getByRole('region', { name: 'Task implementation log' }).scrollIntoViewIfNeeded();
        await capture(page, `task-readable-log-${width}`);
      } else {
        await capture(page, `task-screen-${width}`);
      }
    }
  });
}
