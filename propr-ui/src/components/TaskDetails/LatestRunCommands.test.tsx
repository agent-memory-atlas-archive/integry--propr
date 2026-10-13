import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { postTaskFollowup } from '../../api/proprApi';
import { resetFollowupSubmissions } from '../Inbox/followupSubmissions';
import { ToastProvider } from '../ui/Toast';
import type { TaskRunEntry } from '../TaskList/rowModel';
import type { Task } from '../TaskList/types';
import LatestRunCommands from './LatestRunCommands';
import { latestRunFollowup } from './runFollowup';

vi.mock('../../api/proprApi', () => ({ postTaskFollowup: vi.fn() }));

function run(number: number, type: string | null, task: Partial<Task> = {}): TaskRunEntry {
  return {
    number,
    type,
    summary: '',
    outcome: 'passed',
    task: { id: `run-${number}`, status: 'completed', createdAt: '2026-10-13T10:00:00.000Z', prNumber: 3065, ...task },
  };
}

const implementation = run(1, null);
const review = run(2, 'review', { score: 6 });

describe('latestRunFollowup', () => {
  test('offers /fix on a newest review with findings and /review, /ultrafix on a newest finished run', () => {
    expect(latestRunFollowup([implementation, review], 'run-2')).toEqual({ taskId: 'run-2', prNumber: 3065, commands: ['/fix'] });
    expect(latestRunFollowup([implementation], 'run-1')).toEqual({ taskId: 'run-1', prNumber: 3065, commands: ['/review', '/ultrafix'] });
  });

  test('offers nothing on an earlier run, so a command cannot be replayed from it', () => {
    expect(latestRunFollowup([implementation, review], 'run-1')).toBeNull();
    expect(latestRunFollowup([review, run(3, 'fix', { status: 'processing' })], 'run-2')).toBeNull();
  });

  test('offers nothing before the runs are read, while the run works, after it failed or merged, or without a PR', () => {
    expect(latestRunFollowup(undefined, 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { status: 'processing' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { status: 'failed' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { planIssueStatus: 'merged' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { prNumber: null })], 'run-1')).toBeNull();
  });

  test('offers nothing on a clean review', () => {
    expect(latestRunFollowup([run(1, 'review', { score: 10 })], 'run-1')).toBeNull();
    expect(latestRunFollowup([{ ...run(1, 'review', { score: 9 }), summary: 'Score 9/10 · 0 issues found' }], 'run-1')).toBeNull();
  });
});

describe('LatestRunCommands', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetFollowupSubmissions();
  });

  const renderCommands = (taskId: string) => render(
    <ToastProvider><LatestRunCommands runs={[implementation, review]} taskId={taskId} /></ToastProvider>,
  );

  test('the newest run sends its command once; reopening it keeps the command sent', async () => {
    let resolve: () => void = () => undefined;
    vi.mocked(postTaskFollowup).mockReturnValue(new Promise(done => { resolve = () => done({ success: true, message: 'Posted' }); }));
    const { unmount } = renderCommands('run-2');
    const fix = screen.getByRole('button', { name: 'Send /fix to PR #3065' });
    fireEvent.click(fix);
    fireEvent.click(fix);
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
    expect(postTaskFollowup).toHaveBeenCalledWith('run-2', '/fix', 'pull_request');
    await act(async () => resolve());
    expect(await screen.findByText('Sent /fix to PR #3065.')).toBeInTheDocument();
    unmount();

    renderCommands('run-2');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send /fix to PR #3065' })).toBeDisabled());
  });

  test('an earlier run shows no commands', () => {
    renderCommands('run-1');
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
  });
});
