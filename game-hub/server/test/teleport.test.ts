/** Teleport menu on the server: places, requests, server-side jumps and WAYP persistence. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room } from '@colyseus/sdk';
import {
  decodeTeleport,
  decodeWaypoints,
  decodeWorld,
  encodeEdits,
  encodeMove,
  encodeWorld,
  type HostReadyMsg,
  SECTION_TAGS,
  type TeleportEvent,
  type TeleportOp,
  uploadChunks,
  VoxelMsg,
} from '@hub/shared';
import { playerKeyHash, resetHostLimits } from '../src/rooms/VoxelRoom';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

interface P {
  room: Room;
  events: TeleportEvent[];
  teleports: { x: number; y: number; z: number }[];
  op(o: TeleportOp): void;
  me(): { x: number; y: number; z: number };
  moveTo(x: number, y: number, z: number): Promise<void>;
}

function wrap(room: Room): P {
  const events: TeleportEvent[] = [];
  const teleports: { x: number; y: number; z: number }[] = [];
  room.onMessage(VoxelMsg.TeleportEvent, (e: TeleportEvent) => events.push(e));
  room.onMessage(VoxelMsg.Teleport, (b: Uint8Array) => teleports.push(decodeTeleport(b)));
  room.onMessage('*', () => {});
  const me = () => room.state.players.get(room.sessionId);
  return {
    room, events, teleports,
    op: (o) => room.send(VoxelMsg.TeleportOp, o),
    me,
    // Walk there in small steps so the speed check accepts it.
    moveTo: async (x, y, z) => {
      const from = { ...me() };
      const steps = Math.ceil(Math.hypot(x - from.x, z - from.z) / 0.4) + 1;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        room.sendBytes(VoxelMsg.Move, encodeMove({ x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k, z: from.z + (z - from.z) * k, yaw: 0, pitch: 0, flags: 0 }));
        await wait(55);
      }
      await until(() => Math.hypot(me().x - x, me().z - z) < 0.01);
    },
  };
}

describe('teleport menu (server)', () => {
  it('teleports to saved places and to players who accept', async () => {
    const a = wrap(await ts.client().create('voxel', { nickname: 'Ana', mode: 'sandbox', private: true, seed: 77, playerKey: 'anakeyanakeyanakeyana1' }));
    await until(() => a.events.some((e) => e.kind === 'places'));
    const b = wrap(await ts.client().joinById(a.room.roomId, { nickname: 'Ben' }));
    await until(() => a.room.state.players.size === 2);
    await wait(3100); // spawn grace over: moves are checked from here

    const home = { ...a.me() };
    a.op({ op: 'save', name: 'Home', color: 1 });
    await until(() => a.events.some((e) => e.kind === 'places' && e.list.length === 1));
    await a.moveTo(home.x + 6, home.y, home.z + 4);
    a.teleports.length = 0;
    a.op({ op: 'go', index: 0 });
    await until(() => a.teleports.length > 0);
    expect(Math.hypot(a.teleports[0].x - home.x, a.teleports[0].z - home.z)).toBeLessThan(2);
    // The state patch can arrive a moment after the teleport message on a slow machine.
    await until(() => Math.hypot(a.me().x - home.x, a.me().z - home.z) < 2);

    // Ben asks, Ana accepts: Ben lands next to Ana, and his next moves from there are accepted.
    b.op({ op: 'ask', to: a.room.sessionId });
    await until(() => a.events.some((e) => e.kind === 'request'));
    const req = a.events.find((e) => e.kind === 'request')!;
    expect(req).toMatchObject({ from: b.room.sessionId, name: 'Ben' });
    a.op({ op: 'answer', from: b.room.sessionId, accept: true });
    await until(() => b.teleports.length > 0);
    const at = b.teleports[0];
    const d = Math.hypot(at.x - a.me().x, at.z - a.me().z);
    expect(d).toBeGreaterThanOrEqual(1);
    expect(d).toBeLessThan(4.5);
    b.room.sendBytes(VoxelMsg.Move, encodeMove({ x: at.x + 0.2, y: at.y, z: at.z, yaw: 0, pitch: 0, flags: 0 }));
    await until(() => Math.abs(b.me().x - (at.x + 0.2)) < 0.01);

    // Someone else's place index is just theirs: Ben has none.
    const n = b.teleports.length;
    b.op({ op: 'go', index: 0 });
    await wait(150);
    expect(b.teleports.length).toBe(n);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('keeps places in the WAYP section of a hosted world and gives them back on rejoin', async () => {
    resetHostLimits();
    const key = 'hostplaceshostplaces01';
    const file = encodeWorld({ id: 'x', seed: 4321, mode: 'sandbox', private: true, timeOfDay: 0.3, savedAt: Date.now(), genVersion: 2, edits: encodeEdits([], true), sections: new Map() });
    const open = async (bytes: Uint8Array) => {
      const room = await ts.client().create('voxel', { nickname: 'Hosty', mode: 'sandbox', private: true, host: true, playerKey: key });
      const p = wrap(room);
      const saves: Uint8Array[] = [];
      let ready: HostReadyMsg | null = null;
      room.onMessage(VoxelMsg.HostSave, (b: Uint8Array) => saves.push(b));
      room.onMessage(VoxelMsg.HostReady, (m: HostReadyMsg) => (ready = m));
      for (const c of uploadChunks(bytes)) room.sendBytes(VoxelMsg.HostUpload, c);
      await until(() => ready !== null);
      return { p, saves };
    };
    const first = await open(file);
    await until(() => first.p.events.some((e) => e.kind === 'places'));
    first.p.op({ op: 'save', name: 'Base', color: 5 });
    await until(() => first.p.events.some((e) => e.kind === 'places' && e.list.length === 1));
    first.p.room.send(VoxelMsg.HostSaveRequest, {});
    await until(() => first.saves.length > 0);
    const saved = decodeWorld('x', first.saves.at(-1)!);
    const recs = decodeWaypoints(saved.sections!.get(SECTION_TAGS.waypoints)!);
    expect(recs).toEqual([{ key: playerKeyHash({ playerKey: key }), autoDecline: false, places: [expect.objectContaining({ name: 'Base', color: 5 })] }]);
    await first.p.room.leave();

    await wait(100);
    const again = await open(first.saves.at(-1)!);
    await until(() => again.p.events.some((e) => e.kind === 'places' && e.list.length === 1));
    await again.p.room.leave();
  });
});
