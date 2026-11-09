# Setting up NEXUS on your Mac

Target: MacBook Pro, Apple M5 Pro, 24 GB unified memory, recent macOS. Everything below keeps your
existing Hermes and Ollama setups untouched.

## 1. Audit first (read-only)

```bash
./scripts/audit.sh
```

Writes `docs/AUDIT-<host>.md`: hardware, memory pressure, tool versions, Ollama service + `ollama
list` + `ollama ps`, Hermes binary/version/config summary (never `.env`), API server status, port
usage (8765, 1420, 11434, 8642, 6333), LaunchAgents and nearby projects. Review it before continuing.

## 2. Prerequisites

| Tool | Why | Install if missing |
|---|---|---|
| Python ≥ 3.11 | core service | `brew install python@3.12` — or let `setup.sh` fetch a private copy via uv |
| Node ≥ 20 | desktop UI build | `brew install node` |
| Rust (stable) | Tauri shell | rustup (setup.sh offers it) |
| Xcode Command Line Tools | Tauri macOS build | `xcode-select --install` |
| Ollama | local inference | you already have it |
| ffmpeg *(optional)* | voice: convert recordings | `brew install ffmpeg` |
| mlx-whisper *(optional)* | voice: local STT on the GPU | setup.sh offers it (installs into the NEXUS venv only) |

No Docker is needed.

## 3. Install

```bash
./scripts/setup.sh
```

Creates `services/core/.venv`, installs npm dependencies, writes
`~/Library/Application Support/com.nexus.desktop/launcher.json` (paths the app uses to start the
core) and runs the backend test suite. It asks before anything global.

## 4. Run

```bash
./scripts/dev.sh          # core + desktop app (hot reload)
./scripts/dev.sh --web    # core + UI in a browser tab
./scripts/build.sh        # NEXUS.app + .dmg in apps/desktop/src-tauri/target/…/bundle
```

**Install NEXUS as an app** (recommended for daily use):

```bash
./scripts/install-app.sh
```

