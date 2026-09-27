import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import { db, liveOutputKey } from '@propr/core';
import { LiveOutputProjector, projectLiveOutput, projectLiveOutputRead, type LiveOutputRead } from '../services/liveOutputStream.js';
import { TaskWatcherManager } from '../services/taskWatcher.js';
import { findLatestExecutionStartForTask } from '../services/taskWatcherLookup.js';
import { mergeFullLiveDetails } from '../../../propr-ui/src/components/TaskDetails/liveDetailsMerge.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

after(async () => { await db.destroy(); });

type Event = Record<string, unknown> & { id: string };
const withoutId = (event: Event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'id'));

/** The same log read whole, and read after every record between its head and `retained` was trimmed. */
function fullAndTrimmed(records: string[], retained: number) {
  const text = `${records.join('\n')}\n`;
  const base = Buffer.byteLength(`${records.slice(0, retained).join('\n')}\n`);
  const read = (from: number): LiveOutputRead => ({
    epoch: 'generation:1', base: from, end: Buffer.byteLength(text), start: 0, head: records[0], from,
    text: Buffer.from(text).subarray(from).toString(),
  });
  const project = (from: number) => projectLiveOutputRead(read(from), 'task', null, { selectEvents: false }).events as Event[];
  return { text, full: project(0), trimmed: project(base) };
}

function assertRetainedIdsAgree(full: Event[], trimmed: Event[]) {
  const byId = new Map(full.map(event => [event.id, event]));
  for (const event of trimmed) {
    const before = byId.get(event.id);
    if (before) assert.deepEqual(withoutId(event), withoutId(before), `${event.id} names the same event before and after trimming`);
  }
}

const assistant = (content: unknown[], second: number) =>
  JSON.stringify({ type: 'assistant', timestamp: `2026-09-27T00:00:0${second}Z`, message: { content } });
const toolResults = JSON.stringify({ type: 'user', timestamp: '2026-09-27T00:00:05Z', message: { content: [
  { type: 'tool_result', tool_use_id: 'task-1', content: [{ type: 'text', text: 'Survey found two callers' }] },
  { type: 'tool_result', tool_use_id: 'bash-1', content: 'tests pass' },
] } });

test('Claude tool results keep their IDs whether or not the Task invocation before them was trimmed', () => {
  const records = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    assistant([{ type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'explore', description: 'Survey' } }], 1),
    assistant([{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } }], 2),
    toolResults,
    assistant([{ type: 'text', text: 'Done.' }], 6),
  ];
  const { text, full, trimmed } = fullAndTrimmed(records, 3);
  assert.deepEqual(full.map(event => event.type), ['tool_use', 'tool_use', 'tool_result', 'subagent_completed', 'tool_result', 'thought']);
  assert.deepEqual(trimmed.map(event => event.type), ['tool_result', 'tool_result', 'thought'], 'no subagent completion without its invocation');
  assertRetainedIdsAgree(full, trimmed);
  const secondResult = (events: Event[]) => events.find(event => event.toolUseId === 'bash-1')!;
  assert.equal(secondResult(trimmed).id, secondResult(full).id);
  assert.equal(new Set(full.map(event => event.id)).size, full.length);

  // Incremental reads split inside the multi-result envelope agree with the full read.
  const projector = new LiveOutputProjector({ taskId: 'task', epoch: 'generation:1', offset: 0 });
  const cut = text.indexOf('Survey found');
  const incremental = [...projector.feed(text.slice(0, cut), 0), ...projector.feed(text.slice(projector.offset), projector.offset)];
  assert.deepEqual(incremental, full);
});

