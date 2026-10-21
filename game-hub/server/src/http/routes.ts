/**
 * Tiny REST surface next to the Colyseus matchmaker, served by Colyseus' own
 * router (which handles every HTTP request on the server):
 *   GET /health      liveness probe for Fly.io / Render
 *   GET /api/rooms   public room list + online counts for the hub UI
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createEndpoint, createRouter, matchMaker } from '@colyseus/core';
import { GAME_IDS, type GameId, isGameId, type RoomListResponse, type RoomMeta } from '@hub/shared';
import { config } from '../config';
import { logger } from '../log';

const log = logger('http');

/**
 * Header carrying the TCP peer address of an HTTP request. stampPeerAddress()
 * sets it on every request before Colyseus reads the request, replacing any
 * value the client sent, so code behind the router (onAuth) can trust it.
 */
export const PEER_ADDRESS_HEADER = 'x-hub-peer-address';

export function stampPeerAddress(req: IncomingMessage): void {
  req.headers[PEER_ADDRESS_HEADER] = req.socket.remoteAddress ?? '';
}

const ROUTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

/**
 * True when Colyseus' router can turn the request into a Fetch Request. It
 * cannot for some methods (TRACE) or an unparseable Host / X-Forwarded-Proto,
 * and then fails without answering, so such requests get a 400 instead.
 */
export function isRoutable(req: IncomingMessage): boolean {
  if (!ROUTED_METHODS.has(req.method ?? '')) return false;
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return typeof proto === 'string' && URL.canParse(`${proto}://${req.headers.host}${req.url ?? '/'}`);
}

/** Proxies may chain X-Forwarded-Proto ("https, http"); the router expects one scheme. */
function normaliseForwardedProto(req: IncomingMessage): void {
  const raw = req.headers['x-forwarded-proto'];
  if (raw === undefined) return;
  const first = (Array.isArray(raw) ? raw[0] : raw).split(',')[0].trim().toLowerCase();
  if (first === 'http' || first === 'https') req.headers['x-forwarded-proto'] = first;
  else delete req.headers['x-forwarded-proto'];
}

const forwardedCounts = new Set<number>();

/**
 * Logs each new number of X-Forwarded-For entries (a few at most), so that
 * TRUST_PROXY_HOPS can be checked on a live deploy without logging addresses:
 * browsers send none themselves, so on their requests the count is the number
 * of proxies that append one.
 */
export function reportForwardedFor(req: IncomingMessage, report: (msg: string) => void = log.info): void {
  const raw = req.headers['x-forwarded-for'];
  if (raw === undefined || forwardedCounts.size >= 4) return;
  const entries = (Array.isArray(raw) ? raw.join(',') : raw).split(',').filter((s) => s.trim()).length;
  if (forwardedCounts.has(entries)) return;
  forwardedCounts.add(entries);
  report(`X-Forwarded-For with ${entries} entr${entries === 1 ? 'y' : 'ies'} seen (TRUST_PROXY_HOPS=${config.trustProxyHops})`);
}

/**
 * Puts one listener in front of the server's request listeners (Colyseus'
 * router among them): it stamps the peer address, turns away requests the
 * router cannot handle, and hands the rest on.
 */
export function guardRequests(server: Server): void {
  const listeners = server.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    stampPeerAddress(req);
    reportForwardedFor(req);
    normaliseForwardedProto(req);
    if (!isRoutable(req)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
      return;
    }
    for (const listener of listeners) listener.call(server, req, res);
  });
}

/**
 * CORS headers for every HTTP request (matchmaking included), following
 * ALLOWED_ORIGINS. Colyseus adds its defaults (methods, allowed headers).
 */
export function corsHeaders(headers: Headers): Record<string, string> {
  const origin = headers.get('origin') ?? '';
  const allowAll = config.allowedOrigins.includes('*');
  const allowed = allowAll || config.allowedOrigins.includes(origin);
  return { 'Access-Control-Allow-Origin': allowed ? origin || '*' : 'null', Vary: 'Origin' };
}

export async function buildRoomList(): Promise<RoomListResponse> {
  const all = await matchMaker.query({});
  const online = Object.fromEntries(GAME_IDS.map((g) => [g, 0])) as Record<GameId, number>;
  const rooms: RoomListResponse['rooms'] = [];
  for (const r of all) {
    if (!isGameId(r.name)) continue;
    online[r.name] += r.clients;
    const meta = (r.metadata ?? {}) as Partial<RoomMeta>;
    if (r.private || meta.private) continue;
    rooms.push({
      roomId: r.roomId,
      game: r.name,
      mode: meta.mode ?? '',
      clients: r.clients,
      maxClients: r.maxClients,
      locked: !!r.locked,
      status: meta.status,
    });
  }
  rooms.sort((a, b) => b.clients - a.clients);
  return { rooms, online };
}

const health = createEndpoint('/health', { method: 'GET' }, async (ctx) => {
  ctx.setHeader('Cache-Control', 'no-store');
  return { ok: true, uptime: Math.round(process.uptime()) };
});

const rooms = createEndpoint('/api/rooms', { method: 'GET' }, async (ctx) => {
  ctx.setHeader('Cache-Control', 'no-store');
  try {
    return await buildRoomList();
  } catch {
    throw ctx.error(500, { error: 'room query failed' });
  }
});

export function createRoutes() {
  return createRouter({ health, rooms });
}
