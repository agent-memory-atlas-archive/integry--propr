import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GOAL_CONTINUE_INPUT } from '../packages/core/src/goals.ts';
import { probeGoalCapability } from '../packages/core/src/agents/goalCapabilities.ts';
import {
    runAntigravityGoalProtocol,
    type StartAntigravitySegment,
} from '../packages/core/src/agents/impl/antigravityNativeGoal.ts';
import {
    ANTIGRAVITY_GOAL_COMPLETE_MARKER,
    sumAntigravityStepUsage,
    type AntigravityGoalSegment,
    type AntigravitySegmentResult,
} from '../packages/core/src/agents/impl/antigravityGoalStream.ts';
import { splitAntigravityInvocations } from '../packages/core/src/agents/impl/utils/antigravityInvocations.ts';
import type {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    GoalCheckpointOutcome,
    GoalControlSnapshot,
    GoalExecutionControl,
} from '../packages/core/src/agents/types.ts';

const COMMAND = '/goal Add subtract(a, b) to math.js';
const CHECKPOINT = '{"checkpointReady":true,"message":"feat(math): add subtract","include":["math.js"]}';

interface ScriptedStep {
    /** Agent text completed by this step, if any. */
    text?: string;
    /** Ends the invocation on its own with this result. */
    result?: AntigravitySegmentResult;
}

/**
 * One scripted `agy` invocation: it reports its conversation, then completes a
 * step per poll. An interrupt ends it with the CLI's interrupted error result.
 */
class ScriptedSegment implements AntigravityGoalSegment {
    conversationId?: string;
    model = 'gemini-3.8-flash-medium';
    stepActive = false;
    result?: AntigravitySegmentResult;
    exited = false;
    errorText?: string;
    tokenUsage = { input_tokens: 10, output_tokens: 1 };
    interrupts = 0;
    private texts: string[] = [];

    constructor(
        readonly message: string,
        readonly options: { conversationId?: string; launch: boolean },
        private readonly steps: ScriptedStep[],
        conversationId: string,
    ) {
        this.conversationId = conversationId;
    }

    get textCursor(): number { return this.texts.length; }
    textsAfter(cursor: number): string[] { return this.texts.slice(cursor); }

    interrupt(): void {
        this.interrupts += 1;
        this.result = { status: 'error', response: '' };
        this.errorText = 'error: interrupted';
        this.exited = true;
    }

    async waitForActivity(): Promise<void> {
        if (this.exited) return;
        const step = this.steps.shift();
        if (!step) {
            this.result = { status: 'error', response: '' };
            this.errorText = 'error: script exhausted';
            this.exited = true;
            return;
        }
        if (step.text) this.texts.push(step.text);
        if (step.result) {
            this.result = step.result;
            this.exited = true;
        }
    }

    async waitForExit(): Promise<void> {}
}

interface Harness {
    control: GoalExecutionControl;
    snapshot: GoalControlSnapshot;
    delivered: Array<[string, string]>;
    published: string[];
    rejected: string[];
    sessions: string[];
}

function harness(outcome: GoalCheckpointOutcome = { accepted: true, commitSha: 'abc1234' }): Harness {
    const state: Harness = {
        snapshot: { desiredState: 'running', requestedModel: 'antigravity-gemini-3.8-flash-medium', pendingInputs: [], controlGeneration: 1 },
        delivered: [], published: [], rejected: [], sessions: [],
        control: undefined as never,
    };
    state.control = {
        load: async () => ({ ...state.snapshot, pendingInputs: [...state.snapshot.pendingInputs] }),
        heartbeat: async () => undefined,
        setActiveTurn: async () => undefined,
        markInputDelivered: async (inputId, turnId) => {
            state.delivered.push([inputId, turnId]);
            state.snapshot.pendingInputs = state.snapshot.pendingInputs.filter(input => input.id !== inputId);
        },
        markInputUndeliverable: async () => undefined,
        publishCheckpoint: async request => { state.published.push(request.commitMessage); return outcome; },
        rejectCheckpoint: async request => { state.rejected.push(request.error); },
        appendOutput: async () => undefined,
    };
    return state;
}

