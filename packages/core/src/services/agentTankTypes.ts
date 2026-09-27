/**
 * Agent Tank vocabulary shared by both transports (HTTP and bundled).
 *
 * This lives apart from `agentTankService.ts` so the bundled runner can reuse
 * the provider-key mapping and the response shape without importing the
 * transport router that imports it back.
 */

const AGENT_TANK_AGENT_ALIASES: Record<string, string> = {
    antigravity: 'agy',
};

const PROPR_AGENT_ALIASES: Record<string, string> = Object.fromEntries(
    Object.entries(AGENT_TANK_AGENT_ALIASES).map(([proprAgent, tankAgent]) => [tankAgent, proprAgent])
);

/**
 * Translate ProPR agent aliases to Agent Tank provider keys.
 *
 * ProPR exposes Google's agent as "antigravity", while Agent Tank tracks the
 * same provider under the CLI key "agy".
 */
export function toAgentTankAgent(agent: string): string {
    return AGENT_TANK_AGENT_ALIASES[agent] || agent;
}

/** Translate Agent Tank provider keys back to ProPR agent aliases. */
export function toProprAgent(agent: string): string {
    return PROPR_AGENT_ALIASES[agent] || agent;
}

/**
 * Response shape from GET /status/:agent
 *
 * Example call:
 *   const status = await getStatus('claude');
 *   // GET http://0.0.0.0:3456/status/claude
 *   // => { "name": "claude", "usage": { "session": { "percent": 42, ... }, ... }, ... }
 */
export interface AgentStatusResponse {
    name: string;
    usage: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    lastUpdated?: string;
    error?: string | null;
    isRefreshing?: boolean;
}

/**
 * Whether a status map is evidence that usage monitoring actually works.
 *
 * A run can succeed and still describe nothing: bundled mode returns an empty
 * map when no enabled agent is a provider Agent Tank can inspect, and a daemon
 * with nothing configured answers the same way. That is a successful run, not
 * operational readiness - reporting it as "ready" would promise a capacity
 * gauge that cannot produce a single number - so readiness asks for at least
 * one provider status.
 */
export function hasAgentTankStatuses(agents: Record<string, AgentStatusResponse> | undefined): boolean {
    return !!agents && Object.keys(agents).length > 0;
}

/** Normalize a single Agent Tank status object to ProPR-facing agent names. */
export function normalizeAgentTankStatus(status: AgentStatusResponse): AgentStatusResponse {
    return { ...status, name: toProprAgent(status.name) };
}

/** Normalize a GET /status response map to ProPR-facing agent keys and names. */
export function normalizeAgentTankAgents(agents: Record<string, AgentStatusResponse>): Record<string, AgentStatusResponse> {
    return Object.fromEntries(
        Object.entries(agents).map(([agent, status]) => {
            const proprAgent = toProprAgent(agent);
            return [proprAgent, { ...status, name: toProprAgent(status.name || agent) }];
        })
    );
}
