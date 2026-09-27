import { useCallback, useRef, useState } from 'react';
import { getAgentTankStatus, updateAgentTankSettings } from '../../api/revertApi';
import type { AgentTankSettings } from './AgentTankSection';

/**
 * Give the backend time to store the new mode before asking whether it works;
 * a bundled run in particular is not ready the instant the write returns.
 */
const STATUS_PROBE_DELAY = 500;

const INITIAL_SETTINGS: AgentTankSettings = { mode: 'disabled', enabled: false, url: '' };

/**
 * Agent Tank mode state and its optimistic write.
 *
 * Split out of `useSettingsState` because the write has to be able to undo its
 * own optimistic update: a backend can legitimately refuse a mode - an older
 * one cannot honor `bundled` at all - and the radio group must then show the
 * mode that is really persisted instead of the one that was clicked.
 *
 * Writes are queued rather than fired independently. `updateAgentTankSettings`
 * awaits a compatibility GET before POSTing `bundled`, and the URL field writes
 * on every keystroke, so concurrent writes would reach the backend in an order
 * unrelated to the operator's clicks and could persist the mode they moved away
 * from - most damagingly leaving tracking on after it was switched off.
 *
 * @param reportError - called with `null` when a write starts and with a
 * message when it fails, so the settings page can surface it.
 */
export function useAgentTankSettings(reportError: (message: string | null) => void) {
  const [settings, setSettings] = useState<AgentTankSettings>(INITIAL_SETTINGS);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  /**
   * Monotonic id of the newest selection. Anything that finishes late - a
   * failed write's rollback, a delayed status probe - compares against this
   * before touching state, so it can only speak for the selection it belongs to.
   */
  const selectionRef = useRef(0);
  /** What the backend last confirmed, i.e. what a rollback must restore. */
  const persistedRef = useRef<AgentTankSettings>(INITIAL_SETTINGS);
  /** Tail of the write queue; never rejects, so the queue cannot stall. */
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const probeStatus = useCallback((delayMs = 0, selection = selectionRef.current) => {
    setCheckingStatus(true);
    const probe = () => {
      // A probe for a superseded selection would answer about a mode nobody has
      // selected any more; the newer selection owns these three states.
      if (selection !== selectionRef.current) return;
      getAgentTankStatus()
        .then(status => { if (selection === selectionRef.current) setAvailable(status.available); })
        .catch(() => { if (selection === selectionRef.current) setAvailable(false); })
        .finally(() => { if (selection === selectionRef.current) setCheckingStatus(false); });
    };
    if (delayMs > 0) setTimeout(probe, delayMs); else probe();
  }, []);

  /** Adopt the settings just loaded from the backend. */
  const adopt = useCallback((loaded: AgentTankSettings) => {
    const selection = ++selectionRef.current;
    persistedRef.current = loaded;
    setSettings(loaded);
    if (loaded.mode !== 'disabled') probeStatus(0, selection);
    // Bumping the selection above muted any probe still in flight, so nothing
    // else would clear the spinner.
    else setCheckingStatus(false);
  }, [probeStatus]);

  const change = useCallback((newSettings: AgentTankSettings) => {
    const selection = ++selectionRef.current;
    setSettings(newSettings);
    setAvailable(null);
    reportError(null);
    if (newSettings.mode !== 'disabled') probeStatus(STATUS_PROBE_DELAY, selection);
    else setCheckingStatus(false);

    writeQueueRef.current = writeQueueRef.current.then(async () => {
      try {
        await updateAgentTankSettings({ mode: newSettings.mode, url: newSettings.url });
        persistedRef.current = newSettings;
      } catch (err) {
        console.error('Failed to save Agent Tank settings:', err);
        // A newer selection is already displayed and is queued behind this
        // write, so its state is the one that will be persisted: rolling back to
        // this write's predecessor, or reporting an error about a mode the
        // operator has since replaced, would describe a selection that no longer
        // exists.
        if (selection !== selectionRef.current) return;
        setSettings(persistedRef.current);
        setCheckingStatus(false);
        reportError((err as Error).message || 'Failed to save Agent Tank settings');
      }
    });
  }, [probeStatus, reportError]);

  return { settings, available, checkingStatus, adopt, change };
}
