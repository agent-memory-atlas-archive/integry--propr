import type { ConversationEvent } from '@propr/shared';
import { liveOutputKey, liveOutputMetaKey } from '@propr/core';
import { createClaudeStreamProjection } from '../routes/liveDetailsCodexParser.js';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';
import { idSegment } from './liveEventIds.js';
import { selectLiveEvents } from './liveEventSelection.js';
import {
  createRedisOutputProjection,
  parseVibeTranscript,
  type NativeGoalProjection,
  type ParsedRedisOutput,
} from './redisOutputParser.js';
import { claudeNativeGoalRecord, projectClaudeNativeGoalRecord, type ClaudeNativeGoalRecord } from './agentStreamProjection.js';

/**
 * Readers of a task's append-only live output (see core's liveOutputLog): they
 * fetch only bytes they have not seen and project them record by record, so a
 * live update costs what the new output costs, not what the whole run costs.
 */

export interface LiveOutputRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const READ_LIVE_OUTPUT_SCRIPT = `
local meta = redis.call('hmget', KEYS[2], 'base', 'epoch', 'start', 'head', 'generation')
local base = tonumber(meta[1] or '0') or 0
local length = redis.call('strlen', KEYS[1])
-- Metadata-free workers replace whole snapshots, including at the retention ceiling.
local from = meta[2] and tonumber(ARGV[1]) or 0
if from < base or from > base + length then from = base end
local epoch = meta[2] or 'legacy'
if meta[5] then epoch = meta[5] .. ':' .. epoch end
local text = ''
if from - base < length then text = redis.call('getrange', KEYS[1], from - base, length - 1) end
return { tostring(base), epoch, tostring(tonumber(meta[3] or '0') or 0), meta[4] or '', tostring(from), text, tostring(length) }
`;

export interface LiveOutputRead {
  /** Generation plus execution counter; changes on reset or recreation after expiry. */
  epoch: string;
  /** Absolute offset of the first byte still retained. */
  base: number;
  /** Absolute offset just past the retained log; offsets beyond it require resync. */
  end: number;
  /** Absolute offset where this execution began, and its first record (kept even once trimmed). */
  start: number;
  head: string;
  /** Offset of `text`: clamped to base after trimming or a request beyond end; zero for legacy snapshots. */
  from: number;
  text: string;
}

export async function readLiveOutput(redis: LiveOutputRedis, taskId: string, from = 0): Promise<LiveOutputRead | null> {
  const [base, epoch, start, head, readFrom, text, length] = await redis.eval(READ_LIVE_OUTPUT_SCRIPT, {
    keys: [liveOutputKey(taskId), liveOutputMetaKey(taskId)],
    arguments: [String(from)],
  }) as string[];
  if (Number(length) === 0 && epoch === 'legacy') return null;
  return { epoch, base: Number(base), end: Number(base) + Number(length), start: Number(start), head, from: Number(readFrom), text };
}

export interface LiveProjectionSnapshot {
  todos: ParsedRedisOutput['todos'];
  currentTask: string | null;
  tokenUsage: ParsedRedisOutput['tokenUsage'];
  nativeGoal: NativeGoalProjection | null;
}

type LiveEvent = ConversationEvent & { id: string };

interface Projection {
  feed(line: string, offset: number): LiveEvent[];
  pending(): LiveEvent | null;
  snapshot(): LiveProjectionSnapshot;
}

const SYNTHETIC_TIMESTAMP_STEP_MS = 1000;
/** Unidentifiable output past this is projected with the generic parser. */
const MAX_PREAMBLE_RECORDS = 200;
const MAX_PREAMBLE_BYTES = 256 * 1024;

/**
 * Projects one execution's records as they arrive. Event IDs derive from the
 * offset (from the execution's start) of the record that produced them, so the
 * same event gets the same ID from a full read, an incremental read, a read
 * after old output was trimmed, or a re-published snapshot.
 */
export class LiveOutputProjector {
  private projection: Projection | null = null;
  private preamble: Array<{ line: string; offset: number }> = [];
  private preambleBytes = 0;
  /** Offset just past the last complete record consumed. */
  offset: number;

  private readonly taskId: string;
  readonly epoch: string;
  private readonly executionStartTimestamp: string | null;
  /** Absolute offset where the execution's output begins; event keys are relative to it. */
  readonly start: number;

  constructor(options: { taskId: string; epoch: string; offset: number; start?: number; executionStartTimestamp?: string | null }) {
    this.taskId = options.taskId;
    this.epoch = options.epoch;
    this.offset = options.offset;
    this.start = options.start ?? 0;
    this.executionStartTimestamp = options.executionStartTimestamp ?? null;
  }

