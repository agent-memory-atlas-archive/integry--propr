import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const retryScript = resolve("scripts/retry-transient-download.sh");

const GATEWAY_TIMEOUT = [
  "An unhandled rejection has occurred inside Forge:",
  "HTTPError: Response code 504 (Gateway Time-out) for"
    + " https://github.com/electron/electron/releases/download/v44.0.0/electron-v44.0.0-linux-arm64.zip",
].join("\n");

function runRetry({ failures, message, attempts = 4 }) {
  const root = mkdtempSync(join(tmpdir(), "propr-retry-download-test-"));
  try {
    const counter = join(root, "attempts");
    const forwarded = join(root, "forwarded");
    const failureOutput = join(root, "failure-output");
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin);
    writeFileSync(failureOutput, message ? `${message}\n` : "");

    const command = join(fakeBin, "package-desktop");
    writeFileSync(command, [
      "#!/usr/bin/env bash",
      `attempt=$(( $(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0) + 1 ))`,
      `echo "$attempt" > ${JSON.stringify(counter)}`,
      `printf '%s\\n' "$*" > ${JSON.stringify(forwarded)}`,
      `if [ "$attempt" -le ${failures} ]; then`,
      `  cat ${JSON.stringify(failureOutput)} >&2`,
      "  exit 1",
      "fi",
      "echo 'packaged the desktop app'",
      "",
    ].join("\n"));
    chmodSync(command, 0o755);

    const result = spawnSync("bash", [retryScript, command, "--platform", "linux-arm64"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RETRY_TRANSIENT_ATTEMPTS: String(attempts),
        RETRY_TRANSIENT_BASE_DELAY_SECONDS: "0",
      },
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      attempts: Number(readFileSync(counter, "utf8").trim()),
      forwarded: readFileSync(forwarded, "utf8").trim(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("runs the command once and forwards its arguments when it succeeds", () => {
  const result = runRetry({ failures: 0 });
  assert.equal(result.status, 0);
  assert.equal(result.attempts, 1);
  assert.equal(result.forwarded, "--platform linux-arm64");
  assert.match(result.stdout, /packaged the desktop app/);
  assert.doesNotMatch(result.stderr, /retrying/);
});

test("retries the Electron runtime download until a gateway timeout clears", () => {
  const result = runRetry({ failures: 2, message: GATEWAY_TIMEOUT });
  assert.equal(result.status, 0);
  assert.equal(result.attempts, 3);
  assert.match(result.stderr, /attempt 1 hit a transient network error; retrying in 0s/);
  assert.match(result.stderr, /attempt 2 hit a transient network error; retrying in 0s/);
});

test("gives up after the attempt budget when the outage outlasts the backoff", () => {
  const result = runRetry({ failures: Number.MAX_SAFE_INTEGER, message: GATEWAY_TIMEOUT, attempts: 4 });
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 4);
  assert.match(result.stderr, /kept hitting transient network errors across 4 attempts/);
});

test("fails immediately on a real build break instead of burning the backoff budget", () => {
  const result = runRetry({
    failures: Number.MAX_SAFE_INTEGER,
    message: "src/main.ts(12,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  });
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
  assert.match(result.stderr, /failed without a transient network error; not retrying/);
});

test("treats a missing release asset as permanent rather than transient", () => {
  const result = runRetry({
    failures: Number.MAX_SAFE_INTEGER,
    message: "HTTPError: Response code 404 (Not Found) for"
      + " https://github.com/electron/electron/releases/download/v44.0.0/electron-v44.0.0-linux-arm64.zip",
  });
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
});

test("rejects an empty command line", () => {
  const result = spawnSync("bash", [retryScript], { encoding: "utf8" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: retry-transient-download\.sh/);
});

test("every active desktop packaging step in CI goes through the retry wrapper", () => {
  const workflowDirectory = resolve(".github/workflows");
  const invocations = [];

  for (const entry of readdirSync(workflowDirectory).sort()) {
    if (!entry.endsWith(".yml")) continue;
    const workflow = readFileSync(join(workflowDirectory, entry), "utf8");
    for (const line of workflow.split("\n")) {
      if (line.includes("npm run desktop:package")) invocations.push(`${entry}|${line.trim()}`);
    }
  }

  assert.deepEqual(invocations, [
    "desktop-connect-discovery-guard.yml|run: bash scripts/retry-transient-download.sh npm run desktop:package",
    // The paused Windows durability job keeps the bare invocation: it is gated
    // behind PROPR_WINDOWS_DESKTOP_CI_ENABLED and runs with continue-on-error.
    "desktop-release-guard.yml|run: npm run desktop:package",
    "desktop-release-guard.yml|bash scripts/retry-transient-download.sh npm run desktop:package",
    "desktop-release-guard.yml|bash scripts/retry-transient-download.sh npm run desktop:package",
  ]);
});
