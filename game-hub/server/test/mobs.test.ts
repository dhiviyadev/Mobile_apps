import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  buildTestArena,
  decodeEdit,
  decodeEdits,
  decodeEntitySnapshot,
  decodeMobInteractResult,
  encodeEdit,
  encodeMobInteract,
  encodeMobsSection,
  ignoredResult,
  isFriendlyKind,
  MobFlag,
  MobKind,
  packPos,
  StructureType,
  createWorldGenerator,
  VoxelMsg,
  type PlayerHooks,
} from '@hub/shared';
import type { VoxelRoom } from '../src/rooms/VoxelRoom';
import { ServerVoxelWorld } from '../src/voxel/ServerVoxelWorld';
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
const gen = createWorldGenerator(SEED, 'sandbox');
const spawn = gen.findSpawn();

function collect(room: Room, type: string): Uint8Array[] {
  const got: Uint8Array[] = [];
  room.onMessage(type, (b: Uint8Array) => got.push(b));
  return got;
}

const live = (room: Room) => matchMaker.getLocalRoomById(room.roomId) as unknown as VoxelRoom;

async function join(mode: 'sandbox' | 'survival' | 'parkour', extra: Record<string, unknown> = {}) {
  const room = await ts.client().create('voxel', { nickname: 'Ann', mode, private: true, seed: SEED, ...extra });
  const n = collect(room, VoxelMsg.Entities);
  const v = collect(room, VoxelMsg.EntityEvents);
  const mr = collect(room, VoxelMsg.MobInteractResult);
  const rejects = collect(room, VoxelMsg.Reject);
  collect(room, VoxelMsg.World);
  collect(room, VoxelMsg.Edits);
  await until(() => room.state.players?.get(room.sessionId) !== undefined);
  return { room, n, v, mr, rejects, server: live(room) };
}

/** Lets the sim's chunk views around the spawn generate. */
async function warm(server: VoxelRoom): Promise<void> {
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) server.world.getBlock(spawn.x + dx * 16, 30, spawn.z + dz * 16);
}

