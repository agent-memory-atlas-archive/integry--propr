import type { Knex } from 'knex';
import type { UsageTipSignals } from '@propr/shared';

const LIMIT = 1000;
const WINDOW_MS = 30 * 86_400_000;
// Legacy SQLite timestamps are epoch milliseconds (bound Dates), ISO strings,
// or SQLite UTC strings. Do not compare them lexically to an ISO cutoff.
export function usageSignalTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return NaN;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Date.parse(raw.includes('T') || raw.endsWith('Z') ? raw : raw.replace(' ', 'T') + 'Z');
}
const json = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) ?? {}; } catch { return {}; }
};
/** Bounded, guarded reads. No task text, user identity or credentials enter the snapshot. */
export async function collectUsageTipSignals(database: Knex, now = Date.now()): Promise<UsageTipSignals> {
  const signals: UsageTipSignals = Object.fromEntries([
    'tasks', 'oneOffTasks', 'review', 'fix', 'switch', 'use', 'merge', 'ultrafix', 'manualCycles',
    'goals', 'plans', 'todos', 'indexingFailures', 'indexingSlow', 'distinctAgents', 'distinctModels',
    'tankEnabled', 'tankRecords', 'mcpEnabled', 'mcpGrants', 'notifications', 'inboxActions',
  ].map(key => [key, null]));
  const recent = (value: unknown) => {
    const time = usageSignalTimestamp(value);
    return time >= now - WINDOW_MS && time <= now;
  };
  const guarded = async (fn: () => Promise<void>) => { try { await fn(); } catch { /* unavailable remains null */ } };
  await Promise.all([
    guarded(async () => {
      // SQLite JSON1 is already used throughout the task-history queries. Extract
      // only aggregate inputs, never load potentially large prompts/attachments.
      const safeJson = "CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END";
      const rows = await database('tasks').select('task_type', 'created_at',
        database.raw(`json_extract(${safeJson}, '$.commandMode') AS command_mode`),
        database.raw(`json_extract(${safeJson}, '$.ultrafixMeta') IS NOT NULL AS is_ultrafix`),
        database.raw(`json_extract(${safeJson}, '$.goalId') IS NOT NULL OR json_extract(${safeJson}, '$.planDraftId') IS NOT NULL AS is_grouped`),
      ).orderBy('created_at', 'desc').limit(LIMIT);
      if (rows.some(r => !Number.isFinite(usageSignalTimestamp(r.created_at)))) return;
      const tasks = rows.filter(r => recent(r.created_at));
      signals.tasks = tasks.length;
      signals.oneOffTasks = tasks.filter(r => ['issue', 'task-import'].includes(r.task_type) && !r.is_grouped).length;
      // Missing historical command metadata is unknown, never evidence of non-use.
      const commands = tasks.filter(d => typeof d.command_mode === 'string');
      const complete = rows.length < LIMIT && tasks.every(d => d.task_type !== 'pr-comment' || typeof d.command_mode === 'string');
      for (const mode of ['review', 'fix', 'use', 'ultrafix']) {
        const count = commands.filter(d => mode === 'ultrafix' ? d.command_mode === mode || !!d.is_ultrafix : d.command_mode === mode && !d.is_ultrafix).length;
        // Even an incomplete sample can establish regular use, but cannot
        // establish a usage gap. Missing metadata must not produce a zero.
        signals[mode] = complete || count >= 3 ? count : null;
      }
      signals.manualCycles = signals.review !== null && signals.fix !== null
        ? Math.min(signals.review as number, signals.fix as number) : null;
      // /switch and /merge can be handled without a task; absent durable command
      // telemetry cannot establish their non-use, so those signals stay unknown.
    }),
    ...(['goals', 'plans', 'todos'] as const).map(key => guarded(async () => {
      const table = { goals: 'goals', plans: 'task_drafts', todos: 'repo_todos' }[key];
      // Presence is enough to avoid advertising existing workflows as unused.
      const rows = await database(table).select('created_at').limit(LIMIT);
      signals[key] = rows.length;
    })),
    guarded(async () => {
      const rows = await database('llm_logs').select('agent_alias', 'model_name', 'execution_type', 'success', 'duration_ms', 'start_time')
        .whereNot('execution_type', 'usage-tips-selection').orderBy('log_id', 'desc').limit(LIMIT);
      if (rows.some(r => !Number.isFinite(usageSignalTimestamp(r.start_time)))) return;
      const logs = rows.filter(r => recent(r.start_time));
      signals.distinctAgents = logs.some(r => !r.agent_alias) || rows.length === LIMIT ? null : new Set(logs.map(r => r.agent_alias)).size;
      signals.distinctModels = logs.some(r => !r.model_name) || rows.length === LIMIT ? null : new Set(logs.map(r => r.model_name)).size;
      const indexing = logs.filter(r => r.execution_type === 'summarization');
      signals.indexingFailures = indexing.some(r => r.success === null) ? null : indexing.filter(r => r.success === false || r.success === 0).length;
      signals.indexingSlow = indexing.some(r => r.duration_ms === null) ? null : indexing.filter(r => r.duration_ms >= 120_000).length;
    }),
    guarded(async () => {
      const row = await database('system_configs').where({ key: 'agent_tank' }).first('value');
      const value = row ? json(row.value).enabled : false;
      signals.tankEnabled = typeof value === 'boolean' ? value : null;
    }),
    guarded(async () => { signals.tankRecords = (await database('usage_metric_records').select('id').limit(3)).length; }),
    guarded(async () => {
      const row = await database('mcp_admin_settings').where({ key: 'enabled' }).first('value');
      signals.mcpEnabled = process.env.MCP_ENABLED === 'true' ? true : process.env.MCP_ENABLED === 'false' ? false : row ? row.value === 'true' : false;
    }),
    guarded(async () => {
      // Grants are encrypted. Presence establishes adoption; never decrypt them for tips.
      signals.mcpGrants = (await database('mcp_records').where({ kind: 'grant' }).select('id').limit(3)).length;
    }),
    guarded(async () => { signals.notifications = (await database('notification_events').select('event_id').limit(3)).length; }),
    guarded(async () => {
      const rows = await database('notification_user_states').select('read_at', 'dismissed_at').limit(LIMIT);
      const actions = rows.filter(r => r.read_at !== null || r.dismissed_at !== null).length;
      signals.inboxActions = rows.length === LIMIT && actions < 3 ? null : actions;
    }),
  ]);
  return signals;
}
