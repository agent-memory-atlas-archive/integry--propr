# CI runner routing

PR checks prefer the `gitfix.dev` self-hosted runner where a job fits it.
Everything else stays on GitHub-hosted runners. This page records which jobs
run where, why, what the self-hosted route assumes about trust, and how to add
capacity.

## The self-hosted runner

- Host: `gitfix.dev`, Ubuntu 24.04 x64, 12 logical CPUs, 62 GiB RAM. Other
  repositories and ProPR's production services share the host and its Docker
  daemon.
- Runner: one registered worker, `Ubuntu-2404-noble-amd64-base-propr`, with
  labels `[self-hosted, Linux, X64, propr]`. It runs as **root**.
- One worker runs **one job at a time**. The nightly suite
  (`test-nightly.yml`), the PR preview deploys (`pr-preview.yml`), the image
  publishing jobs (`docker-images.yml`) and the PR checks below all queue for
  that one worker.

## Routing rule

The routed jobs use this expression, identical in every copy
(`test/ciLocalShards.test.mjs` enforces that):

```
vars.PROPR_SELF_HOSTED_PR_CHECKS != 'false' && (github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'))
```

| Event | Route |
| --- | --- |
| PR from a branch in `integry/propr` | self-hosted |
| PR from a fork | GitHub-hosted |
| Dependabot PR (its new dependency versions run install scripts) | GitHub-hosted |
| Manual `workflow_dispatch` (needs write access) | self-hosted |
| Repository variable `PROPR_SELF_HOSTED_PR_CHECKS=false` | GitHub-hosted for everything |

There is **no automatic fallback**. If the self-hosted worker is offline or
busy, routed jobs wait in the queue and the required checks stay pending.
When the host is down for a long time, a maintainer can set
`PROPR_SELF_HOSTED_PR_CHECKS=false` so new runs use hosted runners. Runs that
are already queued keep their original routing; re-run them after changing
the variable.

## Trust constraints

The routing expression decides where code runs. It is **not a security
boundary**. A `pull_request` workflow runs from the PR's merge commit, so a
PR can edit the expression, add a job with `runs-on: self-hosted`, or change
any script a routed job runs.

- **Write access means root on `gitfix.dev`.** Any branch pushed to this
  repository, including branches pushed by ProPR's automation, runs its test
  and build code as root on a host with production services and the Docker
  socket. This is the same trust model as `pr-preview.yml` (minus its
  per-deploy label approval) and the nightly suite. Grant write access with
  that in mind.
- **Fork PRs must not reach the host.** The repository is public. What keeps
  fork code off the runner is the repository setting *Settings → Actions →
  General → Fork pull request workflows from outside collaborators*. It should
  require approval for all outside collaborators (or all external
  contributors). A maintainer approving a fork run must first check that the
  PR does not change `.github/workflows/**`, `.github/actions/**` or scripts
  that routed jobs run. An approved fork PR that edits the routing *can* target
  the self-hosted runner. This change does not alter repository permissions,
  runner registration or runner groups. Maintainers should confirm the setting
  above is enabled.
- Nothing here uses `pull_request_target` to run PR code, and routed jobs
  receive no repository secrets. They get only a read-only `GITHUB_TOKEN`.
  `actions/checkout` runs with `persist-credentials: false`, so the token is
  not left in the persistent workspace's `.git/config` or in shard copies.
- Routed jobs point `HOME`, `TMPDIR`, `XDG_*`, the npm and Playwright caches
  and `.propr/setup.sh`'s cache at the job's private `RUNNER_TEMP`. Tests never
  see the host's `/root` (agent credentials such as `~/.codex`) or shared
  `/tmp` caches. Root can still reach the Docker daemon and the rest of the
  file system, so this protects against accidents, not against malicious code.
- Routed jobs never `apt-get install` onto the host: `scripts/ci-install-chromium.sh`
  passes `--with-deps` only on GitHub-hosted runners. They never run
  machine-wide Docker cleanup. The only containers they remove are their own
  `propr-ci-redis-*` instances, identified by run, job, instance and attempt
  (plus `--rm` tool containers such as actionlint, which remove themselves).

## What moved

| Workflow | Job (check name) | Route |
| --- | --- | --- |
| `pr-test-on-label.yml` | `local` (*Full Test Suite (self-hosted, 4 local shards)*) | self-hosted for trusted runs |
| `pr-build-check.yml` | `validate` (*Validate Changes*) | self-hosted for trusted runs, hosted otherwise |

### Full suite on one worker

Four matrix jobs pointed at the single worker would run one after another. So
for trusted runs, one job (`local`) does the following:

1. Makes a clean checkout, then `npm ci`. Stale `packages/*/dist` is deleted
   before `npm run test:prepare`, and fresh output is required afterwards, so
   leftover files in the persistent workspace can neither fail the preparation
   check nor stand in for a build that did not run.
2. Installs Chromium into the job's `PLAYWRIGHT_BROWSERS_PATH`.
3. Runs `scripts/run-local-shards.mjs run`, which starts **at most four**
   shards concurrently (`MAX_LOCAL_CONCURRENCY`). Each shard gets:
   - its own copy of the prepared checkout (`cp -a --reflink=auto`, including
     `node_modules` and `dist`), so shards share no mutable dependency or build
     tree;
   - its own `HOME`, `TMPDIR` and `XDG_*` directories;
   - its own Redis container and port (`scripts/ci-redis.sh` with
     `CI_REDIS_INSTANCE=shard-N` and a per-shard connection file). Redis is
     flushed only because this job owns that container;
   - its own output directory, with `summary.json`, `stages.json` and sanitized
     output.

   Files still run one at a time inside each shard (`scripts/run-test-suite.mjs`).
