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
- Colyseus is pinned to the **0.16** line (stable API). 0.17/0.18 have since shipped; upgrading is mostly a client package rename (`@colyseus/sdk`) and should be its own change. *(Done later: see Follow-up 2.)*
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
- Lighting is per-vertex face shading plus AO with a global day/night level. There is no flood-fill light propagation, so lamps glow but don't light their surroundings, and caves are lit at the same level as the surface. *(Fixed in the follow-up below.)*
- Water is static: it doesn't flow into holes you dig. *(Fixed in the follow-up below.)*
- In headless Chromium (SwiftShader software GL) the game runs at ~25–40 FPS. Real tablet GPUs are far faster; the performance pass on hardware is Phase 6.
- On first `npm run dev` start, Vite pre-bundles three.js and reloads the page once.

---

## Phase 3: Voxelvale multiplayer ✅

### What was built

**Server** (`server/src/rooms/VoxelRoom.ts`, `server/src/voxel/ServerVoxelWorld.ts`)
- The room picks a seed. Everyone generates identical terrain, so **only edits travel over the network**.
- **Server-authoritative block edits**: each 6-byte binary edit request is validated against the server's copy of the world:
  - rate limit (token bucket, 24 burst / 12 per s)
  - world bounds
  - breakability (no bedrock)
  - placeable block type
  - target cell must be empty or water
  - no overlap with any player
  - reach (eye to block centre ≤ 6 + 2 blocks of latency slack)
- Accepted edits are broadcast in one binary batch per 50 ms tick. Rejected edits go back to the sender with the authoritative block, so their optimistic change rolls back.
- **Late joiners and reconnecting players** get the full edit list as one binary message. The server keeps generated chunks in a 256-chunk LRU, so validation anywhere in the world stays cheap.
- Movement is client-simulated (co-op sandbox) but **sanity-checked**. Over-speed moves after the spawn grace period are snapped back with a teleport, and persistent offenders are kicked (close code 4100).
- **Chat** is sanitised (control and invisible characters removed, 120 chars) and **rate limited** (burst 4, then one message every 2 s), with join and leave system messages.
- **Parkour on the server clock**: checkpoints must be reached in order while standing near the pad, and a finish needs every checkpoint, the finish pad and a plausible time. Best times are replicated in the room state and announced in chat.
- The day/night time of day is shared by all players through the room state.

**Client** (`client/src/games/voxel/net/`, `client/src/games/common/`)
- `VoxelNet`:
  - **optimistic edits**: applied instantly, server echoes are no-ops (no remesh), rejects roll back
  - binary position updates at 15 Hz (only when changed, plus a 1 s keep-alive)
  - remote players rendered **120 ms in the past, interpolated** between schema snapshots
  - server-corrected teleports
  - synced day/night
- `AvatarRenderer`: blocky avatars with walk cycle, crouch and head pitch. All players render in **5 instanced draw calls total**, with canvas nametags that show through walls up to 48 m. It will be reused by the arena.
- `ChatBox`: fading log, input row (T / Enter on keyboard, chat button on tablets, which opens the on-screen keyboard; 16 px font to avoid iOS zoom).
- Pause menu lists the players in the room; the parkour HUD shows the room's best time.

### How to test
```bash
npm test            # 44 tests incl. VoxelRoom: edits, late join, rejects, spam limits, movement snap-back, chat, parkour
npm run e2e         # 19 browser tests incl. a 3-player Voxelvale session (edits, late join, chat, avatars)
npm run dev         # open two browser windows → Voxelvale → Private room in one, join with the code in the other
```

### Known issues / notes
- Edits are kept in memory per room: a room's world resets when everyone leaves. A persistence layer (Redis or SQLite) would be the next step. *(Fixed in the follow-up below: worlds are saved to disk.)*
- Player movement in Voxelvale is client-authoritative with server sanity checks (no full server physics). That is fine for a co-op sandbox; the competitive arena uses full server authority.
- Nametags draw through walls by design (helps find friends while building).

---

## Phase 4: Arcfire Arena vs bots ✅

### What was built

