/** Lattice Rings on the server: lighting, two players crossing there and back, the Veil Wall, old worlds and rejoining inside the realm. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  checkGate,
  decodeEdit,
  decodeTeleport,
  encodeEdit,
  encodeMove,
  findLitGateNear,
  type GateFrame,
  gateCenter,
  gateInterior,
  gateRing,
  PORTAL,
  type PortalEvent,
  Realm,
  realmAt,
  VoxelMsg,
} from '@hub/shared';
import { MemoryWorldStore } from '../src/voxel/WorldStore';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
const store = new MemoryWorldStore();
beforeAll(async () => {
  ts = await startTestServer({ worldStore: store });
});
afterAll(async () => {
  await ts.close();
});

const SEED = 4242;

interface LiveRoom {
  world: { getBlock(x: number, y: number, z: number): number };
  state: { genVersion: number };
  applyServerEdit(x: number, y: number, z: number, id: number): boolean;
}
const live = (room: Room) => matchMaker.getLocalRoomById(room.roomId) as unknown as LiveRoom;

async function join(nickname: string, opts: { roomId?: string; playerKey?: string; reviveCode?: string; mode?: string } = {}) {
  const c = ts.client();
  const base = { nickname, playerKey: opts.playerKey };
  const room: Room = opts.reviveCode
    ? await c.create('voxel', { ...base, reviveCode: opts.reviveCode })
    : opts.roomId
      ? await c.joinById(opts.roomId, base)
      : await c.create('voxel', { ...base, mode: opts.mode ?? 'survival', private: true, seed: SEED });
  const events: PortalEvent[] = [];
  const teleports: { x: number; y: number; z: number }[] = [];
  const rejects: number[] = [];
  room.onMessage(VoxelMsg.PortalEvent, (e: PortalEvent) => events.push(e));
  room.onMessage(VoxelMsg.Teleport, (b: Uint8Array) => teleports.push(decodeTeleport(b)));
  room.onMessage(VoxelMsg.Reject, (b: Uint8Array) => rejects.push(decodeEdit(b).id));
  for (const t of [VoxelMsg.World, VoxelMsg.Edits, VoxelMsg.Chat, VoxelMsg.Container, VoxelMsg.InvSync, VoxelMsg.Vitals, VoxelMsg.SurvivalEvents, VoxelMsg.Dead, VoxelMsg.TeleportEvent, 'N', 'V']) room.onMessage(t, () => {});
  await until(() => room.state.players?.get(room.sessionId) !== undefined);
  const me = () => room.state.players.get(room.sessionId);
  /** Walks in small steps (the speed check accepts it). */
  const walk = async (x: number, y: number, z: number) => {
    const from = { x: me().x, y: me().y, z: me().z };
    const steps = Math.ceil(Math.hypot(x - from.x, z - from.z) / 0.35) + 1;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      room.sendBytes(VoxelMsg.Move, encodeMove({ x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k, z: from.z + (z - from.z) * k, yaw: 0, pitch: 0, flags: 0 }));
      await wait(52);
    }
    await until(() => Math.hypot(me().x - x, me().z - z) < 0.05);
  };
  return { room, events, teleports, rejects, me, walk };
}
type Client = Awaited<ReturnType<typeof join>>;

/** Clears a ring's site and builds a platform, then the twelve stones, with server edits. */
function buildRing(room: Room, f: GateFrame): void {
  const r = live(room);
  for (let v = -1; v < 6; v++) {
    for (let u = -1; u <= 5; u++) {
      for (const side of [-3, -2, -1, 0, 1, 2, 3]) {
        const x = f.axis === 0 ? f.x + u : f.x + side;
        const z = f.axis === 0 ? f.z + side : f.z + u;
        r.applyServerEdit(x, f.y + v, z, v === -1 ? Block.StoneBricks : Block.Air);
      }
    }
  }
  for (const c of gateRing(f)) r.applyServerEdit(c[0], c[1], c[2], Block.LatticeStone);
}

const read = (room: Room) => (x: number, y: number, z: number) => live(room).world.getBlock(x, y, z);

async function inVeil(c: Client, f: GateFrame): Promise<void> {
  const g = gateCenter(f);
  await c.walk(g.x, f.y + 1, g.z);
}

