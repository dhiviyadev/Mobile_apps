#!/usr/bin/env bash
# Build a self-contained NEXUS.app: the core service, its Python runtime, the native helpers and the
# phone app all live inside the app, so the Mac that runs it needs no Terminal setup at all
# (only Ollama, which the first-run guide checks for).
#
#   ./scripts/build-standalone.sh             build NEXUS.app + .dmg
#   ./scripts/build-standalone.sh --install   also copy it to /Applications and open it
#
# Data lives in ~/Library/Application Support/NEXUS (or the data folder of an existing setup).
# Updating a self-contained app means building or downloading a newer one; the in-app
# "Update & restart" button is for installs made from a checkout with install-app.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

[[ "$(uname)" == "Darwin" ]] || { echo "NEXUS.app can only be built on macOS."; exit 1; }
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || { echo "Rust is missing — run ./scripts/setup.sh first."; exit 1; }

"$ROOT/scripts/build-core-binary.sh"

cd "$ROOT/apps/desktop"
say "Building the phone app"
npm run build:mobile
RES="$ROOT/apps/desktop/src-tauri/resources"
rm -rf "$RES/core"
mkdir -p "$RES"
cp -R "$ROOT/build/core" "$RES/core"

say "Building NEXUS.app (release build — the first time takes 5–10 minutes)"
npx tauri build --bundles app,dmg --config src-tauri/tauri.standalone.conf.json
APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/NEXUS.app"
[[ -d "$APP" ]] || { echo "Build finished but $APP was not found."; exit 1; }
# Ad-hoc signature so macOS runs this local build; sign with a Developer ID and notarise to share it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo
echo "Built: $APP"
ls -1 "$ROOT"/apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true

if [[ "${1:-}" == "--install" ]]; then
  DEST_DIR="/Applications"; [[ -w "$DEST_DIR" ]] || { DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; }
  DEST="$DEST_DIR/NEXUS.app"
  osascript -e 'tell application "NEXUS" to quit' >/dev/null 2>&1 || true
  sleep 2
  if [[ -d "$DEST" ]]; then
    say "Moving the previous NEXUS.app to the Trash"
    mv "$DEST" "$HOME/.Trash/NEXUS-$(date +%Y%m%d-%H%M%S).app"
  fi
  say "Installing to $DEST"
  ditto "$APP" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  open "$DEST"
fi
