# CI runner routing

Compatible Linux x64 PR checks support the four gitfix.dev workers labelled
`[self-hosted, Linux, X64, propr]`. There are four independent matrix shard
jobs, one job per available worker, and no nested shard coordinator. Other
eligible jobs share the same pool and can queue ahead of shards; four shards
are not guaranteed to start simultaneously.

**Activation is gated pending independent fork-access verification.**
`PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED` must be explicitly `true`, and
`PROPR_SELF_HOSTED_PR_CHECKS` must not be `false`. Without that opt-in the
checks use GitHub-hosted runners. The older switch alone cannot activate
routing. Neither variable nor the routing expression is an access-control
boundary: a PR can replace the entire workflow.

## Fork exclusion and administrator prerequisite

Read-only inspection on 2026-09-22 confirmed that `integry/propr` is a public,
user-owned repository. The available integration received HTTP 403 for:

- `GET /repos/integry/propr/actions/runners`
- `GET /repos/integry/propr/actions/permissions/fork-pr-contributor-approval`
- `GET /repos/integry/propr/actions/permissions/fork-pr-workflows-private-repos`
- `GET /repos/integry/propr/actions/variables`

The private-repository fork setting is not a solution for this public repo.
SSH inspection could not run because this editing environment has no SSH
client. The owner's report of four online workers is therefore provisioning
context, not an independently verified runner-access policy. No settings,
services, registration, permissions or production data were changed.

Before activation, an administrator must establish and demonstrate a denial
of **all fork-origin jobs before any PR-controlled code executes** on all
four workers, including a fork workflow that directly requests the labels,
removes the routing expression, or uses an `always()` step or job container.
Workflow approval for outside contributors is insufficient: an approved fork
run still must not execute on this host. The rule must cover repeat
contributors, collaborators' forks and reruns, not only first-time authors.

A concrete GitHub-native prerequisite is organization/enterprise runner-group
access restricted to selected, reviewed **workflow file + immutable SHA**
entries, with no unrestricted repository-runner registration exposing these
workers. GitHub's [runner-group access controls](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
apply to jobs defined in the selected workflows. A trusted reusable workflow
entrypoint must reject fork events before scheduling its self-hosted jobs and
bind its checkout to the validated same-repository event. Allowing arbitrary
PR merge refs or just a workflow filename would defeat that restriction.

That option requires administrator-managed organization runner access and
trusted entrypoints; this public user-owned repository does not establish
those controls today. This change restores the direct-job routing support,
but does not supply that infrastructure or claim a runner-group policy was
verified. An existing independent runner admission mechanism is acceptable
only after an administrator demonstrates the same pre-execution denial,
including containers/actions and cleanup steps. A check inside this repo's
workflow cannot substitute for it.

Keep `PROPR_SELF_HOSTED_PR_ACCESS_VERIFIED` unset/false until the administrator
records the effective registration/access policy, its trusted policy revision,
and denial evidence for those fork cases on every worker. Only then set it to
`true` and validate same-repository placement at the resulting PR head. If the
restriction cannot be established, activation remains blocked. The switch is
an operational acknowledgement of that prerequisite, not its enforcement.

## Placement after activation

Eligible events are same-repository PRs except Dependabot, and manual dispatch
on the repository's default branch. Forks, Dependabot, other events and
non-default-branch dispatches select hosted runners. This selection is tested
for consistency across all eligible jobs.

| Workflow | Jobs | Activated placement |
| --- | --- | --- |
| `pr-test-on-label.yml` | `shard` (four entries), `docs` | gitfix.dev pool |
| `pr-build-check.yml` | `validate`, `visual-previews`, `cli-node-matrix`, `cli-init-json` | gitfix.dev pool |
| `cli-node-compatibility.yml` | `project-options` | gitfix.dev pool |
| `pr-test-on-label.yml` | `native-electron` | Hosted Ubuntu, mandatory native assertions |
| `pr-build-check.yml` | `cli-agent-skill-glibc-231` | Hosted Ubuntu; disposable glibc 2.31 container and ordinary-user ownership changes |
| Native macOS, Windows and ARM64 checks | Existing platform jobs | Matching hosted platforms |
| Desktop Linux x64 packaging/acceptance | Existing desktop jobs | Hosted: ordinary-user sandbox, desktop/session and clean-environment requirements remain |
| Aggregate gate and failure reporters | `test`, `comment` | Hosted control/reporting jobs |

