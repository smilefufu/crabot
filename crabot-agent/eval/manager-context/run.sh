#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
MODE=${1:-deterministic}
IMAGE=${EVAL_IMAGE:-crabot-manager-context-eval:local}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_DIR=${EVAL_OUTPUT_DIR:-$SCRIPT_DIR/out/$STAMP-$$}

case "$MODE" in
  deterministic)
    NETWORK=none
    ;;
  behavior)
    BEHAVIOR_CONFIGURED=1
    if [ -z "${EVAL_FORMAT:-}" ] || [ -z "${EVAL_ENDPOINT:-}" ] || [ -z "${EVAL_API_KEY:-}" ] || [ -z "${EVAL_MODEL:-}" ]; then
      BEHAVIOR_CONFIGURED=0
      NETWORK=none
    else
      NETWORK=bridge
    fi
    ;;
  *)
    echo "用法: $0 [deterministic|behavior]" >&2
    exit 2
    ;;
esac

mkdir -p "$OUTPUT_DIR"

if [ "${EVAL_SKIP_BUILD:-0}" != "1" ]; then
  docker build --file "$SCRIPT_DIR/Dockerfile" --tag "$IMAGE" "$REPO_ROOT"
fi

set -- docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --network "$NETWORK" \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$OUTPUT_DIR,dst=/output" \
  --env EVAL_OUTPUT_DIR=/output

if [ "$MODE" = "behavior" ] && [ "$BEHAVIOR_CONFIGURED" = "1" ]; then
  set -- "$@" \
    --env EVAL_FORMAT \
    --env EVAL_ENDPOINT \
    --env EVAL_API_KEY \
    --env EVAL_MODEL
  if [ -n "${EVAL_ACCOUNT_ID:-}" ]; then
    set -- "$@" --env EVAL_ACCOUNT_ID
  fi
fi

"$@" "$IMAGE" "$MODE"
echo "评测报告: $OUTPUT_DIR/report.json"