  /**
   * Consumes the complete records of `text`, which begins at absolute `from`.
   * A trailing partial record is left for the next read.
   */
  feed(text: string, from: number): LiveEvent[] {
    // Whole transcripts must bypass JSONL framing, including a final ] without a newline.
    if (!this.projection && this.preamble.length === 0) {
      const transcript = parseVibeTranscript(text, { executionStartTimestamp: this.executionStartTimestamp });
      if (transcript) {
        this.projection = this.wholeOutputProjection(transcript);
        this.offset = from + Buffer.byteLength(text);
        return this.projection.feed(text, from);
      }
    }
    const entries: Array<{ line: string; offset: number }> = [];
    let offset = from;
    const boundary = text.lastIndexOf('\n') + 1;
    if (boundary > 0) {
      for (const line of text.slice(0, boundary - 1).split('\n')) {
        entries.push({ line, offset });
        offset += Buffer.byteLength(line) + 1;
      }
    }
    // A final JSON record is complete even before its newline arrives: no append
    // can turn one JSON object into another. Anything else waits for its newline.
    const remainder = text.slice(boundary);
    if (isCompleteJsonRecord(remainder)) {
      entries.push({ line: remainder, offset });
      offset += Buffer.byteLength(remainder);
    }
    if (entries.length === 0) return [];
    this.offset = offset;
    if (!this.projection) return this.decide(entries);
    return entries.flatMap(({ line, offset: at }) => this.projection!.feed(line, at));
  }

  /**
   * Records before the provider can be identified (container banners, Claude's
   * init record) are held and replayed once it can, so a full read and any
   * sequence of incremental reads choose the same parser.
   */
  private decide(entries: Array<{ line: string; offset: number }>): LiveEvent[] {
    for (const entry of entries) this.preamble.push(entry);
    this.preambleBytes += entries.reduce((total, entry) => total + entry.line.length + 1, 0);
    const format = detectStoredOutputFormat(this.preamble.map(entry => entry.line).join('\n'));
    if (format === 'unknown' && this.preamble.length < MAX_PREAMBLE_RECORDS && this.preambleBytes < MAX_PREAMBLE_BYTES) return [];
    this.projection = format === 'claude' ? this.claudeProjection() : this.genericProjection();
    const held = this.preamble;
    this.preamble = [];
    return held.flatMap(({ line, offset }) => this.projection!.feed(line, offset));
  }

  /** What a reader shows while the provider is still unidentified, without committing to a parser. */
  private provisional(): Projection {
    const projection = this.genericProjection();
    for (const { line, offset } of this.preamble) projection.feed(line, offset);
    return projection;
  }

  /** Events of held records, for a full read that ends before the provider is identified. */
  heldEvents(): LiveEvent[] {
    if (this.projection || this.preamble.length === 0) return [];
    const projection = this.genericProjection();
    return this.preamble.flatMap(({ line, offset }) => projection.feed(line, offset));
  }

  pending(): LiveEvent | null {
    if (!this.projection) return this.preamble.length > 0 ? this.provisional().pending() : null;
    return this.projection.pending();
  }

  snapshot(): LiveProjectionSnapshot {
    if (!this.projection) {
      return this.preamble.length > 0
        ? this.provisional().snapshot()
        : { todos: [], currentTask: null, tokenUsage: null, nativeGoal: null };
    }
    return this.projection.snapshot();
  }

  private id(event: ConversationEvent, key: string): string {
    const prefix = `live:${idSegment(this.taskId)}:redis:${idSegment(this.epoch)}`;
    const externalId = 'id' in event && typeof (event as { id?: unknown }).id === 'string' && (event as { id: string }).id
      ? (event as { id: string }).id
      : null;
    return externalId
      ? `${prefix}:${idSegment(event.type)}:external:${idSegment(externalId)}`
      : `${prefix}:${key}`;
  }

  private withIds(entries: Array<{ event: ConversationEvent; key: string }>): LiveEvent[] {
    const perKey = new Map<string, number>();
    return entries.map(({ event, key }) => {
      const index = perKey.get(key) ?? 0;
      perKey.set(key, index + 1);
      return { ...event, id: this.id(event, `${key}:${index}`) };
    });
  }

