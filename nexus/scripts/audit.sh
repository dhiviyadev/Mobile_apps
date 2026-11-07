#!/usr/bin/env bash
# NEXUS Phase 0 — environment audit. READ-ONLY: installs nothing, changes nothing,
# never prints secrets. Writes a Markdown report you can review and share.
#
#   ./scripts/audit.sh                 # writes docs/AUDIT-<hostname>.md
#   ./scripts/audit.sh /tmp/audit.md   # custom path
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/AUDIT-$(hostname -s 2>/dev/null || echo mac).md}"
mkdir -p "$(dirname "$OUT")"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

have() { command -v "$1" >/dev/null 2>&1; }
ver() { if have "$1"; then "$@" 2>&1 | head -n1; else echo "not installed"; fi; }
section() { printf '\n## %s\n\n' "$1" >> "$OUT"; }
kv() { printf -- '- **%s:** %s\n' "$1" "$2" >> "$OUT"; }
code() { printf '```\n%s\n```\n' "$1" >> "$OUT"; }

: > "$OUT"
printf '# NEXUS environment audit\n\nGenerated %s on `%s`. Read-only audit — nothing was modified.\n' "$(date '+%Y-%m-%d %H:%M')" "$(hostname)" >> "$OUT"

section "1. Hardware & OS"
if [[ "$(uname)" == "Darwin" ]]; then
  kv "Model" "$(sysctl -n hw.model 2>/dev/null)"
  kv "Chip" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  kv "Cores (P / E)" "$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null) / $(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null)"
  MEM=$(sysctl -n hw.memsize 2>/dev/null); kv "Unified memory" "$((MEM / 1024 / 1024 / 1024)) GB"
  kv "macOS" "$(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  kv "Architecture" "$(uname -m)"
  kv "GPU" "$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model|Total Number of Cores/{printf "%s %s; ", $1, $2}' | sed 's/  */ /g')"
else
  kv "Platform" "$(uname -srm) — NOTE: NEXUS targets macOS on Apple Silicon"
fi

section "2. Memory & storage right now"
if [[ "$(uname)" == "Darwin" ]]; then
  PL=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
  case "$PL" in 1) PLT="normal";; 2) PLT="warning";; 4) PLT="critical";; *) PLT="unknown";; esac
  kv "Memory pressure" "$PLT (level $PL)"
  code "$(memory_pressure -Q 2>/dev/null | tail -n 3)"
  code "$(vm_stat 2>/dev/null | head -n 12)"
  kv "Swap" "$(sysctl -n vm.swapusage 2>/dev/null)"
  code "$(ps -A -o rss=,comm= | sort -rn | head -n 10 | awk '{printf "%6.0f MB  %s\n", $1/1024, $2}')"
fi
code "$(df -h "$HOME" | tail -n +1)"

section "3. Development tools"
for t in "python3 --version" "node --version" "npm --version" "pnpm --version" "git --version" "brew --version" "cargo --version" "rustc --version" "uv --version" "ffmpeg -version" "whisper-cli --help" "piper --version" "docker --version"; do
  set -- $t; kv "$1" "$(ver "$@")"
done
kv "Xcode CLT" "$(xcode-select -p 2>/dev/null || echo 'not installed')"
kv "python3 path" "$(command -v python3 || echo -)"
if have python3; then kv "mlx_whisper importable" "$(python3 -c 'import mlx_whisper; print("yes")' 2>/dev/null || echo no)"; fi

section "4. Ollama"
if have ollama; then
  kv "Binary" "$(command -v ollama)"
  kv "Version" "$(ollama --version 2>&1 | tail -n1)"
  if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    kv "Service" "running on 127.0.0.1:11434"
    printf '\nInstalled models (`ollama list`):\n' >> "$OUT"; code "$(ollama list 2>&1)"
    printf '\nLoaded now (`ollama ps`):\n' >> "$OUT"; code "$(ollama ps 2>&1)"
  else
    kv "Service" "NOT running (start the Ollama app or \`ollama serve\`)"
    printf '\nModels on disk (`ollama list`):\n' >> "$OUT"; code "$(ollama list 2>&1)"
  fi
  for v in OLLAMA_HOST OLLAMA_MODELS OLLAMA_KEEP_ALIVE OLLAMA_MAX_LOADED_MODELS OLLAMA_NUM_PARALLEL OLLAMA_FLASH_ATTENTION OLLAMA_KV_CACHE_TYPE; do
    kv "$v" "${!v:-(unset)} / launchctl: $(launchctl getenv "$v" 2>/dev/null || true)"
  done
  kv "Models dir size" "$(du -sh "${OLLAMA_MODELS:-$HOME/.ollama/models}" 2>/dev/null | cut -f1)"
else
  kv "Ollama" "not installed"
fi

section "5. Hermes Agent (read-only — ~/.hermes is never modified)"
if have hermes; then
  kv "Binary" "$(command -v hermes)"
  kv "Version" "$(hermes --version 2>&1 | head -n1)"
