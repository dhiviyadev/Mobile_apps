/** Build height 256 on the server: chunk views, edits and saves above the old limit of 64. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  type BlockEdit,
  CHUNK_HEIGHT,
  createWorldGenerator,
  decodeEdit,
  decodeEdits,
  encodeEdit,
  encodeMove,
  TERRAIN_VOLUME,
  VoxelMsg,
} from '@hub/shared';
import type { VoxelRoom } from '../src/rooms/VoxelRoom';
import { ServerVoxelWorld } from '../src/voxel/ServerVoxelWorld';
import { FileWorldStore } from '../src/voxel/WorldStore';
import { startTestServer, type TestServer, until, wait } from './helpers';

const SEED = 5150;
const gen = createWorldGenerator(SEED, 'sandbox');
const spawn = gen.findSpawn();
const X = Math.floor(spawn.x) + 2;
const Z = Math.floor(spawn.z);

/** The world's chunk views by slot (private state, read for memory checks). */
const views = (w: ServerVoxelWorld) => (w as unknown as { views: Map<number, { data: Uint8Array }> }).views;

describe('ServerVoxelWorld at the build height', () => {
  it('places and breaks at y 255, growing only the view built in', () => {
    const w = new ServerVoxelWorld(SEED, 'sandbox', 1000, 3);
    expect(w.getBlock(X, 255, Z)).toBe(Block.Air);
    expect(w.getBlock(X + 16, 30, Z)).not.toBe(undefined); // a second view
    const read = w.reader();
    expect(read(X, 255, Z)).toBe(Block.Air);
    expect(w.blockInWorld(X, 255, Z)).toBe(true);
    expect(w.blockInWorld(X, CHUNK_HEIGHT, Z)).toBe(false);
    expect(w.setBlock(X, 255, Z, Block.Brick)).toBe(true);
    expect(w.getBlock(X, 255, Z)).toBe(Block.Brick);
    // A reader made before the view grew sees the new block too.
    expect(read(X, 255, Z)).toBe(Block.Brick);
    const lengths = [...views(w).values()].map((v) => v.data.length).sort((a, b) => a - b);
    expect(lengths).toEqual([TERRAIN_VOLUME, 16 * 16 * CHUNK_HEIGHT]);
    expect(w.allEdits()).toEqual([{ x: X, y: 255, z: Z, id: Block.Brick }]);
    // Breaking it forgets the edit (the generated block there is air).
    w.setBlock(X, 255, Z, Block.Air);
    expect(w.getBlock(X, 255, Z)).toBe(Block.Air);
    expect(w.editCount).toBe(0);
  });

  it('restores saved edits at y 200+ into views as tall as the highest one', () => {
    const edits: BlockEdit[] = [
      { x: X, y: 230, z: Z, id: Block.Brick },
      { x: X, y: 64, z: Z, id: Block.Glass },
      { x: X + 1, y: 250, z: Z, id: Block.Air }, // an air edit high up: nothing to store
    ];
    const w = new ServerVoxelWorld(SEED, 'sandbox', 1000, 3);
    expect(w.loadEdits(edits)).toBe(3);
    expect(w.getBlock(X, 230, Z)).toBe(Block.Brick);
    expect(w.getBlock(X, 64, Z)).toBe(Block.Glass);
    expect(w.getBlock(X + 1, 250, Z)).toBe(Block.Air);
    expect([...views(w).values()][0].data.length).toBe(16 * 16 * 240);
    expect(decodeEdits(w.encodedEdits(), true)).toEqual(edits);
    // Setting the high air edit to air again restores generated terrain: the edit goes away.
    w.setBlock(X + 1, 250, Z, Block.Air);
    expect(w.editCount).toBe(2);
  });
});

