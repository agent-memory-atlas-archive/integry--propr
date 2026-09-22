import type { Notification } from '@propr/shared';
import { summaryBrowserPath, summaryHrefWithBranch } from '../utils/summaryBrowser';

/** System and indexing updates are kept apart from the linear activity feed. */
export function isSystemNotification(notification: Notification): boolean {
  return notification.kind === 'system_failure' || notification.kind === 'indexing';
}

export interface NotificationReference {
  label: string;
  title: string;
}

/** The PR or issue a notification is about, labelled like the task context strip chips. */
export function notificationReference(notification: Notification): NotificationReference | null {
  const { target } = notification;
  if (target.type === 'review' || target.type === 'pull_request') {
    return { label: `PR${target.prNumber}`, title: `Pull Request #${target.prNumber}` };
  }
  if (target.type !== 'task') return null;
  if (target.prNumber !== undefined) {
    return { label: `PR${target.prNumber}`, title: `Pull Request #${target.prNumber}` };
  }
  return target.issueNumber === undefined
    ? null
    : { label: `#${target.issueNumber}`, title: `Issue #${target.issueNumber}` };
}

/** Unread indicator colour: failures red, warnings orange, everything else teal. */
export function notificationIndicatorClass(notification: Notification): string {
  if (notification.severity === 'error') return 'bg-red-500';
  if (notification.severity === 'warning') return 'bg-orange-500';
  return 'bg-teal-500';
}

export function notificationKindLabel(notification: Notification): string {
  switch (notification.kind) {
    case 'plan': return 'Plan ready';
    case 'review': return 'Review completed';
    case 'pull_request': {
      const completionType = notification.metadata?.completionType;
      if (completionType === 'fix') return 'Fix completed';
      if (completionType === 'merge') return 'Merge completed';
      if (completionType === 'switch') return 'Model switched';
      return 'PR ready';
    }
    case 'system_failure': return 'System failure';
    case 'indexing': return notification.severity === 'warning'
      ? 'Indexing stalled'
      : 'Indexing failed';
    case 'task':
      if (notification.severity === 'success') return 'Implementation completed';
      if (notification.severity === 'warning') return 'Task stalled';
      return 'Task failed';
  }
}

export function notificationRepository(notification: Notification): string {
  return notification.target.type === 'system_failure'
    ? `System · ${notification.target.component}`
    : notification.target.repository;
}

export function notificationHref(notification: Notification): string {
  if (notification.action?.type === 'navigate') {
    return notification.target.type === 'indexing'
      ? summaryHrefWithBranch(
        notification.action.href,
        notification.target.repository,
        notification.target.branch,
      )
      : notification.action.href;
  }
  switch (notification.target.type) {
    case 'plan': return `/studio/${encodeURIComponent(notification.target.draftId)}`;
    case 'task': return `/tasks/${encodeURIComponent(notification.target.taskId)}`;
    case 'review': return notification.target.taskId
      ? `/tasks/${encodeURIComponent(notification.target.taskId)}`
      : '/tasks';
    case 'pull_request': {
      const completedTaskId = notification.metadata?.completedImplementationTaskId;
      return notificationPullRequestUrl(notification)
        ?? (typeof completedTaskId === 'string' && completedTaskId
          ? `/tasks/${encodeURIComponent(completedTaskId)}`
          : '/repositories');
    }
    case 'indexing': {
      const [owner, repository] = notification.target.repository.split('/');
      return owner && repository
        ? summaryBrowserPath(owner, repository, notification.target.branch)
        : '/repositories';
    }
    case 'system_failure': return '/';
  }
}

/** Returns a trusted GitHub pull-request URL advertised by the event, if any. */
function isTrustedGithubUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && url.hostname === 'github.com'
    && url.username === ''
    && url.password === ''
    && (url.port === '' || url.port === '443')
    && url.search === ''
    && url.hash === '';
}

function notificationPullRequestIdentity(notification: Notification): {
  repository: string | null;
  prNumber: number | undefined;
} {
  const repository = notification.target.type === 'system_failure'
    ? null
    : notification.target.repository;
  switch (notification.target.type) {
    case 'task':
    case 'review':
    case 'pull_request': return { repository, prNumber: notification.target.prNumber };
    default: return { repository, prNumber: undefined };
  }
}

export function notificationPullRequestUrl(notification: Notification): string | null {
  if (notification.action?.type !== 'external_link') return null;
  try {
    const url = new URL(notification.action.href);
    if (!isTrustedGithubUrl(url)) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const { repository, prNumber } = notificationPullRequestIdentity(notification);
    if (repository !== null && `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
      return null;
    }
    if (prNumber !== undefined && Number(match[3]) !== prNumber) return null;
    return url.href;
  } catch {
    return null;
  }
}

export interface NotificationFollowupCommand {
  taskId: string;
  prNumber: number;
  commands: readonly string[];
}

/**
 * The only buttons an Inbox card offers: the common next command after a
 * finished review (/fix) or a finished PR run (/review, /ultrafix).
 */
export function notificationFollowupCommand(notification: Notification): NotificationFollowupCommand | null {
  if (!notification.actions.includes('follow_up')) return null;
  if (notification.target.type === 'review' && notification.target.taskId) {
    return {
      taskId: notification.target.taskId,
      prNumber: notification.target.prNumber,
      commands: ['/fix'],
    };
  }
  const completedTaskId = notification.metadata?.completedImplementationTaskId;
  if (notification.target.type === 'pull_request' && typeof completedTaskId === 'string' && completedTaskId) {
    return {
      taskId: completedTaskId,
      prNumber: notification.target.prNumber,
      commands: ['/review', '/ultrafix'],
    };
  }
  return null;
}

export function formatRelativeTime(timestamp: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1_000));
  if (elapsedSeconds < 60) return 'just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function compareNewestFirst(left: Notification, right: Notification): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}

export function mergeNotifications(
  current: readonly Notification[],
  incoming: readonly Notification[],
): Notification[] {
  const byId = new Map(current.map(notification => [notification.id, notification]));
  for (const notification of incoming) byId.set(notification.id, notification);
  return [...byId.values()].sort(compareNewestFirst);
}

/**
 * Folds a fresh first page into a list that also holds older pages. Loaded
 * notifications inside the page's range that the server no longer returns were
 * dismissed elsewhere, so they are dropped; older pages are kept as they are.
 * `boundary` is the oldest notification the server returned, or null when the
 * page is the whole Inbox.
 */
export function replaceNotificationRange(
  current: readonly Notification[],
  incoming: readonly Notification[],
  boundary: Notification | null,
): Notification[] {
  const older = boundary
    ? current.filter(notification => compareNewestFirst(notification, boundary) > 0)
    : [];
  return mergeNotifications(older, incoming);
}
