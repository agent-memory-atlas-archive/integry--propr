# CI runner routing

PR checks prefer the `gitfix.dev` self-hosted runner workers where a job fits them.
Everything else stays on GitHub-hosted runners. This page records which jobs
run where, why, what the self-hosted route assumes about trust, and how to add
capacity.

## The self-hosted runner workers

- Host: `gitfix.dev`, Ubuntu 24.04 x64, 12 logical CPUs, 62 GiB RAM. Other
  repositories and ProPR's production services share the host and its Docker
  daemon.
- Runner workers: **four** registered workers (the original
  `Ubuntu-2404-noble-amd64-base-propr` plus three more), each with its own
  installation and work directory. All carry the labels
  `[self-hosted, Linux, X64, propr]`. The original worker runs as **root**;
  every routed job records the user it ran as (see *Placement evidence*).
- Each worker runs **one job at a time**, so at most four routed jobs run on
  the host at once. The nightly suite (`test-nightly.yml`), the PR preview
  deploys (`pr-preview.yml`), the image publishing jobs (`docker-images.yml`)
  and the PR checks below all queue for the same four workers.
- Each worker's systemd service is limited to `CPUQuota=200%`,
  `MemoryHigh=6G` and `MemoryMax=8G`. Together the four runner process trees
  are capped at eight CPU equivalents and 32 GiB. These limits are host
  configuration, provisioned outside this repository; the workflows neither
  set nor change them.
- **Docker containers are not covered by those limits.** The Docker daemon
  starts containers in its own cgroups, outside the runner services. CI-owned
  containers therefore carry explicit limits of their own (below).

## Routing rule

The routed jobs use this expression, identical in every copy
(`test/ciRunnerRouting.test.mjs` enforces that):

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

There is **no automatic fallback**. If every self-hosted worker is offline or
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
  fork code off the workers is the repository setting *Settings → Actions →
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
  not left in the persistent workspace's `.git/config`.
- Routed jobs point `HOME`, `XDG_*`, the npm and Playwright caches and
  `.propr/setup.sh`'s cache at `$RUNNER_TEMP/ci`. `RUNNER_TEMP` belongs to
  one worker's work directory and the runner empties it between jobs. Tests
  never see the host's `/root` (agent credentials such as `~/.codex`), shared
  caches or another worker's files. Root can still reach the Docker daemon
  and the rest of the file system, so this protects against accidents, not
  against malicious code.
- `TMPDIR` is a fresh private (0700) `mktemp -d /tmp/propr-ci.XXXXXX`
  directory, exported as `PROPR_CI_TMPDIR` and removed by the job's last
  step. This gives tests the ancestry they have on hosted runners: `/` and
  the sticky `/tmp`. Under the runner's install tree, a group-writable
  ancestor made the CLI's private-directory checks reject
  `packages/cli/src/commands/initStack.test.ts`, which is correct product
  behaviour. The long path also pushed Chromium's `SingletonSocket` past the
  kernel's 108-byte Unix socket limit. If a worker dies before cleanup, its
  directory stays in `/tmp` until the host's normal tmp cleanup.
- Routed jobs never `apt-get install` onto the host: `scripts/ci-install-chromium.sh`
  passes `--with-deps` only on GitHub-hosted runners, and the full-suite jobs
  download only the browser. They never run machine-wide Docker cleanup. The
  only containers they remove are their own `propr-ci-redis-*` instances
  (below), plus `--rm` tool containers such as actionlint, which remove
  themselves.

## Isolation between concurrent jobs

Up to four routed jobs, including four shards of one run, can run on the host
at the same time.

- **Redis.** Matrix entries share `GITHUB_RUN_ID` and `GITHUB_JOB`, so those
  two values cannot tell shards apart. Each shard passes
  `CI_REDIS_INSTANCE=shard-N` to `scripts/ci-redis.sh`, which adds
  `GITHUB_RUN_ATTEMPT`. The container is named
  `propr-ci-redis-<run>-<job>-shard-N-a<attempt>` and labelled with the run,
  job, instance and attempt. Its port is assigned by Docker on `127.0.0.1`
  only. Its state file lives in the worker's own `RUNNER_TEMP`. `start`
  removes only an earlier attempt of the same run, job and instance; `stop`
  removes only the container this caller owns. Tests flush Redis only because
  the job created that container.
