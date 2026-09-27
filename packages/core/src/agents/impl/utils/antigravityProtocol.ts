export function resolveAntigravityProtocolError(
    terminalStatus: 'success' | 'error' | undefined,
    protocolError: string | undefined,
    hasStreamEnvelopes: boolean,
): string | undefined {
    if (protocolError) return protocolError;
    if (terminalStatus === 'error') return 'Antigravity reported an ERROR result';
    if (hasStreamEnvelopes && terminalStatus !== 'success') {
        return 'Antigravity stream ended without a terminal SUCCESS result';
    }
    return undefined;
}

/** Goals must retain a provider conversation for checkpoints and operator input. */
export function resolveAntigravityGoalSessionError(
    hasStreamEnvelopes: boolean,
    conversationId: string | undefined,
): string | undefined {
    if (!hasStreamEnvelopes || !conversationId) {
        return 'Antigravity goal execution did not report a resumable stream-json conversation';
    }
    return undefined;
}
