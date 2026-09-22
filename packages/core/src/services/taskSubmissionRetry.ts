import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import type { TaskSubmission, SubmissionPayload } from './taskSubmissionService.js';

export interface SubmissionRetry { eventId: string; userId?: string }
interface LabelEvent { id?: number; event: string; created_at?: string; label?: { name: string }; actor?: { id: number } }

/** A fresh trigger after terminal work is ordinary issue follow-up, not a launch retry. */
export async function resolveTaskSubmissionRetry(
  submission: TaskSubmission,
  database: Knex = db,
  getOctokit = getAuthenticatedOctokit,
): Promise<SubmissionRetry | null> {
  if (!submission.task_id) return null;
  const latest = await database('task_history').where({ task_id: submission.task_id }).orderBy('timestamp', 'desc').first('state', 'timestamp');
  if (!latest || !['completed', 'failed', 'cancelled'].includes(String(latest.state).toLowerCase())) return null;
  const trigger = (JSON.parse(submission.payload) as SubmissionPayload).trigger;
  const [owner, repo] = submission.repository.split('/');
  const octokit = await getOctokit();
  let event: LabelEvent | undefined;
  for (let page = 1; ; page++) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner, repo, issue_number: submission.issue_number!, per_page: 100, page,
    });
    for (const item of data as LabelEvent[]) {
      if (item.event === 'labeled' && item.label?.name === trigger) event = item;
    }
    if (data.length < 100) break;
  }
  if (!event?.id || !event.created_at || String(event.id) === submission.retry_event_id
    || Date.parse(event.created_at) <= Date.parse(latest.timestamp)) return null;
  return { eventId: String(event.id), ...(event.actor?.id ? { userId: String(event.actor.id) } : {}) };
}
