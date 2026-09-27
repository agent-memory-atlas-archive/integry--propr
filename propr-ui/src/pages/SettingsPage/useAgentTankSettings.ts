import { useCallback, useState } from 'react';
import { getAgentTankStatus, updateAgentTankSettings } from '../../api/revertApi';
import type { AgentTankSettings } from './AgentTankSection';

/**
 * Give the backend time to store the new mode before asking whether it works;
 * a bundled run in particular is not ready the instant the write returns.
 */
const STATUS_PROBE_DELAY = 500;

/**
 * Agent Tank mode state and its optimistic write.
 *
 * Split out of `useSettingsState` because the write has to be able to undo its
 * own optimistic update: a backend can legitimately refuse a mode - an older
 * one cannot honor `bundled` at all - and the radio group must then show the
 * mode that is really persisted instead of the one that was clicked.
 *
 * @param reportError - called with `null` when a write starts and with a
 * message when it fails, so the settings page can surface it.
 */
export function useAgentTankSettings(reportError: (message: string | null) => void) {
  const [settings, setSettings] = useState<AgentTankSettings>({ mode: 'disabled', enabled: false, url: '' });
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const probeStatus = useCallback((delayMs = 0) => {
    setCheckingStatus(true);
    const probe = () => {
      getAgentTankStatus()
        .then(status => setAvailable(status.available))
        .catch(() => setAvailable(false))
        .finally(() => setCheckingStatus(false));
    };
    if (delayMs > 0) setTimeout(probe, delayMs); else probe();
  }, []);

  /** Adopt the settings just loaded from the backend. */
  const adopt = useCallback((loaded: AgentTankSettings) => {
    setSettings(loaded);
    if (loaded.mode !== 'disabled') probeStatus();
  }, [probeStatus]);

  const change = useCallback((newSettings: AgentTankSettings) => {
    const previous = settings;
    setSettings(newSettings);
    setAvailable(null);
    reportError(null);
    updateAgentTankSettings({ mode: newSettings.mode, url: newSettings.url }).catch(err => {
      console.error('Failed to save Agent Tank settings:', err);
      setSettings(previous);
      setCheckingStatus(false);
      reportError((err as Error).message || 'Failed to save Agent Tank settings');
    });
    if (newSettings.mode !== 'disabled') probeStatus(STATUS_PROBE_DELAY);
    else setCheckingStatus(false);
  }, [settings, reportError, probeStatus]);

  return { settings, available, checkingStatus, adopt, change };
}
