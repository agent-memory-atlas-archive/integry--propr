# Desktop GitHub browser sign-in

Linux and macOS local setup sign in through GitHub's OAuth device authorization flow before starting the local backend. Initial setup asks the user to open GitHub; **Change GitHub account** requests a fresh authorization even if another account was previously saved. No GitHub CLI, terminal emulator, global `gh` credentials, or running local API is needed for GitHub sign-in. The terminal-based `propr login` flow remains supported. Agent registry authentication is a separate operation and retains its existing handoff.

## Provisioning (required)

The distributor must register a **ProPR-owned GitHub OAuth app**, enable **Device Flow**, and supply its public client ID to the desktop main process as `PROPR_DESKTOP_GITHUB_CLIENT_ID`. Use a dedicated OAuth app with non-expiring user tokens for the current host config contract. Do not supply a client secret, reuse GitHub CLI's client ID, or substitute a GitHub App registration (whose expiring user tokens require a separate refresh lifecycle). The requested scopes remain `repo read:org`, matching the existing enrollment login contract. This does not install the ProPR GitHub App or select additional repositories.

The client ID is public configuration, not a credential. For a source launch, set it in the environment that starts Desktop. For a packaged launch, the distributor must arrange for the installed executable's environment to contain it, including when launched from Finder or a Linux application menu. Shell configuration alone does not configure Finder. This change does not modify packaging workflows or provision an OAuth application. Until that configuration exists, sign-in fails with a provisioning message and never falls back to a terminal.

Protocol reference: [GitHub's official device flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow). Device flow does not need a client secret. GitHub's authorization-code exchange still requires a secret, so desktop does not embed one. Existing ProPR Connect instance-login redemption requires an already-enrolled relay token; existing desktop pairing requires a running API. Neither is suitable for pre-enrollment sign-in.

## User journey

1. In the native desktop sign-in dialog, choose **Open GitHub**. Enter the displayed one-time user verification code at `https://github.com/login/device`. The code remains visible in the native waiting dialog.
2. Check the account GitHub displays. To use another account, switch accounts on GitHub **before approving**. No account is inferred from the renderer or the operator's CLI session.
3. Return to ProPR. Desktop independently fetches `/user` with the issued token and asks **Continue as @…?**. Confirm only the intended account. If wrong, cancel, retry sign-in, and switch accounts in GitHub. For issue #3008 live acceptance the authorized account is `propr-ultrafix`.
4. Choose an installation from the refreshed, access-scoped discovery results. The existing separate enrollment permission check still applies. Installation is always a separate explicit action.

Cancel in the native dialog or cancel setup in the app. A refusal, browser failure, expiration, or connection error leaves an actionable retry outcome. An attempt has a maximum 15-minute lifetime (or GitHub's shorter expiration). Relaunch interrupts in-flight authorization; retry creates new codes. Previously saved credentials are replaced only after identity confirmation. No global `gh` credentials are read or written.

## Trust boundary

The main process keeps the device secret and access token in memory during authorization. The short user verification code is shown only in native UI, never in the renderer, IPC snapshots, logs, or URLs. Do not capture the native code dialog or GitHub authorization page in screenshots or recordings. The approved token uses the existing private desktop-local CLI config contract under the desktop user-data directory; it is not written into global CLI configuration.

Each attempt has a random nonce, its own cancellation signal, and a fresh GitHub device secret. GitHub's secret-bound device exchange provides the protocol's exchange protection; there is no authorization-code redirect and no PKCE verifier in this flow. Desktop accepts no callback, HTTP listener, or deep-link completion for it. Existing strict deep-link and external URL protections remain in place. Only the fixed HTTPS GitHub verification URL can be opened. Provider requests reject redirects, polling honors the server interval and cumulative `slow_down`, and expiry/deadline abort both requests and native UI. Late or superseded results cannot complete setup.

## Acceptance still required

Unit/host/UI fixtures establish protocol and lifecycle behavior, not live OAuth acceptance. A new source-bound Linux package and a native macOS package must exercise initial sign-in, changing an existing account to `propr-ultrafix`, verified account confirmation, installation discovery and separately authorized enrollment, cancellation, retry, browser-open failure, and relaunch. Run without `gh` or a terminal on PATH. Check keyboard use, narrow layouts, tablet/phone widths and 200% zoom; do not record codes or credentials. Use the suggested `propr-ultrafix/propr-desktop-acceptance-20260909` fixture only after discovering its accessibility with the authorized identity.

No OAuth client was provisioned and no live or native packaged browser acceptance was performed as part of this implementation. The historical installed 0.9.0 source checkpoint does not establish acceptance for this change.