Build/lint/docs coverage is unchanged. No `pull_request_target` execution or
permission expansion is introduced. Release/deployment workflows are unchanged.
The glibc and desktop exceptions retain their existing environment validation;
they are not weakened to fit a root-run host.

## Four-worker capacity and isolation

The provisioned contract is a separate runner installation/work directory for
each worker, `CPUQuota=200%`, `MemoryHigh=6G`, and `MemoryMax=8G`. This bounds
four runner process trees to eight CPU equivalents and 32 GiB. The workflows
do not change those service settings. Each eligible job records observed
runner name, environment, uid and cgroup limits with
`scripts/ci-runner-evidence.sh`; the administrator must check the actual limits.

Every eligible job uses a clean checkout with `persist-credentials: false`.
On self-hosted runners it isolates HOME, XDG state, npm and Playwright caches
under its worker's job-local `RUNNER_TEMP`. A private `mktemp` directory under
`/tmp` avoids shared state and long Chromium socket paths. Docs setup also
gets a job-local `PROPR_CACHE_DIR`. The shard build verifies old `dist` output
is absent and fresh output exists. Chromium system packages are installed
only on disposable hosted runners; required shared-host libraries must already
be provisioned. Missing prerequisites fail checks rather than trigger host
package installation.

Final `always()` steps remove generated files only from the job's own workspace
and private temporary directory. Shards stop their own Redis on cancellation
and failure. Runner-managed process cleanup and `RUNNER_TEMP` cleanup remain
in effect. Hard host failure/forced termination can bypass cleanup; a later
attempt recovers only its own older Redis containers. There is no global prune.

Docker containers run outside the worker service cgroups. Redis explicitly
uses `--memory 512m --memory-swap 512m --cpus 1 --pids-limit 64` per container.
The validation tool containers use `--memory 1g --memory-swap 1g --cpus 1
--pids-limit 256`, `--network none`, read-only checkout mounts and `--rm`.
These ceilings are additional to the runner process-tree limits.

## Redis ownership

`scripts/ci-redis.sh` computes `propr-ci-redis-<sha256>` from the NUL-delimited
run ID, job ID, instance (including empty), and attempt. This avoids both
component-boundary and sanitization collisions. Matrix jobs pass
`CI_REDIS_INSTANCE=shard-N`. State files use the same hash in the job's temp
directory; optional `CI_REDIS_ENV_FILE` separates connection settings.
Docker assigns each container a loopback-only port.

Before every removal, including `stop`, the helper inspects the Redis marker,
run, job, instance and attempt labels. It removes by the inspected immutable
container ID, not a name that could have been replaced. `start` recovers only
older attempts matching the exact owner; it preserves newer attempts and all
other owners. An unexpected owner fails closed. Existing callers with no
instance, including nightly, retain one container per job and attempt.

Regression tests prove `job=shard, instance=default` and
`job=shard-default, instance=<omitted>` coexist and either stop order preserves
the other. They also cover foreign labels, tampered state, field-boundary
collisions, retries and resource limits using a Docker CLI double.

## Coverage, required check and partial reruns

Sorted discovered test units are assigned deterministically to four shards.
Files run serially within each shard with fresh data directories and an
isolated Redis flush between files. Native workspace suites such as `propr-ui`
are split into four workspace parts. Docs preparation runs once in its own job.

The required **Run Full Test Suite** name stays unchanged. Its gate requires
all shards, docs, complete summary verification, and the hosted native Electron
job to succeed. Electron runs on hosted Ubuntu on both routes with
`PROPR_REQUIRE_NATIVE_ELECTRON=1`; an unavailable binary/headless environment
fails instead of silently skipping assertions. The shared-host shards retain
the full unit manifest, and hosted Electron supplies mandatory native execution.

