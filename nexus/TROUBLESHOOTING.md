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

## Newer features

- **"This model can't see images"** — pick a vision model in the chat's model menu (Settings → Models → Get models has one marked *Sees images*).
- **Screenshot fails** — System Settings → Privacy & Security → Screen & System Audio Recording → allow NEXUS (or Terminal when running `dev.sh`), then restart NEXUS.
- **Calendar/Reminders say macOS hasn't allowed NEXUS** — System Settings → Privacy & Security → Automation (and Calendars) → allow NEXUS. Repeating events missing? That happens when the calendar helper couldn't be built; install Xcode's command-line tools (`xcode-select --install`) and restart.
- **Scanned PDFs still show "no text"** — OCR needs Xcode's command-line tools to build its helper once. Check `data/logs/core.log` for "could not build nexus-ocr".
- **Web search returns nothing** — the search page layout may have changed, or the network blocks it. Agents can still read a page when given its address.
- **No notifications on iPhone** — NEXUS must be opened from the Home Screen icon (not Safari), iOS 16.4+, and allowed in Settings → Notifications → NEXUS. Then *Mac* tab → Notifications → Turn off and on again.
- **⌥⇧Q does nothing** — another app may own that shortcut; the shortcut works on text you've copied first.
- **Hands-free stops by itself** — it pauses after hearing nothing twice in a row, so the microphone is never left open in a quiet room. Press the wave button again.
- **Markets shows "Couldn't get market data"** — check the internet connection; the free data service also rate-limits heavy use ("busy, try again in a minute"). If every symbol fails, the service may have changed its format: please report the exact message.
- **"trades in EUR, but the practice account is in USD"** — the practice account holds one currency. Markets → Practice account → Reset, and pick that currency.

## Updates and trading

- **No update appears in the app** — the title bar always shows an *Updates* button; click it to check now. If it says the check failed, the message explains why (most often GitHub needs you to sign in once: run `git pull` in Terminal inside the NEXUS folder). If your installed app is older than the in-app updater, update once by hand: `cd ~/Mobile_apps/nexus && git checkout -- apps/desktop/package-lock.json apps/desktop/src-tauri/Cargo.lock && git pull && ./scripts/setup.sh && ./scripts/install-app.sh`.
- **Zerodha refuses an order mentioning IP** — register your static IP for the app at developers.kite.trade (required since April 2026).
- **"Your Zerodha session has ended"** — normal every morning; Settings → Brokers → Log in to Zerodha.
- **"Invalid checksum" when logging in** — the API secret saved in NEXUS doesn't match the app's; paste it again.
- **"NEXUS can't work out what this order is worth"** — market orders need a price to check against your limit, and the free Zerodha plan has no live quotes. Use a limit order, or turn on Markets so the delayed public price can be used.
- **A button does nothing, or a banner says the background service is a different version** — click *Restart service* in the banner. From Terminal: `pkill -f -- "-m nexus_core"`, then reopen NEXUS. (Installed apps now do this by themselves at launch.)
- **"Yahoo Finance is turning away automated requests"** — Yahoo blocks programs that aren't web browsers; NEXUS doesn't work around that. Switch the chart to **TradingView** (button above the chart). Prices, practice trading, alerts and trade ideas need a price source and stay unavailable while Yahoo refuses.
- **The TradingView chart area is blank** — it needs internet access to tradingview.com. If it says a symbol is "only available on TradingView", that exchange doesn't allow embedded charts; use the chart's own search for another listing.
