import { loadAgents, resolveConfigPath } from '@propr/core';
import { getManagedAgentConfigRelativePath } from '@propr/shared';
import { collectProvider } from '../../packages/core/src/diagnostics/providerCollector.js';
import { managedDiagnostics, configuredDiagnosticSecrets, diagnosticsFailure } from '../../packages/core/src/diagnostics/managedLogRuntime.js';

/** Daemon owns native snapshots; workers own managed stdout/stderr capture.
 * Only configured managed roots and explicit launcher mounts are eligible. */
export function scheduleManagedDiagnostics(): () => void {
    if (!managedDiagnostics()) return () => {};
    let running = false, nextAgent = 0;
    const collect = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            const spool = managedDiagnostics()!;
            spool.report({ provider: 'claude', agent: 'unknown', source: 'shared-tmp-claude-logs' }, 'ownership-unverified');
            const agents = (await loadAgents()).filter(a => a.enabled);
            const inventory = { provider: 'application', agent: 'application', source: 'agent-inventory' };
            spool.report(inventory, 'protected-native-state', agents.length > 128 ? spool.limits.protectedBytes : 0);
            if (agents.length > 128) spool.report(inventory, 'scan-limit');
            const deadline = performance.now() + 2000;
            const count = Math.min(agents.length, 128);
            for (let visited = 0; visited < count; visited++) {
                if (performance.now() > deadline) {
                    spool.report({ provider: 'application', agent: 'application', source: 'agent-inventory' }, 'scan-limit');
                    break;
                }
                const agent = agents[nextAgent % count];
                nextAgent = (nextAgent + 1) % count;
                const managed = getManagedAgentConfigRelativePath(agent.configPath);
                const mountNames: Record<string, string[]> = {
                    codex: ['CODEX_CONFIG_PATH', 'HOST_CODEX_DIR'], claude: ['CLAUDE_CONFIG_PATH', 'HOST_CLAUDE_DIR'],
                    antigravity: ['ANTIGRAVITY_CONFIG_PATH', 'HOST_ANTIGRAVITY_DIR'],
                    opencode: ['HOST_OPENCODE_DATA_DIR'], vibe: ['VIBE_CONFIG_PATH', 'HOST_VIBE_DIR'],
                };
                const mounted = mountNames[agent.type].map(name => process.env[name]).find(Boolean);
                let root: string;
                if (managed && process.env.PROPR_MANAGED_CREDENTIALS_DIR) {
                    root = resolveConfigPath(agent.configPath);
                    if (agent.type === 'opencode') root = root.replace(/\/\.config\/opencode$/, '/.local/share/opencode');
                } else if (!managed && mounted && (agent.configPath.startsWith('~/') || resolveConfigPath(agent.configPath) === mounted)) {
                    root = mounted;
                } else {
                    spool.report({ provider: agent.type, agent: agent.id, source: 'unmapped-native-state' }, 'ownership-unverified');
                    continue;
                }
                collectProvider(spool, { provider: agent.type, agent: agent.id, root,
                    credentials: [...configuredDiagnosticSecrets(), ...Object.values(agent.envVars ?? {})] });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        } catch { diagnosticsFailure(); }
        finally { running = false; }
    };
    void collect();
    const timer = setInterval(() => { void collect(); }, 30_000);
    timer.unref();
    return () => clearInterval(timer);
}