The gate verifies every discovered unit ran exactly once across the four
selected summaries. Failed, cancelled, skipped or missing results fail closed.
Artifact names include run ID, attempt and shard. On a partial rerun the gate
uses the newest attempt per shard and retains passing earlier-attempt artifacts.

Shard logs and build failure logs are sanitized before upload, raw copies are
removed, and comments read the sanitized artifacts. Shard stage records contain
actual runner names and attempts. A newer PR push cancels the superseded run;
its gate fails closed and its failure reporter avoids posting a stale comment.

## Verification and timing evidence

Local validation of this follow-up covers Redis ownership, routing activation
and fork/default-branch cases, coverage verification, partial reruns, mandatory
Electron enforcement, sanitization and cleanup. Docker ownership tests use a
CLI double; no real Docker daemon or gitfix.dev execution was available here.

The following is **pre-change baseline evidence only**, from head
`04332060be3baff9b31afd09118e3aefe929147b`, attempt 1. It cannot validate the
resulting follow-up head or prove self-hosted placement.

| Check | Actual `runner_name` | Queue (created to started) |
| --- | --- | --- |
| Full suite shard 1 | `GitHub Actions 1000041693` | 2 s |
| Full suite shard 2 | `GitHub Actions 1000041694` | 2 s |
| Full suite shard 3 | `GitHub Actions 1000041689` | 3 s |
| Full suite shard 4 | `GitHub Actions 1000041692` | 3 s |
| Docs | `GitHub Actions 1000041695` | 2 s |
| Run Full Test Suite | `GitHub Actions 1000041716` | 3 s |
| Validate Changes | `GitHub Actions 1000041706` | 2 s |

[Full suite run 35783212970](https://github.com/integry/propr/actions/runs/35783212970)
succeeded, with API creation-to-final-update duration **5m37s**.
[Build/lint run 35783212968](https://github.com/integry/propr/actions/runs/35783212968)
succeeded in **5m16s** by the same measure. All executed jobs in these two runs
were hosted; native Electron was disabled in that earlier head. These are not
claims that this follow-up's required checks have passed.

After publication and authorized activation, capture the exact PR head and
query runs filtered by that full SHA, then every attempt's paginated jobs:

```sh
gh pr view 2466 --repo integry/propr --json headRefOid
gh api 'repos/integry/propr/actions/runs?head_sha=<FULL_SHA>&per_page=100' --paginate
gh api repos/integry/propr/actions/runs/<RUN>/attempts/<ATTEMPT>/jobs --paginate
gh pr checks 2466 --repo integry/propr --required
```

Record actual `runner_name`, `labels`, job `created_at`, `started_at`,
`completed_at`, conclusion, run attempt and total workflow duration. Queue time
is job start minus creation (not time waiting on dependencies). Check all four
shards, every eligible build/docs job, coverage verification, native Electron,
and the aggregate gate. Correlate API runner names with the administrator's
verified four-worker inventory and job cgroup summaries. Do not reuse timings
from an older head as proof. **Resulting-head CI and gitfix.dev placement remain
pending activation and a new run.**

There is no automatic fallback when activated workers are busy/offline. Set
`PROPR_SELF_HOSTED_PR_CHECKS=false` to route new jobs hosted; already queued jobs
need cancellation/restart. For partial failures rerun failed jobs and verify
the aggregate gate, including prior successful shard artifacts.

## Nightly

`test-nightly.yml` keeps its unsharded full suite/live E2E and existing
self-hosted labels. Scheduled/manual runs across refs share
`nightly-test-suite` with `cancel-in-progress: false`: one active run, at most
one pending run. This does not serialize other workflows; nightly and PR
checks compete for the worker pool. Nightly also receives the Redis ownership
fix. This follow-up does not activate or change nightly runner access.