test('OpenCode and Vibe events after a duplicate keep their IDs once the earlier record is trimmed', () => {
  const tool = (id: string, status: string) => ({ type: 'tool', callID: id, tool: 'bash', state: { status, input: { command: id }, output: `${id} output` } });
  const opencode = [
    JSON.stringify({ type: 'step_start', sessionID: 'session', timestamp: '2026-09-27T00:00:00Z' }),
    JSON.stringify({ type: 'message', sessionID: 'session', timestamp: '2026-09-27T00:00:01Z', parts: [tool('a', 'running')] }),
    // Cumulative record: `a` was already emitted by the record before it.
    JSON.stringify({ type: 'message', sessionID: 'session', timestamp: '2026-09-27T00:00:01Z', parts: [tool('a', 'completed'), tool('b', 'completed')] }),
  ];
  const vibe = [
    JSON.stringify({ role: 'system', timestamp: '2026-09-27T00:00:00Z', content: 'You are Vibe.' }),
    JSON.stringify({ role: 'assistant', timestamp: '2026-09-27T00:00:01Z', content: 'Inspect the parser' }),
    JSON.stringify({ role: 'assistant', timestamp: '2026-09-27T00:00:02Z', reasoning_content: 'Inspect the parser', content: 'Update the parser' }),
  ];
  const cases = [
    { records: opencode, duplicate: (event: Event) => event.toolUseId === 'a', retained: (event: Event) => event.toolUseId === 'b' },
    { records: vibe, duplicate: (event: Event) => event.internalReasoning === true, retained: (event: Event) => event.content === 'Update the parser' },
  ];
  for (const { records, duplicate, retained } of cases) {
    const { full, trimmed } = fullAndTrimmed(records, 2);
    assert.ok(trimmed.some(duplicate), 'once trimmed, the retained record emits what it skipped as a duplicate');
    assertRetainedIdsAgree(full, trimmed);
    assert.equal(trimmed.find(retained)?.id, full.find(retained)?.id);
  }
});

test('legacy executions of one task get distinct IDs in watcher and HTTP reads, and the UI replaces the old run', async () => {
  const taskId = 'legacy-executions';
  const history = [{ state: 'claude_execution', timestamp: '2026-09-27T00:00:00.000Z' }];
  const snapshot = (...messages: string[]) =>
    messages.map(text => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`).join('');
  let output = snapshot('Old A', 'Old B');
  const redis = withLiveOutputReads({ get: async (key: string) => {
    if (key.startsWith('worker:state:')) return JSON.stringify({ history });
    return key === liveOutputKey(taskId) ? output : null;
  } });
  const payloads: Array<{ events: Event[]; todos?: unknown[]; omittedEventCount?: number }> = [];
  const io = { to: () => ({ emit: (_event: string, payload: typeof payloads[number]) => payloads.push(payload) }) } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient: redis as unknown as RedisClientType, db: {} as Knex });
  const send = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
  const httpRead = async () => (await projectLiveOutput(redis, taskId, null, {
    resolveLegacyExecution: () => findLatestExecutionStartForTask({ redisClient: redis as unknown as RedisClientType, db: {} as Knex }, taskId),
  }))!.events;
  // The UI treats a payload carrying omittedEventCount as full state (applyTaskLiveUpdate).
  type Details = Parameters<typeof mergeFullLiveDetails>[0];
  let details = { events: [], todos: [], currentTask: null, tokenUsage: null } as unknown as Details;
  const apply = (payload: typeof payloads[number]) => {
    assert.notEqual(payload.omittedEventCount, undefined, 'legacy snapshots are broadcast as full state');
    details = mergeFullLiveDetails(details, { ...payload, todos: [], currentTask: null, tokenUsage: null } as unknown as Details);
    return details.events.map(event => event.content);
  };
  try {
    await manager.startTaskWatcher(taskId);
    assert.deepEqual(apply(payloads[0]), ['Old A', 'Old B']);
    assert.deepEqual(payloads[0].events.map(event => event.id), (await httpRead()).map(event => event.id));

    history.push({ state: 'claude_execution', timestamp: '2026-09-27T01:00:00.000Z' });
    output = snapshot('New X');
    await send(taskId);
    const rerun = payloads.at(-1)!;
    assert.notEqual(rerun.events[0].id, payloads[0].events[0].id, 'the same offset in another execution is another event');
    assert.deepEqual(rerun.events.map(event => event.id), (await httpRead()).map(event => event.id), 'HTTP and watcher reads agree');
    assert.deepEqual(apply(rerun), ['New X'], 'no output of the previous execution survives');

    output = snapshot('New X', 'New Y');
    await send(taskId);
    assert.equal(payloads.at(-1)!.events[0].id, rerun.events[0].id, 'a snapshot of the same execution keeps its IDs');
    assert.deepEqual(apply(payloads.at(-1)!), ['New X', 'New Y']);
  } finally { await manager.closeAll(); }
});
