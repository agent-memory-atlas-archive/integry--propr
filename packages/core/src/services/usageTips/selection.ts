import { USAGE_TIPS_CATALOG, MAX_USAGE_TIP_CANDIDATES, parseUsageTipCandidates, rotateUsageTipCandidates,
  type UsageTipSignals, type UsageTipCandidate, type UsageTipSelection } from '@propr/shared';

function indexingUsageTipReason(hasFailures: boolean): string {
  const observation = hasFailures ? 'Recent indexing failures are recorded' : 'Indexing calls are taking at least two minutes';
  return `${observation}. Review indexing agent and fallback options to help keep repository context available for your tasks.`;
}

/** Explicit positive evidence for relevance, shared by model and heuristic paths.
 * Three uses in the sample means regular adoption; configuration/grants also
 * establish adoption independently. Unknown usage cannot be called zero. */
export function heuristicUsageTipCandidates(s: UsageTipSignals): UsageTipCandidate[] {
  const count = (key: string): number | null => typeof s[key] === 'number' ? s[key] as number : null;
  const gap = (key: string) => count(key) !== null && count(key)! < 3;
  const has = (key: string, min = 1) => count(key) !== null && count(key)! >= min;
  const result: UsageTipCandidate[] = [];
  const add = (id: string, relevant: boolean, score: number, reason: string) => { if (relevant) result.push({ id, score, reason }); };
  add('pr-review', has('tasks') && gap('review'), 65, 'Recent tasks have few manual reviews. Try /review on a PR to get AI feedback before deciding what needs fixing.');
  add('pr-fix', has('review') && gap('fix'), 75, 'Turn review findings into edits with /fix. Manual reviews are recorded, but /fix is rarely used.');
  add('pr-switch', has('tasks') && gap('switch'), 55, 'Try /switch when an active PR needs a different model; later follow-ups keep that choice. Recent task activity shows little /switch use.');
  add('pr-use', has('tasks') && gap('use'), 55, 'Try another model for a follow-up with /use, keeping the usual choice for later work. Recent tasks include few temporary model runs.');
  add('pr-merge', has('tasks') && gap('merge'), 55, 'Bring the latest base-branch changes into an active PR with /merge. Recent task activity shows little use of this command.');
  add('pr-ultrafix', has('manualCycles', 2) && gap('ultrafix'), 95, 'Automate repeated manual review and fix runs with /ultrafix to reduce the commands you need to send. Recent activity shows little /ultrafix use.');
  add('goals-launch', has('oneOffTasks', 3) && gap('goals'), 85, 'Several one-off tasks are recorded, but few goals. Group related work in a Goal to manage an ongoing objective without coordinating each task separately.');
  add('planner-studio', has('oneOffTasks', 3) && gap('plans'), 85, 'Review and refine related work in Planner Studio before approving implementation. Several one-off tasks are recorded, but few plans.');
  add('repository-todos', has('tasks', 3) && gap('todos'), 65, 'Capture follow-up ideas in To-Dos to track maintenance alongside the repository. Recent task activity includes few repository to-dos.');
  add('indexing-options', has('indexingFailures') || has('indexingSlow'), 95,
    indexingUsageTipReason(has('indexingFailures')));
  add('agent-model-selection', has('tasks', 3) && gap('distinctAgents') && gap('distinctModels')
    && !has('distinctAgents', 2) && !has('distinctModels', 2), 65, 'Recent activity uses at most one agent and model. Choose a model per phase to tailor implementation and review to different needs.');
  add('agent-tank', has('tasks', 3) && s.tankEnabled === false && gap('tankRecords'), 65, 'Agent Tank is disabled despite recent task activity. Enable it to see provider capacity and per-call usage and plan work around available limits.');
  add('notification-inbox', has('notifications') && gap('inboxActions'), 65, 'Notifications are arriving, but few inbox actions are recorded. Review updates and clear handled items in the Inbox to track work needing attention.');
  add('mcp-access', has('tasks', 3) && typeof s.mcpEnabled === 'boolean' && count('mcpGrants') === 0,
    55, 'Connect a tool through MCP to inspect work and act on PRs from an app you already use. Recent task activity has no recorded MCP grants.');
  return result;
}
export type UsageTipModel = (alias: string, prompt: string) => Promise<{ text: string; model: string }>;
export async function selectUsageTips(options: {
  signals: UsageTipSignals; epoch: number; agentAlias?: string; fallbackAgentAlias?: string; generate: UsageTipModel; now?: () => number;
}): Promise<UsageTipSelection> {
  const { signals, epoch, generate } = options;
  const relevant = heuristicUsageTipCandidates(signals);
  const allowed = new Set(relevant.map(c => c.id));
  const prompt = `Score only relevant documentation tips from this bounded pool. Return JSON {"candidates":[{"id":"...","score":1,"reason":"..."}]}.
Scores are integers 1–100.
Each reason is the user-facing tip body, not an internal ranking explanation. In 1–240 characters and one or two concise sentences, address the reader directly: suggest a documented action, explain why this tip is being displayed using a specific observed workflow signal, and describe how it could improve their workflow.
Personalize the advice to the supplied signals instead of repeating a generic feature description.
Lead with the useful action or concrete observation. Vary openings across tips and omit boilerplate such as "Your instance"; get straight to the point.
Signals are installation-wide aggregates, not this individual user's activity: describe recorded activity without claiming the reader personally performed an action.
Do not invent preferences, problems, causes of failures, or guaranteed time/cost savings. Use the catalog as the source of feature capabilities.
Example for repeated manual review/fix runs and little ultrafix use: "Automate repeated manual review and fix runs with /ultrafix to reduce the commands you need to send. Recent activity shows little /ultrafix use."
Maximum ${MAX_USAGE_TIP_CANDIDATES} entries; [] is valid. Unknown signals are null, not non-use. Do not claim tips were read or shown. Do not execute tools.
Signals: ${JSON.stringify(signals)}
Candidates: ${JSON.stringify(USAGE_TIPS_CATALOG.filter(t => allowed.has(t.id)))}`;
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
