#!/usr/bin/env bash
# Build NEXUS.app and install it in /Applications (or ~/Applications), so it opens
# like any other Mac app. The app starts the NEXUS core by itself and stops it on quit.
#
#   ./scripts/install-app.sh            build + install + open
#   ./scripts/install-app.sh --no-open  build + install only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="NEXUS.app"
LAUNCHER="$HOME/Library/Application Support/com.nexus.desktop/launcher.json"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

[[ "$(uname)" == "Darwin" ]] || { echo "NEXUS.app can only be built on macOS."; exit 1; }
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || { echo "Rust is missing — run ./scripts/setup.sh first."; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Apple's build tools are missing — run: xcode-select --install"; exit 1; }
[[ -x "$ROOT/services/core/.venv/bin/python" && -f "$LAUNCHER" ]] || { echo "Run ./scripts/setup.sh first (the app uses the NEXUS environment it creates)."; exit 1; }

say "Building NEXUS.app (release build — the first time takes 5–10 minutes)"
cd "$ROOT/apps/desktop"
npx tauri build --bundles app
BUILT="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/$APP_NAME"
[[ -d "$BUILT" ]] || { echo "Build finished but $BUILT was not found."; exit 1; }

# Local, unsigned build: give it an ad-hoc signature so macOS runs it without complaints.
codesign --force --deep --sign - "$BUILT" >/dev/null 2>&1 || true

DEST_DIR="/Applications"
if [[ ! -w "$DEST_DIR" ]]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/$APP_NAME"

if pgrep -xq "nexus-desktop" || pgrep -fq "$DEST/Contents/MacOS"; then
  say "Quitting the running NEXUS app"
  osascript -e 'tell application "NEXUS" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

if [[ -d "$DEST" ]]; then
  # Keep the previous version in the Trash instead of deleting it.
  say "Moving the previous NEXUS.app to the Trash"
  mv "$DEST" "$HOME/.Trash/NEXUS-$(date +%Y%m%d-%H%M%S).app"
fi

say "Installing to $DEST"
ditto "$BUILT" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Stop a core started by ./scripts/dev.sh so the app manages its own (data is shared).
if curl -fsS --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "Note: a NEXUS core is already running (probably from ./scripts/dev.sh). The app will use it;"
  echo "      quit dev.sh (Ctrl+C) if you want the app to manage the core itself."
fi

cat <<EOF

NEXUS is installed: $DEST
  • Open it from Applications, Launchpad or Spotlight (⌘Space, type "NEXUS").
  • To keep it in the Dock: right-click its Dock icon → Options → Keep in Dock.
  • Closing the window keeps NEXUS in the menu bar; quit from the menu-bar icon or ⌘Q.
  • To update later: git pull && ./scripts/install-app.sh
EOF

[[ "${1:-}" == "--no-open" ]] || open "$DEST"
