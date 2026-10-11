---
sidebar_position: 5
---

# Physical agent-run admission

Hosted Fleet admits at most Solo **2**, Team **6**, or Scale **12** simultaneous container-backed agent executions per instance. Admission happens below logical tasks, at `executeDockerCommand` and the native-session `spawnWithNetworkPolicy` wrapper. Multiple worker processes, API requests and indexing workers share the same Redis capacity.

## Configuration and dependency on #2989

The existing server-side Hosted activation boundary is `PROPR_FLEET_CONTROL_SECRET` (see `packages/api/routes/hostedFleetRoutes.ts`). Its presence enables mandatory admission; a malformed secret does not bypass the limit. Every execution process must receive the same operator-provisioned `PROPR_INSTANCE_ID`, `WORKER_CONCURRENCY` (2/6/12), Fleet activation environment and Redis endpoint. Neither the persisted `worker_concurrency` UI setting nor `CONFIG_REPO` can raise this entitlement. Missing/invalid Hosted entitlement or instance identity refuses execution.

Self-hosted installations retain their execution behavior unless `PROPR_AGENT_RUN_LIMIT` is explicitly set to a positive integer, with `PROPR_INSTANCE_ID`. A Hosted instance ignores this optional self-hosted override.

PR [#2989](https://github.com/integry/propr/pull/2989), following #2987, resolves **per-worker job** and repository-workflow ceilings. It was open with no submitted reviews when this implementation was prepared, and its resolver was absent from this checkout. This patch does not copy or replace that resolver. Its reviewed resolution should still be integrated through the normal workflow. It changes different implementation files; the worker-runtime documentation may need both additions retained. The physical entitlement resolver intentionally has stricter semantics: it recognizes Hosted by the existing Fleet boundary and never accepts a config-repository override. Existing repository semaphores and lower repository limits remain in place.

## Covered execution paths

| Entry point | Physical boundary |
| --- | --- |
| Main worker issues, reviews, comments, goals, agent runs/actions | Provider `executeTask` → `executeDockerCommand` |
| Planner generation and refinement | `planFileAgent` → provider `executeTask` → `executeDockerCommand` |
| API agent chat | provider `analyze` → `executeDockerCommand` |
| Indexing and relevance/retrieval analysis | provider `analyze` → `executeDockerCommand` |
| Usage-tip/background analysis | provider `analyze` → `executeDockerCommand` |
| Claude, Codex and Antigravity native goal sessions | `spawnWithNetworkPolicy` → admitted Docker start |
| Synthetic routing, fallback and retries | Each physical attempt independently crosses one of these boundaries |

There is no logical-wrapper lease to acquire twice: nested routing calls consume only the capacity for each physical execution. Sequential retries release their predecessor; parallel physical executions each need a slot. Queue jobs, waiting HTTP/UI requests and publication work are not running agents.

Excluded non-agent work: image pulls/builds/preparation, trusted runtime package metadata/catalog/simulation containers, Agent Tank usage probes, egress proxy containers, login/authentication containers and container inspection/cleanup. The package and usage probes use the existing internal `costCapExempt` classification; request/UI settings cannot supply it. Network restrictions, spend caps, task-generation labels, workflow deadlines and cancellation contexts remain applied to agent containers.

## Lifecycle and supported scope

The supported topology is multiple processes sharing **one instance ID, one Redis database and one Docker daemon**. The stored configuration includes the daemon identity and limit; a process with different configuration cannot admit or reap work. Multiple Docker hosts for one instance are deliberately unsupported: safely reclaiming an unreachable host's live executions requires an external fencing mechanism. All execution processes must run this implementation; mixed old/new workers are not an enforcement boundary.

Redis holds unique owner tokens in a persistent hash. A 30-second renewable deadline uses Redis server time; it is **not** a key TTL. Expiry changes ownership to `recovering`, but does not free capacity. Recovery removes the recorded immutable container ID, then releases that token. Docker/Redis failures retain capacity and surface errors; they never silently skip an agent call or fall back to unrestricted execution.

Execution uses Docker **create → register immutable ID → start ID**. Create does not run the agent. If recovery races with creation, the old token cannot register its ID. If registration already happened, recovery removes that ID before reuse, so a suspended process cannot later start it. Release after execution also fences the token, confirms Docker removal, then deletes the token. A stale release cannot affect another owner. Renewal loss aborts the execution and attempts container removal even when Redis is unavailable. Another admission attempt recovers dead holders; recovery is demand-driven, not a separate daemon.

Use durable Redis with **no eviction** for these records. Do not flush/delete admission state while executions or suspended launchers survive. Missing configuration with surviving labelled containers refuses initialization. Redis data loss, restoration from an older snapshot, or deliberate state edits require stopping all execution processes and draining their containers before reinitialization; asynchronous Redis failover that loses acknowledged writes is outside the supported consistency guarantee. A crash during Docker create can leave a non-running `created` container before its ID is recorded; drain such labelled artifacts during recovery if they prevent reuse of a caller's fixed container name. They cannot start without a successful token registration.

Changing entitlement or Docker daemon requires a coordinated drain: stop intake and all launchers, let/remove existing agent containers, verify no holders or in-flight creates remain, remove only the drained instance's admission `config` key, then start all processes with matching configuration. This patch performs no Fleet rollout, secret mutation, release or preview-pin change.

## Observability

`agentAdmissionMetrics(client, instanceId)` returns `waiting`, `reserved`, `running` and `recovering` separately. Waiting entries expire from the metric after 30 seconds without refresh; they do not consume capacity. `reserved` covers acquisition/create before ID registration. `running` covers registered physical executions, including their short start/exit handshake; `recovering` remains occupied until removal is confirmed. Queue-active and HTTP-request counts are not physical-running metrics. Structured logs record admission waiting and admitted snapshots with instance and immutable container ID, without credentials.

Keys use `propr:agent-admission:{sha256(instanceId)}:{holders,config,waiting}`; the common hash tag keeps script keys together. Docker containers carry `propr.agent-admission.instance=<sha256(instanceId)>` and a unique `propr.agent-admission.token` label. For live acceptance, correlate these records with Docker start/die/destroy events, not only the conservative admission counts.

## Automated validation

Run with a local Redis server binary:

```bash
PROPR_TEST_REDIS_SERVER=/path/to/redis-server NODE_ENV=test \
  node --import tsx --test test/agentRunAdmission.test.ts
```

The tests use real Redis scripts and separate Node processes through both production Docker wrappers, with a Docker lifecycle simulator. They saturate 2/6/12, prove N+1 cannot create/start, and prove one release admits one waiter. Additional cases cover renewal, waiting/running cancellation, nested logical calls, fallback, holder-process death, delayed creation, stale release, blocked physical removal, configuration/daemon conflicts and Redis loss. These are not live Docker/provider or end-to-end planner/chat acceptance tests; the following Fleet checks are still required.

## Exact live Fleet acceptance

Perform these steps only in the authorized disposable Fleet acceptance environment through its normal rollout procedure. Record the exact core commit, immutable preview image digest and running API, worker and indexing image identities. All identities must match the change under test. Do not substitute a floating release tag.

1. For each tier (2, 6, 12), verify every execution process has the matching instance ID, Fleet activation, entitled concurrency and Redis endpoint. Verify one Docker daemon and durable/no-eviction Redis. Repeat with two main workers. Persist UI `worker_concurrency` values 1 and 50 and confirm neither expands the physical entitlement. Verify the separately integrated #2989 resolution for job scheduling.
2. Submit long-running disposable main tasks across repositories until N labelled containers are running. While holding them open, trigger planner generation, planner refinement, API chat, indexing/relevance work and usage-tip analysis, one at a time and together. Record each operation/task ID, admission counters and Docker events. Every extra operation must remain waiting with no extra physical start.
3. Complete one holder. Exactly one waiting physical execution may start; all others remain waiting. Continue until every entrypoint has actually run. Repeat with native goal sessions and provider fallback/retry. Nested logical wrappers must not deadlock at N=2. Verify a repository limit of 1 still constrains that repository while another repository uses remaining capacity.
4. Cancel a waiting planner/task through its normal API, then cancel a running task and native session. Check durable cancellation state, no start for the waiting operation, removal of the running container, and capacity reuse only after its Docker exit/removal. Repeat cancellation during create/start.
5. Kill one holder's worker process without killing its container. Submit a waiter, observe the 30-second deadline, and verify the original immutable ID is removed before the replacement starts. Pause/resume a launcher around create/register/start to test stale-owner fencing. The resumed launcher must fail rather than start an old container or release a new owner's token.
6. Interrupt Redis connectivity for an active process. It must lose renewal, abort/remove its physical execution, and retain the reservation until coordination returns and recovery confirms removal. New requests must fail closed. Separately deny Docker removal: the holder stays `recovering` and no replacement starts until Docker is available. Do not simulate Redis failure by flushing its data.
7. Confirm image/runtime builds and usage probes can run while agent capacity is full without increasing physical-running counts. Verify network restrictions, task-generation cancellation and spend-cap stops still hold for standard and native paths. Record timestamps, identities, entrypoint results and Docker lifetimes for each tier. No live Fleet acceptance is claimed by the automated fixture tests.
