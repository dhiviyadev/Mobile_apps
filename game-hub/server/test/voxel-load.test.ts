/**
 * Player cap (Package W5): a survival room with 30 headless players walking
 * around stays well inside the server's 50 ms tick, patches included.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import { encodeMove, VOXEL_MAX_PLAYERS, VoxelMsg } from '@hub/shared';
import type { VoxelRoom } from '../src/rooms/VoxelRoom';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

const PLAYERS = 30;

describe('crowded worlds', () => {
  it(`run ${PLAYERS} players within the tick budget`, { timeout: 60_000 }, async () => {
    const first = await ts.client().create('voxel', { nickname: 'P0', mode: 'survival', private: true, seed: 1234 });
    const rooms: Room[] = [first];
    for (let i = 1; i < PLAYERS; i++) rooms.push(await ts.client().joinById(first.roomId, { nickname: `P${i}` }));
    for (const r of rooms) r.onMessage('*', () => {});
    await until(() => first.state.players?.size === PLAYERS, 10_000);
    const room = matchMaker.getLocalRoomById(first.roomId) as unknown as Pick<VoxelRoom, 'maxClients' | 'state'> & { tick(dt: number): void; broadcastPatch(): boolean };
    expect(room.maxClients).toBe(VOXEL_MAX_PLAYERS);

    // Time every simulation tick and every state patch from here on.
    const ticks: number[] = [];
    const patches: number[] = [];
    const tick = room.tick.bind(room);
    room.tick = (dt: number) => {
      const t = performance.now();
      tick(dt);
      ticks.push(performance.now() - t);
    };
    const patch = room.broadcastPatch.bind(room);
    room.broadcastPatch = () => {
      const t = performance.now();
      const r = patch();
      patches.push(performance.now() - t);
      return r;
    };

    // Everyone walks in a circle around their own spot, 15 moves a second (as the client sends).
    const start = room.state.players.get(first.sessionId)!;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const s = (Date.now() - t0) / 1000;
      rooms.forEach((r, i) => {
        const a = s * 0.8 + i;
        const cx = start.x + (i % 6) * 6 - 15;
        const cz = start.z + Math.floor(i / 6) * 6 - 15;
        r.sendBytes(VoxelMsg.Move, encodeMove({ x: cx + Math.cos(a) * 2, y: start.y, z: cz + Math.sin(a) * 2, yaw: a, pitch: 0, flags: 0 }));
      });
      await wait(66);
    }
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const p95 = (xs: number[]) => sorted(xs)[Math.floor(xs.length * 0.95)] ?? 0;
    console.log(
      `${PLAYERS} players: tick ${mean(ticks).toFixed(2)} ms mean / ${p95(ticks).toFixed(2)} ms p95 (${ticks.length} ticks), ` +
        `patch ${mean(patches).toFixed(2)} ms mean / ${p95(patches).toFixed(2)} ms p95`,
    );
    expect(ticks.length).toBeGreaterThan(60);
    // 50 ms per tick is the whole budget; leave most of it for other rooms on the same server.
    expect(mean(ticks) + mean(patches)).toBeLessThan(15);
    for (const r of rooms) void r.leave().catch(() => undefined);
  });
});
