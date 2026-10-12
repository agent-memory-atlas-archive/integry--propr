import { render, renderHook, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewScoreHistory, { ReviewScoreSequence } from './ReviewScoreHistory';
import PullRequestOutcomeEntry from './PullRequestOutcomeEntry';
import { pullRequestOutcome, usePullRequestScores } from './pullRequestScores';
import { getPullRequestScores } from '../../api/taskStatsApi';

vi.mock('../../api/taskStatsApi', () => ({ getPullRequestScores: vi.fn() }));

type ScoresResponse = Awaited<ReturnType<typeof getPullRequestScores>>;

const score = (overrides: Record<string, unknown>) => ({
  cycle_number: null, source: 'review', score: 7, goal: null, blocker_count: 0, suggestion_count: 0,
  reviewer_agent: 'codex', reviewer_model: 'gpt-5.6', implementer_model: 'claude-opus-5-5',
  head_sha: '0123456789abcdef', task_id: 'review-task', created_at: '2026-10-06T10:00:00.000Z', ...overrides,
});

const mergedHistory = {
  repository: 'acme/repo', pr_number: 42, outcome: 'merged', merged_at: '2026-10-06T12:00:00.000Z', closed_at: null,
  scores: [
    score({ source: 'ultrafix', cycle_number: 1, score: 4, created_at: '2026-10-06T09:00:00.000Z' }),
    score({ source: 'ultrafix', cycle_number: 2, score: 6, created_at: '2026-10-06T10:00:00.000Z' }),
    score({ source: 'ultrafix', cycle_number: 3, score: 8, head_sha: 'fedcba9876543210', created_at: '2026-10-06T11:00:00.000Z' }),
  ],
} as ScoresResponse;

describe('ReviewScoreHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('joins the scores in sequence and lists each with its cycle, reviewer and head, leaving the merge status out', () => {
    render(<ReviewScoreHistory prNumber={42} history={mergedHistory} />);

    const history = screen.getByTestId('review-score-history');
    expect(history).toHaveTextContent('Review scores · PR #42');
    // A plain progression of the scores, oldest first, not a chart.
    const sequence = within(history).getByRole('list', { name: 'Review scores: 4, 6, 8 out of 10' });
    expect(within(sequence).getAllByRole('listitem').map(item => item.textContent)).toEqual(['4', '6', '8']);
    expect(history.querySelector('svg')).toBeNull();

    const items = within(within(history).getByRole('list', { name: 'Review score details' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Cycle 1');
    expect(items[0]).toHaveTextContent('4/10');
    expect(items[0]).toHaveTextContent('0123456');
    expect(items[2]).toHaveTextContent('8/10');
    expect(items[2]).toHaveTextContent('fedcba9');
    // The PR's outcome is the task's own last entry, not a footnote of its scores.
    expect(history).not.toHaveTextContent('Merged');
  });

  it('renders nothing for an unscored PR or before the history loads', () => {
    const { container, rerender } = render(<ReviewScoreHistory prNumber={7} history={{ ...mergedHistory, scores: [] }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ReviewScoreHistory prNumber={7} history={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('connects each score to the one before it', () => {
    const { rerender } = render(<ReviewScoreSequence scores={[4, 6, 8]} />);
    expect(screen.getByTestId('review-score-sequence').querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    rerender(<ReviewScoreSequence scores={[5]} />);
    expect(screen.getByTestId('review-score-sequence').querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });
});

describe('usePullRequestScores', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads nothing for a task without a PR', () => {
    const { result } = renderHook(() => usePullRequestScores(undefined, undefined));
    expect(result.current).toBeNull();
    expect(getPullRequestScores).not.toHaveBeenCalled();
  });

  it('never returns a previous PR\'s history for a new PR, while loading or after a failed read', async () => {
    vi.mocked(getPullRequestScores).mockResolvedValueOnce(mergedHistory);
    const { result, rerender } = renderHook(({ prNumber }) => usePullRequestScores('acme/repo', prNumber), { initialProps: { prNumber: 42 } });
    await vi.waitFor(() => expect(result.current?.pr_number).toBe(42));
    expect(getPullRequestScores).toHaveBeenCalledWith('acme/repo', 42);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectRead: (error: Error) => void = () => {};
    vi.mocked(getPullRequestScores).mockReturnValueOnce(new Promise((_, reject) => { rejectRead = reject; }));
    rerender({ prNumber: 43 });
    expect(getPullRequestScores).toHaveBeenLastCalledWith('acme/repo', 43);
    // While PR 43 loads, PR 42's history is not returned for it.
    expect(result.current).toBeNull();

    rejectRead(new Error('offline'));
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe('PullRequestOutcomeEntry', () => {
  it('names a merged or closed PR and nothing for an open one', () => {
    expect(pullRequestOutcome(42, mergedHistory)).toEqual({ prNumber: 42, state: 'merged', at: '2026-10-06T12:00:00.000Z' });
    expect(pullRequestOutcome(42, { ...mergedHistory, outcome: 'closed', merged_at: null, closed_at: '2026-10-07T08:00:00.000Z' }))
      .toEqual({ prNumber: 42, state: 'closed', at: '2026-10-07T08:00:00.000Z' });
    expect(pullRequestOutcome(42, { ...mergedHistory, outcome: null })).toBeNull();
    expect(pullRequestOutcome(42, null)).toBeNull();
  });

  it('stands on its own after a single run', () => {
    render(<PullRequestOutcomeEntry outcome={{ prNumber: 42, state: 'closed', at: null }} variant="standalone" />);
    const entry = screen.getByTestId('pr-outcome-entry');
    expect(entry.tagName).toBe('DIV');
    expect(entry).toHaveTextContent('Closed unmerged');
    expect(entry).toHaveTextContent('PR #42');
    expect(entry.querySelector('time')).toBeNull();
  });
});
