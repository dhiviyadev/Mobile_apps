/**
 * Tiny REST surface next to the Colyseus matchmaker:
 *   GET /health      liveness probe for Fly.io / Render
 *   GET /api/rooms   public room list + online counts for the hub UI
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { matchMaker } from '@colyseus/core';
import { GAME_IDS, type GameId, isGameId, type RoomListResponse, type RoomMeta } from '@hub/shared';
import { config } from '../config';

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? '';
  const allowAll = config.allowedOrigins.includes('*');
  const allowed = allowAll || config.allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowAll ? '*' : allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
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

/** Request handler for everything that is not a matchmaking call. */
export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(req, res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    try {
      json(req, res, 200, await buildRoomList());
    } catch (err) {
      json(req, res, 500, { error: 'room query failed' });
    }
    return;
  }
  json(req, res, 404, { error: 'not found' });
}
