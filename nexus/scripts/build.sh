#!/usr/bin/env bash
# Build NEXUS.app and a .dmg (Apple Silicon). The app launches the core service
# from this checkout using launcher.json written by setup.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Rust installed by setup.sh lives in ~/.cargo; load it even if this shell started before the install.
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
cd "$ROOT/apps/desktop"
npm run typecheck
npm test
npx tauri build --target aarch64-apple-darwin "$@"
echo
echo "Built:"
ls -1 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null
echo "Unsigned build: on first launch, right-click NEXUS.app → Open (or sign it with your Developer ID)."