describe('Voxelvale room at the build height', () => {
  let ts: TestServer;
  let dir: string;
  let store: FileWorldStore;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-height-'));
    store = new FileWorldStore(dir);
    ts = await startTestServer({ worldStore: store });
  });
  afterAll(async () => {
    await ts.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function collect(room: Room) {
    const world: Uint8Array[] = [];
    const edits: BlockEdit[] = [];
    const rejects: BlockEdit[] = [];
    room.onMessage(VoxelMsg.World, (b: Uint8Array) => world.push(b));
    room.onMessage(VoxelMsg.Edits, (b: Uint8Array) => edits.push(...decodeEdits(b)));
    room.onMessage(VoxelMsg.Reject, (b: Uint8Array) => rejects.push(decodeEdit(b)));
    room.onMessage(VoxelMsg.Chat, () => undefined);
    room.onMessage(VoxelMsg.Teleport, () => undefined);
    return { world, edits, rejects, snapshot: () => decodeEdits(world[world.length - 1], true) };
  }

  it('places and breaks at y 255 online, and keeps a tall build through a save and reopen', async () => {
    const room = await ts.client().create('voxel', { nickname: 'Climber', mode: 'sandbox', private: true, seed: SEED });
    const got = collect(room);
    await until(() => room.state.players?.get(room.sessionId) !== undefined && got.world.length > 0);
    const code = room.roomId;
    const live = matchMaker.getLocalRoomById(code) as unknown as VoxelRoom;
    // A pillar up to y 254 and a ledge at y 252 beside it (server edits, broadcast like player edits).
    const ground = gen.surfaceHeight(X, Z);
    for (let y = ground + 1; y <= 254; y++) live.applyServerEdit(X, y, Z, Block.Brick);
    live.applyServerEdit(X + 1, 252, Z, Block.Brick);
    // The climber stands on the ledge (moves up there pass the movement checks).
    const me = live.state.players.get(room.sessionId)!;
    me.x = X + 1.5;
    me.y = 253;
    me.z = Z + 0.5;
    room.sendBytes(VoxelMsg.Move, encodeMove({ x: X + 1.5, y: 253, z: Z + 0.5, yaw: 0, pitch: 0, flags: 0 }));
    await wait(100);
    expect(me.y).toBeCloseTo(253);

    room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: X, y: 255, z: Z, id: Block.Glass }));
    await until(() => got.edits.some((e) => e.y === 255 && e.id === Block.Glass));
    expect(live.world.getBlock(X, 255, Z)).toBe(Block.Glass);
    room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: X, y: 255, z: Z, id: Block.Air }));
    await until(() => got.edits.some((e) => e.y === 255 && e.id === Block.Air));
    expect(live.world.getBlock(X, 255, Z)).toBe(Block.Air);
    room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: X, y: 255, z: Z, id: Block.Lamp }));
    await until(() => got.edits.some((e) => e.y === 255 && e.id === Block.Lamp));
    expect(got.rejects).toEqual([]);

    // A late joiner gets the whole tower in the edit list.
    const late = await ts.client().joinById(code, { nickname: 'Late' });
    const lateGot = collect(late);
    await until(() => lateGot.world.length > 0);
    expect(lateGot.snapshot()).toContainEqual({ x: X, y: 255, z: Z, id: Block.Lamp });
    expect(lateGot.snapshot()).toContainEqual({ x: X, y: 200, z: Z, id: Block.Brick });

    // Everyone leaves: the world is saved; reopening it by code brings the tower back.
    await Promise.all([room.leave(), late.leave()]);
    await until(() => !matchMaker.getLocalRoomById(code), 5000);
    for (let i = 0; i < 100 && !(await store.exists(code)); i++) await wait(20);
    const saved = decodeEdits((await store.load(code))!.edits, true);
    expect(saved).toContainEqual({ x: X, y: 255, z: Z, id: Block.Lamp });
    expect(saved.filter((e) => e.y >= 200)).toHaveLength(55 + 2); // pillar 200..254, the ledge, the lamp
    await wait(200);
    const back = await ts.client().create('voxel', { nickname: 'Returner', reviveCode: code });
    const backGot = collect(back);
    await until(() => backGot.world.length > 0);
    const revived = matchMaker.getLocalRoomById(code) as unknown as VoxelRoom;
    expect(revived.world.getBlock(X, 255, Z)).toBe(Block.Lamp);
    expect(revived.world.getBlock(X, 230, Z)).toBe(Block.Brick);
    expect(revived.world.getBlock(X + 1, 252, Z)).toBe(Block.Brick);
    expect(backGot.snapshot()).toContainEqual({ x: X, y: 254, z: Z, id: Block.Brick });
    await back.leave();
  });

  it('lets moves up to the build height through and snaps back moves far above it', async () => {
    const room = await ts.client().create('voxel', { nickname: 'High', mode: 'sandbox', private: true, seed: SEED + 1 });
    const teleports: Uint8Array[] = [];
    room.onMessage(VoxelMsg.Teleport, (b: Uint8Array) => teleports.push(b));
    collect(room);
    await until(() => room.state.players?.get(room.sessionId) !== undefined);
    const live = matchMaker.getLocalRoomById(room.roomId) as unknown as VoxelRoom;
    const me = live.state.players.get(room.sessionId)!;
    me.y = 255;
    room.sendBytes(VoxelMsg.Move, encodeMove({ x: me.x, y: 256, z: me.z, yaw: 0, pitch: 0, flags: 0 }));
    await wait(150);
    expect(teleports).toHaveLength(0);
    expect(me.y).toBeCloseTo(256);
    room.sendBytes(VoxelMsg.Move, encodeMove({ x: me.x, y: CHUNK_HEIGHT + 100, z: me.z, yaw: 0, pitch: 0, flags: 0 }));
    await until(() => teleports.length > 0);
    await room.leave();
  });
});
