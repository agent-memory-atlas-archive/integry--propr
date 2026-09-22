# CI runner routing

PR checks run on disposable GitHub-hosted runners. The full suite uses four
independent hosted shard jobs, a hosted docs job, and the aggregate
`Run Full Test Suite` gate. This page describes the configuration shipped in
the workflows; `test/ciRunnerRouting.test.mjs` checks their hosted placement.

## Where jobs run

| Workflow | Job (check name) | Runner |
| --- | --- | --- |
| `pr-test-on-label.yml` | `shard` matrix (*Full Test Suite Shard N/4*) | `ubuntu-latest`, four independent jobs |
| `pr-test-on-label.yml` | `docs` (*Validate Test Preparation and Docs*) | `ubuntu-latest` |
| `pr-test-on-label.yml` | `test` (*Run Full Test Suite*) and `comment` (*Report Full Test Failure*) | `ubuntu-latest` |
| `pr-test-on-label.yml` | `native-electron` (*Full Test Suite Native Electron (hosted)*) | Permanently disabled by `if: ${{ !always() }}`; its declared runner is `ubuntu-latest` |
| `pr-build-check.yml` | `validate` (*Validate Changes*), `visual-previews`, `cli-node-matrix`, `cli-init-json`, `cli-agent-skill-glibc-231`, `comment` | `ubuntu-latest` |
| `pr-build-check.yml` | `cli-agent-skill-darwin`, `connect-authority-darwin` | `macos-15` |
| `pr-build-check.yml` | `windows-connect-discovery` | `windows-2025` |

Hosted placement is the same for same-repository, fork, Dependabot and manual
runs whenever the job's event conditions allow it to run. The full-suite
shards and docs run for non-draft PRs and manual dispatches. There is no
repository-variable routing switch or automatic self-hosted fallback.
Desktop packaging and acceptance workflows retain their hosted platform
matrices. Release, publishing and deployment workflows are unchanged.

The shard, docs and validation jobs check out without persisted credentials
and use `contents: read` permissions. Their shared-host state isolation and
persistent-workspace cleanup steps are guarded by
`runner.environment == 'self-hosted'` and do not execute in this hosted
configuration. Those dormant steps do not establish a PR trust policy or
change repository permissions, runner registration or runner groups.

## Full suite and coverage

Each of the four shard jobs:

1. Checks out the repository and records runner placement.
2. Runs `npm ci` and `npm run test:prepare`, verifying that the expected build
   output is absent before the build and present afterwards, then installs
   Chromium.
3. Starts its own Redis with `CI_REDIS_INSTANCE=shard-N` and runs its share of
   `scripts/run-test-suite.mjs`. Sorted test units are assigned deterministically
   across shards. Files run one at a time within each shard, with isolated
   data directories and Redis flushed between files. Native Vitest/Jest
   workspaces such as `propr-ui` are split into four workspace test parts.
4. Uploads `full-test-output-<run>-<attempt>-shard-N`, containing `summary.json`,
   sanitized output and `stages.json`. The stage record includes runner name,
   runner environment and run attempt.
5. Stops its Redis even on failure or cancellation.

The independent `docs` job installs dependencies, builds workspace packages
and runs `.propr/setup.sh` to validate the docs once per workflow.

### Required check

The `Run Full Test Suite` gate requires every shard and the docs job to
succeed, and verifies from uploaded summaries that all four shards together
ran every discovered test unit exactly once. A failed, cancelled or skipped
shard, missing summary, or failed coverage verification fails the gate.
Re-running failed jobs can reuse passing shards' artifacts from earlier
attempts; verification selects the newest attempt for each shard.

The gate uses `ROUTE: hosted`, so the permanently disabled `native-electron`
job is not required to succeed. The Electron test files are included in the
hosted shards. The dormant fallback's `PROPR_REQUIRE_NATIVE_ELECTRON=1` is
not set by those shards: their native Electron setup can skip tests if
Electron or its headless environment cannot start. Summary verification
checks test-unit execution, not whether every assertion inside a unit ran;
the disabled fallback provides no additional Electron coverage.

