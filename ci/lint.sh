#!/usr/bin/env bash
# Run vgi-lint against the worker attached to the mock Hue bridge, so the
# execution rules (VGI9xx) and agent tasks see real rows without a real bridge.
#
#   ci/lint.sh <vgi-lint lint command...>
#
# PYTHON may name the interpreter for the mock (default: python3).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
LOG="$(mktemp)"
unset HUE_BRIDGE HUE_APP_KEY
$PYTHON "$REPO/test/mock_bridge/server.py" >"$LOG" 2>/dev/null &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true; rm -f "$LOG"' EXIT
PORT=""
for _ in $(seq 1 60); do
  PORT="$(sed -n 's/^PORT:\([0-9][0-9]*\).*/\1/p' "$LOG" | head -1)"
  [ -n "$PORT" ] && break
  sleep 0.25
done
[ -n "$PORT" ] || { echo "mock bridge did not start" >&2; exit 1; }
"$@" --attach-option "bridge=http://127.0.0.1:$PORT" --attach-option "app_key=test-key"
