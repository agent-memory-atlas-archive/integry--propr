import type { Knex } from 'knex';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' ? value as Row : {};
};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** Execution evidence outranks submission-time routing, which may predate PR label resolution. */
export function taskModelIdentity(task: Row, history: Row[], executions: Row[] = []) {
  const job = object(task.initial_job_data);
  const metadata = history.map(row => object(row.metadata)).reverse();
  // Synthetic tasks retain their virtual identity; physical attempts are shown separately.
  const synthetic = object(metadata.find(item => text(object(item.syntheticRouting).virtualModel))?.syntheticRouting);
  if (synthetic.virtualModel) return { modelName: text(synthetic.virtualModel), agentAlias: text(synthetic.virtualAgentAlias) || text(job.agentAlias) };
  const routed = object(metadata.find(item => item.executionRouting)?.executionRouting);
  const recordedModel = metadata.find(item => text(item.model))?.model;
  const execution = [...executions].reverse().find(row => text(row.model_name));
  const modelName = text(execution?.model_name) || text(recordedModel) || text(routed.model);
  if (modelName) {
    // Never pair execution evidence with a different submission-time provider.
    return { modelName, agentAlias: (modelName === routed.model ? text(routed.agentAlias) : null) || (modelName === job.modelName ? text(job.agentAlias) : null) };
  }
  const isFollowup = task.task_type === 'pr-comment' || !!job.pullRequestNumber || String(task.task_id).startsWith('pr-comment');
  return {
    modelName: isFollowup ? text(job.modelName) || text(job.llm) : text(task.model_name),
    agentAlias: text(job.agentAlias),
  };
}

/** Batched and bounded to the requested page, including historical runs with stale task rows. */
export async function loadTaskModelIdentities(db: Knex, tasks: Row[]) {
  const ids = tasks.map(task => String(task.task_id));
  const [history, executions] = await Promise.all([
    db('task_history').whereIn('task_id', ids).select('task_id', 'metadata').orderBy('timestamp').orderBy('history_id'),
    db('llm_executions').whereIn('task_id', ids).select('task_id', 'model_name').orderBy('start_time').orderBy('execution_id'),
  ]);
  const group = (rows: Row[]) => {
    const result = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row.task_id);
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(row);
    }
    return result;
  };
  const histories = group(history), runs = group(executions);
  return new Map(tasks.map(task => [String(task.task_id), taskModelIdentity(task, histories.get(String(task.task_id)) || [], runs.get(String(task.task_id)) || [])]));
}
