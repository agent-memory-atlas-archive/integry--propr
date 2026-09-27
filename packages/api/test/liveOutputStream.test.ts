import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { createClient, type RedisClientType } from 'redis';
import type { Knex } from 'knex';
import type { Server as SocketIOServer } from 'socket.io';
import { db, liveOutputKey, liveOutputMetaKey, writeLiveOutput } from '@propr/core';
import { LiveOutputProjector, projectLiveOutput, readLiveOutput } from '../services/liveOutputStream.js';
import { selectLiveEvents } from '../services/liveEventSelection.js';
import { TaskWatcherManager } from '../services/taskWatcher.js';

const host = process.env.REDIS_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
let writer: Redis | null = null;
let reader: RedisClientType | null = null;

before(async () => {
  const ioredis = new Redis({ host, port, lazyConnect: true, connectTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null });
  ioredis.on('error', () => {});
  try {
    await ioredis.connect();
    writer = ioredis;
    reader = createClient({ socket: { host, port, reconnectStrategy: false } }) as RedisClientType;
    reader.on('error', () => {});
    await reader.connect();
  } catch {
    ioredis.disconnect();
    writer = null;
  }
});

after(async () => {
  await reader?.quit().catch(() => undefined);
  writer?.disconnect();
  await db.destroy();
});

let sequence = 0;
async function freshTask(t: { skip: (message: string) => void }): Promise<string | null> {
  if (!writer || !reader) {
    t.skip('Redis is not available for live output integration testing');
    return null;
  }
  const taskId = `live-output-test-${process.pid}-${Date.now()}-${sequence += 1}`;
  await writer.del(liveOutputKey(taskId), liveOutputMetaKey(taskId));
  return taskId;
}

const claudeRecords = [
  'Container starting',
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-26T22:47:27Z', message: { content: [{ type: 'text', text: 'Reading the code first. ✓' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-26T22:47:28Z', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] } }),
  JSON.stringify({ type: 'user', timestamp: '2026-09-26T22:47:40Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-26T22:48:00Z', message: { content: [{ type: 'text', text: 'Tests pass.' }] } }),
];

const withoutIds = (events: Array<Record<string, unknown>>) => events.map(event => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'id')));

