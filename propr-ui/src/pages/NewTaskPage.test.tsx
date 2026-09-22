import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import NewTaskPage from './NewTaskPage';
import { API_BASE_URL } from '../api/apiClient';
import * as submissions from '../api/taskSubmissions';
import * as planner from '../api/plannerApi';

vi.mock('../api/taskSubmissions', () => ({ submitTask: vi.fn(), getTaskSubmission: vi.fn(), retryTaskSubmission: vi.fn(), taskSnapshotStorage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/plannerApi', () => ({ createDraft: vi.fn(), uploadAttachment: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn().mockResolvedValue({ repositories: [{ name: 'acme/billing', enabled: true }], agents: [{ alias: 'issue-only', enabled: true, supportedModels: ['model-1'], defaultModel: 'model-1' }] }) }));
vi.mock('../contexts/AuthContext', () => ({ useCurrentUser: () => ({ id: 'alice' }) }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../components/RepositorySelector', () => ({ RepositorySelector: ({ selectedRepo, onRepoChange }: { selectedRepo: string; onRepoChange: (value: string) => void }) => <select aria-label="Repository" value={selectedRepo} onChange={event => onRepoChange(event.target.value)}><option value="" /><option>acme/billing</option></select> }));
function Destination() { const location = useLocation(); return <div data-testid="destination">{location.pathname} {JSON.stringify(location.state)}</div>; }
const pending = { id: 'submission', state: 'failed' as const, issueNumber: 42, issueUrl: 'https://github.com/acme/billing/issues/42', taskId: null, error: 'Queue unavailable' };
const renderPage = () => render(<MemoryRouter initialEntries={[{ pathname: '/tasks/new', state: { initialRepository: 'acme/billing', initialPrompt: 'Fix invoice dates', todoIds: ['todo-1'] } }]}><Routes><Route path="/tasks/new" element={<NewTaskPage />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(submissions.taskSnapshotStorage).mockResolvedValue(undefined); });
describe('New Task issue launcher', () => {
  it('retains the issue and request on failure, retries that submission, then opens the ordinary task', async () => {
    vi.mocked(submissions.submitTask).mockResolvedValue(pending);
    vi.mocked(submissions.retryTaskSubmission).mockResolvedValue({ ...pending, state: 'queued', error: null, taskId: 'ordinary-issue-task' });
    renderPage();
    const run = await screen.findByRole('button', { name: 'Run task' });
    await waitFor(() => expect(run).toBeEnabled());
    expect(screen.getByLabelText('Instruction')).toHaveValue('Fix invoice dates');
    fireEvent.click(run);
    expect(await screen.findByText('Could not start task')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open issue #42' })).toHaveAttribute('href', pending.issueUrl);
    const [key, payload] = vi.mocked(submissions.submitTask).mock.calls[0];
    expect(payload).toMatchObject({ repository: 'acme/billing', instruction: 'Fix invoice dates', todoIds: ['todo-1'] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry submission' }));
    expect(await screen.findByTestId('destination')).toHaveTextContent('/tasks/ordinary-issue-task');
    expect(submissions.retryTaskSubmission).toHaveBeenCalledWith(key);
    expect(submissions.submitTask).toHaveBeenCalledTimes(1);
    expect(planner.createDraft).not.toHaveBeenCalled();
    expect(screen.queryByText(/What's done|Continue|Pause goal/)).not.toBeInTheDocument();
  });
  it('recovers the same identity after reload without resubmitting an issue', async () => {
    vi.mocked(submissions.taskSnapshotStorage).mockResolvedValue({ key: 'saved-key', payload: { repository: 'acme/billing', instruction: 'Saved request' }, files: [] });
    vi.mocked(submissions.getTaskSubmission).mockResolvedValue(pending);
    renderPage();
    expect(await screen.findByText('Could not start task')).toBeInTheDocument();
    expect(screen.getByLabelText('Instruction')).toHaveValue('Saved request');
    expect(submissions.getTaskSubmission).toHaveBeenCalledWith('saved-key');
    expect(submissions.submitTask).not.toHaveBeenCalled();
  });
  it('transfers files to Plan first before navigation and preserves failed transfers for retry', async () => {
    vi.mocked(planner.createDraft).mockResolvedValue({ draft_id: 'plan-1' } as never);
    vi.mocked(planner.uploadAttachment).mockRejectedValueOnce(new Error('Upload unavailable')).mockResolvedValue({} as never);
    renderPage();
    const file = new File(['Invoice date: 09/22/2026'], 'invoice.txt', { type: 'text/plain' });
    await act(async () => fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } }));
    const plan = screen.getByRole('button', { name: 'Plan first' });
    await waitFor(() => expect(plan).toBeEnabled());
    fireEvent.click(plan);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your files are kept here');
    expect(screen.getByText('invoice.txt')).toBeInTheDocument();
    fireEvent.click(plan);
    expect(await screen.findByTestId('destination')).toHaveTextContent('/studio/plan-1');
    expect(planner.createDraft).toHaveBeenCalledTimes(1);
    expect(planner.createDraft).toHaveBeenCalledWith('acme/billing', 'Fix invoice dates', { todoIds: ['todo-1'] });
    expect(planner.uploadAttachment).toHaveBeenLastCalledWith('plan-1', file);
    expect(submissions.submitTask).not.toHaveBeenCalled();
  });
  it('rejects stale remembered routing and allows issue-only agents', async () => {
    localStorage.setItem(`task-routing:${API_BASE_URL}:alice`, JSON.stringify({ agentAlias: 'retired', model: 'old' }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('saved agent or model is unavailable');
    expect(screen.getByRole('button', { name: 'Run task' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'issue-only' } });
    expect(screen.getByRole('button', { name: 'Run task' })).toBeEnabled();
  });
});
