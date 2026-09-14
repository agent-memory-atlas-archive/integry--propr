import { expect, test, type Page, type Route } from '@playwright/test';

const delays = {
  demoMode: { total: 180, server: 60 },
  currentUser: { total: 220, server: 80 },
  routeChunk: { total: 160, server: 0 },
  usefulData: { total: 240, server: 100 },
} as const;

const user = {
  id: 'startup-user',
  login: 'operator',
  username: 'operator',
  displayName: 'Operator',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_settings'],
  authorizationSource: 'local',
};

const task = {
  id: 'startup-task',
  repository: 'integry/propr',
  issueNumber: 2409,
  title: 'Authenticated startup useful row',
  status: 'pending',
  createdAt: '2026-09-14T00:00:00.000Z',
  llmProvider: 'openai',
  model: 'gpt-5.6-sol',
};

type CriticalStage = 'demoMode' | 'currentUser' | 'routeChunk' | 'usefulData';
type StageTiming = { starts: number[]; ends: number[] };

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const installDesktopHarness = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const profile = {
      id: 'startup-profile',
      name: 'Startup instance',
      kind: 'remote' as const,
      baseUrl: 'http://127.0.0.1:4173',
    };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true,
      platform: 'linux',
      app: { onDeepLink: () => () => undefined },
      profiles: {
        list: async () => [profile],
        getActiveId: async () => profile.id,
        setActiveId: async () => undefined,
        save: async () => undefined,
        remove: async () => undefined,
      },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  });
};

const fallbackResponses: Record<string, unknown> = {
  '/api/instance/catalog': { agents: [], repositories: [] },
  '/api/notifications/unread-count': { unreadCount: 0 },
  '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
  '/api/notifications/config': { enabled: false },
  '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
  '/api/stats/generating-plans': { count: 0 },
  '/api/stats/repositories': { repositories: [] },
  '/api/planner/drafts': { drafts: [] },
  '/api/status': { status: 'ok' },
};

for (const runtime of ['web', 'desktop'] as const) {
  test(`${runtime} overlaps independent authenticated startup stages`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    if (runtime === 'desktop') await installDesktopHarness(page);

    const epoch = performance.now();
    const timing: Record<CriticalStage, StageTiming> = {
      demoMode: { starts: [], ends: [] },
      currentUser: { starts: [], ends: [] },
      routeChunk: { starts: [], ends: [] },
      usefulData: { starts: [], ends: [] },
    };
    const apiRequests: string[] = [];
    const record = async (stage: CriticalStage, route: Route, body?: unknown): Promise<void> => {
      timing[stage].starts.push(performance.now() - epoch);
      await wait(delays[stage].total);
      if (body === undefined) await route.continue();
      else {
        await route.fulfill({
          json: body,
          headers: { 'Server-Timing': `fixture;dur=${delays[stage].server}` },
        });
      }
      timing[stage].ends.push(performance.now() - epoch);
    };

    await page.route('**/assets/TasksPage-*.js', route => record('routeChunk', route));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      apiRequests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/auth/demo-mode') return record('demoMode', route, { demoMode: false });
      if (url.pathname === '/api/auth/user') return record('currentUser', route, user);
      if (url.pathname === '/api/tasks') return record('usefulData', route, { tasks: [task], total: 1 });
      return route.fulfill({ json: fallbackResponses[url.pathname] ?? {} });
    });

    await page.goto('/tasks');
    await expect(page.getByRole('table').getByText(task.title)).toBeVisible();
    const firstUsefulRenderMs = performance.now() - epoch;
    const browserResources = await page.evaluate(() => (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    ).filter(entry => entry.name.includes('/api/') || entry.name.includes('/assets/TasksPage-'))
      .map(entry => ({
        path: `${new URL(entry.name).pathname}${new URL(entry.name).search}`,
        responseWaitMs: Math.max(0, entry.responseStart - entry.requestStart),
        transferMs: Math.max(0, entry.responseEnd - entry.responseStart),
        declaredServerMs: entry.serverTiming.find(item => item.name === 'fixture')?.duration ?? null,
      })));

    expect(timing.demoMode.starts).toHaveLength(1);
    expect(timing.currentUser.starts).toHaveLength(1);
    expect(timing.routeChunk.starts).toHaveLength(1);
    expect(timing.currentUser.starts[0]).toBeLessThan(timing.demoMode.ends[0]);
    expect(timing.routeChunk.starts[0]).toBeLessThan(timing.demoMode.ends[0]);
    expect(timing.routeChunk.starts[0]).toBeLessThan(timing.currentUser.ends[0]);

    const firstUsefulDataStart = Math.min(...timing.usefulData.starts);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.demoMode.ends[0]);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.currentUser.ends[0]);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.routeChunk.ends[0]);
    expect(apiRequests.filter(request => request === '/api/auth/demo-mode')).toHaveLength(1);
    expect(apiRequests.filter(request => request.startsWith('/api/auth/user'))).toHaveLength(1);

    const serialInjectedWaitMs = Object.values(delays).reduce((total, stage) => total + stage.total, 0);
    const overlappedInjectedWaitMs = Math.max(
      delays.demoMode.total,
      delays.currentUser.total,
      delays.routeChunk.total,
    ) + delays.usefulData.total;
    const lastUsefulDataEnd = Math.max(...timing.usefulData.ends);
    const authenticatedShellReadyMs = Math.max(
      timing.demoMode.ends[0],
      timing.currentUser.ends[0],
      timing.routeChunk.ends[0],
    );
    const measurement = {
      runtime,
      conditions: delays,
      requestCountBeforeUsefulRender: apiRequests.length,
      criticalRequestCounts: {
        demoMode: timing.demoMode.starts.length,
        currentUser: timing.currentUser.starts.length,
        routeChunk: timing.routeChunk.starts.length,
        usefulData: timing.usefulData.starts.length,
      },
      criticalStageTimingMs: timing,
      browserResourceTimingMs: browserResources,
      injectedCriticalPath: {
        beforeSerialMs: serialInjectedWaitMs,
        afterOverlappedMs: overlappedInjectedWaitMs,
        savedMs: serialInjectedWaitMs - overlappedInjectedWaitMs,
      },
      firstUsefulRenderMs,
      authenticatedShellToUsefulDataRequestMs: Math.max(0, firstUsefulDataStart - authenticatedShellReadyMs),
      renderAfterLastUsefulDataMs: Math.max(0, firstUsefulRenderMs - lastUsefulDataEnd),
      limitations: [
        'Playwright API delays represent response wait; declared Server-Timing separates the fixture server share.',
        'The static chunk delay occurs before route.continue(), so Chromium resource TTFB excludes that harness wait.',
        'Wall time includes local Chromium, bundle parsing, React work, and test routing overhead.',
      ],
    };
    console.log(`STARTUP_MEASUREMENT ${JSON.stringify(measurement)}`);
    await testInfo.attach(`${runtime}-startup-measurement.json`, {
      body: JSON.stringify(measurement, null, 2),
      contentType: 'application/json',
    });
  });
}
