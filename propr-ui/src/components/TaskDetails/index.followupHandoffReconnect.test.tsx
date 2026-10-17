import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskDetails from './index';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser, FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { API_BASE_URL, getDesktopConnectionScope, setDesktopConnectionScope } from '../../api/apiClient';
import { createElectronDesktopAdapters } from '../../desktop/electronAdapters';
import { bridgeFixture, fromProfile, storedProfile } from '../../desktop/electronAdapters.test-fixture';
import { HANDOFF_POLL_MS } from './useFollowupHandoff';
const api = vi.hoisted(() => ({
  postTaskFollowup: vi.fn<(taskId: string, body: string) => Promise<PostFollowupResponse>>(),
  getTaskFollowupRuns: vi.fn<(taskId: string, commentId: number, options?: { signal?: AbortSignal }) => Promise<FollowupRunsResponse>>(),
}));
const loadedTaskIds = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../../api/proprApi', async importOriginal => ({ ...await importOriginal<typeof import('../../api/proprApi')>(), ...api }));
vi.mock('./hooks', () => ({
  useTaskData: (taskId?: string) => {
    loadedTaskIds.push(taskId);
    return {
      loading: false, error: null,
      history: [{ id: 1, status: 'failed', timestamp: '2026-10-17T12:00:00Z', metadata: {} }],
      taskInfo: { title: 'Implement the export', repoOwner: 'acme', repoName: 'widgets', type: 'issue', number: 32,
        followupTarget: { taskId: 'failed-issue-run', repository: 'acme/widgets', kind: 'issue', number: 32 } },
      liveDetails: { todos: [], events: [] },
      usageMetricRecords: [], previewMedia: [],
      stoppingExecution: false, stopFailed: false, deletingTask: false,
      handleStopExecution: vi.fn(), handleDeleteTask: vi.fn(),
    };
  },
  usePromptData: () => ({ fetchPrompt: vi.fn(), selectedPrompt: null, loadingPrompt: false, setSelectedPrompt: vi.fn() }),
  useLogFilesData: () => ({ fetchLogFilesData: vi.fn(), logFiles: null, searchMatches: [], closeLogFiles: vi.fn() }),
}));
vi.mock('./useThinkingLog', () => ({
  useThinkingLog: () => ({ eventsCollapsed: true, collapseEvents: vi.fn(), toggleEventsCollapse: vi.fn(), thinkingLogWithTimestamps: [] }),
}));
vi.mock('./useHistoryData', () => ({
  getHistoryDerivedData: () => ({ currentStatus: 'failed', isTaskActive: false, modelName: null, prInfo: null, historyItemWithPaths: null }),
}));
vi.mock('./useDerivedTaskData', () => ({
  useTotalDuration: () => null, useCommitInfo: () => null, useConsumedReviewCommentIds: () => new Set(), useTokenUsage: () => null,
}));
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
// The original run's own status, as its header shows it; this suite checks it never changes.
vi.mock('./ActionBar', () => ({
  default: ({ onFollowUp, currentStatus }: { onFollowUp?: () => void; currentStatus: string }) => (
    <div data-testid="source-status" data-status={currentStatus}>{onFollowUp ? <button type="button" onClick={onFollowUp}>Follow Up</button> : null}</div>
  ),
}));
vi.mock('../../api/taskStatsApi', () => ({ getPullRequestScores: vi.fn(async () => null) }));
vi.mock('./ThinkingLog', () => ({ default: () => null }));
vi.mock('./ExecutionEventLog', () => ({ default: () => null }));
vi.mock('./ResultOverview', () => ({ default: () => null }));
vi.mock('./PromptModal', () => ({ default: () => null }));
vi.mock('./LogFilesModal', () => ({ default: () => null }));
vi.mock('./ContextStrip', () => ({ default: () => null, ConsumptionGroup: () => null, MobileGitContext: () => null, MobilePeopleRuntime: () => null }));
vi.mock('./TaskHeader', async importOriginal => ({ ...await importOriginal<typeof import('./TaskHeader')>(), default: () => null }));
vi.mock('./useTaskHeadSummary', async importOriginal => ({ ...await importOriginal<typeof import('./useTaskHeadSummary')>(), useTaskHeadSummary: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => <div data-testid="source-timeline">Original failed timeline</div> }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

const SOURCE = 'failed-issue-run';
const USER_ID = '297689653';
const user = (id: string) => ({ id, login: `user-${id}`, permissions: [] }) as unknown as CurrentUser;
const accepted: PostFollowupResponse = {
  success: true, state: 'queued', jobId: 'issue-acme-widgets-32', posted: true, commentId: 500,
  sourceTaskId: SOURCE, intent: 'issue', issueNumber: 32, message: 'Retry queued on issue #32.',
};
const runsOf = (runs: FollowupRunsResponse['runs']): FollowupRunsResponse => ({ sourceTaskId: SOURCE, commentId: 500, runs });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const renderPage = (userId = USER_ID) => render(
  <AuthProvider user={user(userId)}>
    <MemoryRouter initialEntries={[`/tasks/${SOURCE}`]}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetails taskId={SOURCE} />} />
      </Routes>
    </MemoryRouter>
  </AuthProvider>,
);

const flush = () => act(async () => {});
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS); });
const banner = () => screen.queryByTestId('followup-handoff');
const handoffKeys = () => Object.keys(sessionStorage).filter(key => key.startsWith('propr.followupHandoff.v1'));

