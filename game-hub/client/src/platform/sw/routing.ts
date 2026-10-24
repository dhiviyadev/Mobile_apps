/**
 * Service worker routing rules, kept pure so unit tests and the page can use
 * them too (compiles under both the DOM and WebWorker libs).
 *
 * Only GET requests for this site's own files are ever answered by the
 * worker. Everything else (the game server's HTTP API, other origins, other
 * projects on the same github.io host) goes straight to the network.
 * WebSockets never reach a service worker at all.
 */
export const CACHE_PREFIX = 'cobalt-hub-';
export const RUNTIME_CACHE = 'cobalt-hub-runtime-v1';
export const RUNTIME_MAX_ENTRIES = 60;
/** How long a page load waits for the network before the offline copy is used. */
export const NAV_TIMEOUT_MS = 3000;
export const precacheCacheName = (buildId: string): string => `${CACHE_PREFIX}precache-${buildId}`;

/** Paths that belong to a game server (Colyseus matchmaking, REST, health), never to the static site. */
export const SERVER_PATH_RE = /^(?:matchmake|api|health|colyseus)(?:\/|$)/;

export type SwRoute = 'passthrough' | 'navigation' | 'precache' | 'asset';

export interface RouteRequest {
  url: string;
  method: string;
  mode: string;
}

export interface RouteContext {
  /** The registration scope, e.g. https://dhiviyadev.github.io/Mobile_apps/ */
  scope: string;
  /** Absolute URLs (no query) of the precached files. */
  precache: ReadonlySet<string>;
}

export function routeRequest(req: RouteRequest, ctx: RouteContext): SwRoute {
  if (req.method !== 'GET') return 'passthrough';
  let url: URL;
  let scope: URL;
  try {
    url = new URL(req.url);
    scope = new URL(ctx.scope);
  } catch {
    return 'passthrough';
  }
  if (url.origin !== scope.origin) return 'passthrough'; // game server (onrender.com, :2567), CDNs
  if (!url.pathname.startsWith(scope.pathname)) return 'passthrough'; // other projects on the same host
  const rel = url.pathname.slice(scope.pathname.length);
  if (SERVER_PATH_RE.test(rel)) return 'passthrough'; // a game server deployed on the same origin
  if (url.searchParams.has('sw')) return 'passthrough'; // kill-switch URLs always reach the network
  if (rel === 'sw.js') return 'passthrough';
  if (req.mode === 'navigate') return rel === '' || rel === 'index.html' ? 'navigation' : 'passthrough';
  if (ctx.precache.has(url.origin + url.pathname)) return 'precache';
  if (rel.startsWith('assets/')) return 'asset';
  return 'passthrough';
}

/** Page → worker messages. GET_INFO replies on the transferred MessagePort. */
export type SwMessage = { type: 'SKIP_WAITING' } | { type: 'GET_INFO' };

export interface SwInfo {
  buildId: string;
  /** Precached paths relative to the scope. */
  precache: string[];
  kill: boolean;
}