**Shared simulation** (`shared/src/arena/`, used by offline play now and the server in Phase 5)
- `maps.ts`: **3 original maps** built from axis-aligned boxes, point-mirrored so both sides are identical, each with spawns, a bot waypoint graph and a colour theme:
  - **Foundry Yard**: raised central deck with stairs, container lanes, corner gantries.
  - **Sunken Courts**: terraces overlooking a pillared court.
  - **Skybridge**: two towers linked by an exposed bridge over close-quarters cover.
- `geometry.ts`: slab ray tests and a grid-accelerated `BoxWorld` (raycast, overlap, line of sight).
- `movement.ts`: acceleration, friction, jump, crouch, gravity, **step-up for stairs** and snap-down.
- `weapons.ts`: Rifle (auto), Scattergun (9 pellets, falloff), Longshot (scoped sniper, one-shot headshot), Sidearm (semi-auto), Blade (melee). Each has damage, head multiplier, fire rate, magazine/reserve, reload time, spread (hip/ADS/moving/air), bloom, recoil, range falloff and zoom FOV.
- `player.ts`: `applyCommand`, **the single per-input step** for movement, weapon switching, reloads, fire rate, ammo, bloom and **deterministic spread** (seeded by player and command, so client tracers match the server).
- `hitscan.ts`: head and body hitboxes; walls block shots (line of sight); summed pellet damage.
- `sim.ts` (`ArenaSimulation`):
  - 30 Hz ticks
  - **command budget** (a client can't simulate faster than real time)
  - **lag-compensated hits** against a 16-tick hitbox history (capped at 220 ms)
  - teams or FFA, no friendly fire
  - round state machine: warmup → loadout (6 s) → live (90 s) → round end → **first to 5** → match end
  - elimination and time-out rules, plus stats (K/D, damage, accuracy, headshots)
- `bots.ts`: view-cone perception, reaction time, rate-limited aim with shrinking error, preferred range per weapon, strafing, ADS for snipers, reload and weapon fallback, and BFS over the waypoint graph with stuck detection. **Bots send the same commands as players**, so they follow the same rules.
- `protocol.ts`: binary input commands (16-bit seq with wrap-around) and per-client snapshots (cm-quantised poses), ready for Phase 5.

**Client** (`client/src/games/arena/`)
- `ArenaGame` uses the **same prediction, reconciliation and interpolation code offline and online**. Offline, `LocalBackend` runs the authoritative simulation in the browser and feeds it snapshots each tick.
- Rendering:
  - whole map as **one merged mesh** with baked shading, contact shadows and a world-space grid shader
  - gradient sky
  - instanced avatars with team colours and weapons
  - pooled instanced tracers, sparks and muzzle flashes
  - first-person weapon models drawn in an overlay pass, with sway, bob, kick, reload, draw, ADS and slash animations
- HUD:
  - dynamic crosshair (gap follows real spread), hit markers (headshot and kill variants), directional damage arcs, low-HP vignette
  - HP and ammo with reload bar, team scores or FFA leader, round timer, kill feed, round banners
  - sniper scope overlay, spectator camera after death
- Loadout picker between rounds, scoreboard (hold Tab or tap the button), end-of-match screen (MVP, stats table, next map or rematch).
- Touch layout:
  - Fire is a look-through button, so you shoot and aim with one thumb
  - Aim is a toggle; Jump, Crouch, Reload, Swap and Blade buttons
  - scoreboard and menu
- **Touch-only aim assist**: sensitivity slows near a visible enemy and never moves the camera on its own.
- Recoil kick with partial recovery; FOV zoom scales look sensitivity.

### How to test
```bash
npm test     # 51 shared tests incl. map validity (spawns, waypoints, nav connectivity), stairs, fire rate,
             # semi-auto, deterministic spread, headshots/LOS, lag compensation, speed-hack budget,
             # protocol round-trips, and complete bot-vs-bot matches in 1v1/2v2/FFA on all 3 maps
npm run e2e  # arena e2e: loadout pick, touch fire + reload, weapon keys + scoreboard, match end → next map
npm run dev  # Arcfire Arena → pick a mode → Practice vs bots
```

### Known issues / notes
- Bots are deliberately modest (reaction 0.4–0.55 s, imperfect tracking) for touch players. There's no difficulty selector yet.
- Hitboxes are two boxes (head and body) and don't animate with limbs.
- Dead players disappear instead of ragdolling.

---

## Phase 5: Arcfire Arena multiplayer netcode ✅

### What was built

**Server** (`server/src/rooms/ArenaRoom.ts`)
- Runs the shared `ArenaSimulation` at **30 Hz**, with an accumulator so the average rate holds even when Node timers drift. Each tick, every client gets a **binary snapshot** (≈220 bytes):
  - `tick`
  - `ack`: the last input command applied for that client
  - the client's own full simulation state (position, velocity, ammo, timers, bloom), used for reconciliation
  - everyone's quantised pose (cm positions, 16-bit angles, flags, HP, weapon)
- Discrete events (shots with tracer end points, hits, kills, round results) are batched per tick with rounded coordinates.
- Low-frequency data rides on the Colyseus schema at 10 Hz: roster, teams, K/D/damage/accuracy, phase, phase end tick, score, map, winners, warmup countdown and rematch votes.
- **Anti-cheat**, by never trusting client state:
  - Movement is simulated from inputs, and a per-player command budget stops speed hacks.
  - Fire rate, ammo, reloads and weapon switching all run on the server.
  - Shots are ray-cast against the map (line of sight) and against hitboxes **rewound to the shooter's view tick**, capped at 220 ms.
  - Input batches are size- and rate-limited (150 commands/s), and buttons are masked.
  - Malformed or flooding clients are kicked (close code 4100).
- Lobby flow:
  - Warmup: free-for-all damage with quick respawns, so you can practise while waiting.
  - **Auto-start** after a 5 s countdown once enough humans are in (2 for 1v1, 4 for 2v2, 3 for FFA).
  - The host can **start with bots** at any time; lonely public rooms fill with bots after 40 s.
  - A bot is retired when a human joins a full room, and teams are back-filled with bots when someone leaves mid-match.
  - Rematch votes; maps rotate after every match.
- Reconnects keep the player in the match; their command sequence restarts cleanly after a page reload.
- Chat (sanitised, rate-limited, join/leave notices) moved into `HubRoom`, so both games share it.

**Client** (`client/src/games/arena/net/`)
- `NetBackend` implements the same `ArenaBackend` interface as offline play, so `ArenaGame` is unchanged:
  - **Input**: 60 Hz commands sent as compact binary batches every frame; each one carries the tick the client is rendering, for lag compensation.
  - **Clock sync**: estimated from snapshot arrivals and biased toward the fastest packets, so `serverTick()` advances smoothly.
  - **Adaptive interpolation delay**: 2 ticks (66 ms) on clean Wi-Fi, up to 6 when jitter rises.
  - **Prediction and reconciliation**: the local player moves, shoots, spends ammo and reloads instantly. On every snapshot the client rewinds to the server state at `ack` and replays the unacknowledged commands. Small corrections are smoothed over ~100 ms; large ones snap.
  - Deterministic spread means locally predicted tracers match the server's.
- Warmup panel with the room code (tap to copy), roster with bots, auto-start countdown, and host buttons (**Start with bots / Start now**). Chat, rematch, and the reconnect banner come from Phase 1.

### How to test
```bash
npm test     # 70 tests incl. ArenaRoom: 30 Hz snapshots + acks, speed-hack budget, server-side fire rate,
             # ammo and lag-compensated hits over real WebSockets, start with bots, rematch, flood kick
npm run e2e  # incl. a two-browser online match: warmup lobby, prediction matching the server,
             # auto-start, live combat with predicted ammo confirmed by the server
npm run dev  # two windows → Arcfire Arena → Private room → join with the code → play
```
To feel the netcode under bad conditions, use Chrome DevTools → Network → throttling ("Fast 4G", "Slow 4G") in one window. Your own movement stays instant; others stay smooth but further in the past.

### Known issues / notes
- The server trusts the client's view angles (inherent to any FPS), so a client-side aimbot can't be detected; we only validate what physics and rules allow.
- WebSockets are TCP, so a lost packet stalls the stream briefly (head-of-line blocking). WebTransport/UDP would be the upgrade path.
- In headless CI the browser tests render through SwiftShader. The Playwright config passes `--disable-gpu-vsync` and anti-backgrounding flags and allows one retry, because software GL occasionally stalls frames.

---

## Phase 6: Performance, settings, polish and deployment ✅

### What was built
- **Auto quality**: a ≤0.15 s first-run GPU benchmark (offscreen WebGL2 fill-rate and ALU workload, forced to completion with a 1-pixel readback) combined with device hints (cores, memory, known entry-level GPUs) picks Low, Medium or High. It can be re-run from Settings.
- **Battery saver** (30 FPS cap). The dynamic-resolution budget follows the cap.
- **Render-distance caps per preset** (Low 3, Medium 5, High 8 chunks).
- **Stats overlay** now shows FPS, ping, preset and resolution scale, plus draw calls and triangles summed over all render passes.
- **Hot-path trims**:
  - The voxel chunk wish-list is rebuilt only when you cross a chunk border.
  - Scheduling is skipped while workers are saturated.
  - The sky gradient is recoloured only when the sky visibly changes, and its per-frame allocations were removed.
- **Settings**:
  - Battery saver and "Re-test this device" in Graphics.
  - "Reset all settings" (keeps nickname and colour).
  - Everything from earlier phases: quality, render distance, dynamic resolution, FPS/ping, look and mouse sensitivity, invert-Y, left-handed layout, auto-jump, aim assist, button size and opacity, touch layout editor, master/music/effects volume.
- **Menu music** in the hub (generative; games switch to their own track).
- Arena viewmodel resized so it doesn't crowd the touch buttons.
- **Deployment**:
  - `server/Dockerfile`: multi-stage, esbuild bundle, production deps only, non-root user, health check, overridable base image. **Built and run successfully**: `/health`, `/api/rooms` and matchmaking verified inside the container.
  - `fly.toml` (one always-on machine, since rooms are in memory), `../render.yaml` (Docker server + static client), `netlify.toml`, Cloudflare Pages steps in the README, and `_headers` for immutable asset caching.
- **README** rewritten: architecture, local run (including playing on a tablet over LAN), controls, settings, performance budget, deployment for Fly.io, Render, Docker, Cloudflare Pages and Netlify, configuration and known issues. Screenshots in `docs/screenshots/`.

### Measured render budget (Chromium; CPU-side cost per frame)
| Scene | Draw calls | Triangles | CPU per frame (median) |
| --- | --- | --- | --- |
| Voxelvale, Low (3 chunks) | 44 | 49 k | 0.9 ms |
| Voxelvale, Medium (5 chunks) | 61 | 126 k | 1.6 ms |
| Voxelvale, High (8 chunks) | 117 | 181 k | 3.1 ms |
| Arcfire Arena, FFA | 9 | 1.5 k | 1.1 ms |

### How to test
```bash
npm test && npm run e2e            # 70 + 26 automated tests
npm run build                      # client bundle sizes are printed by Vite
docker build -f server/Dockerfile -t cobalt-hub-server . && docker run -p 2567:2567 cobalt-hub-server
```
On a tablet: Settings → Show FPS & ping, then play both games on Auto quality. Try Battery saver and the render-distance slider, and edit the touch layout from the pause menu.

### Known issues / what to verify next
- **Real-device performance is not yet verified.** This environment has no GPU (tests use SwiftShader), so the 60 FPS target on a base iPad and 30 FPS on low-end Android still need checking on hardware. The benchmark thresholds in `client/src/core/render/benchmark.ts` may need tuning after that.
- Voxel worlds aren't persisted server-side; rooms reset when empty. *(Fixed in the follow-up below.)*
- No service worker / offline cache yet (the PWA manifest is in place).
- The FPS-cap and dynamic-resolution heuristics use frame intervals, so a browser that throttles `requestAnimationFrame` (e.g. Low Power Mode on iOS) will look like a slow GPU and drop resolution.

---

## Follow-up: Voxelvale limitations fixed ✅

Three limitations were listed after phase 6. This step fixes the first two: worlds now persist, and lamps light their surroundings, caves are dark, and water flows. As agreed, the third (the arena trusting client aim angles) is unchanged. The Colyseus 0.16 → 0.18 upgrade is still a separate decision.

### What was built

**Saved worlds (server)**

`server/src/voxel/WorldStore.ts` stores one binary file per world.
- **Format:** a `CVW1` header (seed, mode, private flag, time of day, save time) followed by the 6-byte edit list.
- **Safe writes:** each save goes to a temp file, is fsynced, then renamed. Saves of the same world are queued.
- **Bad data:** corrupt files are moved aside. Ids are validated before any file is touched.
- **Pruning:** worlds are deleted after `WORLD_TTL_DAYS` without a visit, and the oldest go when there are more than `MAX_SAVED_WORLDS`.
- **Memory store:** used for tests and `PERSIST_WORLDS=false`, and as a fallback, with a warning, when `DATA_DIR` isn't writable.

Rooms:
- **Private worlds:** a private sandbox world is saved under its room code.
- **Reopening:** `create('voxel', { reviveCode })` reopens a saved world.
  - It fails with `NO_SAVED_WORLD` or `ROOM_ALREADY_OPEN`.
  - Attempts are rate limited per address in `onAuth`.
- **Room codes:** claimed without races, and a new room never takes a saved world's code.
- **Public worlds:** quick-match sandbox rooms use 8 persistent slots, `public-1` to `public-8`. A slot whose save can't be restored is moved aside.
- **When it saves:**
  - Every 30 s while the world has changed.
  - Once more on dispose, which includes graceful shutdown, before the code or slot is released.
  - A world nobody built in is never written.

Client:
- Joining an unknown code tries to reopen a saved world.
- The pause menu says how long the world is kept.
- A chat line greets players in a restored world.

Deploy:
- **Docker:** a `/data` volume. The entrypoint takes ownership of it, then runs the server as `node` via `su-exec`.
- **Fly.io:** a `[mounts]` block, and the one-time `fly volumes create` step in the README.
- **Render:** a commented-out disk block, with `PERSIST_WORLDS=false` until a disk is attached.

**Light propagation (shared mesher + client)**

`shared/src/voxel/light.ts` flood-fills light over typed arrays.
- **Sky light:** level 15 straight down open columns, then spreads into shade.
- **Block light:** lamps give 15; checkpoint and finish pads give 10.
- **Blocking:** opaque blocks stop light; leaves, water and ice dim it faster.

The mesher now takes a 48×64×48 region: the chunk plus its 8 neighbours.
- It lights the region and writes 4 bytes per vertex: shade×AO, sky light, block light and an emissive flag.
- Light is smoothed per corner, and faces merge only when both AO and light match.

The shader turns light levels into brightness.
- **Curve:** `0.8^(15 − level)`.
- **Sky light** is scaled by daylight.
- **Lamp light** is warm-tinted.
- **Ambient floor:** a small minimum, so dark caves aren't pitch black.

`World` streaming changed to match.
- **Readiness:** a chunk is meshed only once all 8 neighbours have block data. A ring of data-only chunks sits beyond the render distance.
- **Edits:** only the neighbours whose border or light an edit can reach are remeshed, and the edited chunk goes first.

**Flowing water (shared + server + client)**

New blocks are flowing water levels 1–7 and falling water (ids 22–29). The water source takes Clay's hotbar slot; Clay stays placeable.

`shared/src/voxel/fluids.ts` is a deterministic, bounded queue simulator (at most 512 cells per step).
- Water above a cell makes it falling water.
- Otherwise the cell takes the best neighbour's level minus one, counting only neighbours that rest on solid ground or a source.
- Falling water passes on the level of the water feeding its column, so water travels at most 7 blocks sideways from its source in total, and falls don't restart the count.
- Water with no supply dries up.
- No new sources are created.

Server:
- `VoxelFluids` steps at 5 Hz inside `VoxelRoom`, and its changes are broadcast with player edits.
- Water may use at most 75 % of the 200 000-edit budget.
- Unfinished flows resume when a saved world is reopened.

Offline:
- `StreamedFluids` waits for unloaded chunks instead of treating them as solid.
- Saves keep only player edits, so water is rebuilt from its sources, and channels dug next to generated water refill on load.

Mesher:
- **Surface height:** level / 8, so a level-7 flow lines up with its 7/8-high source.
- **Steps:** the side of higher water next to lower water shows only the step between them.

### How to test
```bash
npm test && npm run e2e            # 168 + 26 automated tests (6 e2e skipped by design)
```
- **Saved world:**
  1. `npm run dev`, open Voxelvale → Private room, build something and leave.
  2. Enter the same code from the hub: the world comes back.
  3. Stop the server with Ctrl+C (a graceful shutdown saves), restart it, and enter the code again.
- **Water:** place Water (hotbar slot 11, key `-`) on a ledge and watch it spread and fall. Cover the source with a block and the flow dries up.
- **Light:** at night, place lamps and see the warm falloff. Dig into a hillside by day: the tunnel gets dark.

### Review round
An independent multi-reviewer pass over the merged change, with each finding checked by a second reviewer who tried to refute it, confirmed these issues. All are fixed, with tests:

- **Revive rate limit was spoofable.** The limit on reopening worlds by code trusted client-supplied headers (`Fly-Client-IP`, `X-Real-IP`, leftmost `X-Forwarded-For`). It now uses `Fly-Client-IP` only on Fly, otherwise the proxy-appended `X-Forwarded-For` entry (`TRUST_PROXY_HOPS`) or the TCP peer. IPv6 addresses are grouped by /64, and old addresses are evicted LRU instead of the whole table being cleared.
- **Final save could be lost on shutdown.** It could miss Fly's 5 s kill timeout when a seat reservation was pending. Rooms now save as shutdown starts, and `kill_timeout = 20`.
- **Saved-world store was unbounded between prunes.** Every save now enforces the world count and a byte budget, evicting the least recently saved world that isn't open, or refusing the save.
- **Reopening a world with lots of water overflowed the water queue.** It now feeds the saved water in gradually: only cells that can still change, newest first, capped per step by count and time. Dug cells next to water are re-checked too.
- **One source on a hill re-energised at every drop.** It could claim 10 000+ edits; it now wets about 165 cells on a 20-step staircase.
- **Flowing water starved terrain streaming.** Water-only changes now remesh at their own lower priority, at most every 250 ms per chunk, and streaming keeps a worker while terrain is missing.
- **Reconnecting players kept stale water.** The server's edit snapshot now replaces the client's overlay, regenerating chunks whose edits were undone.
- **Shallow water under a block left a see-through gap.** Its surface is now drawn.
- **The held block glowed in dark caves.** It now takes the light at the eye.

### Measured render budget
Same seed (12345), before and after light propagation (Chromium, SwiftShader):

| Scene | Draw calls | Triangles before → after | CPU per frame (median) |
| --- | --- | --- | --- |
| Voxelvale, Low (3 chunks) | 43 | 51 k → 53 k | 1.0 ms |
| Voxelvale, Medium (5 chunks) | 82 | 120 k → 128 k | 1.5 ms |
| Voxelvale, High (8 chunks) | 143 | 240 k → 261 k | 2.2 ms |

In the mesh workers, a chunk takes about 1.5 ms to light and about 12 ms to light and mesh.

### Known issues / notes
- **Visual check:** lighting and water were checked in headless Chromium screenshots only; check them on tablets too.
- **One server:** saved worlds live on one machine's disk. Running several server machines would need shared storage and room routing.
- **Disk use:** the worst case is about 1.2 MB per world (200 000 edits), so about 600 MB at the default limit of 500 worlds.
- **Water model:**
  - No new sources form, and currents don't push players.
  - A flood stopped by the water budget continues only when something next to it changes.
  - Offline, flows pause at unloaded chunks and resume when they load.
- **Render proxy hops:** `TRUST_PROXY_HOPS=1` for Render is based on Render appending the client address to `X-Forwarded-For`; confirm it on a live deploy. Too low groups clients together; it is never spoofable.
- **Avatars:** other players' avatars are still lit by daylight only.
- **Still open:**
  - The arena trusts client aim angles (left as is, as agreed).
  - The Colyseus upgrade has not been done.

---

## Follow-up 2: Colyseus 0.18 and a public website ✅

### What was built

**Colyseus 0.16 → 0.18**
- **Packages:** `@colyseus/core` 0.18.19, `@colyseus/ws-transport` 0.18.4 and `@colyseus/schema` 5.0.40. The client SDK moved from `colyseus.js` to `@colyseus/sdk` 0.18.5, as did the server tests.
- **Room lifecycle:**
  - `Room<{ state, metadata }>` generics.
  - A dropped player's seat is held in `onDrop()` via `allowReconnection()` and restored in `onReconnect()`; `onLeave()` now means gone for good.
  - `setTimestep()` replaces `setSimulationInterval()`.
- **Binary messages:** client `sendBytes` messages now reach only handlers registered with `onMessageBytes()`, so edits, movement and arena input use it. Without that change, every binary message from players was silently ignored, which the room tests caught.
- **HTTP:** Colyseus answers every request through its own router, so `/health` and `/api/rooms` became router endpoints. CORS follows `ALLOWED_ORIGINS` through `matchMaker.controller.getCorsHeaders`.
- **Revive rate limit:** `onAuth` now receives a Fetch `Request` without the socket. The server stamps each request's TCP peer address into its own header, overwriting anything the client sent, before Colyseus reads it.
- **Client reconnection:** the SDK reconnects a dropped room by itself, keeping the same `Room` object. `NetSession` maps `onDrop` / `onReconnect` / `onLeave` to the reconnect banner, tunes the retries to the server's 25 s seat window, and keeps the resume token current for page reloads.
- **Bundle size:** the network chunk is about 54 KB gzipped, up from 41 KB.

**Public website**
- **Workflow:** `.github/workflows/pages.yml` runs the typecheck and unit tests on GitHub, builds the client and deploys it to GitHub Pages at `https://dhiviyadev.github.io/Mobile_apps/`.
- **Base path:** `VITE_BASE` sets Vite's base path, and the web manifest uses relative URLs.
- **No-server builds:** `VITE_SERVER_URL=none` builds a static site without a game server. The hub shows "Offline mode", and online actions explain themselves instead of timing out.
- **Game server:** `render.yaml` puts it on Render's free plan, live at `https://cobalt-hub-server.onrender.com`. The website connects to it by default; the `GAME_SERVER_URL` repository variable overrides that.
- **Waking server:** a sleeping free server takes a minute or two to start.
  - **Hub:** when the server stops answering after a long silence (the first visit, a hidden tab, an offline game), the hub shows "Waking server…" for up to 3 minutes instead of "Server offline". A server that fails while being polled still shows as offline. Rooms from before an outage are no longer offered.
  - **Joins:** online joins first wait for `GET /health`. They try at most every 3 s, give up after 3 minutes, and show the seconds and a Cancel button.
- **Render redeploys:** a build filter in `render.yaml` limits them to server, shared and dependency changes, so website and docs pushes no longer restart the server and drop in-memory worlds.
- **Client addresses on Render:** `TRUST_PROXY_HOPS` is now 3, as Render users report. The server logs each new `X-Forwarded-For` entry count (counts only), so the value can be checked on the live service.
- **Custom domain:** `PAGES_CUSTOM_DOMAIN` builds for a custom domain such as a free `cobalt-hub.js.org`. The README has the steps.

### How to test
```bash
npm test && npm run e2e            # 188 + 26 automated tests (6 e2e skipped by design)
VITE_BASE=/Mobile_apps/ VITE_SERVER_URL=none npm run build -w client
(cd client && VITE_BASE=/Mobile_apps/ npx vite preview)   # → http://localhost:4173/Mobile_apps/
```
Verified here:
- **Server image:** the image built, and its health check, matchmaking and room lifecycle were smoke-tested on 0.18.
- **Static site:** loaded under `/Mobile_apps/` in headless Chromium, with both games playable offline and no failed requests.
- **GitHub Actions:** typecheck, tests and build pass.

### Known issues / notes
- **Pages switch:** GitHub Pages must be switched on once in the repository settings; the workflow's token isn't allowed to do it. The first deploy failed for exactly that reason.
- **Free server sleeps:** Render's free server sleeps when idle, so the first player after a quiet spell waits about a minute.
- **Container user switch:** the `su-exec` package the container uses to drop to the `node` user couldn't be fetched in this sandbox (the Alpine mirror is blocked here). That step was skipped for the local image check; Render and Fly fetch it normally.
