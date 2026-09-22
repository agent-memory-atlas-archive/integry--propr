import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { db } from '../db/connection.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';

export interface SubmissionAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  content: string;
  extension: string;
}
export interface TaskSubmission {
  id: string;
  user_id: string;
  submission_key: string;
  payload_hash: string;
  repository: string;
  payload: string;
  attachments: string;
  state: 'prepared' | 'creating' | 'issue_created' | 'queued' | 'failed';
  issue_number: number | null;
  issue_url: string | null;
  task_id: string | null;
  latest_task_id: string | null;
  dispatch_claim: string | null;
  retry_event_id: string | null;
  dispatch_complete: boolean;
  error: string | null;
}
export interface SubmissionPayload {
  instruction: string;
  agentAlias: string;
  model: string;
  routingLabel: string;
  baseBranch?: string;
  trigger: string;
  username: string;
  todoIds?: string[];
}
export const submissionMarker = (id: string): string => `<!-- propr-task-submission:${id} -->`;
export const submissionAssetPath = (file: SubmissionAttachment, issue: string | number): string =>
  `.propr/assets/${issue}/${file.id}${file.extension}`;

export async function findIssueSubmission(issue: IssueJobData, database: Knex = db): Promise<TaskSubmission | undefined> {
  return database<TaskSubmission>('task_submissions').where({
    repository: `${issue.repoOwner}/${issue.repoName}`.toLowerCase(), issue_number: issue.number,
  }).first();
}

/** The submission owns the initial delivery only; normal task retries keep their own contract. */
export async function materializeSubmissionAttachments(issue: IssueJobData, root: string, database: Knex = db): Promise<void> {
  const submission = await findIssueSubmission(issue, database);
  if (!submission) return;
  const files = JSON.parse(submission.attachments) as SubmissionAttachment[];
  for (const file of files) {
    const relative = submissionAssetPath(file, submission.id);
    await fs.outputFile(path.join(root, relative), Buffer.from(file.content, 'base64'));
  }
}

interface SubmissionServices {
  createIssue: (row: TaskSubmission) => Promise<{ number: number; url: string }>;
  reconcileIssue: (row: TaskSubmission) => Promise<{ number: number; url: string } | null>;
  dispatch: (row: TaskSubmission) => Promise<void>;
}

/** A single CAS authorizes creation. An ambiguous response NEVER authorizes another POST. */
export async function resumeTaskSubmission(database: Knex, id: string, services: SubmissionServices): Promise<TaskSubmission> {
  const read = async () => (await database<TaskSubmission>('task_submissions').where({ id }).first())!;
  let row = await read();
  if (!row.issue_number) {
    const won = await database('task_submissions').where({ id, state: 'prepared' }).update({ state: 'creating', error: null });
    try {
      const issue = won ? await services.createIssue(row) : await services.reconcileIssue(row);
      if (!issue) return read();
      await database('task_submissions').where({ id }).whereNull('issue_number').update({ issue_number: issue.number, issue_url: issue.url, state: 'issue_created', error: null });
    } catch (error) {
      // Only an explicit rejection of the create request permits another POST.
      const status = (error as { status?: number }).status;
      const rejected = won && status !== undefined && [400, 401, 403, 404, 410, 422].includes(status);
      await database('task_submissions').where({ id }).whereNull('issue_number').update({
        ...(rejected ? { state: 'prepared' } : {}),
        error: (rejected ? 'Could not create the issue. ' : 'Issue creation is unconfirmed. Retry to reconcile with GitHub. ') + (error as Error).message,
      });
      return read();
    }
    row = await read();
  }
  if (row.state === 'queued' || row.dispatch_complete) return row;
  const claim = randomUUID();
  const won = await database('task_submissions').where({ id, dispatch_complete: false })
    .whereNot('state', 'queued').whereNull('dispatch_claim').update({ dispatch_claim: claim });
  if (!won) return read();
  try {
    // Re-read inside the durable claim: a webhook may have completed dispatch
    // while this caller was acquiring it. A replay must never reapply the trigger.
    row = await read();
    if (row.state === 'queued' || row.dispatch_complete || row.task_id) return row;
    const pending = await database('task_submissions').where({ id, dispatch_claim: claim, dispatch_complete: false })
      .whereNot('state', 'queued').whereNull('task_id').update({ state: 'issue_created', error: null });
    if (!pending) return read();
    await services.dispatch(row);
    await database('task_submissions').where({ id, dispatch_claim: claim, state: 'issue_created' }).update({ state: 'queued', error: null });
  } catch (error) {
    await database('task_submissions').where({ id, dispatch_claim: claim, dispatch_complete: false }).whereNot('state', 'queued')
      .update({ state: 'failed', error: (error as Error).message });
  } finally {
    // Do not expire a live or interrupted claim: GitHub cannot fence a delayed
    // label write. A crash can still be resolved by the ordinary issue dispatcher.
    await database('task_submissions').where({ id, dispatch_claim: claim }).update({ dispatch_claim: null });
  }
  return read();
}

export async function insertTaskSubmission(database: Knex, input: Pick<TaskSubmission, 'user_id' | 'submission_key' | 'payload_hash' | 'repository' | 'payload' | 'attachments'>): Promise<TaskSubmission> {
  await database('task_submissions').insert({ id: randomUUID(), ...input }).onConflict(['user_id', 'submission_key']).ignore();
  const row = (await database<TaskSubmission>('task_submissions').where({ user_id: input.user_id, submission_key: input.submission_key }).first())!;
  if (row.payload_hash !== input.payload_hash) throw Object.assign(new Error('Submission identity was already used with different content'), { status: 409 });
  return row;
}

/** Receipts follow the first execution; label retries follow the latest execution. */
export async function associateSubmissionTask(database: Knex, id: string, taskId: string): Promise<void> {
  await database('task_submissions').where({ id }).update({
    task_id: database.raw('coalesce(task_id, ?)', [taskId]),
    latest_task_id: taskId,
  });
}
