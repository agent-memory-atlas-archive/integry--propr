import type { Server } from 'socket.io';
import { agentTankUsageFingerprint, loadAgentTankSettings, normalizeAgentTankAgents, type AgentStatusResponse } from '@propr/core';
import { ACTIVITY_UPDATE, USAGE_UPDATE } from '@propr/shared';
import { ACTIVITY_ROOM } from './activitySocketRooms.js';

interface UsageSnapshot {
  enabled?: boolean;
  agents?: Record<string, AgentStatusResponse>;
  error?: string;
}

function usageFingerprint(snapshot: UsageSnapshot): string {
  return JSON.stringify({
    enabled: snapshot.enabled,
    error: snapshot.error ?? null,
    // Keep membership in the fingerprint, but share the per-agent projection
    // with the other usage observers so countdowns cannot become invalidations.
    agents: Object.entries(snapshot.agents ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => [name, agentTankUsageFingerprint({ ...status, name: status.name || name })]),
  });
}

// Agent Tank and runtime health have no external push API. Sample once per API
// process while subscribed, then emit only changes; browser count adds no reads.
export class ShellActivityBroadcaster {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private closed = false;
  private fingerprints = new Map<string, string>();
  constructor(private io: Server, private readStatus?: () => Promise<Record<string, unknown>>,
    private readUsage = async (): Promise<UsageSnapshot> => {
      const settings = await loadAgentTankSettings();
      if (!settings.enabled) return { enabled: false };
      try {
        const response = await fetch(`${settings.url}/status`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return { enabled: true, error: `HTTP ${response.status}` };
        const agents = normalizeAgentTankAgents(await response.json() as Record<string, AgentStatusResponse>);
        return { enabled: true, agents };
      } catch {
        return { enabled: true, error: 'unreachable' };
      }
    }) {}

  start(): void {
    this.timer = setInterval(() => { void this.sample(); }, 30_000);
    this.timer.unref();
  }

  async sample(): Promise<void> {
    if (this.closed || this.running || !this.io.sockets.adapter.rooms.get(ACTIVITY_ROOM)?.size) return;
    this.running = true;
    try {
      await Promise.all([
        this.changed('usage', this.readUsage, () => this.io.to(ACTIVITY_ROOM).emit(USAGE_UPDATE,
          { eventType: USAGE_UPDATE, source: 'agent-tank', occurredAt: new Date().toISOString() })),
        this.readStatus ? this.changed('system', this.readStatus, () => this.io.to(ACTIVITY_ROOM).emit(ACTIVITY_UPDATE,
          { eventType: ACTIVITY_UPDATE, domain: 'system', change: 'progressed', entityId: 'system',
            repository: null, terminal: false, occurredAt: new Date().toISOString() })) : Promise.resolve(),
      ]);
    } finally { this.running = false; }
  }

  private async changed(key: string, read: () => Promise<unknown>, emit: () => void): Promise<void> {
    try {
      const snapshot = await read().catch(error => {
        if (key !== 'usage') throw error;
        // Settings/read failures are also observable endpoint outcomes. Keep
        // their fingerprint stable, independent of incidental error messages.
        console.warn('Unable to sample usage activity:', error);
        return { error: 'Failed to fetch Agent Tank usage' };
      });
      if (this.closed) return;
      // Snapshot timestamps/countdowns are not resource changes.
      const fingerprint = key === 'usage' ? usageFingerprint(snapshot as UsageSnapshot) : JSON.stringify(snapshot, (name, value) =>
        ['timestamp', 'updatedAt', 'lastUpdated', 'fetchedAt', 'resetsIn', 'lastAckAt'].includes(name) ? undefined : value);
      if (this.fingerprints.get(key) === fingerprint) return;
      this.fingerprints.set(key, fingerprint);
      emit();
    } catch (error) { console.warn(`Unable to sample ${key} activity:`, error); }
  }

  close(): void { this.closed = true; clearInterval(this.timer); }
}
