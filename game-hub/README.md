# Cobalt Game Hub

A tablet-first web game hub with **two original online multiplayer 3D games**
that run in the browser, on iPad and Android tablets as well as keyboard and mouse:

| | |
| --- | --- |
| **Voxelvale**: build, explore and race in a shared, procedurally generated block world (sandbox and parkour modes, up to 16 players). | **Arcfire Arena**: fast round-based shooter: 1v1, 2v2 and free-for-all, first to 5 rounds, three maps, five weapons, bots. |
| ![Voxelvale](docs/screenshots/voxel-sandbox.png) | ![Arcfire Arena](docs/screenshots/arena-live.png) |

All names, art, music and sound are original. Textures are painted in code, audio is synthesised with WebAudio, and maps and terrain are generated, so there are **no third-party assets** to license and the download stays small.

- Build log with per-phase summaries, test instructions and known issues: [`docs/PHASES.md`](docs/PHASES.md)
- More screenshots: [hub](docs/screenshots/hub.png), [parkour](docs/screenshots/voxel-parkour.png), [arena loadout](docs/screenshots/arena-loadout.png)

---

## Tech stack and layout

| Package | What it is |
| --- | --- |
| [`client/`](client) | TypeScript, Vite, Three.js; plain DOM UI (no framework) |
| [`server/`](server) | Node.js, Colyseus 0.16: authoritative rooms over WebSockets |
| [`shared/`](shared) | Deterministic game logic and types used by **both** sides: terrain generation, meshing, physics, weapons, the arena simulation, bots, binary protocols |

```
game-hub/
├── shared/src/
│   ├── voxel/       worldgen (seeded simplex), parkour, greedy mesher, physics, raycast, protocol
│   ├── arena/       maps, movement, weapons, player step, hitscan, simulation, bots, protocol
│   └── util/        noise, RNG, binary codec, rate limiter, text sanitising
├── server/src/
│   ├── rooms/       HubRoom (codes, reconnect, chat) · VoxelRoom · ArenaRoom · schema
│   └── http/        /health and /api/rooms
├── client/src/
│   ├── hub/         landing page, game sheets, launcher, room poller
│   ├── core/        input (touch + keyboard/mouse), renderer, quality, audio, settings, UI
│   ├── games/voxel/ world streaming + workers, sky, player, HUD, multiplayer
│   └── games/arena/ ArenaGame (prediction/interpolation), rendering, HUD, offline + online backends
├── server/Dockerfile, fly.toml, netlify.toml   (../render.yaml for Render)
└── docs/PHASES.md
```

