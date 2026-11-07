#!/usr/bin/env bash
# Run NEXUS in development: the core service plus the Tauri app (or just the web UI).
#   ./scripts/dev.sh          core + Tauri desktop app
#   ./scripts/dev.sh --web    core + Vite dev server; open http://127.0.0.1:1420/?token=<token>
#   ./scripts/dev.sh --core   core only
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NEXUS_DATA_DIR="${NEXUS_DATA_DIR:-$ROOT/data}"
PY="$ROOT/services/core/.venv/bin/python"
[[ -x "$PY" ]] || { echo "Run ./scripts/setup.sh first."; exit 1; }

cleanup() { [[ -n "${CORE_PID:-}" ]] && kill "$CORE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if curl -fsS --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "NEXUS core already running on :8765"
else
  (cd "$ROOT/services/core" && "$PY" -m nexus_core) &
  CORE_PID=$!
  for _ in $(seq 1 40); do curl -fsS --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1 && break; sleep 0.25; done
fi
echo "API token: $NEXUS_DATA_DIR/secrets/api_token"

case "${1:-}" in
  --core) wait ;;
  --web)
    echo "Open: http://127.0.0.1:1420/?token=$(cat "$NEXUS_DATA_DIR/secrets/api_token")"
    (cd "$ROOT/apps/desktop" && npx vite) ;;
  *) (cd "$ROOT/apps/desktop" && NEXUS_REPO="$ROOT" NEXUS_PYTHON="$PY" npx tauri dev) ;;
esac
