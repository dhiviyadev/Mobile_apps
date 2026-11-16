# NEXUS roadmap & status

Legend: ✅ done and tested · 🟡 implemented, needs verification on the target Mac · ⏳ pending · ⛔ blocked (reason given)

> **Where this was built.** NEXUS was developed in a Linux cloud container (x86_64, no GPU, no
> macOS). Everything marked ✅ was run and tested there: the backend test suite (103 tests today), the frontend
> unit tests and type checks, the Rust shell compiled with zero warnings, and the **native Tauri app
> launched under a virtual display** — the global shortcut opened the floating assistant, a message
> sent from it streamed a reply, and the main window updated live. Things that only exist on your
> Mac (Apple Silicon performance, memory pressure readings, Keychain, `say`, microphone permission,
> macOS packaging) are 🟡 until you run them there.

## Upgrade set (models, vision, web, Apple apps, projects, push, hands-free, flow builder, self-contained app)
Backend suite is now 103 tests; every ✅ below was exercised in the build environment, most of them
also in a real browser against the running core.
- ✅ **Model manager** — download with live progress, delete (clears routing), failed downloads reported, memory-fit hints; phones can't download or delete
- ✅ **Pictures in chat** — image attachments, paste, thumbnails; sent to the model only when it reports vision support, otherwise a clear note and OCR text is used
- 🟡 **Screenshot button** — uses macOS `screencapture`; needs your Mac and the Screen Recording permission
- ✅ **OCR** — scanned PDFs and photos become searchable (tested with Tesseract on Linux) · 🟡 the Apple Vision helper (`nexus-ocr.swift`) is compiled on first use on your Mac and has **not been compiled or run yet**
- ✅ **Web search for agents** — off by default; private/loopback/Tailscale addresses refused, connection pinned to the checked address, redirects re-checked, size caps, audited (22 tests incl. 15 blocked-target cases) · 🟡 the search-results parser was tested against a saved sample of DuckDuckGo's page layout, **not the live site** (it's blocked in the build environment)
- ✅ **Calendar / Reminders / Mail** — off by default; reading, approval before adding a reminder or opening a draft, user text passed as arguments (never into script source), no send path at all · 🟡 the AppleScript and the EventKit helper (`nexus-cal.swift`) are **untested on macOS** — first use on your Mac is the real test
- ✅ **Projects** — instructions, scoped memory and knowledge, rename/delete keep data, agent tasks inherit the project; UI verified end to end
- ✅ **Phone notifications** — VAPID keys (0600), subscribe/unsubscribe, allow-listed push services only, dead subscriptions removed, Mac-side switch; real payload encryption verified · 🟡 delivery to a **real phone** (needs your iPhone with NEXUS on the Home Screen, iOS 16.4+)
- ✅ **Quick actions (⌥⇧Q)** — shell compiles and registers the shortcut; works on text you've **copied** (reading the current selection directly would need Accessibility access, deliberately not requested) · 🟡 on macOS
- 🟡 **Hands-free conversation** — listen → send → speak → listen loop with end-of-speech detection and auto-off after silence; needs a real microphone and speech engine, so **untested with real audio**
- ✅ **Visual flow builder** — drag-to-reorder nodes, step palette, inline editor (drag verified in a browser)
- ✅ **First-run guide** — name → model → folder; skipped for existing installs
- ✅ **Self-contained app** — core frozen with PyInstaller, starts by itself, and the native desktop binary was run here and found/started the bundled core with data in Application Support · 🟡 `scripts/build-standalone.sh` on macOS (bundling, helpers, dmg). The bundled core does not include MLX Whisper; voice uses whisper.cpp if installed. Updating a self-contained app = installing a newer build.

