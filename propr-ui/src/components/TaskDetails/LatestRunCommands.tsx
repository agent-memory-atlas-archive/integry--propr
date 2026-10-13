import React from 'react';
import FollowupCommands from '../Inbox/FollowupCommands';
import type { TaskRunEntry } from '../TaskList/rowModel';
import { latestRunFollowup } from './runFollowup';

/** The newest run's follow-up commands; an earlier run shows none, so it cannot replay one. */
const LatestRunCommands: React.FC<{ runs?: readonly TaskRunEntry[]; taskId?: string }> = ({ runs, taskId }) => {
  const followup = latestRunFollowup(runs, taskId);
  if (!followup) return null;
  return (
    <FollowupCommands
      taskId={followup.taskId}
      prNumber={followup.prNumber}
      commands={followup.commands}
      label={`Follow-up commands for PR #${followup.prNumber}`}
    />
  );
};

export default LatestRunCommands;
