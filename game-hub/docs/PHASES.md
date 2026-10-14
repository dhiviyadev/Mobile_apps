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

---

## Phase 2: Voxelvale single-player with touch controls ✅

### What was built

**Shared voxel core** (`shared/src/voxel/`, pure TypeScript, unit tested)
- `noise.ts`: seeded 2D/3D simplex noise with fBm.
- `worldgen.ts`: deterministic terrain in 16×16×64 chunks. Rolling hills and ridged mountains, oceans and beaches, plains, forest, desert and snow biomes, trees on a jittered grid (which crosses chunk borders correctly), spaghetti caves plus deep caverns, and a bedrock floor. About 2 ms per chunk.
- `parkour.ts`: seeded floating obstacle course (single blocks, 2×2 pads, glass beams) with checkpoint pads every 8 jumps and a gold finish pad. Every jump is checked against the movement limits so the course is always beatable, and the early jumps are walkable without sprinting.
- `mesher.ts`: **greedy mesher with per-vertex ambient occlusion**. Faces only merge when their AO is uniform, so lighting stays exact. It outputs separate opaque and water buffers and lowers surface water slightly.
- `physics.ts`: axis-separated swept-AABB movement. Walk, sprint, jump (~1.25 blocks), crouch with **edge protection** (no falling off while sneaking), **auto-jump** onto single steps (tablet friendly, toggleable), and swimming with buoyancy and drag.
- `raycast.ts`: Amanatides–Woo voxel traversal, returning the face normal for placement.

**Client** (`client/src/games/voxel/`, lazy-loaded)
- Generation and meshing run in a **pool of Web Workers** (1–3 by core count), returning transferable typed arrays. `World` streams chunks nearest-first, prioritises edit remeshes, unloads far chunks, and keeps player edits in an overlay so they survive unloading.
- **One procedural pixel-art texture atlas** (8×8 tiles of 16 px, painted in code) and one custom shader. Lighting (face shade × AO × day/night) is baked per vertex, so each pixel costs one texture fetch plus fog. Greedy quads tile textures through `fract()` in the shader.
- Day/night cycle (10 min): gradient sky dome, sun, moon, stars, and drifting clouds (one instanced draw call).
- Break (hold, per-block hardness, 8-stage crack overlay, particle burst via one `InstancedMesh`) and place (tap, or hold to keep placing). The hotbar has 12 blocks with isometric icons rendered from the atlas.
- Held block in first person, drawn in a second pass so it never clips into walls. Also view bob, sprint FOV kick, footstep, jump, land and splash sounds, and an underwater tint and fog.
- Offline sandbox worlds **save to localStorage** (seed, edits, position, time); "New world" is in the pause menu.
- Parkour mode: timer starts when you leave the start pad, checkpoints, respawn on falling, finish, and best time stored locally.

**Shared engine pieces** (`client/src/core/`, reused by the arena)
- `InputManager` (device-independent actions, look, move, slots), `KeyboardMouse` (pointer lock, "Click to play" overlay), and `TouchControls`:
  - floating virtual joystick on the left that **auto-sprints** at the rim
  - drag-to-look on the rest of the screen
  - large hold, tap and toggle buttons; "look-through" buttons (Break, Place) also steer the camera while held
  - **built-in layout editor** (drag to move, +/− to resize, reset), saved per game
  - **left-handed mirroring**, global button size and opacity
- `GameRenderer` (quality presets, pixel-ratio cap, **dynamic resolution** that drops resolution when frame time stays over budget for 1 s and recovers after 4 s), `StatsOverlay` (FPS, ping, preset and resolution), and a shared pause menu.

### How to test
```bash
npm test              # 37 unit + integration tests (terrain, mesher, physics, raycast, parkour, lobby)
npm run e2e           # adds Voxelvale e2e: load, touch joystick/look/break/hotbar, parkour HUD, pause → hub, layout editor
npm run dev           # open Voxelvale → Play offline
```
Desktop: click to lock the mouse. WASD moves, Space jumps, Shift sprints, Ctrl crouches, left click breaks, right click places, wheel or 1–0 pick a block, Esc opens the menu.
Tablet: left thumb on the joystick (push to the rim to sprint), drag elsewhere to look, and use the Break, Place, Jump and Crouch buttons. Pause → Edit touch layout rearranges the controls.

### Known issues / notes
- Lighting is per-vertex face shading plus AO with a global day/night level. There is no flood-fill light propagation, so lamps glow but don't light their surroundings, and caves are lit at the same level as the surface.
- Water is static: it doesn't flow into holes you dig.
- In headless Chromium (SwiftShader software GL) the game runs at ~25–40 FPS. Real tablet GPUs are far faster; the performance pass on hardware is Phase 6.
- On first `npm run dev` start, Vite pre-bundles three.js and reloads the page once.
