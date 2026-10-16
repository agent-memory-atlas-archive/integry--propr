// Server auth routes report failures as `/login?error=<code>`. Only known codes
// are rendered; unknown values get generic text so the URL cannot inject copy.
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  oauth_state_mismatch: 'GitHub sign-in did not complete because the sign-in request expired or was opened in another browser session. Start sign-in again from this page.',
  connect_login_failed: 'GitHub sign-in could not be completed. Try again.',
  session_unavailable: 'GitHub sign-in could not be saved because the instance session store is unavailable. Try again shortly.',
  connect_not_configured: 'GitHub sign-in is not configured correctly on this instance.',
  web_auth_not_configured: 'Browser sign-in is not configured on this instance.',
  not_authorized: 'This GitHub account is not authorized to use this instance.',
};

export const loginErrorMessage = (code: string | null): string | null => {
  if (!code) return null;
  return LOGIN_ERROR_MESSAGES[code] ?? 'GitHub sign-in did not complete. Try again.';
};
