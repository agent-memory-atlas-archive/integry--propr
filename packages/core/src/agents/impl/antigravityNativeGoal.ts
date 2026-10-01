import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { GOAL_CONTINUE_INPUT, NATIVE_GOAL_COMMAND_PREFIX, parseGoalCheckpointDeclaration } from '../../goals.js';
import {
    getDockerRunContainerName,
    getExecutionAbortError,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from '../../claude/docker/dockerExecutionOwnership.js';
import type {
    AgentExecutionResult,
    AgentTaskOptions,
    GoalCheckpointOutcome,
    GoalExecutionControl,
    TokenUsage,
} from '../types.js';
import {
    aggregateDeltaMessages,
    filterAntigravityAnalysisEvents,
    normalizeAntigravityModelId,
    parseAntigravityJsonl,
    type AntigravityOutputEvent,
} from './utils/antigravityOutputParser.js';
import { splitAntigravityInvocations } from './utils/antigravityInvocations.js';
import { LiveAgentOutput } from './utils/liveAgentOutput.js';
import {
    ANTIGRAVITY_GOAL_COMPLETE_MARKER,
    AntigravityGoalStream,
    type AntigravityGoalSegment,
} from './antigravityGoalStream.js';

const execFileAsync = promisify(execFile);
const CONTROL_POLL_MS = 400;
/** How long a requested interrupt waits for the running step to finish first. */
const STEP_BOUNDARY_GRACE_MS = 30_000;
const MAX_UNEXPLAINED_TURN_ENDS = 3;

type StopState = 'paused' | 'cancelled';
type Declaration = ReturnType<typeof parseGoalCheckpointDeclaration>;

export interface AntigravityGoalCompletion {
    status: 'completed' | 'failed' | 'interrupted';
    error?: string;
}

interface GoalMessage {
    text: string;
    /** Pending-input ids settled once the invocation carrying this message starts. */
    inputIds: string[];
}

/** Starts one invocation of the goal conversation; `launch` sends the native `/goal` command. */
export type StartAntigravitySegment = (
    message: string,
    options: { conversationId?: string; launch: boolean },
) => AntigravityGoalSegment;

function checkpointFeedback(outcome: GoalCheckpointOutcome): string {
    if (!outcome.accepted) {
        return `ProPR rejected your checkpoint declaration: ${outcome.error || 'The declaration could not be published'}. No checkpoint was committed. Correct the declaration and continue working toward the goal.`;
    }
    return outcome.commitSha
        ? `ProPR accepted and published your checkpoint as commit ${outcome.commitSha}. Continue working toward the goal.`
        : 'ProPR accepted your checkpoint, but there were no matching changes to commit. Continue working toward the goal.';
}

interface SegmentObservation {
    segment: AntigravityGoalSegment;
    stopRequested: StopState | null;
    interrupted: boolean;
    declaration: Declaration;
}

/**
 * Antigravity owns the goal loop: after `/goal` its stop hook keeps the agent
 * working until it marks the goal complete. Its print mode queues stdin input
 * until that loop ends, so ProPR reaches a boundary by interrupting at the next
 * finished step and resuming the exact conversation, which keeps the goal set.
 */
class AntigravityGoalProtocol {
    private turn = 0;
    private readonly control: GoalExecutionControl;
    private identityReported = false;
    conversationId?: string;
    readonly segments: AntigravityGoalSegment[] = [];
    lastResponse?: string;

    constructor(
        private readonly startSegment: StartAntigravitySegment,
        private readonly options: AgentTaskOptions,
        private readonly command: string,
    ) {
        this.control = options.goalControl!;
        this.conversationId = options.resumeConversationId || options.resumeSessionId;
    }

    private async requestedStop(): Promise<StopState | null> {
        const { desiredState } = await this.control.load();
        return desiredState === 'running' ? null : desiredState;
    }

    /** The first message of this attempt: the goal itself, or what resumes it. */
    private initialMessage(): GoalMessage {
        const { initialControlInputId: inputId, initialControlInputMessage: input, initialGoalFeedback } = this.options;
        if (!this.conversationId) {
            // The delivery context rides with the command so the goal's first
            // turn already works under ProPR's delivery policy.
            return {
                text: input ? `${this.command}\n\n${input}` : this.command,
                inputIds: input && inputId ? [inputId] : [],
            };
        }
        const texts = [initialGoalFeedback, input].filter((text): text is string => Boolean(text));
        return {
            text: texts.length ? texts.join('\n\n') : GOAL_CONTINUE_INPUT,
            inputIds: input && inputId ? [inputId] : [],
        };
    }

    private async waitForIdentity(segment: AntigravityGoalSegment): Promise<void> {
        while (!segment.conversationId && !segment.exited) {
            await segment.waitForActivity(CONTROL_POLL_MS);
            await this.control.heartbeat();
        }
        if (!segment.conversationId) return;
        if (this.conversationId && segment.conversationId !== this.conversationId) {
            throw new Error(`Antigravity resumed conversation "${segment.conversationId}" instead of "${this.conversationId}"`);
        }
        this.conversationId = segment.conversationId;
        // Every attempt reports its confirmed identity once, as the Claude and
        // Codex siblings do: the worker acknowledges controls and marks the
        // backing task as executing from this callback.
        if (!this.identityReported) {
            this.identityReported = true;
            await this.options.onSessionId?.(segment.conversationId, segment.conversationId);
        }
    }

    private async observe(segment: AntigravityGoalSegment): Promise<SegmentObservation> {
        let cursor = 0;
        let declaration: Declaration = null;
        let stopRequested: StopState | null = null;
        let interruptRequestedAt: number | null = null;
        let interrupted = false;
        let completing = false;
        while (!segment.exited) {
            for (const text of segment.textsAfter(cursor)) {
                declaration = parseGoalCheckpointDeclaration(text) ?? declaration;
                completing ||= text.includes(ANTIGRAVITY_GOAL_COMPLETE_MARKER);
            }
            cursor = segment.textCursor;
            if (!segment.result && interruptRequestedAt === null) {
                const snapshot = await this.control.load();
                if (snapshot.desiredState !== 'running') stopRequested = snapshot.desiredState;
                // A checkpoint ends the agent's turn, as it does for Claude and
                // Codex, unless the goal is already finishing on its own.
                const checkpointBoundary = Boolean(declaration) && !completing;
                if (stopRequested || checkpointBoundary || snapshot.pendingInputs.length) interruptRequestedAt = Date.now();
            }
            if (interruptRequestedAt !== null && !interrupted && !segment.result
                && (!segment.stepActive || Date.now() - interruptRequestedAt >= STEP_BOUNDARY_GRACE_MS)) {
                interrupted = true;
                segment.interrupt();
            }
            await segment.waitForActivity(CONTROL_POLL_MS);
            await this.control.heartbeat();
        }
        for (const text of segment.textsAfter(cursor)) declaration = parseGoalCheckpointDeclaration(text) ?? declaration;
        return { segment, stopRequested, interrupted, declaration };
    }

    private async publish(declaration: NonNullable<Declaration>, turnId: string): Promise<string> {
        if ('rejected' in declaration) {
            await this.control.rejectCheckpoint({
                kind: 'agent', error: declaration.error, commitMessage: declaration.message,
                include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
            }, turnId);
            return checkpointFeedback({ accepted: false, error: declaration.error });
        }
        return checkpointFeedback(await this.control.publishCheckpoint({
            kind: 'agent', commitMessage: declaration.message,
            include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
        }, turnId));
    }

    /** Operator input queued while the goal ran, delivered as the next invocation's message. */
    private async nextMessage(feedback: string | undefined): Promise<GoalMessage> {
        const { pendingInputs } = await this.control.load();
        const texts = [feedback, ...pendingInputs.map(input => input.message)].filter((text): text is string => Boolean(text));
        return {
            text: texts.length ? texts.join('\n\n') : GOAL_CONTINUE_INPUT,
            inputIds: pendingInputs.map(input => input.id),
        };
    }

    private async runSegment(message: GoalMessage): Promise<SegmentObservation & { turnId: string }> {
        const launch = !this.conversationId;
        const segment = this.startSegment(message.text, { conversationId: this.conversationId, launch });
        this.segments.push(segment);
        await this.waitForIdentity(segment);
        this.turn += 1;
        const turnId = `${this.conversationId ?? 'antigravity'}:${this.turn}`;
        // The CLI reports its conversation only after accepting the prompt.
        if (segment.conversationId) {
            for (const inputId of message.inputIds) await this.control.markInputDelivered(inputId, turnId);
        }
        await this.control.setActiveTurn(turnId);
        const observation = await this.observe(segment);
        await this.control.setActiveTurn(null);
        if (segment.result?.response) this.lastResponse = segment.result.response;
        return { ...observation, turnId };
    }

    async run(): Promise<AntigravityGoalCompletion> {
        if (await this.requestedStop()) return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
        let message = this.initialMessage();
        let nudges = 0;
        while (true) {
            const { segment, stopRequested, interrupted, declaration, turnId } = await this.runSegment(message);
            if (!segment.conversationId) {
                return { status: 'failed', error: segment.errorText || 'Antigravity goal invocation did not report a resumable conversation' };
            }
            const feedback = declaration ? await this.publish(declaration, turnId) : undefined;
            if (stopRequested || await this.requestedStop()) {
                return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
            }
            const result = segment.result;
            // Input queued while the goal finished stays pending for the next attempt.
            if (result?.status === 'success' && result.response.includes(ANTIGRAVITY_GOAL_COMPLETE_MARKER)) {
                return { status: 'completed' };
            }
            if (!interrupted && result?.status !== 'success') {
                return { status: 'failed', error: segment.errorText || 'Antigravity goal invocation ended with an error' };
            }
            nudges = interrupted || feedback ? 0 : nudges + 1;
            if (nudges > MAX_UNEXPLAINED_TURN_ENDS) {
                return { status: 'failed', error: 'Antigravity repeatedly ended its turn without marking the native goal complete' };
            }
            message = await this.nextMessage(feedback);
        }
    }
}

export async function runAntigravityGoalProtocol(
    startSegment: StartAntigravitySegment,
    options: AgentTaskOptions,
    command: string,
): Promise<AntigravityGoalCompletion & { conversationId?: string; segments: AntigravityGoalSegment[]; lastResponse?: string }> {
    const protocol = new AntigravityGoalProtocol(startSegment, options, command);
    const completion = await protocol.run();
    return { ...completion, conversationId: protocol.conversationId, segments: protocol.segments, lastResponse: protocol.lastResponse };
}

async function detectContainer(containerName: string | null, callback: AgentTaskOptions['onContainerId']): Promise<void> {
    if (!containerName || !callback) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.Id}}', containerName]);
            if (stdout.trim()) return void await callback(stdout.trim(), containerName);
        } catch { /* container creation may still be in progress */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

function addTokenUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
    const sum: TokenUsage = { ...total };
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'reasoning_output_tokens'] as const) {
        sum[key] = (sum[key] ?? 0) + (usage[key] ?? 0);
    }
    return sum;
}

