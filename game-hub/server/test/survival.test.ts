import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  type ClientEvent,
  createWorldGenerator,
  decodeEdit,
  decodeInvSync,
  decodeSurvivalEvents,
  decodeTeleport,
  decodeVitals,
  encodeAttack,
  encodeCell,
  encodeEdit,
  encodeHand,
  encodeInvOp,
  encodeMove,
  type GenVersion,
  Item,
  RefType,
  VoxelMsg,
} from '@hub/shared';
import { MemoryWorldStore } from '../src/voxel/WorldStore';
import { decodePlayers } from '../src/voxel/survivalSections';
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

/** A survival client that tracks its inventory, vitals and events. */
async function join(nickname: string, opts: { roomId?: string; playerKey?: string; mode?: string; reviveCode?: string } = {}) {
  const c = ts.client();
  const base = { nickname, playerKey: opts.playerKey };
  const room: Room = opts.reviveCode
    ? await c.create('voxel', { ...base, reviveCode: opts.reviveCode })
    : opts.roomId
      ? await c.joinById(opts.roomId, base)
      : await c.create('voxel', { ...base, mode: opts.mode ?? 'survival', private: true, seed: SEED });
  const inv = new Map<number, { item: number; count: number; meta: number }>();
  const events: ClientEvent[] = [];
  const rejects: number[] = [];
  const teleports: { x: number; y: number; z: number }[] = [];
  const dead: { cause: string; satchel: unknown }[] = [];
  let vitals: ReturnType<typeof decodeVitals> | null = null;
  let syncs = 0;
  let fullSync = false;
  room.onMessage(VoxelMsg.InvSync, (b: Uint8Array) => {
    const s = decodeInvSync(b);
    syncs++;
    if (s.full) fullSync = true;
    for (const [ref, item, count, meta] of s.slots) inv.set(ref, { item, count, meta });
  });
  room.onMessage(VoxelMsg.Vitals, (b: Uint8Array) => (vitals = decodeVitals(b)));
  room.onMessage(VoxelMsg.SurvivalEvents, (b: Uint8Array) => events.push(...decodeSurvivalEvents(b)));
  room.onMessage(VoxelMsg.Reject, (b: Uint8Array) => rejects.push(decodeEdit(b).id));
  room.onMessage(VoxelMsg.Teleport, (b: Uint8Array) => teleports.push(decodeTeleport(b)));
  room.onMessage(VoxelMsg.Dead, (m: { cause: string; satchel: unknown }) => dead.push(m));
  for (const t of [VoxelMsg.World, VoxelMsg.Edits, VoxelMsg.Chat, VoxelMsg.Container, 'N', 'V']) room.onMessage(t, () => {});
  await until(() => room.state.players?.get(room.sessionId) !== undefined);
  const me = () => room.state.players.get(room.sessionId);
  const count = (item: number) => [...inv.entries()].filter(([ref]) => ref < 37).reduce((n, [, s]) => n + (s.item === item ? s.count : 0), 0);
  const move = (x: number, y: number, z: number, yaw = 0, pitch = 0, flags = 0) => room.sendBytes(VoxelMsg.Move, encodeMove({ x, y, z, yaw, pitch, flags }));
  return { room, inv, events, rejects, teleports, dead, me, count, move, vitals: () => vitals, syncs: () => syncs, fullSync: () => fullSync };
}

const send = (room: Room, type: string, bytes: Uint8Array) => room.sendBytes(type, bytes);

