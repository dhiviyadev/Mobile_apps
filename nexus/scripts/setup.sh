#!/usr/bin/env bash
# NEXUS setup for macOS (Apple Silicon). Idempotent. Explains and asks before
# installing anything outside this folder. Never touches ~/.hermes or Ollama models.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/services/core"
APP="$ROOT/apps/desktop"
CONFIG_DIR="$HOME/Library/Application Support/com.nexus.desktop"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
ask() { read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ "$(uname)" == "Darwin" ]] || echo "Warning: NEXUS targets macOS; continuing for development."

say "Checking prerequisites"
have python3 || { echo "python3 is required (brew install python@3.12)"; exit 1; }
PYV=$(python3 -c 'import sys; print("%d%02d" % sys.version_info[:2])')
(( PYV >= 311 )) || { echo "Python 3.11+ required (found $(python3 --version))"; exit 1; }
have node || { echo "Node.js 20+ is required (brew install node)"; exit 1; }
if ! have cargo; then
  echo "Rust is required to build the desktop shell (Tauri)."
  if ask "Install Rust via rustup (https://rustup.rs, installs to ~/.cargo)?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    echo "Skipping. You can still run the UI in a browser with scripts/dev.sh --web."
  fi
fi
xcode-select -p >/dev/null 2>&1 || echo "Note: Xcode Command Line Tools are needed for Tauri builds (xcode-select --install)."

say "Python environment for the core service ($CORE/.venv)"
if have uv; then
  uv venv -q "$CORE/.venv" 2>/dev/null || true
  uv pip install -q --python "$CORE/.venv/bin/python" -e "$CORE[dev]"
else
  python3 -m venv "$CORE/.venv"
  "$CORE/.venv/bin/pip" install -q --upgrade pip
  "$CORE/.venv/bin/pip" install -q -e "$CORE[dev]"
fi

if [[ "$(uname -m)" == "arm64" ]] && ! "$CORE/.venv/bin/python" -c 'import mlx_whisper' 2>/dev/null; then
  echo "Local speech recognition: mlx-whisper runs Whisper on the Apple Silicon GPU (~100 MB + model download on first use)."
  if ask "Install mlx-whisper into the NEXUS venv?"; then
    "$CORE/.venv/bin/pip" install -q "mlx-whisper>=0.4" || "$CORE/.venv/bin/python" -m pip install -q "mlx-whisper>=0.4"
  fi
fi
if ! have ffmpeg; then
  echo "ffmpeg converts push-to-talk recordings for transcription."
  if have brew && ask "brew install ffmpeg?"; then brew install ffmpeg; fi
fi

say "Desktop app dependencies"
(cd "$APP" && npm install --no-fund --no-audit)

say "Recording launcher paths for the desktop shell ($CONFIG_DIR/launcher.json)"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/launcher.json" <<JSON
{
  "repo_dir": "$ROOT",
  "python": "$CORE/.venv/bin/python",
  "data_dir": "$ROOT/data"
}
JSON

say "Running backend tests"
(cd "$CORE" && .venv/bin/python -m pytest -q) || echo "Some tests failed — see output above."

cat <<EOF

NEXUS is set up.
  • Development:   ./scripts/dev.sh           (core + desktop app with hot reload)
  • Build the app: ./scripts/build.sh         (produces NEXUS.app and a .dmg)
  • Models:        see SETUP.md → "Choosing models for 24 GB"
  • Hermes:        optional; see SETUP.md → "Connecting Hermes" (NEXUS never edits ~/.hermes)
EOF
