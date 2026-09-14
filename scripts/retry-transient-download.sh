#!/usr/bin/env bash
#
# Re-runs a command while it keeps failing on a transient network error.
#
# electron-forge fetches the Electron runtime zip and its SHASUMS256.txt from
# github.com release downloads on every packaging run: electron 44 dropped the
# postinstall download, so `npm ci` never warms the @electron/get cache. Those
# fetches serve sustained 5xx often enough to fail otherwise-green desktop jobs
# -- on 2026-09-14 the v44.0.0 arm64 assets returned 504 continuously from
# 15:17:37Z to at least 15:20:25Z, outlasting an earlier 15s/30s retry window.
#
# Only failures whose output looks like a download problem are retried, so a
# real build break still fails on the first attempt instead of burning the
# backoff budget.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'usage: retry-transient-download.sh <command> [argument...]' >&2
  exit 64
fi

attempts="${RETRY_TRANSIENT_ATTEMPTS:-5}"
base_delay_seconds="${RETRY_TRANSIENT_BASE_DELAY_SECONDS:-15}"
transient_pattern='Response code (408|429|5[0-9][0-9])|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|Client network socket disconnected|Gateway Time-?out|Service Unavailable|Bad Gateway'

output="$(mktemp)"
trap 'rm -f -- "$output"' EXIT

attempt=1
while :; do
  if "$@" 2>&1 | tee "$output"; then
    exit 0
  fi

  if ! grep -qE "$transient_pattern" "$output"; then
    echo "retry-transient-download: '$1' failed without a transient network error; not retrying." >&2
    exit 1
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "retry-transient-download: '$1' kept hitting transient network errors across $attempt attempts." >&2
    exit 1
  fi

  delay=$((base_delay_seconds * 2 ** attempt))
  echo "retry-transient-download: attempt $attempt hit a transient network error; retrying in ${delay}s..." >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
