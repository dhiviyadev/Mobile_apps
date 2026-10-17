import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { isValidRoomCode, type RoomListResponse } from '@hub/shared';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

async function roomList(): Promise<RoomListResponse> {
  const res = await fetch(`http://127.0.0.1:${ts.port}/api/rooms`);
  return (await res.json()) as RoomListResponse;
}

describe('lobby & room system', () => {
  it('serves a health check', async () => {
    const res = await fetch(`http://127.0.0.1:${ts.port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('quick match puts players asking for the same mode in the same room', async () => {
    const a = await ts.client().joinOrCreate('voxel', { nickname: 'Alice', mode: 'sandbox' });
    const b = await ts.client().joinOrCreate('voxel', { nickname: 'Bob', mode: 'sandbox' });
    const c = await ts.client().joinOrCreate('voxel', { nickname: 'Cleo', mode: 'parkour' });
    expect(isValidRoomCode(a.roomId)).toBe(true);
    expect(b.roomId).toBe(a.roomId);
    expect(c.roomId).not.toBe(a.roomId);

    await until(() => a.state.players?.size === 2);
    const names = [...a.state.players.values()].map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
    expect(a.state.hostId).toBe(a.sessionId);

    const list = await roomList();
    const listed = list.rooms.find((r) => r.roomId === a.roomId);
    expect(listed?.clients).toBe(2);
    expect(listed?.maxClients).toBe(16);
    expect(list.online.voxel).toBe(3);

    await Promise.all([a.leave(), b.leave(), c.leave()]);
  });

  it('private rooms are hidden from listings and quick match but joinable by code', async () => {
    const host = await ts.client().create('arena', { nickname: 'Host', mode: '2v2', private: true });
    await wait(50);
    const list = await roomList();
    expect(list.rooms.find((r) => r.roomId === host.roomId)).toBeUndefined();
    expect(list.online.arena).toBeGreaterThanOrEqual(1);

    const stranger = await ts.client().joinOrCreate('arena', { nickname: 'Stranger', mode: '2v2' });
    expect(stranger.roomId).not.toBe(host.roomId);

    const friend = await ts.client().joinById(host.roomId, { nickname: 'Friend' });
    expect(friend.roomId).toBe(host.roomId);
    await until(() => host.state.players.size === 2);
    await Promise.all([host.leave(), stranger.leave(), friend.leave()]);
  });

  it('sanitises nicknames server-side', async () => {
    const r = await ts.client().joinOrCreate('arena', { nickname: '‮Evil<b>Name</b>', mode: 'ffa' });
    await until(() => r.state.players?.size === 1);
    expect(r.state.players.get(r.sessionId).name).toBe('EvilbNameb');
    await r.leave();
  });

  it('holds the seat after an unexpected drop and lets the player reconnect', async () => {
    const watcher = await ts.client().joinOrCreate('voxel', { nickname: 'Watcher', mode: 'sandbox' });
    const client = ts.client();
    const dropper = await client.joinById(watcher.roomId, { nickname: 'Dropper' });
    await until(() => watcher.state.players.size === 2);
    const token = dropper.reconnectionToken;
    const sessionId = dropper.sessionId;

    await dropper.leave(false); // abrupt close, not consented
    await until(() => watcher.state.players.get(sessionId)?.connected === false);
    expect(watcher.state.players.size).toBe(2);

    const back = await client.reconnect(token);
    expect(back.sessionId).toBe(sessionId);
    await until(() => watcher.state.players.get(sessionId)?.connected === true);
    await Promise.all([back.leave(), watcher.leave()]);
  });

  it('removes players who leave on purpose and passes host rights on', async () => {
    const a = await ts.client().joinOrCreate('arena', { nickname: 'First', mode: '1v1' });
    const b = await ts.client().joinById(a.roomId, { nickname: 'Second' });
    await until(() => b.state.players?.size === 2);
    expect(b.state.hostId).toBe(a.sessionId);
    await a.leave();
    await until(() => b.state.players.size === 1);
    expect(b.state.hostId).toBe(b.sessionId);
    await b.leave();
  });

  it('answers ping messages', async () => {
    const r = await ts.client().joinOrCreate('voxel', { nickname: 'Pinger', mode: 'sandbox' });
    const got = new Promise<number>((resolve) => r.onMessage('pong', resolve));
    r.send('ping', 1234.5);
    expect(await got).toBe(1234.5);
    await r.leave();
  });
});

/** Sends a raw HTTP request and returns the status line ('' if the server never answers). */
function rawRequest(head: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(ts.port, '127.0.0.1', () => socket.write(head));
    let data = '';
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(data.split('\r\n')[0]);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(data.split('\r\n')[0]);
      }
    });
    socket.on('error', () => resolve(''));
  });
}

describe('HTTP robustness', () => {
  it('answers requests the router cannot handle with 400 and keeps serving', async () => {
    expect(await rawRequest('TRACE /health HTTP/1.1\r\nHost: localhost\r\n\r\n')).toMatch(/ 400 /);
    expect(await rawRequest('GET /health HTTP/1.1\r\nHost: a b\r\n\r\n')).toMatch(/ 400 /);
    expect(await rawRequest('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-Proto: bogus scheme\r\n\r\n')).toMatch(/ 200 /);
    // Proxies that chain schemes still work.
    const chained = await fetch(`http://127.0.0.1:${ts.port}/health`, { headers: { 'X-Forwarded-Proto': 'https, http' } });
    expect(chained.status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${ts.port}/health`);
    expect(res.status).toBe(200);
  });
});

describe('dropped connections', () => {
  it('holds a dropped player\'s seat while the SDK reconnects by itself', async () => {
    const room = await ts.client().create('voxel', { nickname: 'Wobbly', mode: 'sandbox', private: true });
    room.reconnection.minUptime = 0; // the game allows early reconnects too (session.ts)
    let dropped = 0;
    let reconnected = 0;
    room.onDrop(() => dropped++);
    room.onReconnect(() => reconnected++);
    await until(() => room.state.players?.get(room.sessionId) !== undefined);
    const live = matchMaker.getLocalRoomById(room.roomId) as unknown as {
      clients: { getById(id: string): { ref: { terminate(): void } } | undefined };
      state: { players: Map<string, { connected: boolean }> };
    };

    // The socket dies without a close handshake, as when a tablet loses wifi.
    live.clients.getById(room.sessionId)!.ref.terminate();
    await until(() => dropped === 1);
    await until(() => reconnected === 1, 8000);
    expect(live.state.players.get(room.sessionId)?.connected).toBe(true);
    expect(room.state.players.get(room.sessionId)?.connected).toBe(true);

    // Same room object, and messages still flow both ways.
    let pong = 0;
    room.onMessage('pong', () => pong++);
    room.send('ping', 1);
    await until(() => pong === 1);
    await room.leave();
  });
});
