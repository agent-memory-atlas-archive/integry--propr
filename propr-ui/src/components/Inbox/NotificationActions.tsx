import React from 'react';
import type { Notification } from '@propr/shared';
import { notificationFollowupCommand } from '../../pages/inboxUtils';
import FollowupCommands from './FollowupCommands';

interface NotificationActionsProps {
  notification: Notification;
  mutationsEnabled: boolean;
  onCommandSent: () => Promise<void>;
  className?: string;
}

/** A notification's follow-up commands, for the run it reports on. */
export const NotificationActions: React.FC<NotificationActionsProps> = ({
  notification,
  mutationsEnabled,
  onCommandSent,
  className,
}) => {
  const followup = notificationFollowupCommand(notification);
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