  private genericProjection(): Projection {
    const projection = createRedisOutputProjection({ executionStartTimestamp: this.executionStartTimestamp });
    return {
      feed: (line, offset) => this.withIds(projection.feed(line, String(offset - this.start)).events),
      pending: () => {
        const pending = projection.pendingEvent();
        return pending ? { ...pending.event, id: this.id(pending.event, `${pending.key}:0`) } : null;
      },
      snapshot: () => {
        const { todos, currentTask, tokenUsage, nativeGoal } = projection.result();
        return { todos, currentTask, tokenUsage, nativeGoal: nativeGoal ?? null };
      },
    };
  }

  private claudeProjection(): Projection {
    const projection = createClaudeStreamProjection();
    const startMs = this.executionStartTimestamp ? new Date(this.executionStartTimestamp).getTime() : NaN;
    let envelopeIndex = 0;
    let goalRecord: ClaudeNativeGoalRecord | null = null;
    return {
      feed: (line, offset) => {
        // Container entrypoints print plain text before Claude's first envelope.
        if (!line.trimStart().startsWith('{')) return [];
        const stamped = withSyntheticTimestamp(line, startMs, envelopeIndex++);
        goalRecord = claudeNativeGoalRecord(line) ?? goalRecord;
        return this.withIds(projection.feed(stamped).map(event => ({ event: event as unknown as ConversationEvent, key: String(offset - this.start) })));
      },
      pending: () => null,
      snapshot: () => {
        const { todos, currentTask, tokenUsage } = projection.result();
        return {
          todos: todos as LiveProjectionSnapshot['todos'],
          currentTask,
          tokenUsage: tokenUsage as LiveProjectionSnapshot['tokenUsage'],
          nativeGoal: goalRecord ? projectClaudeNativeGoalRecord(goalRecord, tokenUsage) : null,
        };
      },
    };
  }

  /** Vibe publishes whole transcripts, so each read re-projects the snapshot it has. */
  private wholeOutputProjection(parsed: ParsedRedisOutput): Projection {
    let emitted = false;
    return {
      feed: () => {
        if (emitted) return [];
        emitted = true;
        return this.withIds(parsed.events.map((event, index) => ({ event, key: `vibe:${index}` })));
      },
      pending: () => null,
      snapshot: () => ({
        todos: parsed.todos,
        currentTask: parsed.currentTask,
        tokenUsage: parsed.tokenUsage,
        nativeGoal: parsed.nativeGoal ?? null,
      }),
    };
  }
}

function isCompleteJsonRecord(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function withSyntheticTimestamp(line: string, startMs: number, index: number): string {
  if (Number.isNaN(startMs)) return line;
  try {
    const envelope = JSON.parse(line) as { timestamp?: unknown };
    if (envelope.timestamp) return line;
    envelope.timestamp = new Date(startMs + index * SYNTHETIC_TIMESTAMP_STEP_MS).toISOString();
    return JSON.stringify(envelope);
  } catch {
    return line;
  }
}

export interface LiveOutputProjectionResult extends LiveProjectionSnapshot {
  events: LiveEvent[];
  /** Raw events left out by {@link selectLiveEvents}, plus any output already trimmed from Redis. */
  omittedEventCount: number;
  truncated: boolean;
  projector: LiveOutputProjector;
}

/** Everything retained for the current execution, projected from its first record. */
export async function projectLiveOutput(
  redis: LiveOutputRedis,
  taskId: string,
  executionStartTimestamp: string | null = null,
  { selectEvents = true }: { selectEvents?: boolean } = {},
): Promise<LiveOutputProjectionResult | null> {
  const read = await readLiveOutput(redis, taskId, 0);
  if (!read) return null;
  return projectLiveOutputRead(read, taskId, executionStartTimestamp, { selectEvents });
}

/** Project exactly the snapshot read, without another Redis read across an await. */
export function projectLiveOutputRead(
  read: LiveOutputRead,
  taskId: string,
  executionStartTimestamp: string | null = null,
  { selectEvents = true }: { selectEvents?: boolean } = {},
): LiveOutputProjectionResult {
  const projector = new LiveOutputProjector({ taskId, epoch: read.epoch, offset: read.from, start: read.start, executionStartTimestamp });
  const truncated = read.base > read.start;
  // The first record identifies the provider; it survives trimming in `head`.
  const events = truncated && read.head ? projector.feed(`${read.head}\n`, read.start) : [];
  for (const event of projector.feed(read.text, read.from)) events.push(event);
  for (const event of projector.heldEvents()) events.push(event);
  const pending = projector.pending();
  const all = pending ? [...events, pending] : events;
  const selected = selectEvents ? selectLiveEvents(all) : { events: all, omittedEventCount: 0 };
  return { ...projector.snapshot(), events: selected.events, omittedEventCount: selected.omittedEventCount, truncated, projector };
}
