import {
  aggregateDeltaMessages,
  filterAntigravityAnalysisEvents,
  getAntigravityAnalysisText,
  parseAntigravityJsonl,
  parseVibeConversationLog,
  splitAntigravityInvocations,
  type AntigravityOutputEvent,
} from '@propr/core';
import {
  appendClaudeAssistantMessageEvents,
  appendClaudeUserMessageEvents,
  deriveCurrentTask,
  type ClaudeMessageContent,
} from './liveDetailsCodexParser.js';
import type { TokenUsage, ConversationResult, TodoItem, PendingSubagent } from './liveDetailsTypes.js';

function resolveAntigravityLiveDetailsTokenUsage(
  parsedUsage: Partial<TokenUsage>,
  events: AntigravityOutputEvent[],
  hasProtocolError: boolean,
): TokenUsage {
  const usage: TokenUsage = {
    input_tokens: parsedUsage.input_tokens ?? 0,
    output_tokens: parsedUsage.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: parsedUsage.cache_read_input_tokens ?? 0,
  };
  if (!hasProtocolError) return usage;

  // Stored output is an observability source, not execution-success evidence.
  // Preserve valid-shaped usage from partial streams even when strict runtime
  // correlation rejected those envelopes (for example, a result without init).
  for (const event of events) {
    if (!('event' in event) || event.event === 'init') continue;
    const observed = event.event === 'step_update' ? event.step_update.usage : event.result.usage;
    usage.input_tokens = Math.max(usage.input_tokens, observed?.input_tokens ?? 0);
    usage.output_tokens = Math.max(usage.output_tokens, observed?.output_tokens ?? 0);
    usage.cache_read_input_tokens = Math.max(usage.cache_read_input_tokens, observed?.cache_read_tokens ?? 0);
  }
  return usage;
}

/**
 * A goal conversation records one stream per invocation. `result.usage` is
 * cumulative over the conversation, so later invocations report their own cost
 * through step usage instead.
 */
function sumInvocationTokenUsage(usages: TokenUsage[], stepUsages: Array<Partial<TokenUsage> | null>): TokenUsage {
  if (usages.length === 1) return usages[0];
  return usages.reduce<TokenUsage>((total, usage, index) => {
    const own = stepUsages[index] ?? usage;
    return {
      input_tokens: total.input_tokens + (own.input_tokens ?? 0),
      output_tokens: total.output_tokens + (own.output_tokens ?? 0),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: total.cache_read_input_tokens + (own.cache_read_input_tokens ?? 0),
    };
  }, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
}

function stepTokenUsage(events: AntigravityOutputEvent[]): Partial<TokenUsage> | null {
  const steps = new Map<number, { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number }>();
  for (const event of events) {
    if ('event' in event && event.event === 'step_update' && event.step_update.usage) steps.set(event.step_update.step_index, event.step_update.usage);
  }
  if (steps.size === 0) return null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  for (const step of steps.values()) {
    usage.input_tokens += step.input_tokens ?? 0;
    usage.output_tokens += step.output_tokens ?? 0;
    usage.cache_read_input_tokens += step.cache_read_tokens ?? 0;
  }
  return usage;
}

/**
 * A running Antigravity invocation publishes its init envelope before any
 * narration; showing that protocol JSON raw would leak envelopes. Terminal and
 * malformed output keeps its raw fallback so failures stay diagnosable.
 */
export function isAntigravityStreamAwaitingNarration(output: string): boolean {
  const latest = parseAntigravityJsonl(splitAntigravityInvocations(output).pop() ?? '');
  return latest.hasStreamEnvelopes && !latest.terminalStatus && !latest.protocolError;
}

export function parseAntigravityOutputToConversationResult(output: string): ConversationResult | null {
  const invocations = splitAntigravityInvocations(output).map(invocation => parseAntigravityJsonl(invocation));
  const events = invocations.flatMap(parsed => filterAntigravityAnalysisEvents(aggregateDeltaMessages(parsed.conversationLog))).map(event => ({
    type: 'thought',
    content: getAntigravityAnalysisText(event) ?? '',
    timestamp: 'created_at' in event ? event.created_at : 'timestamp' in event ? event.timestamp : undefined
  })).filter(event => event.content);
  const tokenUsage = sumInvocationTokenUsage(
    invocations.map(parsed => resolveAntigravityLiveDetailsTokenUsage(parsed.tokenUsage, parsed.conversationLog, parsed.protocolError !== undefined)),
    invocations.map(parsed => stepTokenUsage(parsed.conversationLog)),
  );
  const hasTokens = tokenUsage.input_tokens > 0
    || tokenUsage.output_tokens > 0
    || tokenUsage.cache_read_input_tokens > 0;
  return events.length || hasTokens ? {
    events,
    todos: [],
    currentTask: null,
    tokenUsage: hasTokens ? tokenUsage : null
  } : null;
}

export function parseVibeOutputToConversationResult(output: string): ConversationResult | null {
  const conversationLog = parseVibeConversationLog(output);
  if (!conversationLog.length) return null;

  const events: Array<Record<string, unknown>> = [];
  let todos: TodoItem[] = [];
  const pendingSubagents: Map<string, PendingSubagent> = new Map();
  const tokenUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  for (const message of conversationLog) {
    const timestamp = message.timestamp;
    const usage = message.message?.usage;
    if (message.type === 'assistant') {
      appendClaudeAssistantMessageEvents(message.message.content as ClaudeMessageContent[], {
        timestamp,
        events,
        pendingSubagents,
        setTodos: nextTodos => {
          todos = nextTodos;
        }
      });
    } else if (message.type === 'user') {
      appendClaudeUserMessageEvents(message.message.content as ClaudeMessageContent[], {
        timestamp,
        events,
        pendingSubagents,
        setTodos: () => {}
      });
    }
    if (usage) {
      tokenUsage.input_tokens += usage.input_tokens ?? 0;
      tokenUsage.output_tokens += usage.output_tokens ?? 0;
    }
  }

  const currentTask = deriveCurrentTask(todos);
  const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0;
  return { events, todos, currentTask, tokenUsage: hasTokens ? tokenUsage : null };
}
