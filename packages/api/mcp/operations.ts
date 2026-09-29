import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { McpError } from './config.js';
import { classifyError, type McpErrorEnvelope } from './errorEnvelope.js';
import { digest } from './store.js';
import type { McpPrincipal } from './policy.js';
import { lifecycleFromLegacy } from './operationLifecycle.js';

export interface OperationResult { status: number; data: unknown }
export type LifecycleState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type LifecycleOutcome = 'completed' | 'failed' | 'cancelled';
export interface Operation {
  id: string; owner_id: string; grant_id: string; idempotency_key: string; tool: string; repository: string | null;
  state: string; result: string | null; created_at: number; updated_at: number; payload_hash: string;
  lifecycle: LifecycleState; accepted_at: number | null; started_at: number | null; finished_at: number | null;
  failure: string | null; artifacts: string | null; progress: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

function iso(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorEnvelope(value: unknown): McpErrorEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as Partial<McpErrorEnvelope>;
  return typeof envelope.code === 'string' && typeof envelope.message === 'string'
    && typeof envelope.retryable === 'boolean' && typeof envelope.status === 'number'
    ? envelope as McpErrorEnvelope : undefined;
}

export class McpOperations {
  constructor(readonly db: Knex) {}

  async replay(principal: McpPrincipal, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const previous = await this.db<Operation>('mcp_operations').where({ owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: String(args.idempotencyKey) }).first();
    if (!previous) return undefined;
    if (previous.payload_hash !== digest(canonical({ tool, args }))) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
    return this.project(previous);
  }

  async run(principal: McpPrincipal, { tool, args, repository }: { tool: string; args: Record<string, unknown>; repository?: string }, invoke: (operationId: string) => Promise<OperationResult>): Promise<Record<string, unknown>> {
    const key = String(args.idempotencyKey || '');
    if (!/^[\w.-]{8,128}$/.test(key)) throw new McpError('IDEMPOTENCY_KEY_REQUIRED', 'Provide a stable 8–128 character idempotencyKey for this action.');
    const identity = { owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: key };
    const payloadHash = digest(canonical({ tool, args }));
    const id = randomUUID();
    const acceptedAt = Date.now();
    const inserted = await this.db('mcp_operations').insert({ ...identity, id, tool, repository: repository || null,
      payload_hash: payloadHash, state: 'running', lifecycle: 'accepted', accepted_at: acceptedAt, artifacts: JSON.stringify({}),
      created_at: acceptedAt, updated_at: acceptedAt }).onConflict(['owner_id', 'grant_id', 'idempotency_key']).ignore().returning('id');
    if (!inserted.length) {
      const previous = await this.db<Operation>('mcp_operations').where(identity).first();
      if (!previous || previous.payload_hash !== payloadHash) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
      return this.project(previous);
    }
    try {
      const result = await invoke(id);
      const reported = (result.data as { state?: string })?.state;
      const state = reported === 'browser_required' ? reported : result.status === 202 && ['posted', 'queued', 'unknown', 'failed'].includes(reported || '') ? reported! : result.status === 202 ? 'accepted' : 'completed';
      await this.db('mcp_operations').where({ id }).update({ state, result: JSON.stringify(result.data), updated_at: Date.now() });
      const lifecycle = lifecycleFromLegacy(state);
      if (['completed', 'failed', 'cancelled'].includes(lifecycle)) {
        const failure = errorEnvelope((result.data as { error?: unknown } | null)?.error);
        await this.finish(id, lifecycle as LifecycleOutcome, failure);
      } else if (lifecycle === 'unknown') {
        const failure = errorEnvelope((result.data as { error?: unknown } | null)?.error);
        await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'unknown'])
          .update({ lifecycle: 'unknown', failure: failure ? JSON.stringify(failure) : null, updated_at: Date.now() });
      }
    } catch (error) {
      // A transport failure can follow an external side effect. Never replay it
      // automatically or claim it was rolled back. The handle remains durable.
      const envelope = classifyError(error, { sideEffectsPossible: true });
      const state = envelope.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed';
      await this.db('mcp_operations').where({ id }).update({ state, result: JSON.stringify({ error: envelope }), updated_at: Date.now() });
      if (state === 'failed') await this.finish(id, 'failed', envelope);
      else await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'unknown'])
        .update({ lifecycle: 'unknown', failure: JSON.stringify(envelope), updated_at: Date.now() });
    }
    return this.project((await this.db<Operation>('mcp_operations').where({ id }).first())!);
  }

  async get(principal: McpPrincipal, id: string): Promise<Operation> {
    const row = await this.db<Operation>('mcp_operations').where({ id, owner_id: principal.user.id, grant_id: principal.grant.id }).first();
    if (!row) throw new McpError('NOT_FOUND', 'Operation not found.', 404);
    return row;
  }

  async markStarted(id: string, at = Date.now()): Promise<void> {
    await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'running', 'unknown']).update({
      lifecycle: 'running',
      started_at: this.db.raw('COALESCE(started_at, ?)', [at]),
      updated_at: Date.now(),
    });
  }

  async recordArtifacts(id: string, partial: Record<string, unknown>): Promise<void> {
    if (!Object.keys(partial).length) return;
    await this.db('mcp_operations').where({ id }).update({
      artifacts: this.db.raw("json_patch(COALESCE(artifacts, '{}'), ?)", [JSON.stringify(partial)]),
      updated_at: Date.now(),
    });
  }

  async recordProgress(id: string, progress: unknown): Promise<void> {
    await this.db('mcp_operations').where({ id }).update({ progress: JSON.stringify(progress), updated_at: Date.now() });
  }

  async finish(id: string, outcome: LifecycleOutcome, failure?: McpErrorEnvelope): Promise<void> {
    const at = Date.now();
    await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'running', 'unknown']).update({
      lifecycle: outcome,
      finished_at: at,
      failure: failure ? JSON.stringify(failure) : null,
      updated_at: at,
    });
  }

  project(row: Operation): Record<string, unknown> {
    const stale = row.state === 'running' && Date.now() - Number(row.updated_at) > 120_000;
    const state = stale ? 'unknown' : row.state;
    return { operationId: row.id, tool: row.tool, state, result: json(row.result), lifecycle: {
      state: row.lifecycle ?? lifecycleFromLegacy(row.state),
      acceptedAt: iso(row.accepted_at ?? row.created_at),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      failure: json(row.failure),
      artifacts: json(row.artifacts) ?? {},
      progress: json(row.progress),
    },
      ...(['accepted', 'posted', 'queued', 'running'].includes(state) ? { retryAfterSeconds: 3 } : {}),
      ...(stale ? { message: 'Execution may have been interrupted. Inspect the target; this action will not be replayed automatically.' } : {}) };
  }
}