4. Runs `.propr/setup.sh` docs validation once, after the shards, in the
   original checkout.
5. Uploads the same per-shard artifacts as the hosted matrix
   (`full-test-output-<run>-<attempt>-shard-N`) plus `coordinator.json`
   timings (`full-test-timing-<run>-<attempt>`), and writes a per-shard timing
   table to the job summary.
6. Runs `scripts/run-local-shards.mjs cleanup` in an `always()` step, which
   also runs on cancellation. Cleanup kills only processes whose environment
   carries this run's `PROPR_LOCAL_SHARD_OWNER` marker, including test daemons
   that left their shard's process group. It stops only this run's shard Redis
   containers and deletes only the work root marked as this run's.

When GitHub cancels the step, the coordinator forwards the signal to every
shard's process group, force-kills after a grace period, stops each shard's
Redis and records `cancelled` stages.

### Required check

The `Run Full Test Suite` check name and its fail-closed behaviour are
unchanged. The gate recomputes the route. For the self-hosted route it
requires `local` **and** `native-electron` to succeed. For the hosted route it
requires every `shard` and `docs` to succeed. In both cases it verifies from
the uploaded summaries that four shards ran every discovered test unit exactly
once. If a shard was skipped, cancelled or failed, or a summary is missing, the
gate fails. Re-running failed jobs reuses the newest attempt of each shard's
artifact.

## What stays GitHub-hosted, and why

| Job | Reason |
| --- | --- |
| Fork and Dependabot runs of the routed jobs (`shard` matrix, `docs`, hosted `validate`) | Untrusted code must not run as root on the shared host. |
| `native-electron` (*Full Test Suite Native Electron (hosted)*) | Electron cannot launch on `gitfix.dev`. The nightly logs show `electron-frame-semantics` and `electron-pairing-zstd` skipping with `Electron cannot start on this worker (exit 127)`, while hosted shards run them. These units run again on `ubuntu-latest` with `PROPR_REQUIRE_NATIVE_ELECTRON=1`, which turns that skip into a failure. Self-hosted routing therefore loses no Electron coverage. |
| `test` gate, `comment` | Seconds of work. Keeping them hosted means they never wait behind other jobs for the single worker. |
| `pr-build-check.yml`: `visual-previews`, `cli-node-matrix` (Node 22/24), `cli-init-json` (Node 22/24) | Capacity. Each takes 0.7–2.5 min on hosted runners and gains nothing from a larger host. On the single worker they would add roughly 7 min of queue ahead of or behind the required checks. Move them after adding workers (below). |
| `cli-agent-skill-glibc-231` | Needs a glibc 2.31 container and an ordinary (non-root) user. It `chown`s the checkout to that user, which would change ownership of the persistent runner workspace. |
| macOS, Windows and `ubuntu-24.04-arm` jobs (Darwin Agent Skill, Connect/Darwin ACL, Windows Connect discovery, desktop packaging matrices) | The runner must match the target OS and architecture. |
| Desktop Linux x64 (`desktop-release-guard.yml` package `linux-x64`, stock-Chromium axe boundary, `desktop-connect-discovery-guard.yml` `linux-x64`) | Each installs system packages with `sudo apt-get install` (xvfb, dbus-x11, gnome-keyring, rpm, …), which would change the shared host. Each needs a clean graphical desktop session (Xvfb, D-Bus, keyring). Electron's Chromium sandbox requires an ordinary user, and running as root would need `--no-sandbox`, weakening what they prove. Electron does not start on this host (see above). |
| `cli-node-compatibility.yml`, `codeql.yml`, `dependency-review.yml` | Capacity (as above). CodeQL and dependency review are GitHub-managed analyses with nothing to gain from the host. |
| Release, publish and deployment jobs | Out of scope. They are unchanged. |

## Capacity and scaling

- Today a same-repository push needs the worker for `local` and `validate`.
  These two run one after the other on the single worker, in either order.
  The nightly suite and preview deploys queue with them.
- **More workers:** register additional runner workers with the same labels,
  preferably as a dedicated non-root user. Each extra worker lets one more
  routed job run at the same time. Then consider routing the short
  `pr-build-check.yml` jobs by giving them the same `runs-on` expression as
  `validate`.
- **More shards:** `MAX_LOCAL_CONCURRENCY` in `scripts/run-local-shards.mjs`
  caps concurrent shards on one worker at 4. To raise it, measure host headroom
  first (other services share the host), then raise the constant, the four
  upload steps and `PROPR_TEST_SHARD_COUNT` together. The hosted matrix and the
  coverage gate read the same count.
- Check placement with the jobs API: `runner_name` should be
  `Ubuntu-2404-noble-amd64-base-propr` for `local`/`validate` on trusted runs,
  and `GitHub Actions <id>` for everything else.

## Nightly

`test-nightly.yml` still runs the unsharded suite and live E2E on the
self-hosted runner. Scheduled and manual runs share one concurrency group with
`cancel-in-progress: false`, so they never overlap. It calls
`scripts/ci-redis.sh` without an instance, keeping its one-Redis-per-job
behaviour.