else
  kv "Binary" "not on PATH"
fi
kv "HERMES_HOME" "$HERMES_HOME ($( [[ -d $HERMES_HOME ]] && echo exists || echo missing ))"
if [[ -d "$HERMES_HOME" ]]; then
  kv "config.yaml" "$( [[ -f $HERMES_HOME/config.yaml ]] && echo present || echo missing )"
  kv ".env" "$( [[ -f $HERMES_HOME/.env ]] && echo 'present (contents NOT read)' || echo missing )"
  if [[ -f "$HERMES_HOME/config.yaml" ]] && have python3; then
    printf '\nNon-secret config summary (model / gateway.api_server enabled, host, port / toolsets):\n' >> "$OUT"
    code "$(python3 - "$HERMES_HOME/config.yaml" <<'PY' 2>&1
import sys
try:
    import yaml
except ImportError:
    print("(PyYAML not available to python3; skipped)"); sys.exit()
d = yaml.safe_load(open(sys.argv[1])) or {}
m = d.get("model"); print("model:", {k: m.get(k) for k in ("provider", "default", "base_url")} if isinstance(m, dict) else m)
gw = ((d.get("gateway") or {}).get("api_server") or {})
print("gateway.api_server:", {k: gw.get(k) for k in ("enabled", "host", "port")})
a = d.get("agent") or {}; print("agent:", {k: a.get(k) for k in ("max_turns", "disabled_toolsets")})
print("toolsets:", d.get("toolsets"))
PY
)"
  fi
  kv "Skills installed" "$(ls -1 "$HERMES_HOME/skills" 2>/dev/null | wc -l | tr -d ' ')"
  kv "Memory files" "$(ls -1 "$HERMES_HOME/memories" 2>/dev/null | tr '\n' ' ')"
  kv "Profiles" "$(ls -1 "$HERMES_HOME/profiles" 2>/dev/null | tr '\n' ' ')"
  if have hermes; then
    printf '\n`hermes status` (truncated):\n' >> "$OUT"; code "$(timeout 20 hermes status 2>&1 | head -n 30)"
    printf '\n`hermes cron list`:\n' >> "$OUT"; code "$(timeout 20 hermes cron list 2>&1 | head -n 20)"
    printf '\nCLI capability check (`hermes chat --help`):\n' >> "$OUT"
    code "$(timeout 20 hermes chat --help 2>&1 | grep -E -- '--oneshot|--query-file|--format|--toolsets|--source' | head -n 10)"
  fi
fi
if curl -fsS --max-time 2 http://127.0.0.1:8642/health >/dev/null 2>&1; then
  kv "Hermes API server" "running on 127.0.0.1:8642 (NEXUS will use /v1/runs)"
else
  kv "Hermes API server" "not running (NEXUS will use the CLI or its native runtime)"
fi

section "6. Ports & services"
for port in 8765 1420 11434 8642 6333; do
  who=$(lsof -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}')
  kv "Port $port" "${who:-free}"
done
printf '\n(8765 NEXUS core · 1420 NEXUS dev UI · 11434 Ollama · 8642 Hermes API · 6333 Qdrant)\n' >> "$OUT"
printf '\nUser LaunchAgents:\n' >> "$OUT"; code "$(ls -1 "$HOME/Library/LaunchAgents" 2>/dev/null)"

section "7. Existing projects that could be affected"
for d in "$HOME/Developer" "$HOME/Projects" "$HOME/Code" "$HOME/src" "$HOME/dev"; do
  [[ -d "$d" ]] && kv "$d" "$(ls -1 "$d" 2>/dev/null | head -n 25 | tr '\n' ' ')"
done
kv "Global npm packages" "$(npm ls -g --depth=0 2>/dev/null | tail -n +2 | tr '\n' ' ' | cut -c1-400)"
kv "Global git hooksPath" "$(git config --global core.hooksPath || echo none)"

section "8. Recommendations computed from this machine"
if [[ "$(uname)" == "Darwin" ]]; then
  GB=$((MEM / 1024 / 1024 / 1024))
  printf -- '- Physical memory: %s GB. Keep the resident model at or below ~%s GB so macOS, apps and the KV cache fit.\n' "$GB" "$((GB * 55 / 100))" >> "$OUT"
  printf -- '- On 24 GB: a 14B Q4 model (~9 GB) as default; gpt-oss:20b (~13–14 GB) only with other heavy apps closed; never both at once.\n' >> "$OUT"
  printf -- '- Keep OLLAMA_MAX_LOADED_MODELS=1 (or rely on NEXUS single-model mode) and a small embedding model (nomic-embed-text, ~0.3 GB).\n' >> "$OUT"
fi
printf '\n---\nNext: review this file, then run `./scripts/setup.sh`.\n' >> "$OUT"
echo "Audit written to $OUT"
