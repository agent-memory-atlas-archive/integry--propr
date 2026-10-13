import React from 'react';
import type { Notification } from '@propr/shared';
import { notificationRunFollowup } from '../TaskDetails/runFollowup';
import type { TaskRunEntry } from '../TaskList/rowModel';
import FollowupCommands from './FollowupCommands';

interface NotificationActionsProps {
  notification: Notification;
  /** The runs of the notification's task, oldest first; null until they are read. */
  runs: readonly TaskRunEntry[] | null;
  mutationsEnabled: boolean;
  onCommandSent: () => Promise<void>;
  className?: string;
}

/**
 * A notification's follow-up commands, for the run it reports on, shown only
 * while that run is its task's newest: the same rule the run follows in Tasks.
 */
export const NotificationActions: React.FC<NotificationActionsProps> = ({
  notification,
  runs,
  mutationsEnabled,
  onCommandSent,
  className,
}) => {
  const followup = notificationRunFollowup(notification, runs);
  if (!mutationsEnabled || !followup) return null;
  return (
    <FollowupCommands
      taskId={followup.taskId}
      prNumber={followup.prNumber}
      commands={followup.commands}
      label={`Actions for ${notification.title}`}
      onCommandSent={onCommandSent}
      className={className}
    />
  );
};

export default NotificationActions;
