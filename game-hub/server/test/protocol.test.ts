/**
 * The hub-wide protocol gate: rooms refuse pages built for another wire format
 * with a message old pages can show as is, and the HTTP endpoints report the version.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type HealthResponse, PROTOCOL_VERSION, type RoomListResponse } from '@hub/shared';
import { startTestServer, type TestServer, until } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('protocol version gate', () => {
  it('refuses joins from pages without a version (arena and voxel) with a reload message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the matchmaker logs every refused create
    await expect(ts.rawClient().create('arena', { nickname: 'Old' })).rejects.toThrow(/Reload the page/);
    await expect(ts.rawClient().create('arena', { nickname: 'Old' })).rejects.toThrow(/CLIENT_OUTDATED/);
    // VoxelRoom overrides onAuth (revive limits) and must still check the version first.
    await expect(ts.rawClient().create('voxel', { nickname: 'Old', mode: 'sandbox' })).rejects.toThrow(/CLIENT_OUTDATED/);
    await expect(ts.rawClient().joinOrCreate('voxel', { nickname: 'Old', mode: 'sandbox' })).rejects.toThrow(/Reload the page/);
  });

  it('refuses newer pages as "server being updated", also when joining by code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const newer = { nickname: 'Future', protocol: PROTOCOL_VERSION + 1 };
    await expect(ts.rawClient().create('arena', newer)).rejects.toThrow(/SERVER_OUTDATED/);
    const open = await ts.client().create('arena', { nickname: 'Host', mode: '1v1', private: true });
    await expect(ts.rawClient().joinById(open.roomId, newer)).rejects.toThrow(/SERVER_OUTDATED/);
    await expect(ts.rawClient().joinById(open.roomId, { nickname: 'Old' })).rejects.toThrow(/CLIENT_OUTDATED/);
    await open.leave();
  });

  it('lets the current version in', async () => {
    const room = await ts.rawClient().create('arena', { nickname: 'Now', mode: '1v1', private: true, protocol: PROTOCOL_VERSION });
    await until(() => room.state.players?.get(room.sessionId) !== undefined);
    const friend = await ts.rawClient().joinById(room.roomId, { nickname: 'Friend', protocol: PROTOCOL_VERSION });
    await until(() => room.state.players?.size === 2);
    await Promise.all([room.leave(), friend.leave()]);
  });

  it('reports the version on /health and /api/rooms', async () => {
    const health = (await (await fetch(`http://127.0.0.1:${ts.port}/health`)).json()) as HealthResponse;
    expect(health).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
    const rooms = (await (await fetch(`http://127.0.0.1:${ts.port}/api/rooms`)).json()) as RoomListResponse;
    expect(rooms.protocol).toBe(PROTOCOL_VERSION);
  });
});