function taskOptions(state: Harness, overrides: Partial<AgentTaskOptions> = {}): AgentTaskOptions {
    return {
        worktreePath: '/tmp/worktree', issueRef: { number: 0, repoOwner: 'acme', repoName: 'repo' },
        prompt: COMMAND, githubToken: 'token', executionMode: 'goal', nativeGoalObjective: COMMAND,
        goalControl: state.control,
        onSessionId: sessionId => { state.sessions.push(sessionId); },
        ...overrides,
    };
}

function scripted(scripts: ScriptedStep[][], conversationId = 'agy-conversation') {
    const segments: ScriptedSegment[] = [];
    const start: StartAntigravitySegment = (message, options) => {
        const segment = new ScriptedSegment(message, options, scripts[segments.length] ?? [], conversationId);
        segments.push(segment);
        return segment;
    };
    return { segments, start };
}

const completed = (text = `Done.\n\n${ANTIGRAVITY_GOAL_COMPLETE_MARKER}`): ScriptedStep => ({
    text, result: { status: 'success', response: text },
});

describe('Antigravity native goal protocol', () => {
    test('launches the native /goal with the delivery context and completes on the goal marker', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, completed()]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state, {
            initialControlInputId: 'context-1', initialControlInputMessage: 'ProPR delivery context',
        }), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].message, `${COMMAND}\n\nProPR delivery context`);
        assert.deepEqual(segments[0].options, { conversationId: undefined, launch: true });
        assert.deepEqual(state.sessions, ['agy-conversation']);
        assert.deepEqual(state.delivered, [['context-1', 'agy-conversation:1']]);
        assert.equal(result.conversationId, 'agy-conversation');
    });

    test('a checkpoint ends the turn at a step boundary and the same conversation resumes with its acknowledgement', async () => {
        const state = harness();
        const { segments, start } = scripted([
            [{ text: `Subtract added.\n${CHECKPOINT}` }, {}],
            [completed()],
        ]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments[0].interrupts, 1);
        assert.deepEqual(state.published, ['feat(math): add subtract']);
        assert.deepEqual(segments[1].options, { conversationId: 'agy-conversation', launch: false });
        assert.match(segments[1].message, /published your checkpoint as commit abc1234/);
    });

    test('a rejected checkpoint is fed back instead of committed', async () => {
        const state = harness();
        const { segments, start } = scripted([
            [{ text: '{"checkpointReady":true,"message":""}' }, {}],
            [completed()],
        ]);
        await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(state.published.length, 0);
        assert.equal(state.rejected.length, 1);
        assert.match(segments[1].message, /rejected your checkpoint declaration/);
    });

    test('a final checkpoint beside the goal marker is published without interrupting completion', async () => {
        const state = harness();
        const text = `Verified.\n${CHECKPOINT}\n${ANTIGRAVITY_GOAL_COMPLETE_MARKER}`;
        const { segments, start } = scripted([[completed(text)]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'completed');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].interrupts, 0);
        assert.deepEqual(state.published, ['feat(math): add subtract']);
    });

    test('operator input interrupts the running goal and is delivered verbatim to the resumed conversation', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}], [completed()]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.pendingInputs = [{ id: 'input-1', message: 'Also add multiply(a, b).' }];
        const result = await running;

        assert.equal(result.status, 'completed');
        assert.equal(segments[0].interrupts, 1);
        assert.equal(segments[1].message, 'Also add multiply(a, b).');
        assert.deepEqual(state.delivered, [['input-1', 'agy-conversation:2']]);
    });

    test('pause stops at a boundary without starting another invocation', async () => {
        const state = harness();
        const { segments, start } = scripted([[{}, {}, {}]]);
        const running = runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        state.snapshot.desiredState = 'paused';
        const result = await running;

        assert.equal(result.status, 'interrupted');
        assert.equal(segments.length, 1);
        assert.equal(segments[0].interrupts, 1);
    });

    test('a resumed attempt continues the saved conversation with its pending feedback', async () => {
        const state = harness();
        const { segments, start } = scripted([[completed()]]);
        await runAntigravityGoalProtocol(start, taskOptions(state, {
            resumeConversationId: 'agy-conversation', initialGoalFeedback: 'ProPR accepted your checkpoint.',
        }), COMMAND);

        assert.deepEqual(segments[0].options, { conversationId: 'agy-conversation', launch: false });
        assert.equal(segments[0].message, 'ProPR accepted your checkpoint.');
        assert.deepEqual(state.sessions, []);
    });

    test('a resumed attempt without feedback or input nudges the goal to continue', async () => {
        const state = harness();
        const { segments, start } = scripted([[completed()]]);
        await runAntigravityGoalProtocol(start, taskOptions(state, { resumeConversationId: 'agy-conversation' }), COMMAND);
        assert.equal(segments[0].message, GOAL_CONTINUE_INPUT);
    });

    test('repeated turn ends without the goal marker fail instead of looping', async () => {
        const state = harness();
        const idle = (): ScriptedStep[] => [{ text: 'Stopping here.', result: { status: 'success', response: 'Stopping here.' } }];
        const { segments, start } = scripted([idle(), idle(), idle(), idle(), idle()]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);

        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /without marking the native goal complete/);
        assert.equal(segments.length, 4);
    });

    test('a provider failure is reported with the CLI error line', async () => {
        const state = harness();
        const { start } = scripted([[{ result: { status: 'error', response: '' } }]]);
        const result = await runAntigravityGoalProtocol(start, taskOptions(state), COMMAND);
        assert.equal(result.status, 'failed');
    });

    test('a resume that reports a different conversation is refused', async () => {
        const state = harness();
        const { start } = scripted([[completed()]], 'other-conversation');
        await assert.rejects(
            runAntigravityGoalProtocol(start, taskOptions(state, { resumeConversationId: 'agy-conversation' }), COMMAND),
            /resumed conversation "other-conversation" instead of "agy-conversation"/,
        );
    });
});

