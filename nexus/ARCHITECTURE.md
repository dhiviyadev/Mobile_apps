# NEXUS architecture

## Components

```
┌──────────────────────── NEXUS.app (Tauri 2, Rust) ────────────────────────┐
│  main window (React)        floating mini window (React)     menu-bar tray │
│        │   ⌥Space / ⌥⇧Space global shortcuts · core lifecycle · dialogs     │
└────────┼──────────────────────────────┼────────────────────────────────────┘
         │ HTTP + SSE + WebSocket (127.0.0.1:8765, bearer token)
┌────────▼──────────────────────────────▼────────────────────────────────────┐
│                     NEXUS core (Python · FastAPI · asyncio)                 │
│  api ─ conversations ─ agents ─ tasks ─ automations ─ knowledge ─ memory     │
│        │                │                                                   │
│        │        ┌───────┴────────┐   permissions · approvals · audit        │
│        │        │ Hermes adapter │   files · macos · notifications · voice  │
│        │        │ native runtime │   system monitor · event bus             │
│        │        └───────┬────────┘                                          │
│   model router ─────────┤                SQLite (WAL, FTS5) in data/        │
└────────┬────────────────┼──────────────────────────────────────────────────┘
         │                │
   Ollama :11434     Hermes Agent (API server :8642  or  `hermes chat --format stream-json`)
```

**Why a separate core process?** It keeps inference orchestration, indexing and schedulers out of
the UI process (the interface stays responsive during generation), lets automations keep running
when windows are closed (optionally as a LaunchAgent), and gives both windows one source of truth.

## Service boundaries

| Module | Responsibility |
|---|---|
| `api/` | REST + SSE routes, auth/host middleware, `/ws` event stream |
| `tasks/` | Task lifecycle, persisted execution events, cancellation hooks, sequential semaphore, restart recovery |
| `agents/` | Agent profiles, orchestration (`service.py`), Hermes adapter, native tool-calling runtime, tool registry |
| `models/` | Ollama client, memory-aware router, benchmark, optional cloud adapter |
| `conversations/` | Sessions, messages, streaming generation with retrieval, regenerate, export, attachments |
| `knowledge/` | Extractors, chunking, incremental indexing, FTS5 + vector store seam, hybrid ranking |
| `memory/` | Categorised long-term memory with provenance, proposals, sensitive-content guard, recall |
| `automations/` | Cron parser, triggers (manual / schedule / file), engine, templates |
| `permissions/` | Folder allowlist & path checks, approvals + emergency stop, audit log |
| `integrations/` | Permission-checked file ops, macOS apps / notifications / Shortcuts / approved scripts |
| `voice/` | STT (MLX Whisper / whisper.cpp) and TTS (Piper / `say`) detection and execution |
| `system/` | CPU / memory / pressure / disk sampling, service health |

## Data flows

**Chat (streaming).** `POST /api/conversations/{id}/messages` → user message persisted → reviewed
memories recalled (FTS) → knowledge excerpts retrieved (FTS / hybrid) and emitted as `sources` →
router resolves the model and checks memory → Ollama `/api/chat` streamed as SSE `delta` events →
assistant message persisted with Ollama's own metrics (tok/s, TTFT, load time) and source list.
`POST /api/generations/{id}/stop` cancels mid-stream; the partial reply is saved as `stopped`.

**Agent task.** `POST /api/agents/{id}/tasks` (or chat in Agent mode) → Task row → runtime chosen:
Hermes API → Hermes CLI → native. Every step (`runtime.selected`, `tool.started`, `tool.denied`,
`approval.relayed`, `task.completed`…) is written to `task_events` **as it happens** and published on
the event bus; the UI timeline is a view of those rows, never simulated progress.

**Shared window state.** Both windows open a WebSocket to `/ws`. Conversations, tasks, approvals and
notifications live in the core; windows only cache. The mini window resumes the most recent
conversation, and "Open in NEXUS" asks the shell to show the main window on that conversation.

**Automations.** One asyncio loop: every 20 s due cron schedules fire; every 15 s watched folders are
diffed against an mtime snapshot (first observation is a baseline, so existing files never fire).
Runs become Tasks; agent steps run inline under the same sequential semaphore as interactive tasks.

## AI model architecture (24 GB unified memory)

* **Dynamic discovery** — models come from `/api/tags`; nothing is hardcoded.
* **Routing** — categories `general, reasoning, coding, documents, classification, embeddings`
  map to installed models; unassigned categories use the default, then the smallest chat model.