- **Docker resource limits.** The CI Redis container runs with
  `--memory 512m --memory-swap 512m --cpus 1 --pids-limit 64`, overridable
  through `CI_REDIS_MEMORY`, `CI_REDIS_CPUS` and `CI_REDIS_PIDS_LIMIT`.
  Invalid values are rejected. The actionlint and shellcheck tool containers
  in `validate` run with `--network none --memory 1g --memory-swap 1g
  --cpus 1 --pids-limit 256`. Worst case, on top of the runner services'
  8 CPUs and 32 GiB, four shard Redis containers add 4 CPUs and 2 GiB and one
  tool container adds 1 CPU and 1 GiB. These are ceilings, not reservations,
  and the CPU limits throttle rather than fail.
- **Processes.** Every step's processes run inside the worker's service
  cgroup. At the end of each job the runner terminates processes the job left
  behind; it tracks them through `RUNNER_TRACKING_ID`.
- **Persistent workspace.** Each worker keeps its checkout between jobs.
  `actions/checkout` uses its default clean mode, which removes untracked and
  ignored files left by the previous job. The shard build step then requires
  that no `packages/*/dist` output exists before `npm run test:prepare` and
  that it exists afterwards. A stale build therefore can neither fail the
  check nor stand in for one that did not run. As the last step, also on
  failure and cancellation, each routed job runs
  `git -C "$GITHUB_WORKSPACE" clean -ffdxq`. That removes its own
  `node_modules`, build output and logs from its own workspace. `.git` stays
  so the checkout post step still works. The same step removes the job's
  `PROPR_CI_TMPDIR` (only when it matches `/tmp/propr-ci.*`). Nothing outside
  the job's workspace, `RUNNER_TEMP` and that directory is deleted.

## Browser sandbox and non-root requirements

- The full-suite browser tests launch Chromium with `--no-sandbox` on every
  route (for example `packages/api/test/mcpBrowser.test.ts` and
  `apps/desktop/scripts/desktop-sidebar-layout.test.mjs`). Playwright's own
  default (`chromiumSandbox: false`) covers the `validate` browser checks the
  same way. Running these as root on the host therefore proves exactly what
  they prove on hosted runners.
- Electron does not start on `gitfix.dev`. It needs a desktop session and an
  ordinary user for its sandbox. Its full-suite units skip there with
  `Electron cannot start on this worker`. For trusted runs they run again in
  the hosted `native-electron` job with `PROPR_REQUIRE_NATIVE_ELECTRON=1`,
  which turns that skip into a failure.
- Desktop Linux x64 packaging and acceptance checks stay hosted (see the
  table below).

## What moved

| Workflow | Job (check name) | Route |
| --- | --- | --- |
| `pr-test-on-label.yml` | `shard` matrix (*Full Test Suite Shard N/4*) | self-hosted for trusted runs, hosted otherwise |
| `pr-test-on-label.yml` | `docs` (*Validate Test Preparation and Docs*) | self-hosted for trusted runs, hosted otherwise |
| `pr-build-check.yml` | `validate` (*Validate Changes*) | self-hosted for trusted runs, hosted otherwise |

### Full suite: one shard per worker

The full suite runs as the same four GitHub matrix jobs on both routes. Only
`runs-on` changes. For trusted runs each shard lands on one of the four
workers. When fewer workers are free, the remaining shards queue. There is no
coordinator that runs several shards inside one job. Each shard job:

1. Makes a clean checkout without persisted credentials, then isolates its
   state in `RUNNER_TEMP` and records its placement.
2. Runs `npm ci` and `npm run test:prepare`, and installs Chromium into its
   own `PLAYWRIGHT_BROWSERS_PATH`.
3. Starts its own Redis (`CI_REDIS_INSTANCE=shard-N`, above) and runs its
   share of the suite with `scripts/run-test-suite.mjs`. Files still run one
   at a time inside the shard.
4. Uploads `full-test-output-<run>-<attempt>-shard-N`, with `summary.json`,
   sanitized output and `stages.json`. `stages.json` also records the
   runner's name and environment.
5. Stops its Redis and cleans its workspace, also on failure and
   cancellation.

`docs` runs `.propr/setup.sh` docs validation once per workflow, on the same
route as the shards.

### Required check

The `Run Full Test Suite` check name and its fail-closed behaviour are
unchanged. On both routes the gate requires every `shard` and `docs` to
succeed. It recomputes the route and, for the self-hosted route, also
requires `native-electron` to succeed. It then verifies from the uploaded
summaries that four shards ran every discovered test unit exactly once. If a
shard was skipped, cancelled or failed, or a summary is missing, the gate
fails. Re-running failed jobs reuses the newest attempt of each shard's
artifact.

### Placement evidence

Every routed job runs `scripts/ci-runner-evidence.sh`. It is read-only and
writes a *Runner placement* table to the job summary with:

