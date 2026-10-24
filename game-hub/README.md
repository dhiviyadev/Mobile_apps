# Cobalt Game Hub

A tablet-first web game hub with **two original online multiplayer 3D games**
that run in the browser, on iPad and Android tablets as well as keyboard and mouse:

| | |
| --- | --- |
| **Voxelvale**: build, explore and race in a shared, procedurally generated block world (sandbox and parkour modes, up to 16 players). | **Arcfire Arena**: fast round-based shooter: 1v1, 2v2 and free-for-all, first to 5 rounds, three maps, five weapons, bots. |
| ![Voxelvale](docs/screenshots/voxel-sandbox.png) | ![Arcfire Arena](docs/screenshots/arena-live.png) |

All names, art, music and sound are original. Textures are painted in code, audio is synthesised with WebAudio, and maps and terrain are generated, so there are **no third-party assets** to license and the download stays small.

- **Play it:** https://dhiviyadev.github.io/Mobile_apps/ (GitHub Pages; see [Public website](#public-website-free))
- Build log with per-phase summaries, test instructions and known issues: [`docs/PHASES.md`](docs/PHASES.md)
- More screenshots: [hub](docs/screenshots/hub.png), [parkour](docs/screenshots/voxel-parkour.png), [arena loadout](docs/screenshots/arena-loadout.png)

---

## Tech stack and layout

| Package | What it is |
| --- | --- |
| [`client/`](client) | TypeScript, Vite, Three.js; plain DOM UI (no framework) |
| [`server/`](server) | Node.js, Colyseus 0.18: authoritative rooms over WebSockets |
| [`shared/`](shared) | Deterministic game logic and types used by **both** sides: terrain generation, meshing, physics, weapons, the arena simulation, bots, binary protocols |

```
game-hub/
├── shared/src/
│   ├── voxel/       worldgen (seeded simplex), parkour, light propagation, greedy mesher, flowing water, physics, raycast, protocol
│   ├── arena/       maps, movement, weapons, player step, hitscan, simulation, bots, protocol
│   └── util/        noise, RNG, binary codec, rate limiter, text sanitising
├── server/src/
│   ├── rooms/       HubRoom (codes, reconnect, chat) · VoxelRoom · ArenaRoom · schema
│   ├── voxel/       authoritative world copy, saved-world store, server-side water
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
- **Seeded worlds.** Voxelvale terrain is generated identically on every client and on the server from a seed; only edits travel over the network, and only edits are saved (a seed plus a compact edit list per world).
- **Lighting in the mesher.** Sky light and lamp light are flood-filled per chunk in the mesh workers and baked into vertices with smooth (per-corner) averaging, so caves are dark, lamps light their surroundings, and the GPU still does one texture fetch per pixel.
- **Server authority where it matters.** Arena: movement, fire rate, ammo, line of sight and hits are all decided on the server, with lag compensation. Voxelvale: block edits are validated by the server; movement is client-simulated but speed-checked (it's a co-op sandbox).
- **Small first download.** The hub is ~30 KB gzipped JS + ~8 KB CSS. Three.js (~124 KB gz) and each game (~20–25 KB gz) load only when you open one; the network library (Colyseus SDK, ~54 KB gz) loads only when you join a room. A service worker then downloads the rest (about 1 MB, 0.3 MB gzipped) in the background so everything also opens offline.

---

## Run it locally

Requirements: **Node.js 20+** and npm 10+.

```bash
cd game-hub
npm install
npm run dev          # game server on :2567 and Vite on :5173, both with hot reload
```

Open http://localhost:5173. **On a tablet:** connect it to the same Wi-Fi and open `http://<your-computer's-LAN-IP>:5173`. The client automatically talks to port 2567 on the same host.

Voxelvale sandbox worlds you build online are saved to `server/data/` (gitignored); delete it to start over.

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and client in watch mode |
| `npm test` | 270 unit and integration tests (Vitest): world generation, lighting, meshing, flowing water, saved worlds, physics, combat rules, lag compensation, full bot matches, real Colyseus rooms over WebSockets, the generated icons/manifest/search tags and the service worker |
| `npm run e2e` | 40 browser tests (Playwright, desktop and emulated Android tablet), incl. multi-touch, two-browser multiplayer, offline play from the service worker, and the Google app / in-app browser fallbacks |
| `npm run typecheck` | `tsc --noEmit` for all three packages |
| `npm run build` | Production builds: `server/dist/index.js` and `client/dist/` |
| `npm start` | Run the built server |