describe('survival rooms', () => {
  it('give joiners an eid, full health, a full inventory sync and vitals', async () => {
    const a = await join('Ana');
    await until(() => a.fullSync() && a.vitals() !== null);
    expect(a.me().eid).toBeGreaterThanOrEqual(1);
    expect(a.me().hp).toBe(20);
    expect(a.vitals()!.hpHalf).toBe(40);
    await a.room.leave();
  });

  it('needs a dig start and enough time to break, drops the block and picks it up; placing consumes it', async () => {
    const a = await join('Digger');
    const gen = createWorldGenerator(SEED, 'survival', a.room.state.genVersion as GenVersion);
    const me = { x: a.me().x, y: a.me().y, z: a.me().z };
    const x = Math.floor(me.x) + 1;
    const z = Math.floor(me.z);
    const y = gen.surfaceHeight(x, z);
    await until(() => a.fullSync());
    send(a.room, VoxelMsg.Edit, encodeEdit({ x, y, z, id: Block.Air }));
    await until(() => a.rejects.length === 1);
    send(a.room, VoxelMsg.DigStart, encodeCell(x, y, z));
    await wait(1100);
    send(a.room, VoxelMsg.Edit, encodeEdit({ x, y, z, id: Block.Air }));
    await until(() => a.events.some((e) => e.type === 'dropSpawn'), 3000);
    expect(a.rejects).toHaveLength(1);
    // Step into the hole: the drop is picked up.
    a.move(x + 0.5, y, z + 0.5);
    await until(() => a.count(Block.Dirt) === 1, 4000);
    // Place it back: consumed; placing again with an empty hand is refused.
    send(a.room, VoxelMsg.Hand, encodeHand(0, 0, 0));
    const slot = [...a.inv.entries()].find(([, s]) => s.item === Block.Dirt && s.count > 0)![0];
    send(a.room, VoxelMsg.InvOp, encodeInvOp(1, { op: 'move', from: slot, to: 0, count: 0 }));
    await until(() => a.inv.get(0)?.item === Block.Dirt);
    a.move(me.x, me.y, me.z);
    await wait(100);
    send(a.room, VoxelMsg.Edit, encodeEdit({ x, y, z, id: Block.Dirt }));
    await until(() => a.count(Block.Dirt) === 0);
    send(a.room, VoxelMsg.Edit, encodeEdit({ x, y: y + 1, z, id: Block.Dirt }));
    await until(() => a.rejects.length === 2);
    await a.room.leave();
  });

  it('crafts planks from a log', async () => {
    const a = await join('Crafter');
    a.room.send('dbg', { give: ['block:Log', 1] });
    await until(() => a.count(Block.Log) === 1);
    send(a.room, VoxelMsg.InvOp, encodeInvOp(2, { op: 'craft', recipe: 1, times: 1 }));
    await until(() => a.count(Block.Planks) === 4);
    expect(a.count(Block.Log)).toBe(0);
    await a.room.leave();
  });

  it('PvP is off until the host turns it on; then hits deal damage with knockback and respect the cooldown', async () => {
    const a = await join('Host');
    const b = await join('Guest', { roomId: a.room.roomId });
    const p = a.me();
    a.move(p.x, p.y, p.z);
    b.move(p.x, p.y, p.z - 2);
    await wait(3200); // spawn protection
    a.move(p.x, p.y, p.z);
    b.move(p.x, p.y, p.z - 2);
    a.room.send('dbg', { give: ['wooden_sword', 1] });
    await until(() => a.count(Item.WoodenSword) === 1);
    const swordSlot = [...a.inv.entries()].find(([, s]) => s.item === Item.WoodenSword)![0];
    send(a.room, VoxelMsg.Hand, encodeHand(swordSlot, 0, 0));
    await wait(150);
    const bEid = b.me().eid;
    const attack = () => send(a.room, VoxelMsg.Attack, encodeAttack({ seq: 1, target: { refType: RefType.Player, id: bEid }, ex: p.x, ey: p.y + 1.62, ez: p.z, yaw: 0, pitch: 0, crit: false, sprint: false }));
    attack();
    await wait(300);
    expect(b.events.filter((e) => e.type === 'damage')).toHaveLength(0);
    a.room.send(VoxelMsg.Rules, { pvp: true });
    await until(() => a.room.state.rules === 1);
    await wait(500);
    attack();
    await until(() => b.events.some((e) => e.type === 'damage'));
    const d = b.events.find((e) => e.type === 'damage') as Extract<ClientEvent, { type: 'damage' }>;
    expect(d.amount).toBe(4);
    expect(Math.hypot(d.dvx, d.dvz)).toBeGreaterThan(1);
    await until(() => b.me().hp === 16);
    attack(); // within the cooldown
    await wait(250);
    expect(b.me().hp).toBe(16);
    // Guests cannot change rules.
    b.room.send(VoxelMsg.Rules, { pvp: false });
    await wait(200);
    expect(a.room.state.rules).toBe(1);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('takes fall damage from reported moves, dies into a satchel and respawns', async () => {
    const a = await join('Faller');
    const p = a.me();
    await wait(3200);
    const x = p.x;
    const z = p.z;
    const ground = p.y;
    a.move(x, ground + 10, z);
    for (let y = ground + 10; y >= ground; y -= 1) {
      await wait(60);
      a.move(x, y, z);
    }
    await until(() => a.me().hp === 14);
    a.room.send('dbg', { give: ['bread', 3] });
    await until(() => a.count(Item.Bread) === 3);
    a.room.send('dbg', { damage: 25 });
    await until(() => a.dead.length === 1);
    expect(a.dead[0].satchel).not.toBeNull();
    expect(a.events.some((e) => e.type === 'dropSpawn' && e.satchel && e.yours)).toBe(true);
    expect(a.count(Item.Bread)).toBe(0);
    send(a.room, VoxelMsg.Respawn, new Uint8Array([0]));
    await until(() => a.teleports.length > 0 && a.me().hp === 20);
    await a.room.leave();
  });

  it('restores inventories by player key; another key starts empty', async () => {
    const key = 'abcdefghijklmnopqrstuv';
    const a = await join('Keeper', { playerKey: key });
    const code = a.room.roomId;
    a.room.send('dbg', { give: ['iron_sword', 1] });
    await until(() => a.count(Item.IronSword) === 1);
    await a.room.leave();
    const start = Date.now();
    while (!(await store.exists(code)) && Date.now() - start < 5000) await wait(50);
    const saved = await store.load(code);
    expect(saved?.mode).toBe('survival');
    expect(decodePlayers(saved!.sections!.get('PLYR')!)).toHaveLength(1);
    while (Date.now() - start < 5000) {
      try {
        const b = await join('Keeper', { playerKey: key, reviveCode: code });
        await until(() => b.fullSync());
        expect(b.count(Item.IronSword)).toBe(1);
        const c = await join('Stranger', { playerKey: 'zyxwvutsrqponmlkjihgfe', roomId: code });
        await until(() => c.fullSync());
        expect(c.count(Item.IronSword)).toBe(0);
        await Promise.all([b.room.leave(), c.room.leave()]);
        return;
      } catch (err) {
        if (!/ALREADY_OPEN/.test(String(err))) throw err;
        await wait(100);
      }
    }
    throw new Error('could not reopen the world');
  });

  it('sandbox: weapons swing without hurting players and saves have no survival sections', async () => {
    const a = await join('Sandy', { mode: 'sandbox' });
    const b = await join('Box', { roomId: a.room.roomId });
    send(a.room, VoxelMsg.Hand, encodeHand(0, 0, Item.IronSword));
    const p = a.me();
    send(a.room, VoxelMsg.Attack, encodeAttack({ seq: 1, target: { refType: RefType.Player, id: b.me().eid }, ex: p.x, ey: p.y + 1.62, ez: p.z, yaw: 0, pitch: 0, crit: false, sprint: false }));
    await until(() => b.room.state.players.get(a.room.sessionId)?.swing === 1);
    expect(b.me().hp).toBe(20);
    expect(b.room.state.players.get(a.room.sessionId)?.held).toBe(Item.IronSword);
    expect(a.syncs()).toBe(0);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('rate limits attack spam', async () => {
    const a = await join('Spammer', { mode: 'sandbox' });
    for (let i = 0; i < 50; i++) send(a.room, VoxelMsg.Attack, encodeAttack({ seq: i, target: { refType: 0, id: 0 }, ex: 0, ey: 0, ez: 0, yaw: 0, pitch: 0, crit: false, sprint: false }));
    await wait(300);
    // Fist cooldown 0.35 s allows one swing; the bucket caps processing at 12 anyway.
    expect(a.me().swing).toBeLessThanOrEqual(2);
    await a.room.leave();
  });
});
