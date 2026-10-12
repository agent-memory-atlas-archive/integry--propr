import { validateGithubClientId } from './github-client-config';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { GithubBrowserSignInError as SignInError } from '@propr/local-setup';

const VERIFICATION_URL = 'https://github.com/login/device';
const cancelled = () => Object.assign(new SignInError('GitHub sign-in was cancelled. Retry when ready.'), { name: 'AbortError' });

export interface GithubBrowserAuthDependencies {
  clientId?: string;
  /** Start trusted native UI and return cleanup without waiting for user action.
   * Never send this code through renderer IPC. */
  presentCode(code: string, url: string, signal: AbortSignal, cancel: () => void): Promise<() => Promise<void>>;
  confirmIdentity(login: string, signal: AbortSignal): Promise<boolean>;
  fetch?: typeof fetch;
  deadlineMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** GitHub device authorization, independent of the local backend and global gh state.
 * The server-generated device secret protects the exchange (no redirect/PKCE).
 * Only this closure can complete its random attempt; deep links cannot complete it.
 */
export const createGithubBrowserLogin = (dependencies: GithubBrowserAuthDependencies) => {
  let active: { nonce: string; controller: AbortController } | undefined;
  return async ({ signal: caller, onLog }: { signal?: AbortSignal; onLog?: (line: string) => void } = {}): Promise<string> => {
    caller?.throwIfAborted();
    let clientId: string;
    try { clientId = validateGithubClientId(dependencies.clientId); } catch {
      throw new SignInError('GitHub browser sign-in is not configured. The desktop distributor must provision PROPR_DESKTOP_GITHUB_CLIENT_ID with a ProPR-owned OAuth app that enables device flow.');
    }
    active?.controller.abort();
    const attempt = { nonce: randomBytes(32).toString('hex'), controller: new AbortController() };
    active = attempt;
    const cancel = () => attempt.controller.abort(cancelled());
    caller?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => attempt.controller.abort(new SignInError('GitHub sign-in timed out. Retry to start a new browser sign-in.')), Math.min(dependencies.deadlineMs ?? 900_000, 900_000));
    let closePrompt: (() => Promise<void>) | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = attempt.controller.signal;
    const check = () => {
      signal.throwIfAborted();
      if (active?.nonce !== attempt.nonce) throw cancelled();
    };
    const request = async (url: string, body?: Record<string, string>, token?: string): Promise<Record<string, unknown>> => {
      check();
      const response = await (dependencies.fetch ?? fetch)(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
      check();
      const data: unknown = await response.json();
      check();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SignInError('Invalid GitHub sign-in response. Retry.');
      const result = data as Record<string, unknown>;
      // Only recognize fixed protocol errors at OAuth endpoints, including HTTP 4xx.
      if (body && result.error === 'device_flow_disabled') throw new SignInError('The ProPR GitHub OAuth app must enable device flow. Contact the desktop distributor.');
      if (body && result.error === 'incorrect_client_credentials') throw new SignInError('The ProPR GitHub OAuth client configuration is invalid. Contact the desktop distributor.');
      if (!response.ok && !(body && typeof result.error === 'string' && ['authorization_pending', 'slow_down', 'access_denied', 'expired_token'].includes(result.error))) {
        throw new SignInError('GitHub could not complete sign-in. Check your connection and retry.');
      }
      return result;
    };
    try {
      onLog?.('Sign in via GitHub in your browser. Choose the intended account, then return to ProPR.');
      const device = await request('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:org' });
      if (typeof device.device_code !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(device.device_code)
        || typeof device.user_code !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(device.user_code)
        || device.verification_uri !== VERIFICATION_URL
        || !Number.isInteger(device.expires_in) || Number(device.expires_in) <= 0 || Number(device.expires_in) > 900
        || !Number.isInteger(device.interval) || Number(device.interval) <= 0 || Number(device.interval) > 900) {
        throw new SignInError('GitHub browser sign-in is unavailable. Check the OAuth app configuration and retry.');
      }
      expiryTimer = setTimeout(() => attempt.controller.abort(new SignInError('GitHub sign-in expired. Retry to request a new sign-in.')), Number(device.expires_in) * 1000);
      closePrompt = await dependencies.presentCode(device.user_code, VERIFICATION_URL, signal, cancel);
      check();
      onLog?.('Waiting for GitHub approval in your browser. Return to ProPR to confirm your account, or choose Cancel sign-in in the desktop dialog.');
      let interval = Number(device.interval) * 1000;
      for (;;) {
        await (dependencies.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(interval, signal);
        check();
        const result = await request('https://github.com/login/oauth/access_token', {
          client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') {
          interval = Math.max(interval + 5000, Number.isInteger(result.interval) && Number(result.interval) > 0 && Number(result.interval) <= 900 ? Number(result.interval) * 1000 : 0);
          continue;
        }
        if (result.error === 'access_denied') throw new SignInError('GitHub sign-in was declined. Retry and approve the intended account.');
        if (result.error === 'expired_token') throw new SignInError('GitHub sign-in expired. Retry to request a new sign-in.');
        if (result.error || typeof result.access_token !== 'string' || !/^[A-Za-z0-9_]{1,512}$/.test(result.access_token)
          || result.token_type !== 'bearer') throw new SignInError('GitHub sign-in failed. Retry or check the OAuth app configuration.');
        if (result.expires_in !== undefined || result.refresh_token !== undefined) {
          throw new SignInError('The ProPR desktop OAuth app must issue non-expiring user tokens. Contact the desktop distributor to correct its configuration.');
        }
        const user = await request('https://api.github.com/user', undefined, result.access_token);
        if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.login !== 'string'
          || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login)) throw new SignInError('GitHub identity could not be verified. Retry sign-in.');
        check();
        await closePrompt();
        closePrompt = undefined;
        check();
        if (!await dependencies.confirmIdentity(user.login, signal)) throw new SignInError('GitHub account was not confirmed. Retry sign-in and choose the intended account in GitHub.');
        check();
        onLog?.('GitHub account confirmed. Refreshing accessible installations…');
        return result.access_token;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? cancelled();
      // Do not propagate transport/provider exceptions: they can contain request secrets.
      if (error instanceof SignInError) throw error;
      throw new SignInError('GitHub browser sign-in could not complete. Check your browser and connection, then retry.');
    } finally {
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      caller?.removeEventListener('abort', cancel);
      if (active?.nonce === attempt.nonce) active = undefined;
      attempt.controller.abort(); // closes native waiting UI; nothing survives relaunch
      await closePrompt?.();
    }
  };
};