> The first `npm run e2e` uses the Chromium that Playwright 1.56 ships with. Run `npx playwright install chromium` if it isn't installed.
>
> `client/e2e/pwa.spec.ts` builds the production site into `client/dist-e2e` itself and serves it on port 4180 (`E2E_STATIC_PORT` moves it), to test the service worker, offline play and updates.

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
Measured render cost per frame (CPU, Chromium; Voxelvale offline sandbox, seed 12345, with light propagation):

| Scene | Draw calls | Triangles | CPU per frame (median) |
| --- | --- | --- | --- |
| Voxelvale, Low (3 chunks) | 43 | 53 k | 1.0 ms |
| Voxelvale, Medium (5 chunks) | 82 | 128 k | 1.5 ms |
| Voxelvale, High (8 chunks) | 143 | 261 k | 2.2 ms |
| Arcfire Arena, FFA | 9 | 1.5 k | 1.1 ms |

Against the same seed before light propagation, draw calls are unchanged and triangles are 4–9 % higher (faces lit differently are no longer merged). Light is computed in the mesh workers: about 1.5 ms per chunk for the flood fill and about 12 ms for light plus meshing.

Techniques used:
- Greedy meshing with ambient occlusion, generated in Web Workers.
- One texture atlas and one shader for all terrain.
- The whole arena map merged into one mesh.
- Instanced avatars (5–6 draw calls for all players), tracers, sparks and particles.
- Frustum culling plus render-distance culling of chunks.
- Baked per-vertex sky and lamp light (flood-filled in workers; no real-time lights on terrain).
- Pixel-ratio caps per preset.

These figures were captured with software rendering, so they show CPU and scene cost rather than real GPU speed. **Please verify on your target devices** (a base iPad and a low-end Android tablet): see "Known issues" in [`docs/PHASES.md`](docs/PHASES.md).

---

## Public website (free)

The hub is published to **GitHub Pages** by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml):

> **https://dhiviyadev.github.io/Mobile_apps/**

Every push to this branch (or `main`) that touches `game-hub/` runs the typecheck and unit tests, builds the client for that path and deploys it.