describe('Antigravity goal accounting and capability', () => {
    test('step usage, not the conversation-cumulative result usage, measures one invocation', () => {
        assert.deepEqual(sumAntigravityStepUsage([
            { input_tokens: 100, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 40 },
            { input_tokens: 50, output_tokens: 3 },
        ]), { input_tokens: 150, output_tokens: 8, cache_read_input_tokens: 40, reasoning_output_tokens: 2 });
    });

    test('a recorded goal stream splits into its invocations at each init envelope', () => {
        const init = '{"event": "init", "conversation_id": "c", "init": {"model": "m"}}';
        const invocations = splitAntigravityInvocations(['entrypoint banner', init, 'a', init, 'b'].join('\n'));
        assert.equal(invocations.length, 2);
        assert.match(invocations[0], /^entrypoint banner\n\{"event": "init"/);
        assert.equal(invocations[1], `${init}\nb`);
    });

    test('runtimes whose CLI lacks the native /goal command are not goal capable', async () => {
        const capability = await probeGoalCapability({
            config: { id: 'agy', alias: 'antigravity', type: 'antigravity', enabled: true, dockerImage: 'image' } as AgentConfig,
            goalCapable: true,
        } as Agent, async () => ({
            stdout: '--print\n--conversation\n--output-format\n--disable-slash-commands\n===PROPR-ANTIGRAVITY-GOAL-PROBE===\n0\n',
            stderr: '', exitCode: 0, messageTimestamps: new Map(),
        }));
        assert.equal(capability.goalCapable, false);
        assert.match(capability.reason ?? '', /native \/goal command/);
    });
});
