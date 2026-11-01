import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  type BlockEdit,
  blockIndex,
  createWorldGenerator,
  decodeEdit,
  decodeEdits,
  encodeEdit,
  encodeEdits,
  TerrainGeneratorV1,
  VoxelMsg,
} from '@hub/shared';
import type { VoxelRoom } from '../src/rooms/VoxelRoom';
import { encodeWorld, FileWorldStore, MemoryWorldStore, type SavedWorld } from '../src/voxel/WorldStore';
import { startTestServer, until, wait } from './helpers';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-worlds-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const world = (id: string, over: Partial<SavedWorld> = {}): SavedWorld => ({
  id, seed: 1234, mode: 'sandbox', private: false, timeOfDay: 0.3, savedAt: 1_700_000_000_000, edits: encodeEdits([], true), ...over,
});

describe('world store: generator info and retiring', () => {
  it('reads savedAt and genVersion from both formats', async () => {
    const store = new FileWorldStore(await tempDir());
    await store.save(world('public-1', { savedAt: 5 }));
    await store.save(world('public-2', { savedAt: 6, genVersion: 2 }));
    expect(await store.info('public-1')).toEqual({ savedAt: 5, genVersion: 1 });
    expect(await store.info('public-2')).toEqual({ savedAt: 6, genVersion: 2 });
    expect(await store.info('public-3')).toBeNull();
    expect(encodeWorld(world('x', { genVersion: 1 }))[4]).toBe(1);
    const mem = new MemoryWorldStore();
    await mem.save(world('public-1', { genVersion: 2 }));
    expect(await mem.info('public-1')).toEqual({ savedAt: 1_700_000_000_000, genVersion: 2 });
    await mem.retire('public-1');
    expect(await mem.exists('public-1')).toBe(false);
  });

  it('retires to .legacy and prunes it after the age limit', async () => {
    const store = new FileWorldStore(await tempDir());
    await store.save(world('public-3', { savedAt: Date.now() }));
    await store.retire('public-3');
    expect(await store.exists('public-3')).toBe(false);
    expect(await fs.readdir(store.worldsDir)).toEqual(['public-3.cvw.legacy']);
    await store.prune(60_000, 100);
    expect(await fs.readdir(store.worldsDir)).toEqual(['public-3.cvw.legacy']);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(path.join(store.worldsDir, 'public-3.cvw.legacy'), old, old);
    await store.prune(60_000, 100);
    expect(await fs.readdir(store.worldsDir)).toEqual([]);
  });
});

async function track(room: Room) {
  const worldMsgs: Uint8Array[] = [];
  const edits: Uint8Array[] = [];
  const rejects: Uint8Array[] = [];
  room.onMessage(VoxelMsg.World, (b: Uint8Array) => worldMsgs.push(b));
  room.onMessage(VoxelMsg.Edits, (b: Uint8Array) => edits.push(b));
  room.onMessage(VoxelMsg.Reject, (b: Uint8Array) => rejects.push(b));
  room.onMessage(VoxelMsg.Chat, () => undefined);
  await until(() => room.state.players?.get(room.sessionId) !== undefined && worldMsgs.length > 0);
  const seen = () => edits.flatMap((b) => decodeEdits(b));
  return { room, rejects, seen, snapshot: () => decodeEdits(worldMsgs[worldMsgs.length - 1], true) };
}

