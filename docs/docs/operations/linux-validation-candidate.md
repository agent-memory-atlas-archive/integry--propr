# Validation only: combined Linux candidate (#2980)

Draft staging/review candidate, targeting `main`. This is not release qualification,
publication approval, or a replacement for the original feature PRs. No original
issue should be closed by this candidate.

## Reconciliation addendum — 2026-10-11

This follow-up started at `b430f376d64521bcfa71447cb59058ea1eb9e03f`,
reconciled with main `a064a22c8d4110e0cec6f5f149344d408488362f`.
The original `e44c573…` base, 53-path reconstruction, byte comparisons, hashes,
and initial pending results below are retained history, not current qualification.
No new main reconciliation or nightly dispatch was performed in this follow-up.

The supplied operator history records these intervening revisions; these are
reported prior-source results, not measurements made by this run:

| Revision | Reconciliation / evidence boundary |
| --- | --- |
| `624eea7` | Original combined candidate; reported gram and CI-native 67 captures, eight smoke launches, and matching Electron/app.asar bytes apply here |
| `dcddbc1` | Managed headless-shell menu fixture correction only; packaged byte equality was expected, but fresh binary/app.asar hashes at this revision are not available here |
| `4080a7e` | Reviewed dispatch-owner child launch repair from #2953; historical live nightly `38110213760` failed, with cause still unknown |
| `60204b6` | F1 capture recipe uses supported default output, then copies verified artifacts |
| `6ed1c69` | Reconciled main `598574f4c54a5addd9ab236ea349e2edc39fb1f2`, including aggregate cancellation guard and three CI regression files |
| `f4233f5` / `cf814a4` | F2 listener capability authentication and main `7e63393` incorporation, followed by actual ancestry reconciliation; reported cf814 full-suite and gram results remain prior-source evidence |
| `b430f376` | Reconciled main `a064a22c`; operator reports 14 main paths across both #2983 and #2986, not just the latest merge's five paths |

F2 is already present: a fresh random 32-byte daemon capability is checked before
caller environment/path interpretation or filesystem access, and authenticated
clients reside in private workspaces. This run rechecked all fixture client
callers and retained the missing/empty/wrong-capability sentinel, state, mode,
non-disclosure, and authenticated-cleanup regressions. The stray
`.propr/validation-f2/final-paths.txt` operator report is removed.

Selected follow-ups add the missing coordinator crash phases (including verified
sibling omissions), early-review success, minimum first-attempt budget, bounded
sequential/model polling and requests, cancellable recovery plan creation, a
non-claiming Redis dedupe pre-check, empty-log handling, and the acceptance bridge
type. Redis NX remains authoritative for concurrent deliveries; cancellation
provenance still precedes any new claim. The E2E request scopes check cancellation
on both sides of awaited requests and revoke further calls when closed. They
cannot atomically cancel mutations already accepted by an external API; cleanup
keeps its separate client and budget.

The renderer fixture now records its actual browser path/version. Hosted workflow
and `.propr/setup.sh` install commands use `playwright install chromium` without
`--no-shell`; the managed launch requires the headless shell and fails loudly if
it is absent. The original 30-second Back-click timeout and reported concurrent
stress crash remain unexplained. This fixture change is not a root-cause claim.

The main zoom authorization listener uses `on`, not a one-shot listener; the local
regression checks repeated attestation for the same webContents. That is not a
native reload test. At the next exact-head gram run, explicitly verify repeat
preload attestation after each reload, Electron zoom persistence, all five
Continue stages with the default draft, and the cancelled heading **Setup needs
attention**. The first native run of these paths is a test, not confirmation of
unit-proven behavior. Require the existing strict 67-capture gate, eight ordinary
plus captured smoke launches, and setup-lifecycle report with `verified`.

### Evidence from this follow-up

Local results describe `b430f376` plus this working-tree correction only. The final
candidate SHA is assigned after this work; no local result is represented as
final-head CI or release qualification. No packaged executable or `app.asar` is
available in this checkout, so neither historical `dcddbc1` re-hashing nor current
native byte comparison was performed. Rebuild/hash at the final candidate using
the recipe below, recording source/tree, lock and both artifact hashes together.
The crash-phase change now affects packaged source, so old package hashes cannot
qualify this correction.

Canonical discovery was run anew with `node scripts/run-test-suite.mjs --list`:
**803 unique units**, no duplicate identifiers. SHA-256 of sorted
`kind:id` identifiers, newline terminated:
`aa33ef76e595c4a3cac72c2581dfe1bed381fe336d3f0f85592041439bb32cd5`.
This is discovery, not full-suite execution. Final-head CI must record its own
manifest and prove every unit completed exactly once; prior 800/802-unit results
must not be substituted.

