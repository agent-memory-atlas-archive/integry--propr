/**
 * The pull request's persisted review scores, oldest first: the scores joined
 * in sequence (4 — 6 — 8) and one line per score (cycle, score, reviewer, head).
 *
 * Renders nothing until the PR has at least one score, so tasks on unscored
 * PRs keep their run notes unchanged. The PR's merge status is not part of it:
 * that is the task's last entry, after every run and review (see PullRequestOutcomeEntry).
 */

import React from 'react';
import type { PullRequestScoresResponse } from '../../api/taskStatsApi';
import { formatModelName } from '../../utils/modelDisplay';

/** The scores in the order they were given, each joined to the next: 4 — 6 — 8. */
export const ReviewScoreSequence: React.FC<{ scores: number[] }> = ({ scores }) => (
  <ol
    aria-label={`Review scores: ${scores.join(', ')} out of 10`}
    data-testid="review-score-sequence"
    className="m-0 flex min-w-0 list-none flex-wrap items-center gap-y-1 p-0"
  >
    {scores.map((score, index) => (
      <li key={index} className="flex items-center">
        {index > 0 && <span aria-hidden="true" className="h-px w-3 bg-teal-300" />}
        <span className="rounded-full border border-teal-200 bg-teal-50 px-1.5 font-semibold tabular-nums leading-5 text-teal-800">
          {score}
        </span>
      </li>
    ))}
  </ol>
);

interface ReviewScoreHistoryProps {
  prNumber: number;
  history: PullRequestScoresResponse | null;
}

const ReviewScoreHistory: React.FC<ReviewScoreHistoryProps> = ({ prNumber, history }) => {
  if (!history || history.scores.length === 0) return null;

  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700" data-testid="review-score-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-900">Review scores · PR #{prNumber}</span>
        <ReviewScoreSequence scores={history.scores.map(entry => entry.score)} />
      </div>
      <ol aria-label="Review score details" className="mt-1 space-y-0.5 text-[11px]">
        {history.scores.map(entry => (
          <li key={`${entry.task_id}:${entry.created_at}:${entry.reviewer_model}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-14 flex-none text-slate-500">
              {entry.source === 'ultrafix' && entry.cycle_number !== null ? `Cycle ${entry.cycle_number}` : 'Review'}
            </span>
            <span className="font-semibold tabular-nums text-slate-900">{entry.score}/10</span>
            {entry.reviewer_model && <span className="text-slate-500">{formatModelName(entry.reviewer_model)}</span>}
            {entry.head_sha && <span className="font-mono text-[10px] text-slate-400">{entry.head_sha.slice(0, 7)}</span>}
            <time className="ml-auto text-slate-400" dateTime={entry.created_at}>
              {new Date(entry.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
};

export default ReviewScoreHistory;
