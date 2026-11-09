#!/usr/bin/env bash
# Update NEXUS from its git branch. Started by Settings → Updates → "Update & restart"
# (or run it yourself). Output goes to data/logs/update.log when started from the app.
#
#   ./scripts/update.sh --app   pull, refresh dependencies, rebuild + reinstall + reopen NEXUS.app
#   ./scripts/update.sh --dev   pull and refresh dependencies (then restart ./scripts/dev.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---dev}"
CORE="$ROOT/services/core"
VENV_PY="$CORE/.venv/bin/python"

step() { printf '\n[%s] ▸ %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() {
  printf '\n[%s] ✗ Update failed during: %s\nNEXUS_UPDATE_FAILED\n' "$(date +%H:%M:%S)" "${CURRENT:-start}"
  if [[ "$(uname)" == "Darwin" ]]; then
    osascript -e 'display notification "See Settings → Updates for details." with title "NEXUS update failed"' >/dev/null 2>&1 || true
  fi
}
trap fail ERR

# Started from the app, PATH can be minimal: add the usual tool locations.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
if ! command -v npm >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
fi

cd "$ROOT"
CURRENT="checking for local changes"; step "$CURRENT"
if [[ -n "$(git status --porcelain --untracked-files=no -- .)" ]]; then
  echo "Local changes in the NEXUS folder — not updating:"
  git status --short --untracked-files=no -- .
  false
fi

CURRENT="downloading the update (git pull)"; step "$CURRENT"
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only
AFTER="$(git rev-parse --short HEAD)"
echo "Updated $BEFORE → $AFTER"
git log -30 --format='  • %s' "$BEFORE..$AFTER" -- .

CURRENT="updating the NEXUS core's Python packages"; step "$CURRENT"
if command -v uv >/dev/null 2>&1; then
  uv pip install -q --python "$VENV_PY" -e "$CORE"
else
  "$VENV_PY" -m pip install -q -e "$CORE"
fi

CURRENT="updating the app's packages"; step "$CURRENT"
(cd "$ROOT/apps/desktop" && npm install --no-audit --no-fund --loglevel=error)

CURRENT="rebuilding the phone app"; step "$CURRENT"
(cd "$ROOT/apps/desktop" && npm run --silent build:mobile)

if [[ "$MODE" == "--app" ]]; then
  CURRENT="rebuilding and reinstalling NEXUS.app (a few minutes)"; step "$CURRENT"
  "$ROOT/scripts/install-app.sh"
  step "Done — NEXUS has restarted on $AFTER."
else
  step "Done. Restart ./scripts/dev.sh (Ctrl+C, then run it again) to use $AFTER."
fi
echo "NEXUS_UPDATE_DONE"
