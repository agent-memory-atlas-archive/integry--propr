# PR #3361 description: delivery_interest.v1

Copy everything below the line into the PR #3361 description. It lives here because the goal agent's token cannot edit or comment on the PR.

---

## Summary

Implements the client side of `delivery_interest.v1` (contract: integry/propr-routing#294). Closes #3360.

- The routing `hello` now advertises `delivery_interest.v1` and carries an `interest` declaration. The heartbeat hello repeats the declaration already made and counts toward the 5 s spacing.
- A changed declaration is sent as `{ "type": "interest", "interest": … }`, at most once per 5 s, with only the latest state. Nothing is sent when the declaration is unchanged, or when a change is undone within the window. A reconnect declares the current state in its hello and drops any pending frame.
- The daemon re-derives the declaration after every config reload (the 5-minute interval and Redis config events). The routing service is assigned when it's created, so reloads during startup reach it.
- If the declaration can't be built, the client declares every supported event unfiltered with repositories `"*"`. With a custom `dispatch` (not the shared webhook handler), no interest is declared at all.
- **Backward compatible:** the field and frame are additive. A relay that ignores them keeps forwarding everything, and no existing frame changes shape.

### Single source of truth

- `packages/core/src/webhook/webhookEventGates.ts` holds the predicates and constants the handlers now use. They are typed against `@octokit/webhooks-types` where GitHub defines an enum.
- `packages/core/src/intake/routingDeliveryInterest.ts` (`eventRules`, `buildDeliveryInterest`) builds the declaration from those same gates.
- `eventRules` is typed `Record<SupportedEvent, …>`, so adding an event to `SUPPORTED_WEBHOOK_EVENTS` fails to compile until the event is declared.
- Repositories come from the repository filter itself. `monitoredRepositoryFilter` (`packages/core/src/daemon/configLoader.ts:46`) is both the filter and the list it accepts, normalized by the same function `isMonitoredRepository` uses. An opaque filter function, or no filter, declares `"*"`.

## Declared filters and why each is safe

I checked every path through `processWebhookEvent`: intent withdrawal and merged-PR handling, Ultrafix label removal, plan tracking, the CI handlers, epic/auto-merge/closed-PR CI handling, conflict detection, standard processing, plan-comment activity, and the injected check-run processor. Notifications (`planIssueTracking.ts` → `notificationService`) are only reached from `pull_request` and comment events, which are unfiltered. The routing intake's only consumer of relay deliveries is `processWebhookEvent`.

| Event | Filter | Proof |
| --- | --- | --- |
| all | `repositories`: lowercased monitored repositories | `packages/core/src/webhook/webhookHandler.ts:418`: an unmonitored repository returns `repository_not_monitored` before any other handler runs. The list comes from the same `monitoredRepos` and normalization as `isMonitoredRepository` (`packages/core/src/daemon/configLoader.ts:35,46`). A delivery without a repository is forwarded by the relay (fail-open). |
| `check_run` | `actions: ["completed"]` | `packages/core/src/webhook/checkRunHandler.ts:320` (`handleCheckRunEvent`) and `packages/core/src/webhook/ciFailureFollowup.ts:87` (`extractCheckRunFailure`) both gate on `isActedCheckRunAction`. The Ultrafix hook is reached only when a run completes green. The injected `checkRunProcessor` (`webhookHandler.ts:338`) receives every action, so the filter is left out whenever one is registered (`getWebhookDeliveryInterest`, `webhookHandler.ts:118`). Neither the daemon nor the API registers one today. |
| `check_suite` | `actions: ["completed"]`, `conclusions: ["success","neutral","skipped"]` | `checkRunHandler.ts:430,432` is the only consumer. `webhookHandler.ts:342` is an accepted no-op. |
| `status` | `states: ["success","failure","error"]` (everything except `pending`) | `checkRunHandler.ts:467` (success → Ultrafix hook) and `ciFailureFollowup.ts:108` (`isFailureStatusState` → follow-up). `pending` returns before any I/O. `webhookHandler.ts:348` is an accepted no-op. |
| `push` | `refPrefixes: ["refs/heads/"]`, `excludeDeleted: true` | `packages/core/src/webhook/mergeConflictDetector.ts:146` (`isBranchUpdatePush`) is the only consumer. `webhookHandler.ts:345` is an accepted no-op. The relay drops only when `deleted === true`, while the client already ignores any truthy value. |
| unsupported event types | not listed | `packages/core/src/intake/RoutingWebSocketIntakeService.ts:432` already ACKs them `ignored: unsupported_event` before dispatch. |

### Omitted filters

- **`issues`, `issue_comment`, `pull_request`, `pull_request_review_comment`: no action filter.** Many handlers read their actions: intent withdrawal (`closed`, `unlabeled`), Ultrafix label removal (`unlabeled`), plan tracking (any), epic/merge handling, closed-PR CI cancellation, auto-merge policy, notifications, and comment created/edited/deleted. I couldn't prove a narrower list safe, so these four events are unfiltered.
- **`check_run` conclusions:** not declared. Failing and green conclusions both lead to work.
- **Push salvage rescue refs** (`refs/heads/propr/rescue/…`) are ignored by the client but stay forwarded. A prefix list can't exclude them inside `refs/heads/`.

### Assumptions to note

- **Status case:** `extractStatusFailure` lowercases `state` defensively, but the relay matches listed strings exactly. GitHub's `status` webhook `state` enum is lowercase-only (`"pending" | "success" | "failure" | "error"` in `@octokit/webhooks-types`), and `STATUS_FAILURE_STATES` is typed `satisfies readonly StatusEvent['state'][]`. So the declaration excludes nothing GitHub can actually send.
- **New repositories:** the 5 s spacing comes from the relay contract, so a newly added repository can take up to about 5 s (plus the config reload) before the relay forwards its deliveries. This is documented.

## Size fallback

`buildDeliveryInterest` deduplicates and sorts the repositories (so the serialization is stable) and declares `"*"` when there are more than 1000 repositories, or when the larger of the serialized `hello` and `interest` frames would exceed 48 KiB.

## Tests

- `test/deliveryInterestHandlerGuard.test.ts` runs every combination of check_run/check_suite actions × conclusions, status states, and push refs × `deleted` through the **real** `processWebhookEvent`. Its reference matcher reads the contract aggressively (a `null` conclusion counts as unlisted). For each of the 65 excluded deliveries it asserts nothing was touched: no GitHub call, Redis, merge-conflict settings, processor or Ultrafix hook. A positive control shows the probe does detect work, and the test also covers unmonitored repositories across all event types and a registered check-run processor. Negative-checked: loosening the check_run gate or the push gate makes it fail.
- `test/routingDeliveryInterest.test.ts` covers the frame shape, contract limits (≤32 events, ≤64 entries, ≤128 chars), the 1000-entry and 48 KiB fallbacks with a boundary search, the hello capability and heartbeat spacing, the custom-dispatch case (hello unchanged, no frames), resend only on change, debounce coalescing and revert, reconnect, and the fallback when the declaration can't be built.
- Both suites are in `test:unit`. Root, core and api typecheck and zero-warning lint are clean, and all CI checks on the PR pass.
- Three core files were at the 400-line lint limit, so the payload guards moved to `webhookPayloadGuards.ts` and token-frame caching moved to `routingTokenFrame.ts`, with no behavior change.

## Docs

`docs/docs/operations/propr-connect.md` gains a "Delivery Interest" section: the filter table, the fallbacks, the fact that monitored repository names are visible to the relay (user allow lists never are), the added-repository delay, and that dropped deliveries don't update the last delivery ID / last ACK time. `docs/docs/architecture/daemon.md` links to it.

No visual previews: nothing in the UI changed.