Focused checks on this correction tree:

| Check | Result |
| --- | --- |
| Plan generation, implementation deadline, CI follow-up, shutdown phases, zoom authorization | 80 tests passed; no skips |
| Three fake-Docker integration harness files | 24 tests passed; no skips |
| Managed headless-shell menu fixture | 1 test passed; Chromium `151.0.7922.34`; no retry |
| Four affected renderer fixture files | 32 tests passed; UI import-boundary checks also passed |
| Desktop and UI typechecks; targeted E2E TypeScript check | Passed |
| CI follow-up ESLint; documentation build; `git diff --check` | Passed |
| Native package hashes, ordinary/captured Electron smoke, strict 67 captures, verified setup lifecycle, full final-head CI | Not run here; remain exact-head gates |

The first focused invocation omitted test/demo configuration and could not load
GitHub auth for the CI follow-up test. Its shutdown assertions also exposed the
three sibling phase omissions now fixed. The initial UI typecheck identified the
five stale bridge mocks now corrected; the targeted E2E typecheck identified test
annotations now corrected. Subsequent focused checks above passed. No credentials
or environment setup policy was changed to obtain these results.

Keep further live-nightly dispatch paused until serving API evidence explains the
historical failure. Dependent early returns do not demonstrate successful model
implementation. Runtime binding, first-user installation/pairing/task behavior,
the three repository actor boundaries, and separate Mac GUI qualification remain
outside demonstrated results. Browser fixture results never replace native
Electron coverage. The clean final-SHA recipe and all existing qualification
boundaries below still apply.

### Separate observation outside the selected corrections

The main E2E cleanup in `test/e2e.test.ts` logs a plan-work settlement timeout and
then continues deleting known plans. If a request remains pending beyond that
wait, cleanup can overlap it. This existing behavior is unchanged; the recovery
call updated for S17 instead defers cleanup when its new tracker cannot settle.

## Original preparation scope (historical)

Original preparation base: `e44c57330e7a02628bc9206724d07470354fb61a`. Remote `main` matched this
revision when preparation began and on the preparation recheck. Recheck it at handoff; a changed main requires
explicit reconciliation and new evidence, not a silent rebase.

| PR | Incorporated head | Proper merge base with the candidate base |
| --- | --- | --- |
| #2953 | `c0e93ec8e686a2bdb9b929a65abaadfdeb4388b0` | `b37781b52538b962c381c556a5602c56e03239a9` |
| #2967 | `efa6cff104596f72e4319f3b2cb8e313a8a0958b` | `482a2bcc646168a9bd74c2cf516fa3352950e5fe` |
| #2974 | `d0a83f0fc1c5a848753aa53df9a86fb508676ec7` | `482a2bcc646168a9bd74c2cf516fa3352950e5fe` |
| #2975 | `16dad7e8ddcaf5969ba30e996a314c9f220913e0` | `650313ecfc59776b813c16984c9adf51ead542e0` |

Each delta was taken against its proper merge base, then applied to the exact
current main tree. Only `docs/docs/features/pr-followup.md` needed a three-way
reconciliation: the cancellation explanation was added while retaining current
main's assignment documentation. No production or test conflict required a
behavior change. All other incorporated files equal their respective requested
head, including the complete split fake-Docker harness. Unrelated ancestry was
not imported. Current-main integration script ownership/cleanup safeguards remain
unchanged.

The candidate includes cancellation/deadline propagation, fail-closed CI
cancellation provenance, hosted-flow cold-transform setup, owned-profile cleanup
that retains primary smoke errors, the production LocalSetupWizard with authorized
data-only fixtures and normal keyboard actions, and Electron 44.7.0 with opt-in
private Linux crash diagnostics. No assertion, fuse, sandbox, authorization,
timeout, or cleanup ownership boundary was relaxed to integrate them.

## Original evidence status and retained failures (historical)

Local implementation checks are recorded below. They do not transfer the four
PRs' review scores, CI passes, native captures, or nightly results to this combined
source. Final committed-head CI, independent review, and native acceptance remain
pending until actual results are bound to that head.

Retain the reported prior #2953 `0a` nightly `38100904672`: **794/795 nonlive,
live E2E skipped**. The issue reported newer nightly `38105782983` and current PR
CI as running; no final result is claimed here. Retain the original frozen
`fd4960f901a589151bc226befd95305d558aa110` package and intermittent shutdown
SIGSEGV evidence. The Electron update does not prove its cause; #2973 remains
open. The earlier failures recorded in [the shutdown investigation](./desktop-native-shutdown-investigation.md)
remain part of the record.

