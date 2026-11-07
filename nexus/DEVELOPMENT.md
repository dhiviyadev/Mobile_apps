# Developing NEXUS

## Commands

| Task | Command |
|---|---|
| Everything (core + app) | `./scripts/dev.sh` |
| Core only | `./scripts/dev.sh --core` or `cd services/core && .venv/bin/python -m nexus_core` |
| UI in a browser | `./scripts/dev.sh --web` |
| Backend tests | `cd services/core && .venv/bin/python -m pytest -q` |
| Frontend typecheck / tests | `cd apps/desktop && npm run typecheck && npm test` |
| Rust shell check | `cd apps/desktop/src-tauri && cargo check` |
| Release build | `./scripts/build.sh` |
| API docs (authenticated) | `http://127.0.0.1:8765/docs` with the bearer token |

Root shortcuts: `npm run dev | test | build` from the repo root.

## Working without Ollama

`scripts/dev/fake_ollama.py` is a **dev-only** stand-in that speaks Ollama's wire format with canned
replies, for UI work on machines without Ollama (CI, Linux). Production code never uses it.

```bash
services/core/.venv/bin/python scripts/dev/fake_ollama.py --port 11434
```

## Code layout & conventions

* Python 3.11+, type hints throughout, Pydantic request models, no global state outside `AppState`.
* Any action with side effects goes through `permissions` (check → approval → audit).
* New task steps: call `TaskManager.add_event` when the step actually happens — never pre-fill
  progress.
* New migrations: add `NNN_description.sql` to `nexus_core/db/migrations` (applied in order, once).
* TypeScript strict mode with `noUncheckedIndexedAccess`. Zustand v5: selectors must return stable
  references — use `EMPTY` from `stores/core.ts` instead of `?? []`.
* UI tokens live in `src/styles.css` (`@theme`). Keep to graphite surfaces, silver accent, 12–16 px
  radii; no neon, no gradients beyond the orb.

## Tests

Backend tests replace Ollama and Hermes with in-process fakes built on `httpx.MockTransport` that
follow the documented wire formats (Ollama NDJSON chat stream, Hermes `/v1/runs` SSE including the
blocking `approval.request` behaviour, Hermes `stream-json` CLI output). Highlights:

* `test_security.py` — auth, Host guard, folder rules, traversal/symlinks, credential paths
* `test_files_approvals.py` — overwrite/delete approvals, backups, emergency stop
* `test_chat_models.py` — discovery, streaming, metrics, single-model mode, memory guard, citations
* `test_agents.py` — native tool loop with real events, denials, Hermes API & CLI adapters, approval relay
* `test_knowledge_memory_automations.py` — all document formats, hybrid search, memory review,
  cron, automations (manual, approval-denied, file trigger), restart recovery

## Debugging

* Core logs: `data/logs/core.log` (rotating) and `data/logs/core-stdout.log` when started by the app.
* Every task's full event timeline: `GET /api/tasks/{id}`.
* Live event stream: connect to `ws://127.0.0.1:8765/ws?token=…`.
* Tauri devtools: right-click → Inspect in `tauri dev` builds.

## Build process

`scripts/build.sh` → typecheck → vitest → `tauri build --target aarch64-apple-darwin` (Vite builds
`dist/`, Cargo builds the shell with LTO). Output: `NEXUS.app` and a `.dmg`. Builds are unsigned;
sign/notarise with your Developer ID for distribution. The app starts the Python core from the
checkout recorded in `launcher.json` (bundling Python into the `.app` is on the roadmap).
