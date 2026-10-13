import { isReviewRun, type TaskRunEntry } from '../TaskList/rowModel';
import { getDisplayStatus } from '../TaskList/utils.tsx';

export interface RunFollowup {
  /** The run the commands are sent through. */
  taskId: string;
  prNumber: number;
  commands: string[];
}

/** A review that found nothing has nothing to fix. */
const isCleanReview = (run: TaskRunEntry): boolean =>
  (run.task.score ?? 0) >= 10 || /\b0 issues found\b/.test(run.summary);

/**
 * The follow-up commands the Inbox offers for a run, on the task's newest run
 * only: a review with findings offers /fix, a finished run with a pull request
 * offers /review and /ultrafix. An earlier run, one still working, a failed or
 * merged one, or a run the list has not read yet offers nothing, so a command
 * is never replayed against a run that newer work has already superseded.
 */
export function latestRunFollowup(runs: readonly TaskRunEntry[] | undefined, taskId: string | undefined): RunFollowup | null {
  const head = runs?.[runs.length - 1];
  if (!head || head.task.id !== taskId || getDisplayStatus(head.task) !== 'completed') return null;
  const prNumber = head.task.prNumber;
  if (!prNumber) return null;
  if (!isReviewRun(head.type)) return { taskId: head.task.id, prNumber, commands: ['/review', '/ultrafix'] };
  return isCleanReview(head) ? null : { taskId: head.task.id, prNumber, commands: ['/fix'] };
}
