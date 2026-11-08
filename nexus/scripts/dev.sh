#!/usr/bin/env bash
# Run NEXUS in development: the core service plus the Tauri app (or just the web UI).
#   ./scripts/dev.sh          core + Tauri desktop app
#   ./scripts/dev.sh --web    core + Vite dev server; open http://127.0.0.1:1420/?token=<token>
#   ./scripts/dev.sh --core   core only
#   ./scripts/dev.sh --mobile core + phone app dev server on http://127.0.0.1:1421/m/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NEXUS_DATA_DIR="${NEXUS_DATA_DIR:-$ROOT/data}"
# Rust installed by setup.sh lives in ~/.cargo; load it even if this shell started before the install.
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
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
  --mobile) (cd "$ROOT/apps/desktop" && npx vite --config vite.mobile.config.ts) ;;
  --web)
    echo "Open: http://127.0.0.1:1420/?token=$(cat "$NEXUS_DATA_DIR/secrets/api_token")"
    (cd "$ROOT/apps/desktop" && npx vite) ;;
  *)
    if ! command -v cargo >/dev/null 2>&1; then
      echo "Rust (cargo) isn't installed, so the desktop app can't be built yet."
      echo "Install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
      echo "Meanwhile you can use NEXUS in your browser: ./scripts/dev.sh --web"
      exit 1
    fi
    (cd "$ROOT/apps/desktop" && NEXUS_REPO="$ROOT" NEXUS_PYTHON="$PY" npx tauri dev) ;;
esac