describe('Lattice Rings (server)', () => {
  it('two players light a ring, cross into the Gloamreach and one comes back', { timeout: 60_000 }, async () => {
    const a = await join('Ana');
    a.room.send('dbg', { give: ['dusk_lens', 1] });
    await wait(3200); // spawn grace over
    const p0 = { x: a.me().x, y: a.me().y, z: a.me().z };
    const f: GateFrame = { axis: 0, x: Math.floor(p0.x) - 2, y: Math.floor(p0.y), z: Math.floor(p0.z) + 4 };
    buildRing(a.room, f);
    const stone = gateRing(f)[1];
    a.room.send(VoxelMsg.PortalOp, { op: 'light', x: stone[0], y: stone[1], z: stone[2] });
    await until(() => a.events.some((e) => e.kind === 'lit'));
    expect(checkGate(read(a.room), f).lit).toBe(true);
    // The lens is spent.
    a.room.send(VoxelMsg.PortalOp, { op: 'light', x: stone[0], y: stone[1], z: stone[2] });
    await until(() => a.events.some((e) => e.kind === 'notice'));

    const b = await join('Ben', { roomId: a.room.roomId });
    await until(() => a.room.state.players.size === 2);
    await wait(3200);
    // Ana steps into the veil and stays; Ben watches. Stepping out early cancels.
    await inVeil(a, f);
    await until(() => a.events.some((e) => e.kind === 'charging'));
    await a.walk(f.x + 2.5, f.y, f.z + 2.5);
    await until(() => a.events.some((e) => e.kind === 'cancelled'));
    expect(realmAt(4, a.me().x)).toBe(Realm.Overworld);
    // The full two seconds: across.
    await inVeil(a, f);
    await until(() => a.events.some((e) => e.kind === 'arrived'), 6000);
    await until(() => realmAt(4, a.me().x) === Realm.Gloamreach);
    expect(Math.abs(a.me().x - (14500 + (f.x + 2.5 + 32000) / 4))).toBeLessThan(40);
    const arrival = a.events.find((e) => e.kind === 'arrived') as Extract<PortalEvent, { kind: 'arrived' }>;
    expect(arrival.realm).toBe(Realm.Gloamreach);
    // The partner stands, lit, next to Ana; Ben follows through the original gate to the same one.
    const partner = findLitGateNear(read(a.room), a.me().x, a.me().z, 12, 2, 63)!;
    expect(partner).toBeTruthy();
    await inVeil(b, f);
    await until(() => realmAt(4, b.me().x) === Realm.Gloamreach, 8000);
    expect(Math.hypot(b.me().x - a.me().x, b.me().z - a.me().z)).toBeLessThan(12);
    // Ben goes home through the partner; Ana stays.
    await wait(PORTAL.cooldownMs + 300);
    const g = gateCenter(partner);
    await b.walk(partner.axis === 0 ? g.x + 3.5 : g.x, partner.y, partner.axis === 0 ? g.z : g.z + 3.5);
    await b.walk(g.x, partner.y + 1, g.z);
    await until(() => realmAt(4, b.me().x) === Realm.Overworld, 8000);
    expect(Math.hypot(b.me().x - (f.x + 2.5), b.me().z - (f.z + 0.5))).toBeLessThan(12);
    expect(realmAt(4, a.me().x)).toBe(Realm.Gloamreach);
    // Breaking a lit stone closes the ring (a server edit as a player would send).
    live(a.room).applyServerEdit(stone[0], stone[1], stone[2], Block.Air);
    await wait(150);
    for (const c of gateInterior(f)) expect(read(a.room)(c[0], c[1], c[2])).toBe(Block.Air);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('rejects moves and edits inside the Veil Wall', { timeout: 30_000 }, async () => {
    const a = await join('Wall');
    await wait(3200);
    a.room.sendBytes(VoxelMsg.Move, encodeMove({ x: 13000.5, y: 30, z: 0.5, yaw: 0, pitch: 0, flags: 0 }));
    await until(() => a.teleports.length > 0);
    expect(realmAt(4, a.me().x)).toBe(Realm.Overworld);
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: 13000, y: 30, z: 0, id: Block.Stone }));
    await until(() => a.rejects.length > 0);
    await a.room.leave();
  });

  it('old worlds refuse politely', { timeout: 30_000 }, async () => {
    const a = await join('Elder', { mode: 'sandbox' });
    await wait(3200);
    (live(a.room).state as { genVersion: number }).genVersion = 3;
    const p = { x: a.me().x, y: a.me().y, z: a.me().z };
    const f: GateFrame = { axis: 0, x: Math.floor(p.x) - 2, y: Math.floor(p.y), z: Math.floor(p.z) + 4 };
    buildRing(a.room, f);
    const stone = gateRing(f)[1];
    a.room.send(VoxelMsg.PortalOp, { op: 'light', x: stone[0], y: stone[1], z: stone[2] });
    await until(() => a.events.some((e) => e.kind === 'notice'));
    const n = a.events.find((e) => e.kind === 'notice') as Extract<PortalEvent, { kind: 'notice' }>;
    expect(n.text).toBe('This world is too old for rifts. Create a new world to find the Gloamreach.');
    expect(checkGate(read(a.room), f).lit).toBe(false);
    await a.room.leave();
  });

  it('a player who logs out inside the Gloamreach rejoins there', { timeout: 60_000 }, async () => {
    const key = 'gloamkeygloamkeygloamk';
    const a = await join('Wanderer', { playerKey: key });
    const code = a.room.roomId;
    a.room.send('dbg', { give: ['dusk_lens', 1] });
    await wait(3200);
    const p = { x: a.me().x, y: a.me().y, z: a.me().z };
    const f: GateFrame = { axis: 0, x: Math.floor(p.x) - 2, y: Math.floor(p.y), z: Math.floor(p.z) + 4 };
    buildRing(a.room, f);
    const stone = gateRing(f)[1];
    a.room.send(VoxelMsg.PortalOp, { op: 'light', x: stone[0], y: stone[1], z: stone[2] });
    await until(() => a.events.some((e) => e.kind === 'lit'));
    await inVeil(a, f);
    await until(() => realmAt(4, a.me().x) === Realm.Gloamreach, 8000);
    const where = { x: a.me().x, y: a.me().y, z: a.me().z };
    await wait(300);
    await a.room.leave();
    const start = Date.now();
    while (!(await store.exists(code)) && Date.now() - start < 5000) await wait(50);
    const b = await join('Wanderer', { playerKey: key, reviveCode: code });
    expect(realmAt(4, b.me().x)).toBe(Realm.Gloamreach);
    expect(Math.hypot(b.me().x - where.x, b.me().z - where.z)).toBeLessThan(4);
    await b.room.leave();
  });
});