## Reproduce on gram: native Linux x64

Use an isolated clean checkout of the final candidate commit, with the qualified
ordinary-user X11/Secret Service synthetic-fixture session already available.
Do not change keyrings, credentials, permissions, sandbox policy, host libraries,
or grants to make a run pass. Run each command once initially; retain its exit,
signal and full log, including failures. Any additional diagnostic attempts must
have a declared count and retain every outcome. Commands below build local files
only; they do not publish or write image tags.

From the repository root, replace the placeholder with the final orchestration
commit (not one of the four input heads):

```sh
set -euo pipefail
candidate_sha=<full-final-candidate-commit>
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain --untracked-files=normal)"
evidence_dir=$(mktemp -d /tmp/propr-2980-evidence-XXXXXXXX)
printf '%s\n' "$candidate_sha" > "$evidence_dir/source.txt"
node --version > "$evidence_dir/build-node.txt"
uname -a > "$evidence_dir/kernel.txt"
cat /etc/os-release > "$evidence_dir/os-release.txt"
sha256sum package-lock.json > "$evidence_dir/lock.sha256"
npm ci 2>&1 | tee "$evidence_dir/install.log"
npm run test:prepare 2>&1 | tee "$evidence_dir/prepare.log"
npm run build 2>&1 | tee "$evidence_dir/build.log"
npm run desktop:typecheck 2>&1 | tee "$evidence_dir/types.log"
npm run desktop:test 2>&1 | tee "$evidence_dir/desktop-tests.log"
npm run desktop:package 2>&1 | tee "$evidence_dir/package.log"
npm run desktop:smoke:inspect 2>&1 | tee "$evidence_dir/inspect.log"
sha256sum apps/desktop/out/propr-desktop-linux-x64/propr-desktop \
  apps/desktop/out/propr-desktop-linux-x64/resources/app.asar \
  > "$evidence_dir/package.sha256"
npm run desktop:smoke 2>&1 | tee "$evidence_dir/smoke-ordinary.log"
crash_evidence_dir=$(mktemp -d /tmp/propr-2980-crashes-XXXXXXXX)
PROPR_DESKTOP_NATIVE_CRASH_DIRECTORY="$crash_evidence_dir" \
  npm run desktop:smoke 2>&1 | tee "$evidence_dir/smoke-capture.log"
env -u PROPR_DESKTOP_ACCEPTANCE_OUTPUT \
  npm run desktop:acceptance 2>&1 | tee "$evidence_dir/visual.log"
env -u PROPR_DESKTOP_ACCEPTANCE_OUTPUT \
  npm run desktop:acceptance:verify 2>&1 | tee "$evidence_dir/visual-verify.log"
cp -a desktop-acceptance-artifacts "$evidence_dir/visual"
PROPR_DESKTOP_REAL_LINUX_SETUP_ACCEPTANCE=1 \
PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA="$candidate_sha" \
PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT="$evidence_dir/linux-setup-lifecycle.json" \
  npm run desktop:acceptance:setup-linux 2>&1 | tee "$evidence_dir/setup-lifecycle.log"
sha256sum -c "$evidence_dir/package.sha256"
```

Capture and verification both use the supported default
`<repository-root>/desktop-acceptance-artifacts`, with any inherited
`PROPR_DESKTOP_ACCEPTANCE_OUTPUT` override unset for each command. Only after
verification succeeds is that directory copied into the owned evidence directory;
the copy is optional. Do not use the evidence directory as the capture output:
artifact cleanup requires the dedicated basename and an allowlisted canonical
parent, and rejects symlinks.

Stop on failure and retain the result; subsequent independent checks can be run
separately with that failure still recorded. The complete smoke is four isolated
launches per invocation, with all existing credential scans, shutdown, connection,
fuse and sandbox checks. The visual verifier must accept **67 captures**, production
`LocalSetupWizard` presentation, zero serious/critical findings, and all **seven
200% zoom keyboard actions**: Continue, Cancel safely, Back, Review saved choices,
Restart with aligned runtime, Retry setup, Connect securely. Inspect original
captures as well as machine reports. Browser-only preview evidence cannot satisfy
this gate. The separate setup report must say `verified`, with bounded cancellation,
fresh retry, interrupted relaunch and owned cleanup; exit zero with `unverified`
means the lifecycle is still pending. This bounded harness stops before actual
provisioning or GitHub enrollment.

