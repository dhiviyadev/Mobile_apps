#!/usr/bin/env bash
# Freeze the NEXUS core into a self-contained folder (no Python needed on the Mac that runs it):
#   build/core/nexus-core            the executable
#   build/core/_internal/            its Python runtime and libraries
#   build/core/nexus-ocr, nexus-cal  native helpers (macOS, when swiftc is available)
# Used by scripts/build-standalone.sh to put the core inside NEXUS.app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/services/core"
PY="$CORE/.venv/bin/python"
OUT="$ROOT/build/core"

[[ -x "$PY" ]] || { echo "Run ./scripts/setup.sh first."; exit 1; }
"$PY" -c "import PyInstaller" 2>/dev/null || {
  echo "▸ Installing PyInstaller into the NEXUS environment"
  if "$PY" -m pip --version >/dev/null 2>&1; then "$PY" -m pip install --quiet "pyinstaller>=6.6"
  else uv pip install --quiet --python "$PY" "pyinstaller>=6.6"; fi
}

WORK="$ROOT/build/pyinstaller"
rm -rf "$OUT" "$WORK"
mkdir -p "$WORK"
echo "▸ Freezing the core (takes a minute or two)"
(cd "$CORE" && "$PY" -m PyInstaller nexus_core_entry.py \
  --name nexus-core --onedir --noconfirm --clean --log-level WARN \
  --distpath "$WORK/dist" --workpath "$WORK/work" --specpath "$WORK" \
  --collect-data nexus_core \
  --collect-submodules uvicorn \
  --collect-submodules pywebpush --collect-submodules py_vapid --collect-submodules http_ece \
  --hidden-import pypdf --hidden-import docx --hidden-import openpyxl \
  --exclude-module tkinter --exclude-module pytest)
mkdir -p "$(dirname "$OUT")"
mv "$WORK/dist/nexus-core" "$OUT"

if [[ "$(uname)" == "Darwin" ]] && command -v swiftc >/dev/null 2>&1; then
  for helper in nexus-ocr nexus-cal; do
    echo "▸ Building $helper"
    swiftc -O -o "$OUT/$helper" "$CORE/nexus_core/native/$helper.swift"
  done
fi

echo "▸ Checking the frozen core starts"
TMP="$(mktemp -d)"
NEXUS_DATA_DIR="$TMP" NEXUS_PORT=8791 NEXUS_BACKGROUND=0 "$OUT/nexus-core" >"$TMP/out.log" 2>&1 &
PID=$!
ok=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 http://127.0.0.1:8791/health >/dev/null 2>&1; then ok=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
if [[ "$ok" != 1 ]]; then
  echo "The frozen core did not start:"; tail -20 "$TMP/out.log"; rm -rf "$TMP"; exit 1
fi
rm -rf "$TMP"
echo "Built $OUT ($(du -sh "$OUT" | cut -f1))"
