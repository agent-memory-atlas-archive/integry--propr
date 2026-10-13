import type { Notification } from '@propr/shared';
import type { FileChange } from '../../api/fileChangesApi';
import { notificationFindingReference, notificationReviewOutcome } from '../inboxUtils';

/** The verdict card shows the few broken lines, not the change: the workbench in /tasks has the rest. */
export const MAX_TRIAGE_DIFF_FILES = 2;
export const MAX_TRIAGE_DIFF_LINES = 12;

export interface TriageFinding {
  /** 1-based position in the reviewer's list. */
  index: number;
  /** The `path:line` the finding leads with, when it names one. */
  reference: string | null;
  text: string;
}

export interface TriageReviewVerdict {
  score: number | null;
  findings: TriageFinding[];
}

/** The review's score and enumerated findings, read from the notification itself; no extra request. */
export function reviewFindings(notification: Notification): TriageReviewVerdict {
  const outcome = notificationReviewOutcome(notification);
  if (!outcome) return { score: null, findings: [] };
  return {
    score: outcome.score,
    findings: outcome.findings.map((finding, position) => {
      const reference = notificationFindingReference(finding);
      return {
        index: position + 1,
        reference: reference?.reference ?? null,
        text: reference ? reference.text : finding,
      };
    }),
  };
}

/** The task behind a notification, which the diff and `Inspect in Tasks` open; null when none backs it. */
export function triageTaskId(notification: Notification): string | null {
  const { target } = notification;
  if ((target.type === 'review' || target.type === 'task') && target.taskId) return target.taskId;
  const completedTaskId = notification.metadata?.completedImplementationTaskId;
  if (target.type === 'pull_request' && typeof completedTaskId === 'string' && completedTaskId) return completedTaskId;
  return null;
}

export type TriageDiffLineKind = 'added' | 'removed';

export interface TriageDiffFile {
  path: string;
  lines: Array<{ kind: TriageDiffLineKind; text: string }>;
  /** Changed lines left out of the card. */
  hiddenLines: number;
}

export interface TriageDiff {
  files: TriageDiffFile[];
  /** Files left out of the card. */
  hiddenFiles: number;
}

function changedLines(diff: string): TriageDiffFile['lines'] {
  return diff.split('\n').flatMap<TriageDiffFile['lines'][number]>(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return [];
    if (line.startsWith('+')) return [{ kind: 'added', text: line.slice(1) }];
    if (line.startsWith('-')) return [{ kind: 'removed', text: line.slice(1) }];
    return [];
  });
}

/** Bounds a task's diff to the first files and changed lines, so the card stays a verdict. */
export function trimDiffForTriage(files: readonly FileChange[]): TriageDiff {
  const withChanges = files
    .map(file => ({ path: file.path, lines: changedLines(file.diff ?? '') }))
    .filter(file => file.lines.length > 0);
  return {
    files: withChanges.slice(0, MAX_TRIAGE_DIFF_FILES).map(file => ({
      path: file.path,
      lines: file.lines.slice(0, MAX_TRIAGE_DIFF_LINES),
      hiddenLines: Math.max(0, file.lines.length - MAX_TRIAGE_DIFF_LINES),
    })),
    hiddenFiles: Math.max(0, withChanges.length - MAX_TRIAGE_DIFF_FILES),
  };
}