Record source/tree and lock hashes, harness source, binary and app.asar hashes,
architecture, actual Electron/Chromium/embedded Node versions from each diagnostic
`runtime.json`, installed libc/libsecret/GLib versions and relevant ELF build IDs.
Electron must actually be 44.7.0; build-time Node is a separate value. Keep raw
crash dumps private and outside preview/public artifact roots. Follow the
[upstream fixture procedure](./desktop-native-shutdown-investigation.md#regression-provenance-and-remaining-acceptance)
for unchanged official fixture bytes and all three upstream success assertions.

Packaging without an explicit source-bound runtime manifest embeds the checked-in
launcher metadata: record it as **unbound**, even if the app and harness match the
candidate. Do not count that as current-source full setup/task qualification.
If an already-approved runtime manifest is supplied separately, verify its source
revision, API compatibility, architecture, and immutable app/UI/agent digests before
passing `PROPR_DESKTOP_RUNTIME_MANIFEST` to packaging; record its hash and the
packaged manifest. Never borrow another PR's/frozen preview's binding or stamp the
candidate SHA onto old images. New image/tag writes and runtime publication require
a separate decision and are outside this staging task.

## Remaining qualification

Integration CI and independent review on the final head, actual native Linux
acceptance, mobile/usability checks, actual live E2E, first-user sign-in/pairing/task,
and proof of all three existing-repository access boundaries remain pending.
The frozen preview and all publication decisions stay unchanged. Existing docs
risk acceptance and runtime exception expiry are unchanged. #2976 macOS guided
setup stays on its separate qualification branch; human Safe Storage approval and
real GUI lifecycle remain pending, not excluded or implicitly complete. No
user-owned server cleanup, TTL, or repository inventory work is included.

## Original local validation (historical)

Implementation workspace: Linux x64, build Node 22.23.3. Evidence applies to the
exact base plus the incorporated working-tree delta, not a future final commit.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; audit reported 8 high advisories; no dependency remediation or risk-acceptance change made |
| `npm run test:prepare`, `npm run build`, API build, UI build | Passed |
| `npm run desktop:typecheck` (desktop and UI) | Passed |
| Root, UI, CLI, API lint with `--max-warnings 0`; changed core source lint | Passed |
| OpenAPI generation check and client contract | Passed (261 routes; 11 client operations) |
| Planning, cancellation provenance, planner failure classification, API route coverage | 96/96 passed |
| Hosted-flow, production wizard and desktop entry/recovery/connect UI | 92/92 passed in 5 files, CI two-worker configuration |
| Fake-Docker harness, unsafe targets and network ownership | 23/23 passed, no skips |
| `npm run desktop:test` | 1,092 tests: 1,054 passed, 38 skipped, zero failed/cancelled (140.6s); skips include native/display and opt-in platform coverage, not qualification |
| Linux x64 `desktop:package` and `desktop:smoke:inspect` | Passed; packaged version 44.7.0, executable/fuse inspection passed |
| Full native smoke, 67-capture gate, seven 200% actions, bounded real setup lifecycle | Not run here; qualified gram session required |

The initial broader `node --test apps/desktop/scripts/*.test.mjs` invocation
produced 546 passes, 2 failures, 35 skips. Both failures were module-resolution
errors for the extensionless TypeScript import `src/account-response` in
`packaged-acceptance-account.test.mjs` and `packaged-connect-journey.test.mjs`.
That invocation omitted the repository's required `tsx` runner. The original
failed invocation is retained; the prescribed `desktop:test` run is reported
separately, with no fixture or assertion edits.

Reproduce the focused checks from the repository root after `test:prepare`:

```sh
NODE_ENV=test npx tsx --experimental-test-module-mocks --test \
  test/e2ePlanGeneration.test.ts test/e2eTaskCompletion.test.ts \
  test/ciFailureFollowup.test.ts packages/api/test/plannerBackgroundLifecycle.test.ts \
  packages/api/test/openapiRouteCoverage.test.ts
node --test test/integrationImageHarness*.test.mjs
CI=1 npm exec -w propr-ui -- vitest run src/App.hostedFlow.test.tsx \
  src/desktop/LocalSetupWizard.integration.test.tsx \
  src/desktop/DesktopExperience.test.tsx \
  src/desktop/DesktopExperience.recovery.test.tsx \
  src/desktop/DesktopExperience.connect-prefill.test.tsx
npm run lint -- --max-warnings 0
npm run lint -w propr-ui -- --max-warnings 0
npm run lint -w @propr/cli -- --max-warnings 0
npm run lint -w @propr/api -- --max-warnings 0
npm exec -w @propr/core -- eslint src/webhook/ciCancellationProvenance.ts \
  src/webhook/ciFailureFollowup.ts --max-warnings 0
npm run gen:openapi:check
npm run check:client-contract
```

At initial preparation, byte comparison verified 52 incorporated paths (including deletions) exactly
match their requested heads; the 53rd is the reconciled PR-follow-up documentation.
The real image integration script/root helper, Forge security configuration and
bounded Linux setup lifecycle harness remain byte-identical to base. `git diff
--check` passed. Two Chromium previews render the real production wizard with the
imported acceptance data fixture, covering progress contrast and recovery button
wrapping. They are supplemental browser evidence, not the native acceptance gate.

Local artifact SHA-256 values (not final-head native qualification):

- Lockfile: `6595f11797cad0660146317e3f7fe7bfd0ebcd8cfb095ca53c5458fe670c6108`
- Electron executable: `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`
- `app.asar`: `4d5f90751ace06e174cffe127cfd4711f8a1b5877cb1f84b6ca15cf77eba27d9`

Full local logs are retained under `/tmp/propr-2980/` for this workspace session.
These transient logs are not a substitute for durable final-head CI artifacts.

## Changed paths against reconciled main

Current correction tree versus `a064a22c`: 61 paths. Regenerate with
`git diff --name-only a064a22c8d4110e0cec6f5f149344d408488362f <final-candidate-sha>`
at final handoff; this supersedes the original preparation path list.

```text
.github/workflows/test-nightly.yml
apps/desktop/README.md
apps/desktop/package.json
apps/desktop/scripts/acceptance-artifacts.mjs
apps/desktop/scripts/acceptance-artifacts.test.mjs
apps/desktop/scripts/desktop-native-menu.test.mjs
apps/desktop/scripts/native-shutdown-diagnostics.test.mjs
apps/desktop/scripts/packaged-acceptance-setup.mjs
apps/desktop/scripts/packaged-acceptance-setup.test.mjs
apps/desktop/scripts/packaged-smoke-plan.mjs
apps/desktop/scripts/packaged-smoke-support.mjs
apps/desktop/scripts/packaged-smoke-support.test.mjs
apps/desktop/scripts/run-packaged-acceptance.mjs
apps/desktop/scripts/smoke-packaged.mjs
apps/desktop/src/acceptance-setup.test.ts
apps/desktop/src/acceptance-setup.ts
apps/desktop/src/acceptance-zoom.test.ts
apps/desktop/src/credential-service.ts
apps/desktop/src/main.ts
apps/desktop/src/native-shutdown-diagnostics.test.ts
apps/desktop/src/native-shutdown-diagnostics.ts
apps/desktop/src/preload.ts
docs/docs/features/pr-followup.md
docs/docs/operations/desktop-native-shutdown-investigation.md
docs/docs/operations/linux-validation-candidate.md
docs/static/openapi/propr-api.yaml
package-lock.json
packages/api/openapi/buildSpec.ts
packages/api/openapi/directRoutes.ts
packages/api/openapi/types.ts
packages/api/routes/plannerHelpers/utils.ts
packages/api/test/openapiRouteCoverage.test.ts
packages/api/test/plannerBackgroundLifecycle.test.ts
packages/cli/src/api/plans.ts
packages/core/src/webhook/ciCancellationProvenance.ts
packages/core/src/webhook/ciFailureFollowup.ts
packages/core/test/taskSubmissionService.test.ts
propr-ui/src/App.hostedFlow.test.tsx
propr-ui/src/api/currentUserResponse.test.ts
propr-ui/src/desktop/DesktopExperience.tsx
propr-ui/src/desktop/LocalSetupWizard.integration.test.tsx
propr-ui/src/desktop/PackagedAcceptanceLocalSetup.test.tsx
propr-ui/src/desktop/PackagedAcceptanceLocalSetup.tsx
propr-ui/src/desktop/desktop.css
propr-ui/src/desktop/desktopExperienceState.ts
propr-ui/src/desktop/packagedAcceptanceLocalSetupSurface.ts
propr-ui/src/desktop/packagedAcceptanceRendererLifecycle.test.ts
propr-ui/src/hooks/useCurrentUserBootstrap.mainProxy.test.tsx
propr-ui/src/vite-env.d.ts
test/ciFailureFollowup.test.ts
test/e2e.test.ts
test/e2e/helpers.ts
test/e2e/planGeneration.ts
test/e2e/recovery.test.ts
test/e2ePlanGeneration.test.ts
test/e2eTaskCompletion.test.ts
test/fixtures/integration-image-harness/fake-docker.mjs
test/fixtures/integration-image-harness/harness.mjs
test/integrationImageHarness.test.mjs
test/integrationImageHarnessNetworkOwnership.test.mjs
test/integrationImageHarnessUnsafeTargets.test.mjs
```