export interface AntigravityNativeGoalLaunch {
    /** Docker args for one invocation; `launch` keeps slash commands enabled for `/goal`. */
    buildDockerArgs(options: { conversationId?: string; launch: boolean }): string[];
    model: string;
    timeoutMs: number;
}

/** Run one attempt of an Antigravity native `/goal` conversation with live ProPR controls. */
export async function executeAntigravityNativeGoal(
    options: AgentTaskOptions,
    launch: AntigravityNativeGoalLaunch,
): Promise<AgentExecutionResult> {
    const start = Date.now();
    const control = options.goalControl;
    if (!control || !options.nativeGoalObjective) {
        throw new Error('Antigravity native goal execution requires durable goal controls and an objective');
    }
    const ownership = getExecutionOwnershipContext();
    const output = new LiveAgentOutput(options.taskId, records => control.appendOutput(records), 'antigravity-goal');
    let current: ChildProcess | null = null;
    let expired = false;
    const stopCurrent = (): void => { current?.kill('SIGTERM'); };
    ownership?.signal.addEventListener('abort', stopCurrent, { once: true });
    const deadline = setTimeout(() => { expired = true; stopCurrent(); }, launch.timeoutMs);
    const startSegment: StartAntigravitySegment = (message, segmentOptions) => {
        if (ownership?.signal.aborted) throw getExecutionAbortError(ownership.signal)!;
        if (expired) throw new Error('Antigravity native goal attempt exceeded its execution timeout');
        const args = resolveExecutionArgs('docker', launch.buildDockerArgs(segmentOptions), options.taskId, ownership?.attemptGeneration);
        const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.worktreePath });
        current = child;
        // Print mode reads the prompt from non-TTY stdin, avoiding argv limits.
        child.stdin?.end(message);
        void detectContainer(getDockerRunContainerName(args), options.onContainerId);
        return new AntigravityGoalStream(child, output);
    };
    let run: Awaited<ReturnType<typeof runAntigravityGoalProtocol>> | undefined;
    let failure: string | undefined;
    try {
        const command = options.nativeGoalObjective.startsWith(NATIVE_GOAL_COMMAND_PREFIX)
            ? options.nativeGoalObjective
            : `${NATIVE_GOAL_COMMAND_PREFIX}${options.nativeGoalObjective}`;
        run = await runAntigravityGoalProtocol(startSegment, options, command);
    } catch (error) {
        failure = (getExecutionAbortError(ownership?.signal) ?? error as Error).message;
    } finally {
        // An abort kills the running invocation, which the protocol sees as a
        // CLI failure; report the abort itself instead.
        failure ??= getExecutionAbortError(ownership?.signal)?.message;
        clearTimeout(deadline);
        ownership?.signal.removeEventListener('abort', stopCurrent);
        stopCurrent();
        await control.setActiveTurn(null).catch(() => undefined);
        await output.close();
    }
    return goalAttemptResult(run, { failure, raw: output.raw, model: launch.model, executionTimeMs: Date.now() - start });
}