## Markets (charts, alerts, practice trading)
- ✅ Watchlist, search, price history for six ranges, day change taken from the one-day view, short-lived caching, clear errors (unknown symbol, service busy); 9 backend tests against responses in the data service's documented shape
- ✅ Charts: candles or line, 20/50-bar averages, volume in its own panel, hover and keyboard read-out, table view; colours checked for colour-blind separation (blue = up, red = down); verified in a browser
- ✅ Practice account: buys and sells at the latest price, average cost, gain/loss, no short selling or overspending, single currency, reset; orders blocked during emergency stop; phones can look but not trade
- ✅ Price alerts with notifications (checked every 3 minutes while NEXUS runs)
- ✅ Agents (Chief of Staff, Analyst) can look up prices; there is deliberately **no** tool that trades
- 🟡 **Live data has not been fetched yet**: Yahoo Finance is blocked in the build environment, so browser checks used generated sample prices (the screenshots in `docs/screenshots/markets*.png` show sample data, not real quotes). The service is unofficial; if its format differs from what the tests assume, the first chart on your Mac will show an error — tell me what it says.
- ✅ RSI (14) momentum panel under the chart (checked against Wilder's published worked example)
- ✅ Markets on the phone app: watchlist, tap-to-read charts, practice account summary — view only; trading and edits stay on the Mac (verified in an emulated iPhone)
- ⏳ Real-money trading through a broker (needs your broker account, its API keys in the Keychain, and an approval step per order) · MACD and drawing tools

## Phase 0 — Environment audit
- ✅ Read-only audit script `scripts/audit.sh` (hardware, memory pressure, tools, Ollama models, Hermes config summary without secrets, ports, LaunchAgents, nearby projects) — tested on Linux
- ⛔ Audit of *your* Mac — run `./scripts/audit.sh` there (the build environment cannot reach your machine)
- ✅ Hermes inspected from upstream source/docs: API server (`/v1/runs` + SSE + stop + approval), CLI `--format stream-json`, ACP and TUI-gateway protocols; adapter built on the first two
- ✅ Implementation plan, model recommendations and repository structure (this file, SETUP.md, ARCHITECTURE.md)

## Phase 1 — Frontend foundation
- ✅ Tauri 2 shell, main window with overlay title bar, sidebar, title bar, command palette (⌘K, ⌘1–6, ⌘N, ⌘,)
- ✅ Graphite + Silver design tokens, components, Home command centre
- ✅ Liquid-glass material: translucent panes with rim light and specular edge over a drifting ambient light field, shared pointer-following light, spring-driven sliding selection pills, springy presses, staggered entrances; Appearance settings (Ambient / Desktop vibrancy / Solid, Full / Calm motion); honours Reduce Motion and Reduce Transparency
- 🟡 GPU cost of backdrop blur on the M5 Pro — check Activity Monitor's GPU History while idle; switch to Motion: Calm or Material: Solid if it's noticeable
- ✅ Ambient orb as a liquid-glass droplet (morphing counter-rotating caustics, rim-lit shell): idle / listening (audio-reactive) / thinking / executing ripples; CSS-only, paused when hidden, reduced-motion aware (Three.js not needed)
- ✅ Live (not mock) data for tasks, agents, system widgets; honest empty/offline states
- ✅ Frontend unit tests (vitest), strict TypeScript

## Phase 2 — Floating assistant
- ✅ Separate frameless, transparent, always-on-top window; drag, expand/collapse, pin, hide (Esc), open in main app
- ✅ ⌥Space toggles (verified in the native app under X11); ⌥⇧Space push-to-talk without stealing focus
- ✅ Shared state through the core event bus (verified: mini → main live update)
- 🟡 macOS vibrancy/transparency and shortcut conflicts (e.g. with Spotlight/Raycast) on your Mac

## Updates & appearance
- ✅ In-app updates: automatic checks (git fetch, NEXUS-folder commits only), title-bar pill, notification, "What's new", one-click update with live log; detached updater survives the app restarting; refuses local edits; phone can't trigger it (6 tests, incl. real git repos and a full rehearsal of update.sh)
- ✅ Glass transparency slider (Settings → Appearance), clearer default
- 🟡 "Update & restart" for the installed app on macOS (rebuild + reopen) — exercised via install-app.sh, needs your Mac

## Phone companion app
- ✅ Installable web app (iPhone/Android) served by the core at `/m`: Home with approvals first, Chat, Tasks (run agents, live timelines in swipe-to-dismiss sheets), Search + memory review, Mac status/automations/emergency stop; liquid-glass UI with spring tab pill
- ✅ Remote access off by default; Tailscale-served HTTPS; pairing codes (single use, 5 min, rate-limited) → per-device hashed, revocable tokens; restricted remote role; audit trail (11 tests)
- ✅ Verified end-to-end in an emulated iPhone 15 Pro against the real core: pair → approve an automation from the phone → it ran on the Mac → its timeline shown on the phone
- 🟡 On a real phone over Tailscale (needs your devices); iOS microphone permission and home-screen install
- ⏳ Native wrapper via Tauri mobile if you want App Store distribution

## Phase 3 — Backend foundation
- ✅ FastAPI core, SQLite (WAL) + migrations, REST + SSE + WebSocket events, task manager, config, rotating logs
- ✅ Graceful shutdown; restart recovery marks orphaned tasks as interrupted
- ✅ Core lifecycle from the app (connect to running core or spawn it; stop only what it started); optional LaunchAgent

## Phase 4 — Ollama integration
- ✅ Dynamic discovery, model selection, streaming chat, load/unload, running-model status, errors when offline
- ✅ Router (6 categories), memory guard, single-model mode, keep-alive, context size
- ✅ Metrics from Ollama's counters (tok/s, TTFT, load time); on-device benchmark incl. tool-calling reliability
- ⛔ Real performance measurements on the M5 Pro — Ollama downloads are blocked in the build environment; run System → *Measure a model* for `qwen3:14b`, `gpt-oss:20b` and a 4B model and record results here

## Phase 5 — Hermes integration
- ✅ Adapter: capability detection, API runs + SSE event mapping, stop, approval relay, sessions per conversation, skills/toolsets listing; CLI stream-json transport with SIGINT cancel; native fallback with an explicit timeline event
- ✅ Tested against fakes that follow Hermes' documented wire formats (including run pausing on `approval.request`)
- 🟡 End-to-end against your installed Hermes (enable the API server, add the key) — Hermes wasn't installed in the build environment
- ⏳ TUI-gateway JSON-RPC transport (richer: clarify questions, steering, branching)

## Phase 6 — Knowledge & memory
- ✅ Folder allowlist, incremental indexing of PDF/DOCX/TXT/MD/CSV/XLSX/JSON, FTS5 search with snippets & citations, projects, search history, re-index, document preview
- ✅ Local embeddings + hybrid search (SQLite vector store behind a `VectorStore` seam)
- ✅ Memory: categories, provenance, proposals → review, sensitive-content guard, pin/archive/delete, recall into chat & agents
- ⏳ Qdrant vector store (after validating retrieval quality on your documents)
- ⏳ Conversation auto-summaries into memory (currently on demand via the brain icon)

## Phase 7 — Voice
- ✅ Push-to-talk capture with level meter/waveform, cancel, transcription preview, TTS playback with interrupt, voice selection, engine detection
- 🟡 MLX Whisper / whisper.cpp transcription and macOS `say` — code paths need your Mac (engines not available in the build environment)
- ⏳ Wake word (would need an always-on microphone; not planned without an explicit request)

## Phase 8 — Automations
- ✅ Manual / cron / file triggers, conditions, 8 action types, templating, approvals, retries with backoff, failure notifications, history, templates, structured step editor
- ⏳ Branching flows (the builder is visual, the engine still runs steps top to bottom)

## Phase 9 — macOS integrations
- ✅ Approved-folder file ops with atomic writes, backups and trash; filename search; open/reveal in Finder; launch apps (validated names, approval); approved scripts (no shell, timeout); Shortcuts list/run (approval); native notifications via `osascript` argv
- 🟡 These macOS-specific calls were written for macOS and are untested off it
- ⏳ Browser automation; sending email (deliberately draft-only)

## Phase 10 — Production polish
- ✅ Menu-bar tray (open, assistant, new conversation, emergency stop, quit), close-to-tray, single instance, launch-at-login toggle, app icon, backup/restore, documentation set, security review (SECURITY.md)
- 🟡 `scripts/build.sh` → `NEXUS.app` + `.dmg` on Apple Silicon (Rust shell compiles; macOS bundling must run on a Mac)
- ⏳ In-app updates for the self-contained build (needs a signed download channel)
- ⏳ Code signing & notarisation (needs your Apple Developer ID)

## Known limitations
- GPU utilisation is not displayed: macOS only exposes it via root-only `powermetrics`; Ollama's per-model VRAM residency is shown instead.
- Hermes' own tools follow Hermes' permission model; NEXUS's folder allowlist governs only NEXUS-native tools (see SECURITY.md).
- In Hermes CLI mode, Hermes approval prompts cannot be answered interactively.
- Memory-pressure readings come from `kern.memorystatus_vm_pressure_level` (macOS only).
- The vector store loads embeddings into RAM; comfortable to ~100k passages before Qdrant is worthwhile.