* **Memory guard** — before loading, model size is compared against
  `available memory (+ memory reclaimable by unloading others) × max_memory_fraction (0.75)`.
  Oversized loads are refused with an explanation instead of pushing macOS into swap.
* **Single-model mode** (default on) — other resident chat models are unloaded (`keep_alive: 0`)
  before a new one loads; the small embedding model may stay.
* **Lazy loading** — models load on first use; keep-alive (default 10 min) frees memory when idle.
* **Measurement** — every generation records Ollama's `load_duration`, `eval_count/eval_duration`
  and TTFT. The System workspace benchmark adds cold-load time, resident size, memory delta,
  pressure level and tool-calling success rate.
* **Cloud** — optional adapter (Anthropic or OpenAI-compatible), off by default, per-message consent,
  separate switch for sending documents, key in the Keychain.

## Hermes integration

NEXUS uses only interfaces documented in hermes-agent
(`website/docs/developer-guide/programmatic-integration.md`, `user-guide/features/api-server.md`,
`reference/cli-commands.md`), verified against the upstream source while building:

| Operation | API server transport | CLI transport |
|---|---|---|
| Detect | `GET /health`, `GET /v1/capabilities` | `hermes --version` |
| Submit task | `POST /v1/runs {input, instructions, session_id}` + `Idempotency-Key` | `hermes chat --oneshot --query-file - --format stream-json --source tool [--toolsets …]` |
| Events | `GET /v1/runs/{id}/events` (SSE: `message.delta`, `tool.started/completed/failed`, `approval.request`, `subagent.*`, `run.completed/failed/cancelled`) | JSONL: `system`, `text`, `tool_use`, `tool_result`, `result` |
| Cancel | `POST /v1/runs/{id}/stop` | SIGINT (Hermes exits 130) |
| Approvals | `approval.request` → NEXUS approval card → `POST /v1/runs/{id}/approval {request_id, choice}` | Hermes' own non-interactive policy (NEXUS never passes `--yolo`) |
| Sessions | `session_id = nexus-<conversation id>`; `GET /api/sessions` | per-run |
| Skills / toolsets | `GET /v1/skills`, `GET /v1/toolsets` | — |

Limitations found and handled: the API server does not accept per-run toolset restrictions (the
Hermes profile's toolset config applies); the CLI one-shot cannot relay interactive approvals; the
API server requires `API_SERVER_ENABLED` + `API_SERVER_KEY`, which only the user sets. If neither
transport is available, agents run on the NEXUS native runtime and the timeline says so.
NEXUS never writes to `~/.hermes`, reads `config.yaml` read-only for display, and never reads
`~/.hermes/.env`. Hermes keeps working on its own when NEXUS is closed.

## Visual system

Liquid glass on graphite. A fixed **ambient light field** (three pre-softened radial gradients
drifting via `transform`, a static grain layer and a vignette) sits behind translucent panes that use
`backdrop-filter: blur + saturate`, a masked gradient rim, and an inner specular edge. One **shared
pointer light** is published as CSS variables once per animation frame and rendered by every pane
with a fixed-attachment gradient, so all glass is lit by the same source with no per-element work.
The field brightens while the orb is thinking/executing (`html[data-activity]`). Selection uses
spring-driven `layoutId` pills (sidebar, segmented controls, palette). The orb is a dark glass body
with two counter-rotating, morphing caustic layers, a rim-lit shell and a specular highlight.

Cost controls: animations pause when the window is hidden; **Motion: Calm** freezes the field and
pointer light; **Material: Solid** removes all backdrop blur; macOS *Reduce Motion* / *Reduce
Transparency* are honoured automatically. **Material: Desktop** makes the main window see-through
to the wallpaper using native macOS vibrancy (`windowEffects`); the floating assistant always uses
HUD vibrancy. Backdrop *refraction* filters (SVG displacement) are not used because WebKit doesn't
support them in `backdrop-filter`.

## Persistence

SQLite in `data/database/nexus.db` (WAL). Migrations: numbered SQL files in
`nexus_core/db/migrations`, tracked in `schema_migrations`. FTS5 virtual tables with triggers index
chunks and memories. Embeddings are float32 blobs on `chunks`; `SQLiteVectorStore` implements the
`VectorStore` protocol that a Qdrant store can replace.
