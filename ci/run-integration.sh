#!/usr/bin/env bash
# managed-by: vgi-starters (edit upstream in shared/, then run tools/render.py)
#
# Run test/sql/*.test through DuckDB (the haybarn-unittest sqllogictest runner)
# against this worker, over one transport.
#
#   WORKER=/abs/path/to/worker-executable TRANSPORT=stdio ci/run-integration.sh
#
# Required environment:
#   WORKER            absolute path to an executable that serves the worker:
#                     no arguments = stdio; `--http --port 0` = HTTP, printing
#                     `PORT:<n>` on stdout once listening.
# Optional:
#   TRANSPORT         stdio | launch | http                        (default: stdio)
#   HAYBARN_UNITTEST  path to haybarn-unittest   (default: the one on PATH)
#   PYTHON            command for the mock API, may contain spaces (default: python3)
#   MIN_EXECUTED      fail if fewer test cases ran (default: 1)
#   EXPECTED_SKIP_REASONS  newline-separated skip reasons that are allowed,
#                     e.g. "require-env HUE_LIVE". Any other skip fails.
#   RECIPES_WORKER    command that runs a recipe by name (`$RECIPES_WORKER <recipe>`);
#                     when set, examples/test/*.test run too (stdio/launch only)
#   KEEP_STAGE=1      keep the staged test tree for debugging
#
# Isolation: every test file runs against its own fresh mock bridge (and, on
# the http lane, its own fresh worker; on the launch lane, its own launcher
# pool), with its own discovery cache and transaction directory. A file that
# leaves the bridge changed -- transactions.test COMMITs real light changes --
# therefore cannot break the files that run after it, in any order.
#
# Transports:
#   stdio   DuckDB spawns the worker and talks over stdin/stdout (the default).
#   launch  DuckDB starts the worker once on an AF_UNIX socket and pools
#           connections (`LOCATION 'launch:/path'`); best for slow-starting
#           runtimes such as the JVM.
#   http    the worker runs as an HTTP server (`--http`), as in Docker deploys.
#
# Why the extra checks: the sqllogictest runner turns some errors into silent
# SKIPs (anything mentioning "HTTP" without --test-config) and exits 0 when no
# test matched. Both would make a broken lane look green, so this script passes
# a config that disables error-skipping and fails on any unexpected skip.
set -euo pipefail

: "${WORKER:?absolute path to the worker executable}"
TRANSPORT="${TRANSPORT:-stdio}"
HAYBARN_UNITTEST="${HAYBARN_UNITTEST:-$(command -v haybarn-unittest || true)}"
PYTHON="${PYTHON:-python3}"
MIN_EXECUTED="${MIN_EXECUTED:-1}"
[ -n "$HAYBARN_UNITTEST" ] || { echo "::error::haybarn-unittest not found (make tools)"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
STAGE="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  [ "${KEEP_STAGE:-0}" = "1" ] && echo "stage kept at $STAGE" || rm -rf "$STAGE"
}
trap cleanup EXIT

# start_server <log> <cmd...> — run a server that prints PORT:<n>; sets PORT.
PORT=""
start_server() {
  local log="$1"; shift
  "$@" >"$log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || { echo "::error::'$*' exited early:"; cat "$log"; return 1; }
    PORT="$(sed -n 's/^PORT:\([0-9][0-9]*\).*/\1/p' "$log" | head -1)"
    [ -n "$PORT" ] && return 0
    sleep 0.5
  done
  echo "::error::'$*' never printed PORT:<n>"; cat "$log"; return 1
}

# Clear any real bridge settings so a developer's environment cannot leak in.
unset HUE_BRIDGE HUE_APP_KEY
case "$TRANSPORT" in
  stdio | launch) HTTP=0 ;;
  http) HTTP=1 ;;
  *) echo "::error::unknown TRANSPORT=$TRANSPORT (expected stdio|launch|http)"; exit 1 ;;
esac

# start_fixtures <dir> <n> — a fresh mock Hue bridge for one test file (and,
# over HTTP, a fresh worker), with throwaway state; exports what the tests and
# the worker read. The mock answers the first GET of every path with 429 +
# Retry-After so the retry path is always exercised.
start_fixtures() {
  local dir="$1" n="$2"
  mkdir -p "$dir"
  MOCK_FLAKY=1 start_server "$dir/mock.log" $PYTHON "$REPO/test/mock_bridge/server.py"
  export HUE_MOCK_BRIDGE="http://127.0.0.1:$PORT"
  # Bridge discovery (ATTACH without `bridge`) goes to the mock's stand-in for
  # discovery.meethue.com only: no mDNS on the real LAN, and a throwaway cache.
  export HUE_DISCOVERY_URL="$HUE_MOCK_BRIDGE/discovery"
  export HUE_DISCOVERY_SCHEME=http
  export HUE_DISCOVERY_MDNS=off
  export XDG_CACHE_HOME="$dir/cache"
  # Staged transaction requests go to a throwaway directory too.
  export HUE_TX_DIR="$dir/tx"
  # The launcher pools workers by (argv, cwd, VGI_RPC_* env): a per-file value
  # gives each file its own worker processes, started with this file's env.
  export VGI_RPC_HUE_TEST_FILE="$n"
  case "$TRANSPORT" in
    stdio)  export HUE_WORKER="$WORKER" ;;
    launch) export HUE_WORKER="launch:$WORKER" ;;
    http)
      start_server "$dir/worker.log" "$WORKER" --http --port 0
      WORKER_PID="${PIDS[${#PIDS[@]}-1]}"
      export HUE_WORKER="http://127.0.0.1:$PORT"
      ;;
  esac
}