A newer push cancels the superseded full-suite run. Its gate still runs and
fails closed. The failure comment job posts only for failed, non-cancelled,
same-repository PR runs. It reports cancelled shard steps as cancelled and
bounds the complete comment, including failure rows and log markup, to
GitHub's comment-body limit. Omitted details remain in the uploaded artifacts
linked from the comment.

## Redis isolation

Matrix entries share `GITHUB_RUN_ID` and `GITHUB_JOB`, so each shard passes
`CI_REDIS_INSTANCE=shard-N` to `scripts/ci-redis.sh`. The script also includes
`GITHUB_RUN_ATTEMPT`:

- Container name: `propr-ci-redis-<run>-<job>-shard-N-a<attempt>`.
- Ownership labels identify the run, job, instance and attempt.
- Docker assigns a port bound only to `127.0.0.1`.
- The container's state file lives in `RUNNER_TEMP` by default and includes
  the same instance and attempt in its filename.
- `start` cleans up older attempts for the same run, job and instance;
  `stop` removes only the caller's container. No machine-wide Docker cleanup
  is performed.

Redis runs with `--memory 512m --memory-swap 512m --cpus 1 --pids-limit 64`.
`CI_REDIS_MEMORY`, `CI_REDIS_CPUS` and `CI_REDIS_PIDS_LIMIT` can override those
limits; invalid values are rejected. These are per-container ceilings. The
four PR shards run on separate hosted runners, so their containers do not
share a self-hosted worker pool. The same isolation also supports other
callers of the Redis helper, including nightly runs.

## Placement evidence

The shard, docs and `validate` jobs run the read-only
`scripts/ci-runner-evidence.sh`. It writes a *Runner placement* table to the
job summary with the runner name and environment, OS and architecture, user
and uid, run attempt, visible CPU count, process cgroup, and the nearest
cgroup limits for `cpu.max`, `memory.high` and `memory.max`.

These PR jobs should report `RUNNER_ENVIRONMENT=github-hosted`. The script
reports observed limits; it does not configure quotas or assume a particular
host capacity. Shard `stages.json` artifacts and failure comments also name
the runners. To inspect placement after a run:

```sh
gh api repos/integry/propr/actions/runs/<run>/jobs --paginate \
  --jq '.jobs[] | [.name, .runner_name, .labels] | @tsv'
```

Compare the reported labels with the workflow's declared hosted platform.
The disabled Electron job has no runner execution to inspect.

## Capacity and recovery

The full suite can run four shard jobs and one docs job concurrently, subject
to GitHub-hosted capacity and the repository's Actions concurrency limits.
`validate` and other build checks also use hosted capacity. PR shards do not
queue behind the self-hosted nightly suite or deployment jobs. There is no
nested coordinator running several CI shards inside one runner job.

Use job timings, placement summaries and shard `summary.json` durations to
identify slow units and queue delays. If hosted jobs are queued, inspect
Actions capacity and concurrency; adding self-hosted workers does not change
these PR jobs' placement. For a transient failure, re-run failed jobs and
check the aggregate gate. Missing artifacts may require re-running the
corresponding shard. A self-hosted host outage does not require rerouting
these PR checks.

If the shard count changes in a future update, change the matrix and
`PROPR_TEST_SHARD_COUNT` together and update the displayed shard counts. The
coverage gate reads the same count. Additional shards consume additional
hosted job slots, so compare queue time and test duration before scaling.

## Nightly

`test-nightly.yml` runs the unsharded full suite and live E2E on
`[self-hosted, linux, x64, propr]`. Scheduled and manual runs, including runs
on different refs, share the `nightly-test-suite` concurrency group with
`cancel-in-progress: false`. They do not overlap and an active run is not
cancelled; GitHub retains at most one pending run in that group. This group
does not serialize other workflows using self-hosted runners.

Nightly calls `scripts/ci-redis.sh` without an instance, preserving one Redis
container per job with attempt discrimination and the same container limits.
