# Troubleshooting

## "NEXUS core is not running"

1. `curl http://127.0.0.1:8765/health` — should print `{"status":"ok","service":"nexus-core",…}`.
2. Read `data/logs/core-stdout.log` and `data/logs/core.log`.
3. Port taken? `lsof -nP -iTCP:8765 -sTCP:LISTEN`. Set `NEXUS_PORT` for the core *and* rebuild the
   app (the CSP allows 8765), or free the port.
4. `launcher.json` stale after moving the repo → re-run `./scripts/setup.sh`.
5. Start manually to see errors: `./scripts/dev.sh --core`.

## "Unauthorised" / token rejected

The token lives in `data/secrets/api_token`. If you changed `NEXUS_DATA_DIR`, the app and core must
agree. In browser dev mode, open `http://127.0.0.1:1420/?token=$(cat data/secrets/api_token)`.

## Ollama

* **Offline** — open the Ollama app or run `ollama serve`; check `curl 127.0.0.1:11434/api/version`.
* **"Not enough free memory to load …"** — NEXUS's guard. Close heavy apps, unload models
  (System → Loaded models), choose a smaller model, or raise *Settings → Models → Max share of free
  memory*.
* **First reply slow** — the model is loading (the chat shows "Loading … into memory"). Keep-alive
  keeps it warm for 10 minutes by default.
* **Agent tasks don't use tools** — some models have weak tool-calling. Run System → *Measure a
  model*; prefer one with 3/3 tool-call successes, and assign it to that agent's category.

## Hermes

* **"not installed"** — `hermes` not on PATH. Set `NEXUS_HERMES_BIN=/path/to/hermes`.
* **"API server: running · no key in NEXUS"** — paste `API_SERVER_KEY` in Settings → Hermes.
* **"key rejected"** — the key in NEXUS doesn't match `~/.hermes/.env`, or you use a named profile
  (`/p/<profile>` routing needs that profile's key).
* **Runs fail immediately** — run `hermes doctor`; check Hermes' own model provider.
* Tasks fall back to the native runtime when Hermes is unavailable; the timeline shows
  "Hermes unavailable — using NEXUS native runtime" with the reason.

## Voice

* **Mic button disabled** — no STT engine. Install `mlx-whisper` into the NEXUS venv
  (`services/core/.venv/bin/pip install mlx-whisper`) or `brew install whisper-cpp` and set a ggml
  model path in Settings → Voice. Install `ffmpeg` too.
* **Permission denied** — System Settings → Privacy & Security → Microphone → enable NEXUS.
* **⌥Space does nothing** — another app (e.g. a launcher) owns it; the log says
  "could not register global shortcuts". Free the shortcut and relaunch.

## Knowledge

* PDF shows "No extractable text" → it's scanned; OCR isn't supported yet.
* Files over 25 MB are skipped (Settings key `knowledge.max_file_mb`).
* Semantic search says unavailable → pull an embedding model and press *Build embeddings*.

## Memory optimisation (24 GB)

* Keep **single-model mode** on; avoid running a 20B model alongside other GPU-heavy apps.
* Lower context (Settings → Models → Context window) — KV cache grows with context.
* Shorter keep-alive (2–5 min) frees memory sooner at the cost of reload time.
* Watch System → Memory pressure; "warning" means close something or switch to a smaller model.
* Optional, global Ollama settings: `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_FLASH_ATTENTION=1`,
  `OLLAMA_KV_CACHE_TYPE=q8_0`.

## Service recovery

* After a crash, tasks that were running are marked *failed — core restarted* (never left
  "running"), and stale approvals expire.
* Database issues: quit NEXUS, restore with `./scripts/restore.sh <backup.tar.gz>` (previous data is
  moved aside, not deleted).
* Emergency stop stuck on? Press **Resume NEXUS** in the title bar.