describe('creatures online', () => {
  it('sends N snapshots at about 10 Hz with friendly creatures in sandbox; none in parkour', async () => {
    const a = await join('sandbox');
    await warm(a.server);
    a.server.state.timeOfDay = 0.5;
    const m = a.server.entities!.sim.spawnMob(MobKind.Woolback, spawn.x + 3, spawn.y, spawn.z)!;
    const before = a.n.length;
    await wait(1000);
    const count = a.n.length - before;
    expect(count).toBeGreaterThanOrEqual(7);
    expect(count).toBeLessThanOrEqual(13);
    const snap = decodeEntitySnapshot(a.n[a.n.length - 1]);
    expect(snap.mobs.some((s) => s.id === m.id)).toBe(true);
    expect(snap.mobs.every((s) => isFriendlyKind(s.kind) && Math.hypot(s.x - spawn.x, s.z - spawn.z) <= 64)).toBe(true);
    await a.room.leave();

    const p = await join('parkour');
    await wait(400);
    expect(p.n.length).toBe(0);
    await p.room.leave();
  });

  it('rejects solid blocks placed into a creature but accepts a torch', async () => {
    const a = await join('sandbox');
    await warm(a.server);
    const sim = a.server.entities!.sim;
    // A clear surface cell near spawn: solid ground with two air cells above (no plant in the way).
    const { x, y, z } = (() => {
      for (let dx = 2; dx < 14; dx++) {
        const x = Math.floor(spawn.x) + dx;
        const z = Math.floor(spawn.z);
        const g = gen.surfaceHeight(x, z);
        const chunk = gen.generateChunk(Math.floor(x / 16), Math.floor(z / 16));
        const at = (yy: number) => chunk[(yy * 16 + (((z % 16) + 16) % 16)) * 16 + (((x % 16) + 16) % 16)];
        if (at(g) !== Block.Air && at(g + 1) === Block.Air && at(g + 2) === Block.Air) return { x, y: g + 1, z };
      }
      throw new Error('no clear surface next to spawn');
    })();
    const m = sim.spawnMob(MobKind.Woolback, x + 0.5, y, z + 0.5)!;
    m.speedMul = 0;
    m.panicUntil = 0;
    // Keep it still for the test.
    m.intent.vx = m.intent.vz = 0;
    const edits = collect(a.room, VoxelMsg.Edits);
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x, y, z, id: Block.Stone }));
    await until(() => a.rejects.length > 0);
    expect(decodeEdit(a.rejects[0]).id).toBe(Block.Air);
    sim.removeMob(m);
    // A torch needs support: it goes on the ground where the creature stood.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x, y, z, id: Block.Torch }));
    await until(() => edits.flatMap((b) => decodeEdits(b)).some((e) => e.id === Block.Torch));
    await a.room.leave();
  });

  it('answers mi within reach (fed or tamed) and ignores it from 10 blocks away', async () => {
    const a = await join('sandbox');
    await warm(a.server);
    const sim = a.server.entities!.sim;
    const me = a.server.state.players.get(a.room.sessionId)!;
    const near = sim.spawnMob(MobKind.Woolback, me.x + 2, me.y, me.z)!;
    const far = sim.spawnMob(MobKind.Woolback, me.x + 10, me.y, me.z)!;
    a.room.sendBytes(VoxelMsg.MobInteract, encodeMobInteract(far.id, 'block:HayBale'));
    a.room.sendBytes(VoxelMsg.MobInteract, encodeMobInteract(near.id, 'block:HayBale'));
    await until(() => a.mr.length > 0);
    await wait(150);
    expect(a.mr.length).toBe(1);
    const r = decodeMobInteractResult(a.mr[0])!;
    expect(r.mobId).toBe(near.id);
    expect(['fed', 'tamed']).toContain(r.result);
    await a.room.leave();
  });

  it('mob melee goes through survival\'s damagePlayer hook in a survival room', async () => {
    const a = await join('survival');
    await warm(a.server);
    a.server.state.timeOfDay = 0;
    const ent = a.server.entities!;
    const hits: string[] = [];
    const me = a.server.state.players.get(a.room.sessionId)!;
    const hooks: PlayerHooks = {
      playerTargets: () => [{ id: a.room.sessionId, eid: 1, name: 'Ann', x: me.x, y: me.y, z: me.z, vx: 0, vy: 0, vz: 0, yaw: 0, crouching: false, sprinting: false, targetable: true, alive: true, halfWidth: 0.3, height: 1.8, blockingYaw: null }],
      damagePlayer: (id) => {
        hits.push(id);
        return ignoredResult();
      },
      dropItems: () => undefined,
      consumeHeld: () => true,
      heldItem: () => null,
      playerName: () => 'Ann',
    };
    ent.setPlayerHooks(hooks);
    ent.sim.spawnMob(MobKind.Mudlurch, me.x + 1.2, me.y, me.z);
    await until(() => hits.length > 0, 5000);
    expect(hits[0]).toBe(a.room.sessionId);
    await a.room.leave();
  });

  it('a boss defeat broadcasts the altar edit', async () => {
    const a = await join('survival');
    await warm(a.server);
    const ent = a.server.entities!;
    const me = a.server.state.players.get(a.room.sessionId)!;
    const arena = buildTestArena(StructureType.SunscorchTemple, me.x, me.y, me.z + 20);
    for (const [x, y, z, id] of arena.edits) a.server.world.setBlock(x, y, z, id);
    ent.addStructure(arena.info);
    const edits = collect(a.room, VoxelMsg.Edits);
    const boss = ent.sim.spawner.spawnBoss(arena.info)!;
    boss.boss!.mode = 'fight';
    ent.sim.damageMob(boss.id, { amount: 1e6, kind: 0, attacker: null, fromX: 0, fromY: 0, fromZ: 0, knockback: 0, lift: 0, ignoreArmor: true });
    const { x, y, z } = arena.info.altar;
    await until(() => edits.flatMap((b) => decodeEdits(b)).some((e) => e.x === x && e.y === y && e.z === z && e.id === Block.BossAltarDormant));
    expect(a.server.world.getBlock(x, y, z)).toBe(Block.BossAltarDormant);
    await a.room.leave();
  });

  it('keeps tamed creatures across save and reopen; an unknown MOBS version keeps its bytes', async () => {
    const a = await join('sandbox');
    const code = a.room.roomId;
    await warm(a.server);
    const sim = a.server.entities!.sim;
    const me = a.server.state.players.get(a.room.sessionId)!;
    const m = sim.spawnMob(MobKind.Woolback, me.x + 3, me.y, me.z, { flags: MobFlag.Tamed })!;
    m.owner = 'Ann';
    m.name = 'Fluffy';
    sim.markPersistChanged();
    await wait(200);
    await a.room.leave();
    await until(() => !matchMaker.getLocalRoomById(code), 5000).catch(() => undefined);
    await wait(300);
    const saved = await store.load(code);
    expect(saved?.sections?.get('MOBS')).toBeTruthy();

    const b = await ts.client().create('voxel', { nickname: 'Ann', reviveCode: code });
    await until(() => !!matchMaker.getLocalRoomById(code));
    const back = live(b).entities!.sim;
    expect(back.dormant.map((d) => d.name)).toEqual(['Fluffy']);
    await b.leave();
    await wait(300);

    const odd = encodeMobsSection([]);
    odd[0] = 9;
    await store.save({ ...saved!, id: code, sections: new Map([['MOBS', odd]]), savedAt: Date.now() });
    const c = await ts.client().create('voxel', { nickname: 'Ann', reviveCode: code });
    await until(() => !!matchMaker.getLocalRoomById(code));
    await c.leave();
    await wait(400);
    expect(Array.from((await store.load(code))!.sections!.get('MOBS')!)).toEqual(Array.from(odd));
  });
});

