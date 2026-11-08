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
# Python 3.11+: use any suitable interpreter already installed (macOS's own python3 is often 3.9).
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; }
PY=""
for cand in python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 \
            /Library/Frameworks/Python.framework/Versions/Current/bin/python3 python3; do
  if have "$cand" || [[ -x "$cand" ]]; then
    if py_ok "$cand"; then PY="$(command -v "$cand" || echo "$cand")"; break; fi
  fi
done
USE_UV=0
have uv && USE_UV=1
if [[ -z "$PY" ]]; then
  echo "NEXUS needs Python 3.11 or newer (found: $(python3 --version 2>&1 || echo none))."
  if (( USE_UV )); then
    echo "uv is installed; it will download a private Python 3.12 just for NEXUS."
  elif ask "Install uv (https://astral.sh/uv, a small tool in ~/.local/bin) to fetch a private Python 3.12 for NEXUS? Your system Python is not changed."; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    have uv && USE_UV=1
  fi
  if (( ! USE_UV )); then
    echo "Install Python 3.12 (brew install python@3.12, or https://www.python.org/downloads/macos/), open a new Terminal and re-run this script."
    exit 1
  fi
fi
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
VENV_PY="$CORE/.venv/bin/python"
# Recreate the venv if it exists but was built with a Python that's too old.
if [[ -x "$VENV_PY" ]] && ! py_ok "$VENV_PY"; then
  echo "Existing environment uses $("$VENV_PY" --version 2>&1); rebuilding it with Python 3.11+."
  rm -rf "$CORE/.venv"
fi
if [[ ! -x "$VENV_PY" ]]; then
  if (( USE_UV )); then
    uv venv -q --python "${PY:-3.12}" "$CORE/.venv"
  else
    "$PY" -m venv "$CORE/.venv"
  fi
fi
# uv-built environments have no pip; install with whichever tool built it.
pip_install() {
  if (( USE_UV )); then uv pip install -q --python "$VENV_PY" "$@"
  else "$VENV_PY" -m pip install -q "$@"; fi
}
(( USE_UV )) || "$VENV_PY" -m pip install -q --upgrade pip
# PYTHONWARNINGS hides a harmless setuptools notice about editable installs.
PYTHONWARNINGS=ignore pip_install -e "$CORE[dev]" 2> >(grep -v -F -e BuildBackendWarning -e "Please be careful" -e "name as your package" -e "WheelFile(wheel_path" -e "*****" -e "!!" >&2 || true)
echo "Using $("$VENV_PY" --version)"

if [[ "$(uname -m)" == "arm64" ]] && ! "$VENV_PY" -c 'import mlx_whisper' 2>/dev/null; then
  echo "Local speech recognition: mlx-whisper runs Whisper on the Apple Silicon GPU (~100 MB + model download on first use)."
  if ask "Install mlx-whisper into the NEXUS venv?"; then
    echo "Installing mlx-whisper and its dependencies (a few hundred MB) — this usually takes 2–5 minutes…"
    if (( USE_UV )); then uv pip install --python "$VENV_PY" "mlx-whisper>=0.4"
    else "$VENV_PY" -m pip install --progress-bar on "mlx-whisper>=0.4"; fi
  fi
fi
if ! have ffmpeg; then
  echo "ffmpeg converts push-to-talk recordings for transcription."
  if have brew && ask "brew install ffmpeg?"; then brew install ffmpeg; fi
fi

say "Desktop app dependencies"
(cd "$APP" && npm install --no-fund --no-audit && npm run build:mobile)

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
(cd "$CORE" && "$VENV_PY" -m pytest -q) || echo "Some tests failed — see output above."

cat <<EOF

NEXUS is set up.
  • Development:   ./scripts/dev.sh           (core + desktop app with hot reload)
  • Build the app: ./scripts/build.sh         (produces NEXUS.app and a .dmg)
  • Models:        see SETUP.md → "Choosing models for 24 GB"
  • Hermes:        optional; see SETUP.md → "Connecting Hermes" (NEXUS never edits ~/.hermes)
EOF
