# NEXUS

**Your intelligence. Your machine. Your control.**

NEXUS is a local-first personal AI operating system for macOS on Apple Silicon. It combines a
liquid-glass native desktop app, a floating mini assistant, specialist agents (orchestrated by
[Hermes Agent](https://github.com/NousResearch/hermes-agent) when available), local inference via
[Ollama](https://ollama.com), persistent reviewed memory, a private document knowledge base,
workflow automations and controlled macOS integration — with no cloud dependency.

<p align="center"><img src="docs/screenshots/home.png" width="860" alt="NEXUS Home"></p>
<p align="center">
  <img src="docs/screenshots/phone-2-home.png" width="200" alt="Phone home with approval">
  <img src="docs/screenshots/phone-4-thread.png" width="200" alt="Phone chat">
  <img src="docs/screenshots/phone-6-sheet.png" width="200" alt="Phone task timeline">
  <img src="docs/screenshots/phone-8-mac.png" width="200" alt="Phone Mac status">
</p>

## Features

| Area | What you get |
|---|---|
| **Home** | Contextual greeting, ambient orb, central prompt with voice, recent tasks, active agents, scheduled automations, folders, service health |
| **Chat** | Streaming Markdown with code highlighting, attachments with text extraction, pictures and screenshots (analysed by a vision model, or read with on-device OCR), persistent history & search, model picker, stop / regenerate / copy / export, read-aloud, source citations, live agent execution timeline |
| **Projects** | A space per client, course or area of life: its own instructions, chats, memories and linked folders, so answers stay on topic and searches stay inside that project's documents |
| **Agents** | Six specialists (Chief of Staff, Researcher, Developer, Analyst, Knowledge, Automation) — configurations, not daemons. Runs on Hermes (API server or CLI) with a NEXUS-native Ollama tool-calling fallback. Status, history, tool usage, per-agent tool permissions |
| **Knowledge** | Explicitly approved folders only; PDF, DOCX, TXT, Markdown, CSV, XLSX, JSON, plus scanned PDFs and photos through on-device OCR; SQLite FTS5 keyword search + optional local embeddings (hybrid); citations with page/sheet/line; projects; search history; re-index |
| **Memory** | Six categories with provenance; automatic suggestions are proposals until you approve; credential-like content is flagged; review / pin / archive / delete |
| **Automations** | Manual, cron schedule and new-file triggers; conditions; multi-step actions (agent task, prompt, write/append file, notify, re-index, approved script); approvals, retries, history, notifications; templates (morning briefing, weekly summary, document classification, invoice extraction…); visual flow builder with drag-to-reorder steps |
| **Web & apps** *(off until you switch them on)* | Agents can search and read the public web; read your Calendar and Reminders, add reminders and prepare Mail drafts (changes always ask first; NEXUS never sends email) |
| **Markets** *(off until you switch it on)* | Watchlist with live-ish prices, TradingView's interactive chart (optional, in an isolated frame) or built-in candlestick and line charts (1 day – 5 years) with moving averages, RSI and volume, price alerts, and a **practice trading account** that buys and sells at real prices with pretend money. No broker connection and no real orders |
| **Trade ideas** | A Market Analyst agent and a transparent rule-based reading of each symbol: go long / go short / stay out, with entry, stop-loss and targets drawn on the chart, a position-size helper, a whole-watchlist scan, and a back-test showing how those same rules did on that symbol — including when they lost |
| **Real-money trading** *(off until you connect and switch it on)* | Zerodha Kite orders (shares, ETFs, F&O) and Coin mutual-fund holdings. Every order needs a review screen and your confirmation; per-order and per-day limits; agents, automations and phones cannot place orders |
| **Models** | Download, switch and delete local models inside the app with live progress and a "will it fit this Mac" hint |
| **System** | CPU, memory, macOS memory pressure, swap, disk, loaded models with VRAM residency, inference tok/s and TTFT from Ollama's own counters, service health, on-device model benchmark (load time, speed, tool-calling reliability) |
| **Phone app** | Installable companion for iPhone/Android (Add to Home Screen): chat, run agents, approve or deny actions, review memories, run automations, emergency stop, optional notifications for approvals and finished tasks. Connects to your Mac over Tailscale; off until you enable it; per-device revocable keys |
| **Floating assistant** | Separate always-on-top window, ⌥Space to toggle, ⌥⇧Space push-to-talk, ⌥⇧Q quick actions on copied text (summarise, explain, rewrite, fix grammar, translate, draft a reply), expand/collapse, shares conversations and tasks with the main window |
| **Voice** | Hands-free conversation (talk, it answers aloud, keeps listening until you stop it) and push-to-talk with live waveform, local transcription (MLX Whisper or whisper.cpp), local speech (macOS `say` or Piper), interrupt playback |
| **Security** | Loopback-only API with per-install token, DNS-rebinding guard, folder allowlist with separate read/write/execute, no general shell for agents, approvals for destructive actions, emergency stop, Keychain secrets, audit log, cloud off by default |

## Quick start (macOS, Apple Silicon)

```bash
git clone https://github.com/dhiviyadev/Mobile_apps.git && cd Mobile_apps/nexus
./scripts/audit.sh        # Phase 0: read-only report of your Mac, Ollama, Hermes → docs/AUDIT-<host>.md
./scripts/setup.sh        # venv, npm deps, launcher config (asks before installing anything global)
./scripts/dev.sh          # core service + desktop app with hot reload
```

The first time it opens, a short guide asks your name, helps you download a model (or use
**Settings → Models → Get models** later) and lets you approve a first folder.
See [SETUP.md](SETUP.md#choosing-models-for-24-gb) for which model to pick.

Install it as a normal Mac app (appears in Applications, Launchpad and Spotlight; starts and stops
the NEXUS core by itself): `./scripts/install-app.sh`.

A fully self-contained app — the core and its Python runtime live inside `NEXUS.app`, so the Mac that
runs it needs nothing but Ollama: `./scripts/build-standalone.sh` (add `--install` to put it in Applications).

## Repository layout

```
nexus/
├── apps/desktop/          Tauri 2 + React + TypeScript desktop app (main window + floating assistant)
│   ├── src/               workspaces/, components/, stores/, hooks/, lib/
│   └── src-tauri/         Rust shell: windows, global shortcuts, tray, core lifecycle
├── services/core/         Python FastAPI core service (package: nexus_core)
│   ├── nexus_core/        api, agents (Hermes adapter, native runtime), models, knowledge,
│   │                      memory, automations, voice, permissions, integrations, tasks, system
│   └── tests/             pytest suite
├── scripts/               audit, setup, dev, build, build-standalone, install-app, update, restore, launchagent
├── docs/                  audit reports, screenshots
└── data/                  runtime data (gitignored): database, workspace, logs, secrets, backups
```

## Documentation

[ARCHITECTURE](ARCHITECTURE.md) · [SETUP](SETUP.md) · [SECURITY](SECURITY.md) · [DEVELOPMENT](DEVELOPMENT.md) · [ROADMAP](ROADMAP.md) (status checklist & known limitations) · [TROUBLESHOOTING](TROUBLESHOOTING.md)
