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

## Built-in chart vs TradingView (checked with real Tesla data, 17 Nov 2026)
- ✅ Daily candles are identical to TradingView's to the cent (compared bar by bar)
- ✅ Fixed: on 1M–5Y ranges the "change today" could be measured from the start of the chart (Tesla showed −10.17% instead of −0.12%); it now uses the day's change Yahoo sends, which also halves Yahoo requests
- ✅ Candle colours: green/red like TradingView by default, with a one-click switch to the colour-blind-friendly blue/red
- ✅ The range buttons drive TradingView too (1Y and 5Y open on the same window and candle size; 1M/6M open on daily candles, since TradingView's own 6M switches to 2-hour candles)
- Explained beside the chart: TradingView's free US chart uses Cboe One (15 min delayed), so today's bar and volumes can differ slightly

## Language and watchlist polish
- ✅ Chat and agents reply in the language you write in (Hindi, Tamil, English…, in its own script; mixed if you mix); tickers and numbers stay as they are
- ✅ 30-day trend line on every watchlist entry (Mac and phone), drawn from prices already stored locally, adjusted for bonus issues and splits; missing history is fetched quietly in the background (checked with real NSE data)

## Getting the AI running
- ✅ When Ollama isn't ready, Home and Chat show what's missing (install / start / choose a model) with a one-click fix: **Get Ollama** opens the official download page, **Start Ollama** opens the app and waits for it, **Choose a model** goes to model downloads. Chat errors are in plain words. 🟡 Starting Ollama.app is macOS-only and was tested with a stand-in.

## Market overview
- ✅ Today's market on the phone app too (tap a stock for its chart)
- ✅ "Today's market" on Markets and Home: Nifty 50, Bank Nifty, Nifty IT, Midcap 100, India VIX, and the Nifty 50's top gainers and losers, from NSE's free live service (checked against the real service); click anything to open its chart; "Add to watchlist" for symbols opened that way
- ✅ `market_overview` agent tool (Market Analyst, Chief of Staff) and a "How's the market?" quick prompt
- ✅ "Market close briefing" automation template: weekdays 15:50 — index moves, top movers and a read of your watchlist, saved to the workspace and sent as a notification (and to your phone if push is on). Starts switched off, like every template.

## Reliability fixes after first real use on the Mac
- ✅ **Out-of-date background service.** After an update the new app could keep talking to the previous version's service, so new features silently failed ("Turn on Markets" did nothing). Now: the service reports the build it was started from; the installed app replaces a service from other code at launch (verified with the real app binary: old process stopped, fresh one started); the install script stops any old service; a banner with *Restart service* covers the remaining cases; and the Markets switch shows its error instead of swallowing it.
- 🔴 **Yahoo Finance refuses automated requests** (answers "Too Many Requests" to programs that aren't a browser — seen on the first request on the Mac). NEXUS does not disguise itself to get around that. Consequences: with Yahoo refusing, the built-in chart, prices, practice trading, alerts and trade ideas have no data. Mitigations in place: one polite retry then a two-minute pause, last-known data shown as stale, symbols can still be added, and the message says what is happening.
- ✅ **TradingView chart option** — TradingView's published Advanced Chart embed (the embeddable Supercharts), in a sandboxed frame served by the core with its own strict content policy; symbol mapping (INFY.NS → NSE:INFY, etc.); choice remembered. 🟡 The frame and its wiring were verified in a browser; **TradingView's own script could not be loaded from the build environment**, so the chart itself is unseen until it runs on the Mac. Whether NSE/BSE symbols are served to embedded widgets depends on TradingView's exchange licensing.
- ⏳ A reliable price source for prices/ideas/practice/alerts: Zerodha's market-data plan (official, ₹500/month) is the natural one for Indian markets — to be built if wanted. NSE also publishes an official no-key data service that could cover daily history.

## Trade ideas and real-money trading (Zerodha)
- ✅ Analysis engine: SMA/EMA, RSI, MACD, ATR, swing support/resistance, efficiency ratio; a scored view with reasons; entry / stop / targets from volatility; causal back-test of the same rules (checked against published indicator values; no look-ahead test)
- ✅ Market Analyst agent + `market_analysis` / `market_scan` tools (read-only); idea card, levels on the chart, position-size helper, watchlist scan — verified in a browser
- ✅ Zerodha client and order safety layer, 12 tests against a stand-in that follows Kite Connect's documented behaviour: login handshake and checksum, one-time callback state, preview → single-use confirmation code bound to the exact order (2-minute expiry), value and daily limits re-checked at send time, emergency stop, market-protection on market orders, rejection handling, secrets never in API answers or logs, phones refused, no agent/automation path
- ✅ Review-and-confirm dialog, live account view (funds, holdings, positions, today's orders with cancel, Coin funds) — verified in a browser against the stand-in
- 🟡 **Never run against the real Zerodha.** No account or network access from the build environment. Login, account reads and — above all — the first real order are untested on the real service. Start with one small limit order (or an after-market order) and check it in Kite.
- 🟡 Field names for holdings/positions/margins come from Kite Connect's documentation as I know it; the docs site was unreachable for a field-by-field check. If a number shows as "—", that field name needs adjusting.
- 🟡 Zerodha requires a registered **static IP** for API orders (since 1 April 2026) and a fresh login each trading day; market data (live quotes) needs the paid Connect plan — on the free Personal plan the order estimate uses the delayed public price.
- ⏳ GTT / bracket orders, option chains, basket orders, MACD panel on the chart · other brokers

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