/**
 * Analysis events of a goal attempt's recorded stream. Each invocation is
 * filtered on its own: an interrupted invocation's narration must not be
 * superseded by a later invocation's terminal response.
 */
export function antigravityGoalConversationLog(raw: string): AntigravityOutputEvent[] {
    return splitAntigravityInvocations(raw).flatMap(invocation =>
        filterAntigravityAnalysisEvents(aggregateDeltaMessages(parseAntigravityJsonl(invocation).conversationLog)))
        // An empty ERROR result is an interrupt at a control boundary, not a failure.
        .filter(event => !('event' in event && event.event === 'result' && !event.result.response));
}

function goalAttemptResult(
    run: Awaited<ReturnType<typeof runAntigravityGoalProtocol>> | undefined,
    { failure, raw, model: requestedModel, executionTimeMs }: { failure?: string; raw: string; model: string; executionTimeMs: number },
): AgentExecutionResult {
    const segments = run?.segments ?? [];
    const reportedModel = segments.map(segment => segment.model).filter(Boolean).pop();
    const model = reportedModel ? normalizeAntigravityModelId(reportedModel) : requestedModel;
    const conversationLog = antigravityGoalConversationLog(raw);
    const success = !failure && run?.status === 'completed';
    return {
        success,
        executionTimeMs,
        logs: raw,
        rawOutput: raw,
        summary: run?.lastResponse,
        conversationLog,
        modifiedFiles: [],
        commitMessage: null,
        sessionId: run?.conversationId,
        conversationId: run?.conversationId,
        modelUsed: model,
        providerModel: model,
        tokenUsage: segments.reduce<TokenUsage>((total, segment) => addTokenUsage(total, segment.tokenUsage), {
            input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, reasoning_output_tokens: 0,
        }),
        exitCode: success ? 0 : 1,
        error: success ? undefined : failure || run?.error || 'Antigravity native goal did not complete',
    };
}
