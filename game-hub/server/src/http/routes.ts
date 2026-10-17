/**
 * Tiny REST surface next to the Colyseus matchmaker, served by Colyseus' own
 * router (which handles every HTTP request on the server):
 *   GET /health      liveness probe for Fly.io / Render
 *   GET /api/rooms   public room list + online counts for the hub UI
 */
import type { IncomingMessage } from 'node:http';
import { createEndpoint, createRouter, matchMaker } from '@colyseus/core';
import { GAME_IDS, type GameId, isGameId, type RoomListResponse, type RoomMeta } from '@hub/shared';
import { config } from '../config';

/**
 * Header carrying the TCP peer address of an HTTP request. stampPeerAddress()
 * sets it on every request before Colyseus reads the request, replacing any
 * value the client sent, so code behind the router (onAuth) can trust it.
 */
export const PEER_ADDRESS_HEADER = 'x-hub-peer-address';

export function stampPeerAddress(req: IncomingMessage): void {
  req.headers[PEER_ADDRESS_HEADER] = req.socket.remoteAddress ?? '';
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
