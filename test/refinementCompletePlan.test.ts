import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const llmResponses: string[] = [];
const prompts: string[] = [];
const runLightweightLLMAnalysis = mock.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    const next = llmResponses.shift();
    if (next === undefined) throw new Error('no scripted LLM response left');
    return next;
});

const claudeService = await import('../packages/core/src/claude/claudeService.js');
await mock.module('../packages/core/src/claude/claudeService.js', { namedExports: { ...claudeService, runLightweightLLMAnalysis } });
const estimation = await import('../packages/core/src/utils/llmEstimation.js');
await mock.module('../packages/core/src/utils/llmEstimation.js', {
    namedExports: { ...estimation, estimateLlmDuration: async () => ({ estimatedDurationMs: 1000, isHistoricalEstimate: false, sampleCount: 0 }) },
});
const configManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: { ...configManager, loadSettings: async () => ({ planner_generation_model: 'codex:gpt-6-astra' }) },
});
const configuredModel = await import('../packages/core/src/config/configuredModel.js');
await mock.module('../packages/core/src/config/configuredModel.js', {
    namedExports: { ...configuredModel, resolveConfiguredModel: async (model: string) => model },
});
const routingSession = { select: async () => ({ physicalAgentAlias: 'codex', physicalModel: 'gpt-6-astra' }), fork() { return routingSession; } };
const agentRegistry = await import('../packages/core/src/agents/AgentRegistry.js');
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        ...agentRegistry,
        AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => undefined, beginRoutingSession: () => routingSession }) },
    },
});

const { refinePlan, incompletePlanItems } = await import('../packages/core/src/services/taskPlanning/refinement.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => { await closeConnection(); });

const issue = (title: string) => ({ title, body: `${title} body`, implementation: `${title} implementation` });
const currentPlan = [issue('Operation lifecycle'), issue('Submission progress'), issue('Optional expectedHead')];
const options = { currentPlan, instruction: 'Add task media retrieval', worktreePath: '/tmp', repository: 'integry/propr', githubToken: 't', draftId: 'draft-1' };
// What the broken refinement actually returned: edits, not a plan.
const edits = JSON.stringify({
    action: 'modified',
    summary: 'Added media retrieval',
    changes: [
        { number: 1, action: 'extend', scope: 'media references', requirements: ['...'] },
        { number: 3, action: 'retain', instruction: 'issue 3 remains unchanged' },
    ],
});
const editsAsPlan = JSON.stringify({
    action: 'modified',
    summary: 'Added media retrieval',
    plan: [{ number: 1, action: 'extend', scope: 'media' }, { number: 2, action: 'retain', instruction: 'unchanged' }, issue('Media retrieval')],
});

beforeEach(() => {
    llmResponses.length = 0;
    prompts.length = 0;
    runLightweightLLMAnalysis.mock.resetCalls();
});

describe('plan refinement returns complete plans only', () => {
    test('identifies entries that are not complete issues', () => {
        assert.deepEqual(incompletePlanItems([issue('a'), { number: 2, action: 'retain' }, { title: 'x', body: ' ', implementation: 'y' }, null]), [2, 3, 4]);
        assert.deepEqual(incompletePlanItems(currentPlan), []);
    });

    test('asks once for the full plan when the model returns edits, and uses it', async () => {
        const refined = [...currentPlan, issue('Media retrieval')];
        llmResponses.push(editsAsPlan, JSON.stringify({ action: 'modified', summary: 'Added media retrieval', plan: refined }));
        const result = await refinePlan(options);
        assert.deepEqual(result.plan, refined);
        assert.equal(result.action, 'modified');
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 2);
        assert.match(prompts[1], /EVERY issue of the refined plan in full/);
        assert.match(prompts[1], /Operation lifecycle body/, 'the repair sees the current plan');
    });

    test('fails and leaves the plan alone when the full plan never arrives', async () => {
        llmResponses.push(editsAsPlan, editsAsPlan);
        await assert.rejects(refinePlan(options), /returned edits instead of a complete plan \(entries 1, 2 lack[^]*left unchanged/);
    });

    test('a `changes` list is never taken for the plan', async () => {
        llmResponses.push(edits);
        await assert.rejects(refinePlan(options), /not a valid array/);
    });

    test('answers and clarifying questions keep the current plan whatever came back', async () => {
        llmResponses.push(JSON.stringify({ action: 'answered', summary: 'It covers three areas.', plan: [{ number: 1, action: 'retain' }] }));
        const result = await refinePlan(options);
        assert.equal(result.action, 'answered');
        assert.deepEqual(result.plan, currentPlan);
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
    });
});