async function postFollowup() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post Comment' })); });
}

const expectOriginalUntouched = () => {
  for (const status of screen.getAllByTestId('source-status')) expect(status).toHaveAttribute('data-status', 'failed');
  expect(screen.getByTestId('source-timeline')).toBeInTheDocument();
  expect(new Set(loadedTaskIds)).toEqual(new Set([SOURCE]));
};

/**
 * The desktop's own activation path: every activation of a saved profile gets
 * a new transport generation, as the credential service issues one, and a
 * renewal of the same identity keeps this tab's session storage.
 */
function desktopConnection() {
  const fixture = bridgeFixture();
  const adapters = createElectronDesktopAdapters(fixture.bridge);
  const otherProfile = { ...storedProfile, id: 'profile-2', label: 'Second server' };
  const connect = async (transportScope: string, stored = storedProfile) => {
    fixture.activate.mockResolvedValueOnce({ status: 'ready', profileId: stored.id, transportScope, identityEpoch: 'AAAAAAAAAAAAAAAAAAAAAA' });
    const profile = fromProfile(stored);
    const activated = await adapters.connection.activate!(profile, { status: 'ready', version: '0.8.15', activationTicket: `ticket-${transportScope}` });
    if (activated.status !== 'ready') throw new Error(`activation was ${activated.status}`);
    await act(async () => {
      adapters.connection.publishActivation!(profile, activated);
      await fixture.bridge.profiles.setActive(stored.id);
    });
  };
  const disconnect = () => act(() => adapters.connection.deactivate!());
  return { connect, disconnect, otherProfile };
}

const initialBaseUrl = API_BASE_URL;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sessionStorage.clear();
  loadedTaskIds.length = 0;
  api.postTaskFollowup.mockResolvedValue(accepted);
  api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
});

afterEach(() => {
  setDesktopConnectionScope(null, initialBaseUrl);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('an accepted issue follow-up survives a same-profile desktop reconnect', () => {
  it('restores the request on the remounted task view and follows it to the new run without posting again', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    const first = renderPage();
    await flush();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    first.unmount();

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    expect(getDesktopConnectionScope()?.transportScope).toBe('reconnected-transport-generation');
    expect(handoffKeys()).toHaveLength(1);
    // The remembered request carries no transport generation, so it outlives the one it was sent on.
    expect(handoffKeys()[0]).not.toContain('first-transport-generation');

    api.getTaskFollowupRuns.mockClear();
    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());

    // Admission is delayed: still starting, with no run guessed.
    await poll();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(within(banner()!).queryByRole('link')).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(banner()).toHaveTextContent('A new run is working on your follow-up');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
    await poll();
    expect(banner()).toHaveTextContent('The new run completed');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toBeInTheDocument();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    expectOriginalUntouched();
  });

  it('keeps the started run across a reconnect while the view stays mounted', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await postFollowup();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'started');

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'started');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});

describe('a response from a connection that is gone is never applied', () => {
  it('drops a lookup from the old generation that lands after a same-profile renewal, then looks again on the new one', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(late.promise);
    await poll();

    await desktop.disconnect();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    await desktop.connect('reconnected-transport-generation');
    await act(async () => { late.resolve(runsOf([{ taskId: 'stale-run', status: 'completed' }])); });
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(within(banner()!).queryByRole('link')).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
  });

  it('does not adopt an acceptance from the old generation that lands after a same-profile renewal', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    const pending = deferred<PostFollowupResponse>();
    api.postTaskFollowup.mockReturnValue(pending.promise);
    fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    await act(async () => { pending.resolve(accepted); });
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    await poll();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('drops a late lookup after a switch to another profile, which sees nothing of the handoff', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(late.promise);
    await poll();

    await desktop.disconnect();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    await desktop.connect('second-profile-generation', desktop.otherProfile);
    await act(async () => { late.resolve(runsOf([{ taskId: 'fresh-run', status: 'completed' }])); });
    expect(banner()).toBeNull();
    // Switching profiles still clears this renderer's state, the handoff included.
    expect(handoffKeys()).toHaveLength(0);
    // Nothing is looked up for the other profile: only the two lookups made before the switch.
    await poll();
    expect(api.getTaskFollowupRuns).toHaveBeenCalledTimes(2);
  });
});

describe('the remembered request stays with its account, instance and endpoint', () => {
  const scope = (profileId: string, transportScope: string) => ({ bridge: {} as never, profileId, transportScope });

  it('shows the same profile’s handoff to neither another endpoint nor another account', async () => {
    act(() => setDesktopConnectionScope(scope('instance-a', 'first-transport-generation'), 'https://one.propr.example.test'));
    const first = renderPage();
    await flush();
    await postFollowup();
    first.unmount();

    act(() => setDesktopConnectionScope(scope('instance-a', 'second-transport-generation'), 'https://two.propr.example.test'));
    const otherEndpoint = renderPage();
    await flush();
    expect(banner()).toBeNull();
    otherEndpoint.unmount();

    act(() => setDesktopConnectionScope(scope('instance-a', 'third-transport-generation'), 'https://one.propr.example.test'));
    const otherAccount = renderPage('42');
    await flush();
    expect(banner()).toBeNull();
    otherAccount.unmount();
    expect(api.getTaskFollowupRuns).toHaveBeenCalledTimes(1);

    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});