**One-time setup:**
1. Turn Pages on: [Settings → Pages](https://github.com/dhiviyadev/Mobile_apps/settings/pages) → *Build and deployment* → Source: **GitHub Actions**. Then re-run the latest *Publish website* run (Actions tab → the run → *Re-run all jobs*).
2. Only if the deploy then reports that the branch "is not allowed to deploy to github-pages": [Settings → Environments → github-pages](https://github.com/dhiviyadev/Mobile_apps/settings/environments) → *Deployment branches* → add `claude/web-game-hub-multiplayer-vs7eqq`, or merge the branch into `main`.

**Online play** goes through the game server on Render's free plan:

> **https://cobalt-hub-server.onrender.com** (health check: [`/health`](https://cobalt-hub-server.onrender.com/health))

- **Server setup:** it was created from [`render.yaml`](../render.yaml) with *New → Blueprint* on [Render](https://render.com), using this repository and branch. Render redeploys it when a push changes the server, the shared code or the dependencies; website-only and docs-only pushes leave it running.
- **Sleeping:** free instances sleep after 15 minutes without players and take a minute or two to wake. The hub then shows "Waking server…". Quick Match, private rooms and codes wait for the server: the loading screen counts the seconds and has a Cancel button.
- **Worlds:** kept in memory until the next restart.
- **Where the address is set:** the website workflow uses `wss://cobalt-hub-server.onrender.com` by default. To use another server, set the repository variable `GAME_SERVER_URL` ([Settings → Secrets and variables → Actions → Variables](https://github.com/dhiviyadev/Mobile_apps/settings/variables/actions)) and re-run *Publish website*. Set it to `none` for an offline-only site.
- **Origins:** keep the server's `ALLOWED_ORIGINS` at `*`, or list `https://dhiviyadev.github.io` plus any custom domain.

**Offline play** works whether or not the server is up. Voxelvale offline (sandbox and parkour) and Arcfire Arena against bots run fully in the browser. A build with `GAME_SERVER_URL=none` shows "Offline mode", and its online buttons explain that online play isn't set up.

### Free custom domain (optional)

`dhiviyadev.github.io/Mobile_apps` is already a free address. For a shorter name, [js.org](https://js.org) gives JavaScript projects a free `*.js.org` subdomain with HTTPS.
- At the time of writing, `cobalt-hub.js.org` was free.
- The request is a pull request from your own GitHub account.

1. Fork [js-org/js.org](https://github.com/js-org/js.org). In `cnames_active.js`, add this line in alphabetical order (just before `"cobalt-kit"`):
   ```js
     "cobalt-hub": "dhiviyadev.github.io/Mobile_apps",
   ```
   Then open the pull request, linking the live site.
2. In this repository:
   - Add the variable `PAGES_CUSTOM_DOMAIN` = `cobalt-hub.js.org`.
   - Re-run *Publish website*. The site is then built for the domain's root, with a `CNAME` file, as js.org checks for.
   - Set the same domain in [Settings → Pages → Custom domain](https://github.com/dhiviyadev/Mobile_apps/settings/pages).
3. Once js.org merges the request (usually within a few days), tick *Enforce HTTPS*. The game is then at **https://cobalt-hub.js.org**.

If you prefer, any domain you own works the same way: point a `CNAME` record at `dhiviyadev.github.io` and set `PAGES_CUSTOM_DOMAIN`.

## Install it as an app, play offline, and find it on Google

The website is an installable web app (PWA). Installed, it opens from the home screen full screen, with no browser bar, and works without internet.

**Installing.** The hub's **Install app** button (and the "Play it like an app" card on tablets) does the right thing for each browser:

| Where | How |
| --- | --- |
| Chrome, Edge, Samsung Internet (Android, Chromebook, Windows, Mac) | One tap: the browser's own install prompt. Without it yet: ⋮ menu → **Install app** / **Add to Home screen**, or the install icon in the address bar |
| iPad / iPhone Safari | Share → **Add to Home Screen** (the button shows the steps) |
| Chrome / Firefox / Edge on iOS | Share → **Add to Home Screen**, or open the page in Safari |
| Safari on a Mac | File → **Add to Dock** |
| The Google app, Facebook, Instagram and other in-app browsers | They can't install: the hub says so and offers **Open in Chrome** (Android) or explains **Open in Safari** (iOS). The games still run in them |

On Android the installed app is a real app entry, so "Hey Google, open Cobalt Hub" should open it.

**Offline.** After one online visit, a service worker keeps a copy of the hub, both games, the Voxelvale world worker, the styles and the icons. Then the hub, Voxelvale offline and Arcfire Arena against bots open with no connection, installed or not. Online play always needs the network, and the service worker never touches game-server traffic (WebSockets, matchmaking, `/api/rooms`, `/health`).

**Updates.** Page loads check the network first (3 s budget, then the offline copy). A new deploy downloads in the background; the hub then shows **A new version of Cobalt Hub is ready → Restart**, never during a game. Settings → **App** shows the version, offline status, install, **Check for updates**, storage protection and **Reset offline copy**.

**The Google app and in-app browsers.** The hub detects the Google app (on Android it usually opens results in a Chrome Custom Tab; on iOS it is an in-app browser), Android WebViews, social apps' browsers and iframes, and falls back gracefully when something is missing:
- no full screen → the game plays in the page (and suggests installing);
- no screen wake lock → touch input keeps the screen on while playing;
- no pointer lock → drag with the mouse button held to look;
- no localStorage → settings and worlds live in memory for the visit (the banner warns);
- no service worker → online only; if a deploy replaced a game's files, the hub offers a reload;
- no WebGL 2 or no module workers → a clear message instead of a broken game.

**Kill switches** (if the offline copy ever misbehaves):
1. Open the site with `?sw=off`: it removes the service worker and its caches on that device and remembers that (`?sw=on` undoes it). The loading screen links to it after 12 s.
2. Set the repository variable `SERVICE_WORKER` = `off` and re-run *Publish website*: every browser that has the site installs a worker that deletes itself and the offline copy at its next update check (on the next visit).
3. Settings → App → **Reset offline copy** on one device.

**Getting found on Google.** Every build has a title and description, a canonical URL, Open Graph and Twitter cards with a generated 1200×630 preview image, JSON-LD (`WebSite`, `VideoGame`/`WebApplication`, with no made-up ratings), a real `<h1>`, an About text, `robots.txt` and `sitemap.xml`. All icons and the preview are drawn by code at build time (`client/tools/pwa`). One-time steps in [Google Search Console](https://search.google.com/search-console):
1. Add a property → **URL prefix** `https://dhiviyadev.github.io/Mobile_apps/` → verification method **HTML tag**. Put the tag's `content` value in the repository variable `GOOGLE_SITE_VERIFICATION`, re-run *Publish website*, then click **Verify**.
2. **Sitemaps** → submit `sitemap.xml`. **URL Inspection** → the site's address → **Request indexing**.
3. On GitHub, set the repository's **About → Website** to the site's address.
4. Check the previews with the [Rich Results Test](https://search.google.com/test/rich-results) and any social-card preview tool.

github.io limits: crawlers read `robots.txt` only at a host's root, and Google shows a site name and favicon per host, not per folder. On `dhiviyadev.github.io/Mobile_apps/`, submit the sitemap in Search Console instead; a [custom domain](#free-custom-domain-optional) gets the full search appearance (`robots.txt` and `sitemap.xml` are emitted for it already).

A Google Play app (a Trusted Web Activity built with Bubblewrap from this same manifest) is possible later; it needs a custom domain (for `/.well-known/assetlinks.json`) and a Play developer account, and is not built.

## Deploy

The client is a static site; the server is one Node process holding game rooms in memory. Voxelvale sandbox worlds are also written to disk (`DATA_DIR`, `/data` in the image), so give the server a persistent volume if worlds should survive deploys and restarts.

### 1. Game server

**Fly.io** (config: [`fly.toml`](fly.toml))
```bash
cd game-hub
fly launch --no-deploy --copy-config   # pick a unique app name, keep the Dockerfile
fly volumes create hub_data --size 1 --region iad   # once; same region as primary_region
fly secrets set ALLOWED_ORIGINS=https://dhiviyadev.github.io   # optional, defaults to "*"; list every site serving the client
fly deploy
# → wss://<app>.fly.dev
```
`fly.toml` keeps one machine running (`auto_stop_machines = "off"`) because rooms live in memory, mounts the `hub_data` volume at `/data` for saved worlds, and gives a stopping server 20 s (`kill_timeout`) to save them. Fly volumes are root-owned, so the container's entrypoint takes ownership of `/data` and then runs the server as the unprivileged `node` user.

**Render** (Blueprint: [`../render.yaml`](../render.yaml)): New → Blueprint → select this repository. It creates the game server as a free Docker web service (`game-hub/server/Dockerfile`, health check `/health`). The client is published on GitHub Pages (see [Public website](#public-website-free)), which connects to `wss://cobalt-hub-server.onrender.com` by default. Render disks need a paid instance, so the blueprint sets `PERSIST_WORLDS=false`: worlds survive rooms emptying but not restarts, and players are told so. To keep them, uncomment the `disk` block in `render.yaml` and delete `PERSIST_WORLDS`. The blueprint also sets `TRUST_PROXY_HOPS=3`: Render's proxies (Cloudflare, then Render's own) append to `X-Forwarded-For`, and Render users report the client 3 entries from the right. Render doesn't document it, so check on a live deploy: the server logs `X-Forwarded-For with N entries seen` (counts only, no addresses), and for browser traffic `N` should equal `TRUST_PROXY_HOPS`. The blueprint's build filter limits redeploys to server, shared and dependency changes, because each redeploy drops the worlds kept in memory.

**Any Docker host**
```bash
cd game-hub
docker build -f server/Dockerfile -t cobalt-hub-server .
docker run -p 2567:2567 -v hub-data:/data -e ALLOWED_ORIGINS=* cobalt-hub-server
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

`client/public/_headers` sets long-term caching for hashed assets and makes browsers revalidate `sw.js`, `index.html` and the manifest (`netlify.toml` does the same on Netlify). Set `VITE_SITE_URL` to the site's address for the canonical and social-card URLs.

**Netlify:** Add site → import the repo → Base directory `game-hub`. [`netlify.toml`](netlify.toml) supplies the build command and output folder. Add `VITE_SERVER_URL` under Site settings → Environment variables.

You can also point any build at another server with `?server=wss://host` in the URL.

### Configuration

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_SERVER_URL` | client build | `ws(s)://<page host>:2567` | Game server WebSocket URL; `none` builds a static site for offline play only |
| `VITE_BASE` | client build | `/` | Path the site is served under (e.g. `/Mobile_apps/` on GitHub Pages) |
| `VITE_SITE_URL` | client build | unset | Public address of the site, e.g. `https://dhiviyadev.github.io/Mobile_apps/`. Enables the canonical URL, Open Graph/Twitter image URLs, JSON-LD URLs and `sitemap.xml` (the Pages workflow sets it; repository variable `SITE_URL` overrides) |
| `VITE_SW` | client build | `on` | `off` builds the kill-switch service worker, which removes itself and the offline copy (repository variable `SERVICE_WORKER`) |
| `VITE_GOOGLE_SITE_VERIFICATION` | client build | unset | Search Console HTML-tag verification value (repository variable `GOOGLE_SITE_VERIFICATION`) |
| `VITE_BUILD_SHA` | client build | `dev` | Commit shown in Settings → App (the workflow sets it) |
| `PORT` | server | `2567` | Listen port |
| `HOST` | server | `0.0.0.0` | Listen address |
| `ALLOWED_ORIGINS` | server | `*` | Comma-separated web origins allowed to use the server over HTTP: matchmaking (joining rooms) and `/api/rooms`. If you restrict it, include every site that serves the client, e.g. `https://dhiviyadev.github.io` and your custom domain |
| `LOG_LEVEL` | server | `info` | `debug`, `info`, `warn`, `error` |
| `DATA_DIR` | server | `./data` (`/data` in the image) | Where saved Voxelvale worlds are written (`worlds/<id>.cvw`) |
| `PERSIST_WORLDS` | server | on | `false`/`0` keeps saved worlds in memory only (until restart) |
| `WORLD_TTL_DAYS` | server | `30` | Saved worlds not visited for this long are deleted |
| `MAX_SAVED_WORLDS` | server | `500` | Most saved worlds kept; a new save evicts the least recently saved world that isn't open |
| `MAX_SAVED_WORLD_BYTES` | server | 850 MiB | Byte budget for world files on disk (same eviction rule) |
| `MAX_MEMORY_WORLD_BYTES` | server | 128 MiB | Byte budget when worlds are kept in memory (`PERSIST_WORLDS=false`) |
| `TRUST_PROXY_HOPS` | server | `0` | Reverse proxies that append to `X-Forwarded-For` (Render: `3`; the server logs the entry counts it sees). Used for the rate limit on reopening worlds by code. On Fly.io `Fly-Client-IP` is used automatically; otherwise the TCP peer address is used. Client-supplied headers are never trusted |

---

## Status and known issues
All six phases are complete, plus a follow-up that removed the Voxelvale limitations listed after phase 6; see [`docs/PHASES.md`](docs/PHASES.md) for what each step delivered, how to test it, and the known issues.

**Saved worlds.** Online sandbox worlds are kept when their room empties and across server restarts:
- A private room's world is saved under its room code. Entering that code later reopens it, with the same terrain, builds, water and time of day, for 30 days after the last visit (`WORLD_TTL_DAYS`). Reopening by code is rate limited.
- Quick-match sandbox rooms use eight persistent public worlds; a new public room continues the most recently played free one.
- Worlds autosave every 30 s while changed and on close. Parkour courses are not saved, and a room nobody built in is never written.
- The pause menu says whether, and for how long, the current world is kept. Offline worlds are still saved in the browser.

**Light and water.** Lamps (and parkour checkpoints) light their surroundings, caves and interiors are dark by day, and the block in your hand takes the light where you stand.

Water flows. It spreads up to 7 blocks sideways from its source in total, and a fall doesn't restart the count, so one source on a hillside stays small. It also falls, and dries up when its source is removed.

Online, the server runs the water and sends changes as ordinary edits; offline, the browser does. Water may use at most three quarters of a world's 200 000-edit budget, so floods can't stop players building. The room gets a chat notice when water hits that limit.

Remaining limitations:
- The arena trusts client aim angles (inherent to FPS games); everything else is validated on the server.
- Water is a simple 7-level model: no new sources form, currents don't push players, and a flood cut off by the edit budget resumes only when something nearby changes.
- Other players' avatars are lit by daylight only, not by lamps or cave darkness.
