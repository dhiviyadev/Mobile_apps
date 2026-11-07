# NEXUS roadmap & status

Legend: ✅ done and tested · 🟡 implemented, needs verification on the target Mac · ⏳ pending · ⛔ blocked (reason given)

> **Where this was built.** NEXUS was developed in a Linux cloud container (x86_64, no GPU, no
> macOS). Everything marked ✅ was run and tested there: the 49-test backend suite, the frontend
> unit tests and type checks, the Rust shell compiled with zero warnings, and the **native Tauri app
> launched under a virtual display** — the global shortcut opened the floating assistant, a message
> sent from it streamed a reply, and the main window updated live. Things that only exist on your
> Mac (Apple Silicon performance, memory pressure readings, Keychain, `say`, microphone permission,
> macOS packaging) are 🟡 until you run them there.

## Phase 0 — Environment audit
- ✅ Read-only audit script `scripts/audit.sh` (hardware, memory pressure, tools, Ollama models, Hermes config summary without secrets, ports, LaunchAgents, nearby projects) — tested on Linux
- ⛔ Audit of *your* Mac — run `./scripts/audit.sh` there (the build environment cannot reach your machine)
- ✅ Hermes inspected from upstream source/docs: API server (`/v1/runs` + SSE + stop + approval), CLI `--format stream-json`, ACP and TUI-gateway protocols; adapter built on the first two
- ✅ Implementation plan, model recommendations and repository structure (this file, SETUP.md, ARCHITECTURE.md)

## Phase 1 — Frontend foundation
- ✅ Tauri 2 shell, main window with overlay title bar, sidebar, title bar, command palette (⌘K, ⌘1–6, ⌘N, ⌘,)
- ✅ Graphite + Silver design tokens, components, Home command centre
- ✅ Ambient orb: idle / listening (audio-reactive waveform) / thinking / executing; CSS-only, paused when hidden, reduced-motion aware (Three.js deliberately not used — not needed for this look)
- ✅ Live (not mock) data for tasks, agents, system widgets; honest empty/offline states
- ✅ Frontend unit tests (vitest), strict TypeScript

## Phase 2 — Floating assistant
- ✅ Separate frameless, transparent, always-on-top window; drag, expand/collapse, pin, hide (Esc), open in main app
- ✅ ⌥Space toggles (verified in the native app under X11); ⌥⇧Space push-to-talk without stealing focus
- ✅ Shared state through the core event bus (verified: mini → main live update)
- 🟡 macOS vibrancy/transparency and shortcut conflicts (e.g. with Spotlight/Raycast) on your Mac

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
- ⏳ OCR for scanned PDFs; conversation auto-summaries into memory (currently on demand via the brain icon)

## Phase 7 — Voice
- ✅ Push-to-talk capture with level meter/waveform, cancel, transcription preview, TTS playback with interrupt, voice selection, engine detection
- 🟡 MLX Whisper / whisper.cpp transcription and macOS `say` — code paths need your Mac (engines not available in the build environment)
- ⏳ Continuous conversation mode (off by design until requested)

## Phase 8 — Automations
- ✅ Manual / cron / file triggers, conditions, 8 action types, templating, approvals, retries with backoff, failure notifications, history, templates, structured step editor
- ⏳ Visual drag-and-drop workflow builder (milestone after real-world use of the step editor)

## Phase 9 — macOS integrations
- ✅ Approved-folder file ops with atomic writes, backups and trash; filename search; open/reveal in Finder; launch apps (validated names, approval); approved scripts (no shell, timeout); Shortcuts list/run (approval); native notifications via `osascript` argv
- 🟡 These macOS-specific calls were written for macOS and are untested off it
- ⏳ Calendar, browser automation, email, clipboard workflows

## Phase 10 — Production polish
- ✅ Menu-bar tray (open, assistant, new conversation, emergency stop, quit), close-to-tray, single instance, launch-at-login toggle, app icon, backup/restore, documentation set, security review (SECURITY.md)
- 🟡 `scripts/build.sh` → `NEXUS.app` + `.dmg` on Apple Silicon (Rust shell compiles; macOS bundling must run on a Mac)
- ⏳ Bundle the Python core inside the `.app` (today the app runs the core from your checkout via `launcher.json`)
- ⏳ Code signing & notarisation (needs your Apple Developer ID)

## Known limitations
- GPU utilisation is not displayed: macOS only exposes it via root-only `powermetrics`; Ollama's per-model VRAM residency is shown instead.
- Hermes' own tools follow Hermes' permission model; NEXUS's folder allowlist governs only NEXUS-native tools (see SECURITY.md).
- In Hermes CLI mode, Hermes approval prompts cannot be answered interactively.
- Memory-pressure readings come from `kern.memorystatus_vm_pressure_level` (macOS only).
- The vector store loads embeddings into RAM; comfortable to ~100k passages before Qdrant is worthwhile.
