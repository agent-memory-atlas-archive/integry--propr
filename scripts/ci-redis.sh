#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
IMAGE="${CI_REDIS_IMAGE:-redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2}"
RUN_ID="${GITHUB_RUN_ID:-local}"
JOB_ID="${GITHUB_JOB:-job}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
# Matrix entries share GITHUB_RUN_ID and GITHUB_JOB and may run concurrently
# on one host (one per self-hosted runner worker), so each must name its own
# instance. Unset keeps the single-Redis-per-job behaviour of existing callers.
INSTANCE="${CI_REDIS_INSTANCE:-}"
# The Docker daemon runs containers outside the runner service's cgroup, so
# the runner's CPU and memory quotas do not cover this container. These
# explicit limits bound it instead; test data sets are small.
MEMORY_LIMIT="${CI_REDIS_MEMORY:-512m}"
CPU_LIMIT="${CI_REDIS_CPUS:-1}"
PIDS_LIMIT="${CI_REDIS_PIDS_LIMIT:-64}"

if [[ -n "$INSTANCE" && ! "$INSTANCE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
  # Rejected rather than sanitized: rewriting characters could map two
  # instances to one container name.
  echo "CI_REDIS_INSTANCE must match [A-Za-z0-9][A-Za-z0-9_.-]{0,62}, got: $INSTANCE" >&2
  exit 2
fi
if [[ ! "$MEMORY_LIMIT" =~ ^[1-9][0-9]*[kmg]$ || ! "$CPU_LIMIT" =~ ^[0-9]+(\.[0-9]+)?$ || ! "$PIDS_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "CI_REDIS_MEMORY, CI_REDIS_CPUS and CI_REDIS_PIDS_LIMIT must be a Docker size (e.g. 512m), CPU count and positive integer" >&2
  exit 2
fi
if [[ ! "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
  echo "GITHUB_RUN_ATTEMPT must be a positive integer, got: $RUN_ATTEMPT" >&2
  exit 2
fi

RUN_KEY="${RUN_ID}-${JOB_ID}${INSTANCE:+-${INSTANCE}}"
SAFE_RUN_KEY="$(printf '%s' "$RUN_KEY" | tr -c 'A-Za-z0-9_.-' '-')"
CONTAINER_NAME="propr-ci-redis-${SAFE_RUN_KEY}-a${RUN_ATTEMPT}"
STATE_DIR="${CI_REDIS_STATE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
STATE_FILE="${STATE_DIR}/${CONTAINER_NAME}.name"
# Owner labels identify exactly this run, job and instance. Label values are
# compared verbatim, so sanitizing the name cannot widen the match.
LABEL_RUN="propr.ci.redis.run=${RUN_ID}"
LABEL_JOB="propr.ci.redis.job=${JOB_ID}"
LABEL_INSTANCE="propr.ci.redis.instance=${INSTANCE:-default}"

write_env() {
  local key="$1"
  local value="$2"

  # CI_REDIS_ENV_FILE lets one job start several instances without their
  # connection settings overwriting each other in the shared GITHUB_ENV.
  if [[ -n "${CI_REDIS_ENV_FILE:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$CI_REDIS_ENV_FILE"
  elif [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

remove_container() {
  local name="$1"

  case "$name" in
    propr-ci-redis-*) ;;
    *)
      echo "Refusing to remove unexpected container name: $name" >&2
      return 1
      ;;
  esac

  if docker inspect "$name" >/dev/null 2>&1; then
    docker rm --force "$name" >/dev/null
    echo "Stopped Redis container $name"
  fi
}

stop_redis() {
  local name="$CONTAINER_NAME"

  if [[ -f "$STATE_FILE" ]]; then
    name="$(<"$STATE_FILE")"
  fi
  if [[ "$name" != "$CONTAINER_NAME" ]]; then
    echo "Refusing to remove $name: this caller owns $CONTAINER_NAME" >&2
    return 1
  fi

  remove_container "$name"
  rm -f "$STATE_FILE"
}

# A cancelled earlier attempt of this same run, job and instance may have left
# its container behind. Attempts of one run never overlap, so removing those is
# safe; other runs, jobs and instances never match all three labels.
remove_previous_attempts() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" && "$name" != "$CONTAINER_NAME" ]] || continue
    remove_container "$name"
  done < <(docker ps --all --format '{{.Names}}' \
    --filter "label=${LABEL_RUN}" \
    --filter "label=${LABEL_JOB}" \
    --filter "label=${LABEL_INSTANCE}")
}

start_redis() {
  mkdir -p "$STATE_DIR"

  stop_redis
  remove_previous_attempts

  docker run \
    --detach \
    --rm \
    --name "$CONTAINER_NAME" \
    --label propr.ci.redis=true \
    --label "$LABEL_RUN" \
    --label "$LABEL_JOB" \
    --label "$LABEL_INSTANCE" \
    --label "propr.ci.redis.attempt=${RUN_ATTEMPT}" \
    --memory "$MEMORY_LIMIT" \
    --memory-swap "$MEMORY_LIMIT" \
    --cpus "$CPU_LIMIT" \
    --pids-limit "$PIDS_LIMIT" \
    --publish 127.0.0.1::6379 \
    --health-cmd 'redis-cli ping' \
    --health-interval 2s \
    --health-timeout 2s \
    --health-retries 15 \
    "$IMAGE" >/dev/null

  printf '%s\n' "$CONTAINER_NAME" > "$STATE_FILE"

  local ready=false
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)" == "healthy" ]]; then
      ready=true
      break
    fi
    sleep 1
  done

  if [[ "$ready" != "true" ]]; then
    docker logs "$CONTAINER_NAME" >&2 || true
    stop_redis
    echo "Redis did not become healthy within 30 seconds" >&2
    return 1
  fi

  local mapping
  local port
  mapping="$(docker port "$CONTAINER_NAME" 6379/tcp)"
  port="${mapping##*:}"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    stop_redis
    echo "Could not determine the dynamically assigned Redis port from: $mapping" >&2
    return 1
  fi

  write_env REDIS_HOST 127.0.0.1
  write_env REDIS_PORT "$port"
  write_env REDIS_CONTAINER_NAME "$CONTAINER_NAME"
  # Flushing is only enabled for the Redis this script just created.
  write_env PROPR_TEST_REDIS_ISOLATION flush
  echo "Redis is healthy on 127.0.0.1:${port} ($CONTAINER_NAME)"
}

case "$ACTION" in
  start) start_redis ;;
  stop) stop_redis ;;
  name) printf '%s\n' "$CONTAINER_NAME" ;;
  *)
    echo "Usage: $0 start|stop|name" >&2
    exit 2
    ;;
esac