# stop_fixtures — stop this file's mock (and worker); keep the PIDS list for cleanup.
stop_fixtures() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  for p in ${PIDS[@]+"${PIDS[@]}"}; do wait "$p" 2>/dev/null || true; done
  PIDS=()
}

# Stage the tests, rewriting `require vgi` into a signed INSTALL + LOAD (the
# standalone runner links no extensions) and loading httpfs for HTTP workers.
mkdir -p "$STAGE/test/sql"
TEST_FILES=("$REPO"/test/sql/*.test)
if [ -n "${RECIPES_WORKER:-}" ] && [ "$HTTP" = "0" ]; then
  TEST_FILES+=("$REPO"/examples/test/*.test)
fi
for f in "${TEST_FILES[@]}"; do
  awk -v http="$HTTP" '
    /^require[ \t]+vgi[ \t]*$/ {
      print "statement ok"; print "LOAD vgi;"; print ""
      if (http == 1) { print "statement ok"; print "LOAD httpfs;"; print "" }
      next
    }
    { print }' "$f" > "$STAGE/test/sql/$(basename "$f")"
done

# Install the extensions once, refreshing any stale cached copy of vgi.
cat > "$STAGE/test/_warm.test" <<'EOF'
statement ok
FORCE INSTALL vgi FROM community;

statement ok
INSTALL httpfs FROM core;

statement ok
INSTALL json FROM core;
EOF
"$HAYBARN_UNITTEST" --keep-home --test-dir "$STAGE" "test/_warm.test" >/dev/null 2>&1 \
  || echo "::warning::extension warm-up did not fully succeed"
rm -f "$STAGE/test/_warm.test"

cat > "$STAGE/no_error_skip.json" <<'EOF'
{"skip_error_messages": ["__vgi_hue_never_matches__"]}
EOF

echo "Running test/sql over $TRANSPORT, one fresh mock bridge per file"
LOG="$STAGE/unittest.log"
: > "$LOG"
rc=0
n=0
for staged in "$STAGE"/test/sql/*.test; do
  n=$((n + 1))
  name="$(basename "$staged")"
  fixtures="$STAGE/fixtures/$n"
  start_fixtures "$fixtures" "$n"
  echo "== $name (worker: $HUE_WORKER, bridge: $HUE_MOCK_BRIDGE)"
  file_rc=0
  ( cd "$STAGE" && "$HAYBARN_UNITTEST" --keep-home --test-dir "$STAGE" \
      --test-config "$STAGE/no_error_skip.json" "test/sql/$name" ) 2>&1 | tee "$fixtures/unittest.log" \
    && file_rc=0 || file_rc="${PIPESTATUS[0]}"
  cat "$fixtures/unittest.log" >> "$LOG"
  [ "$file_rc" = "0" ] || { echo "::error::$name failed over $TRANSPORT"; rc=1; }
  if [ "$HTTP" = "1" ] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "::error::the HTTP worker died during $name:"; cat "$fixtures/worker.log"; rc=1
  fi
  stop_fixtures
done

if grep -q 'No test cases matched\|No tests ran' "$LOG"; then
  echo "::error::no test cases matched; the staging is wrong"; exit 1
fi
# Each file's log reports [i/1]; count the files, then subtract skips.
total="$(grep -c '^\[1/1\]' "$LOG" || true)"
total="${total:-0}"
skips="$(awk '/^Skipped tests for the following reasons:/{b=1;next} b&&/^[[:space:]]*$/{b=0} b&&match($0,/: [0-9]+[[:space:]]*$/){print substr($0,1,RSTART-1) "\t" substr($0,RSTART+2)+0}' "$LOG")"
skipped=0
while IFS=$'\t' read -r reason count; do
  [ -n "$reason" ] || continue
  skipped=$((skipped + count))
  if ! printf '%s\n' "${EXPECTED_SKIP_REASONS:-}" | grep -qxF "$reason"; then
    echo "::error::unexpected skip: '$reason'. A test file silently stopped running;" \
         "fix the gate or add it to EXPECTED_SKIP_REASONS."
    rc=1
  fi
done <<< "$skips"
executed=$((total - skipped))
echo "executed $executed of $total test files over $TRANSPORT ($skipped skipped)"
if [ "$executed" -lt "$MIN_EXECUTED" ]; then
  echo "::error::only $executed test files ran (MIN_EXECUTED=$MIN_EXECUTED)"; rc=1
fi
exit "$rc"