describe('append-only live output', () => {
  test('incremental reads project the same events, with the same IDs, as one full read', async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const output = `${claudeRecords.join('\n')}\n`;
    // Chunks split mid-record and mid-UTF-8 character must not change anything.
    const cuts = [7, 40, 95, 180, 181, output.length];
    const reads: Array<Record<string, unknown>> = [];
    let projector: LiveOutputProjector | null = null;
    let previous = 0;
    for (const cut of cuts) {
      await writeLiveOutput(writer!, taskId, output.slice(previous, cut), { mode: previous === 0 ? 'reset' : 'append' });
      previous = cut;
      const read = await readLiveOutput(reader!, taskId, projector?.offset ?? 0);
      assert.ok(read);
      projector ??= new LiveOutputProjector({ taskId, epoch: read.epoch, offset: read.from, start: read.start });
      reads.push(...projector.feed(read.text, read.from));
    }
    const full = await projectLiveOutput(reader!, taskId);
    assert.ok(full);
    assert.deepEqual(reads, full.events);
    assert.deepEqual(withoutIds(full.events).map(event => event.type), ['thought', 'tool_use', 'tool_result', 'thought']);
    assert.equal(new Set(full.events.map(event => event.id)).size, full.events.length);
  });

  test('a buffered assistant message keeps its ID from its first delta to completion', async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const delta = (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content });
    await writeLiveOutput(writer!, taskId, `${delta('Checking ')}\n${delta('the parser')}\n`, { mode: 'reset' });
    const early = await projectLiveOutput(reader!, taskId);
    assert.equal(early?.events.at(-1)?.content, 'Checking the parser');
    await writeLiveOutput(writer!, taskId, `${JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.' })}\n`);
    const done = await projectLiveOutput(reader!, taskId);
    const completed = done?.events.find(event => event.content === 'Checking the parser');
    assert.equal(completed?.id, early?.events.at(-1)?.id, 'the provisional and the completed message are one event');
  });

  test('trimmed output keeps its first record and every retained event keeps its ID', async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const text = (index: number) => JSON.stringify({ type: 'assistant', timestamp: `2026-09-26T22:${String(index % 60).padStart(2, '0')}:00Z`, message: { content: [{ type: 'text', text: `Step ${index}` }] } });
    const lines = [claudeRecords[1], ...Array.from({ length: 40 }, (_, index) => text(index))];
    const before = await (async () => {
      await writeLiveOutput(writer!, taskId, `${lines.join('\n')}\n`, { mode: 'reset' });
      return projectLiveOutput(reader!, taskId);
    })();
    // Re-publish the same records under a ceiling that forces the oldest out.
    await writer!.del(liveOutputKey(taskId), liveOutputMetaKey(taskId));
    for (const [index, line] of lines.entries()) await writeLiveOutput(writer!, taskId, `${line}\n`, { mode: index === 0 ? 'reset' : 'append', maximumBytes: 2000 });
    const meta = await writer!.hgetall(liveOutputMetaKey(taskId));
    assert.ok(Number(meta.base) > 0, 'old records were trimmed');
    assert.equal(meta.head, claudeRecords[1], 'the first record survives in the metadata');
    const trimmed = await projectLiveOutput(reader!, taskId);
    assert.ok(trimmed?.truncated);
    const beforeIds = new Map(before!.events.map(event => [event.content, event.id]));
    for (const event of trimmed!.events) assert.equal(event.id, beforeIds.get(event.content));
    assert.equal(trimmed!.events.at(-1)?.content, 'Step 39');
  });

  test('a new execution gets new IDs; a snapshot of the same execution keeps them', async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const record = `${claudeRecords[2]}\n`;
    await writeLiveOutput(writer!, taskId, record, { mode: 'reset' });
    const first = await projectLiveOutput(reader!, taskId);
    await writeLiveOutput(writer!, taskId, record, { mode: 'replace' });
    const snapshot = await projectLiveOutput(reader!, taskId);
    await writeLiveOutput(writer!, taskId, record, { mode: 'reset' });
    const rerun = await projectLiveOutput(reader!, taskId);
    assert.equal(snapshot?.projector.epoch, first?.projector.epoch);
    assert.equal(snapshot?.events[0].id, first?.events[0].id);
    assert.notEqual(rerun?.projector.epoch, first?.projector.epoch);
    assert.notEqual(rerun?.events[0].id, first?.events[0].id);
  });

  test('the live view keeps every readable event and only the most recent raw events', () => {
    const events = Array.from({ length: 1200 }, (_, index) => ({ id: String(index), type: index % 4 === 0 ? 'thought' : 'tool_use' }));
    const selected = selectLiveEvents(events, 500);
    assert.equal(selected.events.filter(event => event.type === 'thought').length, 300);
    assert.equal(selected.events.filter(event => event.type !== 'thought').length, 500);
    assert.equal(selected.omittedEventCount, 400);
    assert.equal(selected.events.at(-1)?.id, '1199');
  });

  test('the watcher sends only new events after its full-state update, and resynchronizes on a new execution', async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const emitted: Array<{ events: Array<{ id: string; content?: string }>; omittedEventCount?: number }> = [];
    const io = {
      to: () => ({ emit: (_event: string, payload: typeof emitted[number]) => { emitted.push(payload); } }),
      sockets: { adapter: { rooms: new Map() } },
    } as unknown as SocketIOServer;
    await writer!.set(`worker:state:${taskId}`, JSON.stringify({ history: [{ state: 'claude_execution', timestamp: new Date().toISOString(), metadata: {} }] }), 'EX', 60);
    await writeLiveOutput(writer!, taskId, `${claudeRecords.slice(0, 3).join('\n')}\n`, { mode: 'reset' });
    const manager = new TaskWatcherManager(io);
    manager.setDeps({ redisClient: reader!, db: {} as Knex });
    const send = (manager as unknown as { sendRedisLiveUpdate: (id: string, initial?: boolean) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
    try {
      await manager.startTaskWatcher(taskId);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].omittedEventCount, 0);
      assert.deepEqual(emitted[0].events.map(event => event.content), ['Reading the code first. ✓']);

      await send(taskId);
      assert.equal(emitted.length, 1, 'nothing new, nothing sent');

      await writeLiveOutput(writer!, taskId, `${claudeRecords.slice(3).join('\n')}\n`);
      await send(taskId);
      assert.equal(emitted.length, 2);
      assert.equal(emitted[1].omittedEventCount, undefined, 'an increment, not full state');
      assert.equal(emitted[1].events.length, 3);

      await writeLiveOutput(writer!, taskId, `${claudeRecords[5]}\n`, { mode: 'reset' });
      await send(taskId);
      assert.equal(emitted[2].omittedEventCount, 0, 'a new execution is sent as full state');
      assert.deepEqual(emitted[2].events.map(event => event.content), ['Tests pass.']);
    } finally {
      await manager.closeAll();
      await writer!.del(`worker:state:${taskId}`);
    }
  });
});

