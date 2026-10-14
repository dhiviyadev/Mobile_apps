# Cobalt Game Hub

A tablet-first web game hub with two original online multiplayer 3D games:

- **Voxelvale**: a voxel sandbox for building, exploring and racing parkour courses.
- **Arcfire Arena**: a round-based arena shooter (1v1, 2v2, free-for-all).

All names, art, music and sound are original. Textures and audio are generated
procedurally in the browser, so there are no third-party assets to license.

| Part | Stack |
| --- | --- |
| `client/` | TypeScript, Vite, Three.js, vanilla DOM UI (no framework) |
| `server/` | Node.js, Colyseus 0.16 (authoritative rooms over WebSockets) |
| `shared/` | Types, constants and deterministic game logic used by both sides |

> Build progress and per-phase notes live in [`docs/PHASES.md`](docs/PHASES.md).

## Quick start (local)

Requirements: Node.js 20+ and npm 10+.

```bash
cd game-hub
npm install
npm run dev          # server on :2567, client on :5173 (both with hot reload)
```

Open http://localhost:5173. To play on a tablet on the same Wi-Fi, open
`http://<your-computer-ip>:5173`. The client connects to port 2567 on the
same host automatically.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and client in watch mode |
| `npm test` | Unit and server integration tests (Vitest) |
| `npm run e2e` | Browser smoke tests (Playwright, desktop and tablet profiles) |
| `npm run typecheck` | `tsc --noEmit` for all three packages |
| `npm run build` | Production build of the server (`server/dist`) and client (`client/dist`) |

## Configuration

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_SERVER_URL` | client build | `ws(s)://<page host>:2567` | Game server address, e.g. `wss://cobalt-hub.fly.dev` |
| `PORT` | server | `2567` | Listen port |
| `ALLOWED_ORIGINS` | server | `*` | Comma-separated origins allowed to call `/api/rooms` |
| `LOG_LEVEL` | server | `info` | `debug`, `info`, `warn` or `error` |

You can also point a running client at another server with `?server=wss://host`.
