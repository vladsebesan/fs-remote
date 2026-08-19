#!/usr/bin/env bash
# Launch the Playwright e2e suite in a way that works around Cursor's
# extension-host process tree.
#
# The default mode opens a new Terminal.app window via `osascript`, so the
# spawned Chrome has Terminal (not Cursor) as its Responsible Process —
# avoiding the `TransformProcessType` / HIServices crash.
#
# Flags:
#   --detach     (default) open a new Terminal window.
#   --nohup      run fully headless/detached with nohup; output -> tests/e2e/run.log.
#   --foreground run in the current shell (same as `npm test`).
#
# Examples:
#   ./scripts/run-e2e.sh                 # new Terminal window, headed
#   ./scripts/run-e2e.sh --nohup         # background, log to file
#   HEADLESS=1 ./scripts/run-e2e.sh      # headless in a new Terminal window

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="${ROOT}/tests/e2e"
LOG="${E2E}/run.log"

MODE="detach"
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --detach) MODE="detach"; shift ;;
    --nohup) MODE="nohup"; shift ;;
    --foreground|--fg) MODE="foreground"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done

# Ports must be free so Playwright's webServer can bind them. We stop any
# existing listeners here (matches scripts/start.sh behaviour).
kill_port() {
  local port=$1 pids
  pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.3
    pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "${pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
    fi
  fi
}
kill_port 8080
kill_port 5173

CMD=(npm test)
if [[ ${#PASS_ARGS[@]} -gt 0 ]]; then
  CMD+=("--" "${PASS_ARGS[@]}")
fi

ENV_PREFIX=""
if [[ -n "${HEADLESS:-}" ]]; then
  ENV_PREFIX="HEADLESS=${HEADLESS} "
fi
# Cursor injects PLAYWRIGHT_BROWSERS_PATH into its integrated shell, which
# points at a sandbox-cache dir that only exists per-session. Unset it in the
# child shell so Playwright uses ~/Library/Caches/ms-playwright.
ENV_PREFIX="unset PLAYWRIGHT_BROWSERS_PATH; ${ENV_PREFIX}"

case "${MODE}" in
  foreground)
    cd "${E2E}"
    eval "${ENV_PREFIX} ${CMD[*]}"
    ;;

  nohup)
    mkdir -p "$(dirname "${LOG}")"
    : > "${LOG}"
    # `setsid`-style detach using nohup + new process group. We redirect all
    # std streams so the parent shell can exit immediately.
    nohup bash -lc "cd '${E2E}' && ${ENV_PREFIX} ${CMD[*]}" \
      >"${LOG}" 2>&1 </dev/null &
    PID=$!
    disown || true
    echo "fsremote e2e: launched PID=${PID}"
    echo "Logs: ${LOG}"
    echo "Follow with: tail -f '${LOG}'"
    ;;

  detach)
    if ! command -v osascript >/dev/null 2>&1; then
      echo "osascript not found; falling back to --nohup" >&2
      exec "$0" --nohup "${PASS_ARGS[@]}"
    fi
    # Build the one-liner Terminal will execute. Escape double quotes for
    # AppleScript.
    INNER="cd '${E2E}' && ${ENV_PREFIX} ${CMD[*]}; echo; echo '— e2e run finished (exit '\$?') —'; exec \$SHELL"
    # shellcheck disable=SC2001
    ESCAPED=$(printf '%s' "${INNER}" | sed 's/"/\\"/g')
    osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "${ESCAPED}"
end tell
APPLESCRIPT
    echo "fsremote e2e: launched in a new Terminal.app window."
    echo "Close the window when the run is done, or re-run tests inside it."
    ;;
esac