### Key design decisions
- **One simulation, three users.** The arena's `ArenaSimulation` runs on the server for online play, in the browser for practice against bots, and its per-input step (`applyCommand`) drives client-side prediction. Bots send the same input commands as players, so they obey the same rules.
- **Seeded worlds.** Voxelvale terrain is generated identically on every client and on the server from a seed; only edits travel over the network.
- **Server authority where it matters.** Arena: movement, fire rate, ammo, line of sight and hits are all decided on the server, with lag compensation. Voxelvale: block edits are validated by the server; movement is client-simulated but speed-checked (it's a co-op sandbox).
- **Small first download.** The hub is ~21 KB gzipped JS + ~7 KB CSS. Three.js (~124 KB gz) and each game (~20–25 KB gz) load only when you open one; the network library (~41 KB gz) loads only when you join a room.

---

## Run it locally

Requirements: **Node.js 20+** and npm 10+.

```bash
cd game-hub
npm install
npm run dev          # game server on :2567 and Vite on :5173, both with hot reload
```

Open http://localhost:5173. **On a tablet:** connect it to the same Wi-Fi and open `http://<your-computer's-LAN-IP>:5173`. The client automatically talks to port 2567 on the same host.

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and client in watch mode |
| `npm test` | 70 unit and integration tests (Vitest): world generation, meshing, physics, combat rules, lag compensation, full bot matches, real Colyseus rooms over WebSockets |
| `npm run e2e` | 26 browser tests (Playwright, desktop and emulated Android tablet), incl. multi-touch and two-browser multiplayer |
| `npm run typecheck` | `tsc --noEmit` for all three packages |
| `npm run build` | Production builds: `server/dist/index.js` and `client/dist/` |
| `npm start` | Run the built server |

> The first `npm run e2e` uses the Chromium that Playwright 1.56 ships with. Run `npx playwright install chromium` if it isn't installed.

---

## Controls

### Tablet (touch)
| | Voxelvale | Arcfire Arena |
| --- | --- | --- |
| Move | Floating joystick: put your thumb anywhere on the left side; push to the rim to **sprint** | same |
| Look | Drag anywhere on the right | same; **light aim assist** slows the camera over an enemy (toggleable) |
| Actions | **Break** (hold, also steers the camera), **Place** (tap or hold), Jump, Crouch (toggle, stops you falling off edges) | **Fire** (hold, also steers the camera), Aim (toggle), Jump, Crouch, Reload, Swap, Blade |
| Other | Hotbar: tap or slide your finger across it · Chat · Menu | Scoreboard · Chat · Menu |

Every button can be **moved and resized**: Menu → *Edit touch layout*. You can also turn on **left-handed mode**, change button size and opacity, look sensitivity and invert-Y in Settings → Controls.

### Keyboard and mouse
| | Voxelvale | Arcfire Arena |
| --- | --- | --- |
| Move / jump / sprint / crouch | WASD · Space · Shift · Ctrl or C | WASD · Space · — · Ctrl or C |
| Mouse | Left: break · Right: place · Wheel: block | Left: fire · Right: aim · Wheel: weapon |
| Keys | 1–0, -, = hotbar · T chat · Esc menu | 1–3 weapons · R reload · V blade · B loadout · Tab scoreboard · T chat · Esc menu |

---

## Settings and tablet optimisation

- **Quality presets** (Low / Medium / High) are picked automatically by a ≤0.15 s GPU benchmark on first launch ("Auto"), and can be changed or re-tested in Settings → Graphics.
- **Dynamic resolution** lowers the render scale when frames take longer than the budget for ~1 s, and raises it again after ~4 s of headroom.
- **Battery saver** caps games at 30 FPS. Voxelvale **render distance** goes from 2 to 8 chunks, capped per preset (Low 3, Medium 5, High 8).
- **FPS, ping and draw-call** overlay (Settings → Show FPS & ping).
- Volume sliders for master, music and effects. Original synthesised SFX and a generative soundtrack for the menu and each game.
- Landscape is enforced on phones and tablets with a "rotate your device" overlay; **fullscreen** and orientation lock are requested where the browser supports them (Android Chrome; iPadOS Safari supports element fullscreen).
- During play there is no page scroll, pinch-zoom, double-tap zoom, long-press callout or text selection. Safe-area insets keep controls clear of notches.
- iOS: no pointer lock (touch look instead), WebAudio unlocked on the first tap, 16 px inputs (no zoom on focus), and the room is rejoined automatically if Safari reloads the tab.
- The screen is kept awake while playing (Wake Lock API, where available).

### Performance budget
Measured render cost per frame (CPU, Chromium):

| Scene | Draw calls | Triangles | CPU per frame (median) |
| --- | --- | --- | --- |
| Voxelvale, Low (3 chunks) | 44 | 49 k | 0.9 ms |
| Voxelvale, Medium (5 chunks) | 61 | 126 k | 1.6 ms |
| Voxelvale, High (8 chunks) | 117 | 181 k | 3.1 ms |
| Arcfire Arena, FFA | 9 | 1.5 k | 1.1 ms |

Techniques used:
- Greedy meshing with ambient occlusion, generated in Web Workers.
- One texture atlas and one shader for all terrain.
- The whole arena map merged into one mesh.
- Instanced avatars (5–6 draw calls for all players), tracers, sparks and particles.
- Frustum culling plus render-distance culling of chunks.
- Baked vertex lighting (no real-time lights on terrain).
- Pixel-ratio caps per preset.

These figures were captured with software rendering, so they show CPU and scene cost rather than real GPU speed. **Please verify on your target devices** (a base iPad and a low-end Android tablet): see "Known issues" in [`docs/PHASES.md`](docs/PHASES.md).

---

## Deploy

The client is a static site; the server is one Node process holding game rooms in memory.

### 1. Game server

**Fly.io** (config: [`fly.toml`](fly.toml))
```bash
cd game-hub
fly launch --no-deploy --copy-config   # pick a unique app name, keep the Dockerfile
fly secrets set ALLOWED_ORIGINS=https://your-client.example   # optional, defaults to "*"
fly deploy
# → wss://<app>.fly.dev
```
`fly.toml` keeps one machine running (`auto_stop_machines = "off"`) because rooms live in memory.

**Render** (Blueprint: [`../render.yaml`](../render.yaml)): New → Blueprint → select this repository. It creates the Docker web service (`game-hub/server/Dockerfile`, health check `/health`) and a static site for the client. After the first deploy, set the client's `VITE_SERVER_URL` to `wss://<server>.onrender.com` and redeploy the client.

**Any Docker host**
```bash
cd game-hub
docker build -f server/Dockerfile -t cobalt-hub-server .
docker run -p 2567:2567 -e ALLOWED_ORIGINS=* cobalt-hub-server
```
(Behind a registry rate limit, use `--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine`.)

### 2. Client (static)

Build with the server's address baked in:
```bash
VITE_SERVER_URL=wss://<your-server> npm run build -w client   # output: client/dist
```

**Cloudflare Pages:** Create project → connect the repo →
- Root directory: `game-hub`
- Build command: `npm ci && npm run build -w client`
- Build output: `client/dist`
- Environment variables: `VITE_SERVER_URL=wss://<your-server>` and `NODE_VERSION=22`

`client/public/_headers` sets long-term caching for hashed assets.

**Netlify:** Add site → import the repo → Base directory `game-hub`. [`netlify.toml`](netlify.toml) supplies the build command and output folder. Add `VITE_SERVER_URL` under Site settings → Environment variables.

You can also point any build at another server with `?server=wss://host` in the URL.

### Configuration

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_SERVER_URL` | client build | `ws(s)://<page host>:2567` | Game server WebSocket URL |
| `PORT` | server | `2567` | Listen port |
| `HOST` | server | `0.0.0.0` | Listen address |
| `ALLOWED_ORIGINS` | server | `*` | Comma-separated origins allowed to call `/api/rooms` |
| `LOG_LEVEL` | server | `info` | `debug`, `info`, `warn`, `error` |

---

## Status and known issues
All six phases are complete; see [`docs/PHASES.md`](docs/PHASES.md) for what each phase delivered, how to test it, and the known issues. Main limitations:
- Voxel worlds live in memory per room (no persistence when a room empties). Offline worlds are saved in the browser.
- Voxel lighting is baked AO and face shade with a global day/night level (no light propagation from lamps), and water doesn't flow.
- The arena trusts client aim angles (inherent to FPS games); everything else is validated on the server.
- Colyseus is pinned to the 0.16 line; 0.17/0.18 have since been released.
