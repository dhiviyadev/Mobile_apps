#!/usr/bin/env bash
# Restore a NEXUS backup created from Settings → Backup. Quit NEXUS first.
# The current database and workspace are moved aside (never deleted).
set -euo pipefail
ARCHIVE="${1:?usage: restore.sh <nexus-YYYYmmdd-HHMMSS.tar.gz>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${NEXUS_DATA_DIR:-$ROOT/data}"

if curl -fsS --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "NEXUS core is running. Quit NEXUS (tray → Quit) before restoring."; exit 1
fi
TMP="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'nexus-*' | head -n1)"
[[ -f "$SRC/nexus.db" ]] || { echo "Archive does not contain nexus.db"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
ASIDE="$DATA/pre-restore-$STAMP"
mkdir -p "$ASIDE"
for f in "$DATA/database/nexus.db" "$DATA/database/nexus.db-wal" "$DATA/database/nexus.db-shm"; do
  [[ -f "$f" ]] && mv "$f" "$ASIDE/"
done
[[ -d "$DATA/workspace" ]] && mv "$DATA/workspace" "$ASIDE/workspace"

mkdir -p "$DATA/database"
cp "$SRC/nexus.db" "$DATA/database/nexus.db"
[[ -d "$SRC/workspace" ]] && cp -R "$SRC/workspace" "$DATA/workspace" || mkdir -p "$DATA/workspace"
rm -rf "$TMP"
echo "Restored. Previous data kept in $ASIDE"
