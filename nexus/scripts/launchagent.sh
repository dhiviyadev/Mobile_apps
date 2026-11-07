#!/usr/bin/env bash
# Optional: run the NEXUS core as a per-user background service (LaunchAgent), so
# scheduled automations run even when the desktop window is closed.
#   ./scripts/launchagent.sh install | uninstall | status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.nexus.core"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$ROOT/services/core/.venv/bin/python"
DATA="${NEXUS_DATA_DIR:-$ROOT/data}"

case "${1:-status}" in
  install)
    [[ -x "$PY" ]] || { echo "Run ./scripts/setup.sh first."; exit 1; }
    mkdir -p "$DATA/logs" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-m</string><string>nexus_core</string></array>
  <key>WorkingDirectory</key><string>$ROOT/services/core</string>
  <key>EnvironmentVariables</key><dict><key>NEXUS_DATA_DIR</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$DATA/logs/launchagent.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/launchagent.log</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed and started $LABEL" ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL" ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|pid' || echo "not installed"
    curl -fsS --max-time 1 http://127.0.0.1:8765/health && echo ;;
  *) echo "usage: $0 install|uninstall|status"; exit 1 ;;
esac