- `RUNNER_NAME` and `RUNNER_ENVIRONMENT`;
- OS and architecture;
- the user and uid the steps ran as;
- the run attempt;
- the visible CPU count;
- the process cgroup and the nearest cgroup that sets `cpu.max`,
  `memory.high` and `memory.max`.

On a correctly provisioned worker the table should show `cpu.max` as
`200000 100000` and the service's 6 GiB and 8 GiB memory values. Shard
`stages.json` files and the failure comment also name the runner each shard
ran on. The jobs API gives the same answer after the fact:

```
gh api repos/integry/propr/actions/runs/<run>/jobs --paginate \
  --jq '.jobs[] | [.name, .runner_name, .labels] | @tsv'
```

`runner_name` should be one of the four workers for `shard`, `docs` and
`validate` on trusted runs, and `GitHub Actions <id>` for everything else.
This change has not yet run on the new workers, so there is no recorded
placement for them yet.

## What stays GitHub-hosted, and why

| Job | Reason |
| --- | --- |
| Fork and Dependabot runs of the routed jobs (`shard` matrix, `docs`, hosted `validate`) | Untrusted code must not run as root on the shared host. |
| `native-electron` (*Full Test Suite Native Electron (hosted)*) | Electron cannot launch on `gitfix.dev`. The nightly logs show `electron-frame-semantics` and `electron-pairing-zstd` skipping with `Electron cannot start on this worker (exit 127)`, while hosted shards run them. These units run again on `ubuntu-latest` with `PROPR_REQUIRE_NATIVE_ELECTRON=1`, which turns that skip into a failure. Self-hosted routing therefore loses no Electron coverage. |
| `test` gate, `comment` | Seconds of work. Keeping them hosted means they never wait behind other jobs for a worker. |
| `pr-build-check.yml`: `visual-previews`, `cli-node-matrix` (Node 22/24), `cli-init-json` (Node 22/24) | Capacity. Each takes 0.7–2.5 min on hosted runners and gains nothing from a larger host. On the self-hosted workers they would compete with the shards for the four slots. Measure queueing with four workers before moving them (below). |
| `cli-agent-skill-glibc-231` | Needs a glibc 2.31 container and an ordinary (non-root) user. It `chown`s the checkout to that user, which would change ownership of the persistent runner workspace. |
| macOS, Windows and `ubuntu-24.04-arm` jobs (Darwin Agent Skill, Connect/Darwin ACL, Windows Connect discovery, desktop packaging matrices) | The runner must match the target OS and architecture. |
| Desktop Linux x64 (`desktop-release-guard.yml` package `linux-x64`, stock-Chromium axe boundary, `desktop-connect-discovery-guard.yml` `linux-x64`) | Each installs system packages with `sudo apt-get install` (xvfb, dbus-x11, gnome-keyring, rpm, …), which would change the shared host. Each needs a clean graphical desktop session (Xvfb, D-Bus, keyring). Electron's Chromium sandbox requires an ordinary user, and on the root worker it would need `--no-sandbox`, weakening what they prove. Electron does not start on this host (see above). |
| `cli-node-compatibility.yml`, `codeql.yml`, `dependency-review.yml` | Capacity (as above). CodeQL and dependency review are GitHub-managed analyses with nothing to gain from the host. |
| Release, publish and deployment jobs | Out of scope. They are unchanged. |

## Capacity and scaling

- A trusted push needs six worker slots: four `shard` jobs, `docs` and
  `validate`. With four workers, up to four run at once and the rest queue.
  The nightly suite and preview deploys queue with them.
- Each shard gets at most two CPUs (`CPUQuota=200%`). A GitHub-hosted
  `ubuntu-latest` runner has four vCPUs. Compare shard times from the job
  summaries and `summary.json` before and after routing; do not assume the
  host is faster per shard.
- **More workers:** register additional workers with the same labels,
  preferably as a dedicated non-root user, and apply the same service limits.
  Each extra worker lets one more routed job run at the same time. Then
  consider routing the short `pr-build-check.yml` jobs by giving them the same
  `runs-on` expression as `validate`.
- **More shards:** raise the `shard` matrix and `PROPR_TEST_SHARD_COUNT`
  together. The coverage gate reads the same count. More shards than workers
  only adds queueing on the self-hosted route.

## Nightly

`test-nightly.yml` still runs the unsharded suite and live E2E on a
self-hosted worker. Scheduled and manual runs share one concurrency group with
`cancel-in-progress: false`, so they never overlap. It calls
`scripts/ci-redis.sh` without an instance, keeping its one-Redis-per-job
behaviour, and gets the same Redis container limits.
