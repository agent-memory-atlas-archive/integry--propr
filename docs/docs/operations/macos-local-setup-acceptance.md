# Native macOS local setup acceptance

Issue #2969 changes the production wizard and shared host, not a Mac-only replica. Issue #2968 owns the common
production wizard acceptance/zoom coverage. The Mac entry point reuses its existing packaged lifecycle driver.
Do not alter the frozen fd4960f preview, publish, sign, notarize, deploy, or replace an installed release for this check.

## Native evidence at 7cc97e1

PR #2976 comment6104149475 reports native MacBook results for exact
`7cc97e179dbc8832c8e975ae115a2b0e763c7549`:

- Node 22 locked installation and desktop/UI type checks passed. The Darwin identity
  regression passed 1/1 after restoring ordinary checkout file modes. The initial
  archive transport made the tracked broker mode 0775; its authority rejection and
  the subsequent correction are separate evidence.
- Native ARM64 packaging and package/fuse inspection passed. Those checks did **not**
  establish that setup resources existed in `Contents/Resources`.
- The held-pull lifecycle failed before setup: `connectOverCDP` timed out after
  30 seconds. A diagnostic using the same app with a fresh profile reached HTTP
  `/json/version` 200 (Electron 44.0.0 / Chrome 152.0.7977.54), then exited 1 before
  WebSocket connection. Logs showed `desktop.app.ready`, macOS Keychain error
  -25308 (`errSecInteractionNotAllowed`), and `desktop.app.start_failed` /
  `OPERATION_FAILED`. No proxy environment variables were present.

No setup interaction, provisioning, cancellation, or retry has passed on that native
run. The Linux-only chooser and resource gates independently blocked macOS setup at
that revision. Their corrections and automated regressions do not resolve or prove
resolution of the separate Keychain startup failure. Repeat native resource inspection
and the production chooser-to-wizard lifecycle on the repaired revision once startup
succeeds; full provisioning evidence remains outstanding.

## Read-only prerequisites and held-pull lifecycle

On a native Mac with Node, the repository's Playwright dependency, and Docker Desktop already running:

1. Independently build the current source and its native application. Keep it separate from the existing preview.
2. Run `npx tsx --test packages/cli/src/localSetupDarwin.test.ts`. This uses actual Darwin descriptors and the
   packaged ACL broker in a disposable directory. A skipped Linux run is not native evidence.
3. Set `PROPR_DESKTOP_REAL_MACOS_SETUP_ACCEPTANCE=1` and
   `PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA` to the exact source revision being tested. Run:

   ```sh
   node apps/desktop/scripts/run-packaged-macos-setup-lifecycle.mjs '/absolute/path/propr-desktop.app/Contents/MacOS/propr-desktop'
   ```

The driver uses a private disposable HOME/user-data directory, unique stack/network names, reserved loopback ports,
and a Docker command boundary. It reads only the active local Docker endpoint, not Docker/provider credentials.
It compares existing container/network identities before and after. Only read-only Docker commands reach the daemon;
pulls are held so cancellation, retry, and interrupted relaunch can be observed before GitHub enrollment.
No Docker resource is deleted. The report must retain its limitations: **this is not full provisioning, health,
agent compatibility, enrollment, or pairing proof**. Docker-unavailable reports are unverified, not passes.

Also test the production wizard with Docker Desktop stopped (actionable start guidance) and without the Docker CLI
(actionable installation guidance), then reopen Docker Desktop and retry. Do not change socket permissions or grant
file access to make the checks pass. Confirm a normal Finder launch locates Docker without a terminal-exported PATH.

## Full provisioning proof — separate, explicit native session

Use a fresh app profile and a newly allocated runtime root/stack/network/loopback ports, isolated from existing
containers, networks and profiles. Record the source revision, app hash, Docker engine architecture and actual image
manifest platforms. Do not use the held-pull boundary or synthetic enrollment responses for this session.

Walk the real wizard with keyboard navigation at a narrow window and 200% zoom. Sign in and select the authorized
GitHub installation explicitly; authenticate each chosen agent explicitly. Record daemon and bind-mount errors
truthfully. If file sharing is needed, the user decides whether to grant it in Docker Desktop.

Verify actual image pulls, startup, protected health, stable public identity across relaunch, local profile registration,
and normal browser pairing/instance identity confirmation. On Apple Silicon, additionally run the selected AMD64 agent
under Docker Desktop emulation and record its real authentication/validation result. Never copy provider credentials,
infer success from a discovered installation, or treat a healthy HTTP endpoint alone as pairing proof.

Cancel and retry during provisioning; interrupt/relaunch and verify recovery without duplicate execution. Check that
existing Docker container/network identities and existing desktop profiles are unchanged. Retain the isolated runtime
for review; do not perform destructive cleanup. Full proof remains unverified until these native actions succeed.
