# Build log, phase by phase

Each phase ends with a summary of what was built, how to test it, and known issues.

---

## Phase 1: Monorepo, hub UI, lobby and room system ✅

### What was built

**Monorepo** (`game-hub/`, npm workspaces)
- `shared/`: constants (room names, limits, modes), room-code helpers, nickname and chat sanitising, token-bucket rate limiter, seeded RNG and math helpers. It ships as TypeScript source and is consumed directly by Vite (client) and esbuild/tsx (server).
- `server/`: Colyseus 0.16 on a plain Node HTTP server.
  - `HubRoom` base class: unique **6-character room codes** (unambiguous alphabet, used as the Colyseus `roomId`, so `joinById(code)` just works), private rooms, nickname sanitising, host assignment and handover, a **25 s reconnection window** after unexpected drops, and a ping/pong channel.
  - `VoxelRoom` (16 players) and `ArenaRoom` (2/4/8 players by mode), with `filterBy(['mode'])` so quick match only pairs players asking for the same mode.
  - `GET /api/rooms` (public rooms plus per-game online counts) and `GET /health`.
  - Production build: esbuild bundles the server and `shared` into `server/dist/index.js`.
- `client/`: Vite + TypeScript, no UI framework.
  - Landing page with two large tappable game cards (original inline-SVG art), a nickname field and an avatar colour picker (saved in localStorage), and a join-by-code field.
  - Per-game sheet with mode picker, **Quick Match**, **Private room**, **Play offline / Practice vs bots** (wired up in later phases), and a live list of open rooms with player counts (polled every 4 s).
  - `NetSession`, a wrapper around a Colyseus room that **auto-reconnects** with backoff, re-binds handlers to the new room object, buffers messages that arrive before the lazily loaded game registers its handlers, measures ping, and resumes after a page reload (iOS sometimes reloads backgrounded tabs).
  - Launcher: user-gesture fullscreen and landscape lock (where supported), audio unlock, loading screen with progress, and lazy-loaded game bundles. The hub entry is ~16 KB gzipped; colyseus.js loads only when you join.
  - Settings store and menu (graphics, controls, audio tabs), procedural WebAudio SFX and generative music engine, toasts, dialogs, reconnect banner, and a "rotate your device" overlay.
  - Tablet guards: no pinch zoom, double-tap zoom, rubber-band scroll, text selection or long-press callout during play; safe-area insets; `--vh` fix for mobile Safari.
  - Phase 1 placeholder in-room view: room code with copy button, player list with host and reconnecting tags, ping, and leave.

### How to test
```bash
cd game-hub && npm install
npm test          # 14 unit + integration tests
npm run e2e       # 10 Playwright tests (desktop + emulated Android tablet)
npm run dev       # then open http://localhost:5173 in two browser windows
```
Manual check: pick a nickname, open Arcfire Arena, choose **Private room**, then type the code shown into the second window's "Have a room code?" box. Both windows list both players. Kill the server's network (or close the laptop lid briefly) to see the reconnect banner.

### Known issues / notes
- Colyseus is pinned to the **0.16** line (stable API). 0.17/0.18 have since shipped; upgrading is mostly a client package rename (`@colyseus/sdk`) and should be its own change.
- The room list polls over HTTP rather than using Colyseus' LobbyRoom. That is simpler and works behind any proxy, but it can lag a few seconds.
- Fullscreen and orientation lock are best-effort: iPhone Safari has neither, so the rotate overlay covers that case. iPadOS Safari supports element fullscreen.