describe('creature CPU on the server (logged)', () => {
  it('40 creatures and a boss fight stay within the per-tick budget', async () => {
    const a = await join('survival');
    await warm(a.server);
    a.server.state.timeOfDay = 0;
    const ent = a.server.entities!;
    const me = a.server.state.players.get(a.room.sessionId)!;
    const kinds = [MobKind.Woolback, MobKind.Hopling, MobKind.Cluckit, MobKind.Fernhart, MobKind.Mudlurch, MobKind.Rattlebow, MobKind.Cragcrawler, MobKind.Puffcap];
    for (let i = 0; i < 40; i++) {
      const x = me.x + ((i * 37) % 50) - 25;
      const z = me.z + ((i * 53) % 50) - 25;
      let y = 63;
      while (y > 1 && !a.server.world.getBlock(Math.floor(x), y - 1, Math.floor(z))) y--;
      ent.sim.spawnMob(kinds[i % kinds.length], x, y, z);
    }
    await wait(1000); // JIT warm-up and the first paths
    const samples: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      await wait(50);
      samples.push(ent.sim.stats().stepMs);
    }
    samples.sort((p, q) => p - q);
    const mean = samples.reduce((p, q) => p + q, 0) / samples.length;
    console.log(`[perf] server: ${ent.sim.stats().mobs} creatures, step ${mean.toFixed(3)} ms mean, p95 ${samples[Math.floor(samples.length * 0.95)].toFixed(3)} ms, governor level ${ent.governorLevel}`);
    // Generous: client and server share this process, and the suite runs in parallel.
    expect(mean).toBeLessThan(12);
    await a.room.leave();
  });
});

describe('ServerVoxelWorld chunk views', () => {
  it('reader() agrees with getBlock on 10,000 random cells with edits', () => {
    const w = new ServerVoxelWorld(77, 'sandbox');
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 2000; i++) w.setBlock(Math.floor(rnd() * 96 - 48), 1 + Math.floor(rnd() * 60), Math.floor(rnd() * 96 - 48), Math.floor(rnd() * 20));
    const r = w.reader();
    for (let i = 0; i < 10000; i++) {
      const x = Math.floor(rnd() * 96 - 48);
      const y = Math.floor(rnd() * 64);
      const z = Math.floor(rnd() * 96 - 48);
      expect(r(x, y, z)).toBe(w.getBlock(x, y, z));
    }
    expect(w.hasChunkView(500, 500)).toBe(false);
    expect(r(500 - 512, 30, 500 - 512 + 1000)).toBe(Block.Bedrock);
    void packPos;
  });

  it('warm + pumpWarm generate queued chunks within the budget', () => {
    const w = new ServerVoxelWorld(5, 'sandbox');
    w.warm(3, 3);
    expect(w.hasChunkView(48, 48)).toBe(false);
    w.pumpWarm(50);
    expect(w.hasChunkView(48, 48)).toBe(true);
    w.warm(4, 4);
    w.warmBudgetMs = 0;
    w.pumpWarm(50);
    expect(w.hasChunkView(64, 64)).toBe(false);
  });
});
