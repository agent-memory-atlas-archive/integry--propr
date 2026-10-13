import { useSyncExternalStore } from 'react';

/**
 * A follow-up command sent from a card: in flight until the request settles,
 * then sent. Sent stays for the page's lifetime, so the command cannot be
 * replayed against the same run from another card or after a remount.
 */
export interface FollowupSubmission {
  command: string;
  status: 'pending' | 'sent';
}

// Keyed by the task the command is sent through, so the Inbox verdict, a
// remounted verdict and the Tasks screen all see one submission per run.
const submissions = new Map<string, FollowupSubmission>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

/** Claims the run for `command`; false when a command for it is already in flight or sent. */
export function claimFollowup(taskId: string, command: string): boolean {
  if (submissions.has(taskId)) return false;
  submissions.set(taskId, { command, status: 'pending' });
  notify();
  return true;
}

/** Settles the claim: a sent command keeps the run claimed; a failed one frees it for a retry. */
export function settleFollowup(taskId: string, sent: boolean): void {
  if (sent) submissions.set(taskId, { command: submissions.get(taskId)?.command ?? '', status: 'sent' });
  else submissions.delete(taskId);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFollowupSubmission(taskId: string | null): FollowupSubmission | undefined {
  return useSyncExternalStore(subscribe, () => (taskId ? submissions.get(taskId) : undefined));
}

/** Tests only: forget every submission. */
export function resetFollowupSubmissions(): void {
  submissions.clear();
  notify();
}
