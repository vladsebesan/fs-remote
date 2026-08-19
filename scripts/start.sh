#!/usr/bin/env bash
# Restart fsremote stack: stop listeners on 8080/5173, run server, open the web UI (Vite).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "Stopping listener(s) on port ${port}: ${pids}"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.4
    pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "${pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
    fi
  fi
}

echo "Stopping any existing fsremote server / UI on ports 8080 and 5173…"
kill_port 8080
kill_port 5173
# Any leftover fsremote-server process (e.g. crashed after bind)
pkill -f '/fsremote-server' 2>/dev/null || true

mkdir -p "${ROOT}/data"
export FSREMOTE_CONFIG="${FSREMOTE_CONFIG:-${ROOT}/config.toml}"

echo "Starting fsremote-server (${FSREMOTE_CONFIG})…"
cargo run -p fsremote-server &
SERVER_PID=$!

cleanup() {
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Stopping fsremote-server (pid ${SERVER_PID})…"
    kill "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Waiting for http://127.0.0.1:8080/health …"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:8080/health" >/dev/null; then
    echo "Server is up."
    break
  fi
  sleep 0.25
done

if ! curl -sf "http://127.0.0.1:8080/health" >/dev/null; then
  echo "Server did not become healthy in time; check logs above." >&2
  exit 1
fi

cd "${ROOT}/web"
echo "Starting Vite (opens browser). Press Ctrl+C to stop the UI and server."
npm run dev -- --open --host 127.0.0.1 --port 5173
