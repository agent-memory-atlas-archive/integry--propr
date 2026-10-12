import type { MessageBoxOptions } from 'electron';
import { isSafeExternalUrl } from './security';

export function createGithubCodePresenter(dependencies: {
  showDialog(options: MessageBoxOptions): Promise<{ response: number }>;
  copy(code: string): void;
  openExternal(url: string): Promise<void>;
  isShuttingDown(): boolean;
}) {
  return async (code: string, url: string, signal: AbortSignal, cancel: () => void): Promise<() => Promise<void>> => {
    const detail = `Enter this one-time code on GitHub: ${code}\nChoose the intended GitHub account before approving. Return to ProPR to confirm your verified account.`;
    for (;;) {
      signal.throwIfAborted();
      const approval = await dependencies.showDialog({
        type: 'info', title: 'Sign in via GitHub', message: 'Open GitHub in your browser', detail,
        buttons: ['Open GitHub', 'Copy code', 'Cancel sign-in'], defaultId: 0, cancelId: 2, signal,
      });
      signal.throwIfAborted();
      if (approval.response === 1) { dependencies.copy(code); continue; }
      if (approval.response !== 0) { cancel(); signal.throwIfAborted(); throw new Error('Sign-in cancelled'); }
      break;
    }
    if (dependencies.isShuttingDown() || !isSafeExternalUrl(url)) throw new Error('Browser unavailable');
    await dependencies.openExternal(url);
    signal.throwIfAborted();
    const prompt = new AbortController();
    const waitingSignal = AbortSignal.any([signal, prompt.signal]);
    const waiting = (async () => {
      while (!waitingSignal.aborted) {
        const result = await dependencies.showDialog({
          type: 'info', title: 'Waiting for GitHub', message: 'Finish signing in in your browser', detail,
          buttons: ['Copy code', 'Cancel sign-in'], defaultId: 0, cancelId: 1, signal: waitingSignal,
        });
        if (waitingSignal.aborted) return;
        if (result.response === 0) dependencies.copy(code);
        else { cancel(); return; }
      }
    })().catch(() => { if (!waitingSignal.aborted) cancel(); });
    return async () => { prompt.abort(); await waiting; };
  };
}
