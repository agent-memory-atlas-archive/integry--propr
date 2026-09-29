# API latency diagnostics

`PROPR_API_TIMING_SAMPLE_RATE` enables privacy-safe request attribution for a
fraction of API requests. It accepts a value from `0` to `1` and defaults to
`0` (disabled). A short diagnostic window can use `0.01`; use `1` only for a
bounded, low-traffic investigation.

Each `[api-performance]` record contains the static Express route template,
status, total time, shared middleware time, an event-loop scheduling probe and
aggregate stage durations. Relevant stages distinguish authentication,
authorization, bearer-cache access, GitHub fallback, session grant sync,
agent-health work, queue work and named SQL operations. Records never include
the request URL or query string, headers, credentials, bodies, SQL, or SQL
parameters. At most 24 stage names are retained per request.

## Issue #2355 measurements

The production baseline supplied with the issue is 18 sequential authenticated
GETs over three rounds. Its medians were 2,578–3,769 ms, including 2,584 ms for
the 11-byte generating-plan response; a same-credential loopback read was
2,085 ms. These values are the deployment baseline, not reproduced locally.

The focused regression fixtures record these before/after work counts:

| Fixture | Before | After |
| --- | ---: | ---: |
| 12 simultaneous expired-cache status reads, one configured agent | 12 health probes | 1 health probe |
| Task-list count presentation enrichments | 3 full-history enrichments | 0 enrichments |

The status result retains the existing five-second freshness window; concurrent
misses now share one in-flight snapshot, and the window begins when that
snapshot completes. The task page still performs its processing/completion and
critique enrichments; only the logically independent count avoids repeating
them. These are labeled fixtures and are not claims about production latency.
A deployment comparison should repeat the issue's exact credential, endpoints,
parameters, ordering and three-round method, with a temporary bounded timing
sample enabled to attribute any remaining delay.

## Issue #2390 bounded-fresh status

The follow-up production trace showed that a five-second single-flight cache
still made every consumer in an expired-cache burst wait for registry lifecycle
work and serial groups of agent probes. Status no longer calls
`AgentRegistry.ensureInitialized()`: that execution-lifecycle method can inspect
or prepare Docker images and does not belong on a diagnostic read path. Direct,
synthetic, and legacy probes now run together, as do Redis status reads, indexing,
summarization warnings, and agent health. Configuration, indexing, and warning
reads have a 250 ms diagnostic deadline; a timeout projects their existing
failure value (`unknown`, `disconnected`, or no warnings) and a later refresh
can recover.

Agent, indexing, and warning measurements use a five-second fresh window and a
30-second hard age. A stale read returns the last measured result while one
background refresh runs; after the hard age, a reader waits for that bounded
probe result instead of extending stale data indefinitely. Agent configuration
events clear the agent measurement immediately. Cache generations ensure a
refresh begun before invalidation cannot overwrite or be joined by the new
configuration identity.

Focused fixture evidence:

| Fixture | Work / latency assertion |
| --- | --- |
| 12 simultaneous stale-cache consumers | 1 refresh probe; all 12 return the prior measured status without waiting for its gate |
| Never-resolving health check | 0 registry initializations; disconnected result at the configured 25 ms probe timeout (asserted 10–200 ms locally) |
| Hard-expired cache with refresh in flight | 1 refresh probe; reader joins it and receives its 40 ms timeout result (asserted 10–200 ms locally) |
| Direct + synthetic health, direct + synthetic config, indexing, warnings | all 6 fixture operations start before the shared gate is released |
| Configuration invalidated during an old refresh | new identity is returned immediately; the late old generation cannot replace it |
| Persisted config newer than the live registry | old runtime receives 0 probes and the new identity is reported disconnected until registry synchronization |
| Unavailable direct-agent configuration read | returns `agents: []` and `claudeAuth: unknown` at the 25 ms fixture deadline |

These timings are deterministic fixture bounds, not production latency claims.
Promise timeouts cannot interrupt synchronous event-loop stalls, and the first
or hard-expired read can still wait for up to the 250 ms configuration deadline
plus the configured 1.5-second health-probe bound. Root must validate actual
latency and contention after deployment.

## Issue #2376 active-update contention

The remaining capture had several unrelated, lightweight reads begin together
and finish together after roughly four seconds. The task-update subscriber also
started optional notification persistence on the API thread. The shared SQLite
configuration gives `better-sqlite3` a 30-second `busy_timeout`; because its
busy handler is synchronous, a background notification write racing a writer
in another process could stop the event loop even though WAL readers themselves
were available.

Notification projection and Web Push dispatch now use a dedicated connection
with `busy_timeout=0`. Projection contention is retried with asynchronous
backoff for the same bounded interval, so durable ordering/deduplication remains
in the projection layer while foreground requests keep using uncached,
user-scoped reads. The regression fixture holds SQLite's writer lock and checks
that an event-loop turn and two account-scoped reads complete before the
background write succeeds; it then verifies that a later foreground mutation is
visible rather than served from a cache.

The task analysis endpoint was intentionally left unchanged. A `404` means no
`llm_executions` row exists for that task; this is an expected first-visit state
before an execution is recorded, while a recorded execution whose analysis is
not ready returns `202`. Converting every missing execution to a success response
would also hide genuinely absent execution data.

The repeated task-list and repository-stat calls in the capture were separated
by a later live task event. The first pair is the Tasks-page mount snapshot and
the second pair is its freshness invalidation, rather than two overlapping
mount requests. Existing burst coalescing and reconnect recovery remain intact.

## September 29 staging read investigation

Authenticated sequential HTTPS measurements (three rounds) found warmed task
list/search reads around 200–235 ms, but `/api/dashboard/outcomes` took
3.08–4.09 seconds. A headless Chromium dashboard load also showed unrelated
reads completing together around seven seconds; both the outcomes feed and
narrative collect the completion projection on the API's synchronous SQLite
connection. The staging snapshot contains 14,436 tasks and 65,782 history rows,
with `task_history_task_id_timestamp_index` already present.

The completion projection now keeps task job/result JSON out of its entity
window sorts and retrieves those payloads after ranking. Against the same
read-only staging snapshot, the first paired 50-entity measurement fell from
2,374 ms to 1,080 ms; repository-scoped reads fell from 1,083 ms to 834 ms.
Returned objects were compared with deep equality, including every earlier
update. These are local query measurements, not deployed API timings.

Reproduce the current query against an offline snapshot with:

```sh
node --import tsx scripts/benchmark-dashboard-outcomes.ts --database=/path/to/snapshot.sqlite
```

Optional `--repository=owner/repo` and `--search=text` exercise filtered reads.
The benchmark opens SQLite read-only and prints only timings and row counts.

A second change shares the ranking between selected parents and earlier
updates, and searches compact parent titles once instead of repeating the
projection for each 500 candidates. Paired snapshot reads then measured:

| Read (50-entity limit) | Original | Optimized |
| --- | ---: | ---: |
| All repositories | 1,662 ms | 689 ms |
| `integry/propr` | 1,187 ms | 511 ms |
| Title search `dashboard` | 4,784 ms | 974 ms |
| No-match title search | 4,008 ms | 438 ms |

All four results matched the original projection by deep equality. The search
regression also places a Unicode title behind 505 unrelated parents and checks
that search uses two rankings regardless of candidate pages; an unfiltered read
uses one ranking for both parents and earlier updates.