Builds `NEXUS.app` (5–10 minutes the first time), installs it in `/Applications` (or
`~/Applications` if you can't write there) and opens it. From then on open NEXUS like any other app —
Applications, Launchpad, Spotlight or the Dock. The app starts the NEXUS core itself (using the
environment `setup.sh` created) and stops it when you quit; your data in `data/` is shared with
`dev.sh`. To update: `git pull && ./scripts/install-app.sh`. The app runs from this checkout, so keep
the `nexus` folder where it is.

On first launch macOS asks for **Microphone** access the first time you use push-to-talk. NEXUS
does not need Full Disk Access — it only reads folders you approve inside the app.

Optional — keep the core (and scheduled automations) running when the app is closed:
`./scripts/launchagent.sh install` (remove with `uninstall`).

## Choosing models for 24 GB

macOS, your apps and the model's KV cache share the 24 GB. NEXUS's memory guard refuses a load that
would exceed 75 % of currently free memory and, in single-model mode, unloads the previous chat model
first. Suggested starting point — **validate on your machine with System → "Measure a model"**, which
records load time, tok/s, time-to-first-token, resident size, pressure and tool-calling success:

| Role (NEXUS category) | Suggested | Approx. size (Q4) | Notes |
|---|---|---|---|
| Default / general / documents | `qwen3:14b` | ~9 GB | Good tool-calling, leaves headroom |
| Reasoning (heavy) | `gpt-oss:20b` | ~13–14 GB | Use when other heavy apps are closed; keep ctx ≤ 8–16k |
| Coding | `qwen2.5-coder:14b` | ~9 GB | Or reuse the default |
| Classification (fast) | `qwen3:4b` | ~2.5 GB | Automations, memory extraction |
| Embeddings | `nomic-embed-text` | ~0.3 GB | Enables semantic/hybrid search |

```bash
ollama pull qwen3:14b && ollama pull nomic-embed-text   # only pull what you decide to use
```

Assign them in **Settings → Models**. Don't assume the largest model is best: compare
`gpt-oss:20b` and a 14B model with the benchmark and keep the one whose speed, quality and
tool-calling you prefer. Optional Ollama server settings that reduce memory (change them only if you
choose to; they are global): `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_FLASH_ATTENTION=1`,
`OLLAMA_KV_CACHE_TYPE=q8_0`.

## Connecting Hermes

NEXUS works without Hermes (native runtime). To route agent tasks through your existing Hermes:

**Option A — API server (recommended: live events, cancel, approvals).** In `~/.hermes/.env` *(you
edit this; NEXUS never does)*:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<long random string, e.g. from: openssl rand -hex 32>
```

Run `hermes gateway`, then paste the same key in **Settings → Hermes** (stored in the Keychain).
The Agents page shows "Hermes · ready · API server".

**Option B — CLI.** If `hermes` is on your PATH (or `NEXUS_HERMES_BIN` points to it), NEXUS runs
one-shot tasks with `--format stream-json`. Hermes' approval prompts cannot be answered in this
mode, so risky tools are refused by Hermes' own policy.

To point Hermes at the same Ollama models, follow Hermes' own `hermes model` setup — NEXUS doesn't
change Hermes' provider.

## Updating NEXUS

NEXUS checks your GitHub branch for new versions about a minute after it starts and every 6 hours
(turn this off in **Settings → Updates**). When there is one, an **Update available** pill appears in
the title bar and you get a notification. **Settings → Updates** lists what changed; **Update &
restart** downloads it, refreshes packages, rebuilds the phone app and — when you use the installed
app — rebuilds and reopens NEXUS.app (a few minutes; keep working meanwhile). Nothing installs without
your click, updates are refused if NEXUS's files were edited locally, and a paired phone can't start
one. From Terminal: `./scripts/update.sh --app` (installed app) or `--dev` (dev.sh). Progress is
written to `data/logs/update.log`.

## Using NEXUS from your phone

The phone app is a companion: everything still runs on your Mac. It needs your Mac awake with the
NEXUS core running (keep the app open, or install the LaunchAgent: `./scripts/launchagent.sh install`).

1. **Tailscale** — install it on the Mac and the phone and sign in to the same account
   (free for personal use). It encrypts the connection and works away from home with no port
   forwarding.
2. **Expose NEXUS to your tailnet** — on the Mac, once: `tailscale serve --bg 8765`.
   This gives the Mac an HTTPS address like `https://my-mac.tail1234.ts.net` that only your own
   devices can reach. NEXUS itself keeps listening on 127.0.0.1 only. (HTTPS is also what lets the
   phone use its microphone and install the app.)
3. **In NEXUS → Settings → Phone** — confirm the Mac's address (auto-detected from Tailscale), turn
   on **Allow remote access**, and press **Pair a phone**.
4. **On the phone** — scan the QR code, or open `https://<your-mac>.ts.net/m/` and type the 8-character
   code. On iPhone, tap Share → **Add to Home Screen** first and pair from the home-screen app (it keeps
   its own storage). On Android, use Chrome's **Install app**.

Revoke a phone any time in Settings → Phone; turning remote access off locks out every phone
instantly. The phone app is built by `setup.sh`; rebuild after updates with
`cd apps/desktop && npm run build:mobile`.

Not using Tailscale? Any HTTPS reverse proxy *on the Mac* that forwards to `127.0.0.1:8765` works the
same way (add its hostname in Settings → Phone). NEXUS deliberately does not listen on your network
directly.

## Configuration

Static settings are environment variables (see `.env.example`); runtime preferences are edited in
**Settings** and stored in SQLite. Secrets live in the macOS Keychain (service `com.nexus.desktop`).

| Variable | Default |
|---|---|
| `NEXUS_DATA_DIR` | `<repo>/data` (source checkout) or `~/Library/Application Support/NEXUS` |
| `NEXUS_PORT` | `8765` (bind address is always loopback) |
| `NEXUS_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `NEXUS_HERMES_MODE` | `auto` (`api`, `cli`, `off`) |
| `NEXUS_HERMES_API_URL` | `http://127.0.0.1:8642` |
| `NEXUS_HERMES_BIN` | `hermes` on PATH |
| `NEXUS_WHISPER_MODEL` | path to a ggml model for whisper.cpp |
| `NEXUS_PIPER_VOICE` | path to a Piper `.onnx` voice |
| `NEXUS_MOBILE_DIST` | built phone app (default `apps/desktop/dist-mobile`, served at `/m`) |