describe('upgraded Voxelvale rooms', () => {
  it('opens new worlds on generator 2, with placement rules and the support cascade', async () => {
    const ts = await startTestServer();
    try {
      const SEED = 4242;
      const gen = createWorldGenerator(SEED, 'sandbox');
      const spawn = gen.findSpawn();
      const a = await track(await ts.client().create('voxel', { nickname: 'Gardener', mode: 'sandbox', private: true, seed: SEED }));
      expect(a.room.state.genVersion).toBe(2);
      const room = matchMaker.getLocalRoomById(a.room.roomId) as unknown as VoxelRoom;
      const get = (x: number, y: number, z: number) => room.world.getBlock(x, y, z);
      // A dry surface cell next to spawn with air (or a plant) above it.
      let soil: BlockEdit | null = null;
      for (let dx = 1; dx < 5 && !soil; dx++) {
        const x = Math.floor(spawn.x) + dx, z = Math.floor(spawn.z);
        const y = gen.surfaceHeight(x, z);
        if ([Block.Grass, Block.Dirt].includes(get(x, y, z)) && get(x, y + 2, z) === Block.Air) soil = { x, y, z, id: Block.Air };
      }
      expect(soil).not.toBeNull();
      const s = soil!;
      // A torch in mid-air is refused with the authoritative block.
      a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: s.x, y: s.y + 3, z: s.z, id: Block.Torch }));
      await until(() => a.rejects.length === 1);
      expect(decodeEdit(a.rejects[0]).id).toBe(Block.Air);
      // A flower on the soil (replacing any grass there), then the soil goes: the flower goes too.
      a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: s.x, y: s.y + 1, z: s.z, id: Block.Sunpetal }));
      await until(() => a.seen().some((e) => e.id === Block.Sunpetal));
      a.room.sendBytes(VoxelMsg.Edit, encodeEdit(s));
      await until(() => a.seen().some((e) => e.x === s.x && e.y === s.y + 1 && e.z === s.z && e.id === Block.Air));
      expect(a.seen()).toContainEqual(s);
      expect(get(s.x, s.y + 1, s.z)).toBe(Block.Air);
      expect(a.rejects).toHaveLength(1);
      await a.room.leave();
    } finally {
      await ts.close();
    }
  });

  it('keeps old saves on generator 1 and gives public play the new terrain', async () => {
    const dir = await tempDir();
    const store = new FileWorldStore(dir);
    const ts = await startTestServer({ worldStore: store });
    try {
      // An old private world keeps its terrain.
      await store.save(world('K7PX2M', { private: true, seed: 1234, edits: encodeEdits([{ x: 0, y: 40, z: 0, id: Block.Brick }], true) }));
      const old = await track(await ts.client().create('voxel', { nickname: 'Returner', reviveCode: 'K7PX2M' }));
      expect(old.room.state.genVersion).toBe(1);
      const room = matchMaker.getLocalRoomById('K7PX2M') as unknown as VoxelRoom;
      const v1 = new TerrainGeneratorV1(1234).generateChunk(3, -2);
      for (let i = 0; i < v1.length; i += 97) {
        const x = i % 16, z = Math.floor(i / 16) % 16, y = Math.floor(i / 256);
        expect(room.world.getBlock(48 + x, y, -32 + z)).toBe(v1[blockIndex(x, y, z)]);
      }
      await old.room.leave();

      // Public slots: a v2 save wins over an empty slot and an old v1 save.
      await store.save(world('public-1', { savedAt: 10, seed: 111 }));
      await store.save(world('public-2', { savedAt: 20, seed: 222, genVersion: 2 }));
      const p = await track(await ts.client().create('voxel', { nickname: 'Visitor', mode: 'sandbox' }));
      expect(p.room.state.seed).toBe(222);
      // With only old saves free, the oldest is retired and a fresh v2 world starts there.
      for (let i = 3; i <= 8; i++) await store.save(world(`public-${i}`, { savedAt: 100 + i, seed: 1000 + i }));
      const q = await track(await ts.client().create('voxel', { nickname: 'Newcomer', mode: 'sandbox' }));
      expect(q.room.state.genVersion).toBe(2);
      expect(q.room.state.seed).not.toBe(111);
      await until(() => true);
      expect((await fs.readdir(store.worldsDir)).includes('public-1.cvw.legacy')).toBe(true);
      await Promise.all([p.room.leave(), q.room.leave()]);
      await wait(100);
    } finally {
      await ts.close();
    }
  });
});
