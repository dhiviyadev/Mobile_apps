/**
 * The service worker (built into sw.js by tools/pwa/plugin.ts).
 *
 * - install: downloads every precached file of this build, all or nothing,
 *   and checks that index.html really belongs to this build.
 * - activate: deletes older cobalt-hub-* caches and takes control of the page.
 * - fetch: page loads are network-first (3 s budget, then the offline copy);
 *   precached files are cache-first; other hashed assets are cached as they
 *   are used. Anything else, including all game-server traffic, is untouched.
 * - Updates wait until the page asks (SKIP_WAITING), so a running game is
 *   never swapped underneath the player.
 * - The kill-switch build (__SW_KILL__) deletes the caches and unregisters.
 */
import {
  CACHE_PREFIX,
  NAV_TIMEOUT_MS,
  precacheCacheName,
  routeRequest,
  RUNTIME_CACHE,
  RUNTIME_MAX_ENTRIES,
  type SwInfo,
  type SwMessage,
} from './routing';

declare const self: ServiceWorkerGlobalScope;

const SCOPE = self.registration.scope;
const abs = (rel: string) => new URL(rel, SCOPE).href;
const PRECACHE = precacheCacheName(__SW_BUILD_ID__);
const INDEX_URL = abs('index.html');
const PRECACHE_URLS = new Set(__SW_PRECACHE__.map(abs));

self.addEventListener('install', (event) => {
  if (__SW_KILL__) {
    void self.skipWaiting();
    return;
  }
  // No skipWaiting here: the page decides when to switch (update flow).
  event.waitUntil(precacheAll());
});

self.addEventListener('activate', (event) => event.waitUntil(__SW_KILL__ ? selfDestruct() : activate()));

self.addEventListener('message', (event) => {
  const msg = event.data as SwMessage | undefined;
  if (msg?.type === 'SKIP_WAITING') void self.skipWaiting();
  else if (msg?.type === 'GET_INFO') {
    const info: SwInfo = { buildId: __SW_BUILD_ID__, precache: __SW_PRECACHE__, kill: __SW_KILL__ };
    event.ports[0]?.postMessage(info);
  }
});

if (!__SW_KILL__) {
  self.addEventListener('fetch', (event) => {
    const r = event.request;
    const route = routeRequest({ url: r.url, method: r.method, mode: r.mode }, { scope: SCOPE, precache: PRECACHE_URLS });
    if (route === 'navigation') event.respondWith(navigate(event));
    else if (route === 'precache') event.respondWith(fromCache(r, false));
    else if (route === 'asset') event.respondWith(fromCache(r, true));
    // 'passthrough': no respondWith, so the browser fetches it normally.
  });
}

/** All or nothing: fetch everything first, write only if every file arrived and index.html is from this build. */
async function precacheAll(): Promise<void> {
  try {
    const fetched = await Promise.all(
      __SW_PRECACHE__.map(async (rel) => {
        const res = await fetch(new Request(abs(rel), { cache: 'reload' }));
        if (!res.ok || res.type !== 'basic') throw new Error(`[sw] precache ${rel}: HTTP ${res.status}`);
        return [abs(rel), res] as const;
      }),
    );
    const index = fetched.find(([u]) => u === INDEX_URL)?.[1];
    if (!index || !(await index.clone().text()).includes(__SW_ENTRY__)) {
      throw new Error('[sw] index.html belongs to a different deploy; retry later');
    }
    const cache = await caches.open(PRECACHE);
    await Promise.all(fetched.map(([u, res]) => cache.put(u, res)));
  } catch (err) {
    await caches.delete(PRECACHE);
    throw err; // install fails; the browser tries again on a later page load
  }
}

async function activate(): Promise<void> {
  try {
    await self.registration.navigationPreload?.enable();
  } catch {
    /* unsupported */
  }
  for (const key of await caches.keys()) {
    if (key.startsWith(CACHE_PREFIX) && key !== PRECACHE && key !== RUNTIME_CACHE) await caches.delete(key);
  }
  await trimRuntime();
  // First install: control the open page right away so it works offline without a reload.
  await self.clients.claim();
}

async function selfDestruct(): Promise<void> {
  for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX)) await caches.delete(key);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) await (c as WindowClient).navigate(c.url).catch(() => null);
}

/** Network first with a 3 s budget, then the precached page, then a tiny offline page. */
async function navigate(event: FetchEvent): Promise<Response> {
  // No init object: re-wrapping a navigation Request throws, so the timeout is a race.
  const network = (async () => ((await event.preloadResponse) as Response | undefined) ?? fetch(event.request))();
  // Keep the worker alive until the network settles, even when the cached copy wins.
  event.waitUntil(network.then(() => undefined, () => undefined));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res && res.ok) return res;
  } catch {
    /* offline */
  }
  const cached = (await caches.match(INDEX_URL, { cacheName: PRECACHE, ignoreVary: true })) ?? (await caches.match(INDEX_URL, { ignoreVary: true }));
  if (cached) return cached;
  try {
    return await network;
  } catch {
    return offlinePage();
  }
}

async function fromCache(req: Request, store: boolean): Promise<Response> {
  // All caches: a waiting build's precache counts too. ignoreVary: hosts may send "Vary: Origin",
  // and module scripts and crossorigin styles carry an Origin header the precache requests lack;
  // these files are content-hashed, so the stored copy is always the right one.
  const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (store && res.ok && res.type === 'basic') {
    const copy = res.clone();
    void caches
      .open(RUNTIME_CACHE)
      .then((c) => c.put(req, copy))
      .then(trimRuntime)
      .catch(() => undefined);
  }
  return res;
}

async function trimRuntime(): Promise<void> {
  const c = await caches.open(RUNTIME_CACHE);
  const keys = await c.keys(); // insertion order: oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - RUNTIME_MAX_ENTRIES))) await c.delete(k);
}

function offlinePage(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Cobalt Game Hub</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
      'background:#10162a;color:#eef2ff;font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
      '<div><h1>Cobalt Game Hub is offline</h1><p>Connect to the internet once so the games can download for offline play.</p>' +
      '<p><a style="color:#ffd166" href="./">Try again</a></p></div>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