for (const indentation of [undefined, 2]) {
  test(`whole Vibe arrays without a trailing newline are projected (${indentation ?? 'compact'})`, () => {
    const text = JSON.stringify([{ role: 'assistant', content: 'Inspecting ✓', usage: { input_tokens: 10, output_tokens: 2 } }], null, indentation);
    const projector = new LiveOutputProjector({ taskId: 'vibe', epoch: '1', offset: 50, start: 50 });
    const events = projector.feed(text, 50);
    assert.deepEqual(events.map(event => event.content), ['Inspecting ✓']);
    assert.equal(projector.offset, 50 + Buffer.byteLength(text));
    assert.equal(projector.snapshot().tokenUsage?.input_tokens, 10);
    assert.deepEqual(projector.feed('', projector.offset), []);
    assert.deepEqual(projector.feed('\n', projector.offset), [], 'a delayed newline does not replay the snapshot');
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const format of ['records', 'compact-array', 'formatted-array']) {
  test(`watcher rebuilds ${format} replacements at its exact offset and serializes polls`, async () => {
    const taskId = `replacement-${format}`;
    const emitted: Array<{ events: Array<{ id: string; content?: string }>; omittedEventCount?: number }> = [];
    const io = {
      to: () => ({ emit: (_event: string, payload: typeof emitted[number]) => { emitted.push(payload); } }),
      sockets: { adapter: { rooms: new Map() } },
    } as unknown as SocketIOServer;
    const snapshot = (messages: string[]) => format === 'records'
      ? messages.map(content => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: content }] } })).join('\n') + '\n'
      : JSON.stringify(messages.map(content => ({ role: 'assistant', content })), null, format === 'formatted-array' ? 2 : undefined);
    let data = snapshot(['First']);
    let start = 0;
    let epoch = '1';
    let gate: ReturnType<typeof deferred<void>> | null = null;
    let entered = deferred<void>();
    const redis = {
      get: async (key: string) => key.startsWith('worker:state:') ? JSON.stringify({ history: [{ state: 'claude_execution', timestamp: '2026-09-27T00:00:00Z' }] }) : null,
      eval: async (_script: string, options: { arguments: string[] }) => {
        const from = Math.max(start, Number(options.arguments[0]));
        const result = [String(start), epoch, String(start), '', String(from), Buffer.from(data).subarray(from - start).toString(), String(Buffer.byteLength(data))];
        if (gate) { entered.resolve(); await gate.promise; }
        return result;
      },
    } as unknown as RedisClientType;
    const manager = new TaskWatcherManager(io);
    manager.setDeps({ redisClient: redis, db: {} as Knex });
    const send = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
    try {
      await manager.startTaskWatcher(taskId);
      const firstId = emitted[0].events[0].id;
      start += Buffer.byteLength(data);
      data = snapshot(['First', 'Second']);
      gate = deferred<void>();
      const firstPoll = send(taskId);
      await entered.promise;
      const overlappingPoll = send(taskId);
      gate.resolve();
      gate = null;
      await Promise.all([firstPoll, overlappingPoll]);
      assert.equal(emitted.length, 2, 'overlapping polls do not replay bytes');
      assert.equal(emitted[1].omittedEventCount, 0, 'replacement broadcasts full state');
      assert.deepEqual(emitted[1].events.map(event => event.content), ['First', 'Second']);
      assert.equal(emitted[1].events[0].id, firstId);
      start += Buffer.byteLength(data);
      data = snapshot(['New execution']);
      epoch = '2';
      await send(taskId);
      assert.notEqual(emitted[2].events[0].id, firstId);
      assert.deepEqual(emitted[2].events.map(event => event.content), ['New execution']);
      // A pending read loses authority when its watcher is removed.
      start += Buffer.byteLength(data);
      data = snapshot(['After removal']);
      entered = deferred<void>();
      gate = deferred<void>();
      const latePoll = send(taskId);
      await entered.promise;
      await manager.closeAll();
      gate.resolve();
      gate = null;
      await latePoll;
      assert.equal(emitted.length, 3, 'a removed watcher cannot publish a late read');
    } finally { await manager.closeAll(); }
  });
}
