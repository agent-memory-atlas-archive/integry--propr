import { USAGE_TIPS_CATALOG, MAX_USAGE_TIP_CANDIDATES, parseUsageTipCandidates, rotateUsageTipCandidates,
  type UsageTipSignals, type UsageTipCandidate, type UsageTipSelection } from '@propr/shared';

/** Explicit positive evidence for relevance, shared by model and heuristic paths.
 * Three uses in the sample means regular adoption; configuration/grants also
 * establish adoption independently. Unknown usage cannot be called zero. */
export function heuristicUsageTipCandidates(s: UsageTipSignals): UsageTipCandidate[] {
  const count = (key: string): number | null => typeof s[key] === 'number' ? s[key] as number : null;
  const gap = (key: string) => count(key) !== null && count(key)! < 3;
  const has = (key: string, min = 1) => count(key) !== null && count(key)! >= min;
  const result: UsageTipCandidate[] = [];
  const add = (id: string, relevant: boolean, score: number, reason: string) => { if (relevant) result.push({ id, score, reason }); };
  add('pr-review', has('tasks') && gap('review'), 65, 'Recent tasks with fewer than three manual reviews.');
  add('pr-fix', has('review') && gap('fix'), 75, 'Manual reviews are present with fewer than three fix runs.');
  add('pr-switch', has('tasks') && gap('switch'), 55, 'Recent tasks with little recorded persistent model switching.');
  add('pr-use', has('tasks') && gap('use'), 55, 'Recent tasks with fewer than three temporary model runs.');
  add('pr-merge', has('tasks') && gap('merge'), 55, 'Recent tasks with little recorded base-branch updating.');
  add('pr-ultrafix', has('manualCycles', 2) && gap('ultrafix'), 95, 'Repeated manual review/fix cycles with little ultrafix use.');
  add('goals-launch', has('oneOffTasks', 3) && gap('goals'), 85, 'Several one-off tasks with fewer than three goals.');
  add('planner-studio', has('oneOffTasks', 3) && gap('plans'), 85, 'Several one-off tasks with fewer than three plans.');
  add('repository-todos', has('tasks', 3) && gap('todos'), 65, 'Recent task activity with fewer than three repository to-dos.');
  add('indexing-options', has('indexingFailures') || has('indexingSlow'), 95, 'Recent indexing calls failed or took at least two minutes.');
  add('agent-model-selection', has('tasks', 3) && gap('distinctAgents') && gap('distinctModels')
    && !has('distinctAgents', 2) && !has('distinctModels', 2), 65, 'Recent tasks use at most one recorded agent and model.');
  add('agent-tank', has('tasks', 3) && s.tankEnabled === false && gap('tankRecords'), 65, 'Task activity with Agent Tank disabled and little recorded capacity data.');
  add('notification-inbox', has('notifications') && gap('inboxActions'), 65, 'Notifications exist with few recorded inbox actions.');
  add('mcp-access', has('tasks', 3) && typeof s.mcpEnabled === 'boolean' && count('mcpGrants') === 0,
    55, 'Task activity with no recorded MCP grants.');
  return result;
}
export type UsageTipModel = (alias: string, prompt: string) => Promise<{ text: string; model: string }>;
export async function selectUsageTips(options: {
  signals: UsageTipSignals; epoch: number; agentAlias?: string; fallbackAgentAlias?: string; generate: UsageTipModel; now?: () => number;
}): Promise<UsageTipSelection> {
  const { signals, epoch, generate } = options;
  const relevant = heuristicUsageTipCandidates(signals);
  const allowed = new Set(relevant.map(c => c.id));
  const prompt = `Score only relevant documentation tips from this bounded pool. Return JSON {"candidates":[{"id":"...","score":1,"reason":"..."}]}. Scores are integers 1–100. Reasons must be 1–240 characters grounded in signals. Maximum ${MAX_USAGE_TIP_CANDIDATES} entries; [] is valid. Unknown signals are null, not non-use. Do not claim tips were read or shown. Do not execute tools.\nSignals: ${JSON.stringify(signals)}\nCandidates: ${JSON.stringify(USAGE_TIPS_CATALOG.filter(t => allowed.has(t.id)))}`;
  let candidates = relevant;
  let model: string | null = null;
  let source: UsageTipSelection['source'] = 'heuristic';
  for (const alias of [...new Set([options.agentAlias?.trim() || '', options.fallbackAgentAlias?.trim()].filter((a): a is string => a !== undefined))]) {
    try {
      const response = await generate(alias, prompt);
      if (typeof response.model !== 'string' || !response.model.trim() || response.model.length > 512) throw new Error('Invalid model identity');
      const output = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\s*```$/, ''));
      candidates = parseUsageTipCandidates(output.candidates).filter(c => allowed.has(c.id));
      model = response.model;
      source = 'model';
      break;
    } catch { /* Failure or invalid response tries the configured fallback. */ }
  }
  return { candidates: rotateUsageTipCandidates(candidates, epoch), model, source, signals,
    rotationEpoch: epoch, generatedAt: (options.now ?? Date.now)() };
}
