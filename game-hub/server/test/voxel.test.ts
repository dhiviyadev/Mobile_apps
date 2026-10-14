import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room } from 'colyseus.js';
import {
  Block,
  type ChatMessage,
  decodeEdit,
  decodeEdits,
  decodeTeleport,
  encodeEdit,
  encodeMove,
  TerrainGenerator,
  VoxelMsg,
} from '@hub/shared';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

/** Collects binary messages of a type. */
function collect(room: Room, type: string) {
  const got: Uint8Array[] = [];
  room.onMessage(type, (b: Uint8Array) => got.push(b));
  return got;
}

async function joinSandbox(seed: number, nickname: string, roomId?: string) {
  const c = ts.client();
  const room = roomId
    ? await c.joinById(roomId, { nickname })
    : await c.create('voxel', { nickname, mode: 'sandbox', private: true, seed });
  const world = collect(room, VoxelMsg.World);
  const edits = collect(room, VoxelMsg.Edits);
  const rejects = collect(room, VoxelMsg.Reject);
  const teleports = collect(room, VoxelMsg.Teleport);
  const chat: ChatMessage[] = [];
  room.onMessage(VoxelMsg.Chat, (m: ChatMessage) => chat.push(m));
  await until(() => room.state.players?.get(room.sessionId) !== undefined);
  return { room, world, edits, rejects, teleports, chat };
}

const SEED = 4242;
const gen = new TerrainGenerator(SEED);
const spawn = gen.findSpawn();

/** A block next to spawn: the surface block, which is breakable. */
const surface = { x: Math.floor(spawn.x) + 1, y: gen.column(Math.floor(spawn.x) + 1, Math.floor(spawn.z)).height, z: Math.floor(spawn.z) };

describe('Voxelvale room', () => {
  it('uses the requested seed in tests and spawns players at the seed spawn', async () => {
    const a = await joinSandbox(SEED, 'Ann');
    expect(a.room.state.seed).toBe(SEED);
    const me = a.room.state.players.get(a.room.sessionId);
    expect(me.x).toBeCloseTo(spawn.x);
    expect(me.y).toBeCloseTo(spawn.y);
    await a.room.leave();
  });

  it('applies valid edits, broadcasts them, and sends the edit list to late joiners', async () => {
    const a = await joinSandbox(SEED, 'Builder');
    const b = await joinSandbox(SEED, 'Watcher', a.room.roomId);
    await until(() => a.world.length > 0 && b.world.length > 0);
    expect(decodeEdits(a.world[0], true)).toEqual([]);

    // Break the surface block, then place stone above where it was.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ ...surface, id: Block.Air }));
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ ...surface, y: surface.y + 2, id: Block.Stone }));
    await until(() => b.edits.flatMap((e) => decodeEdits(e)).length >= 2);
    const seen = b.edits.flatMap((e) => decodeEdits(e));
    expect(seen).toContainEqual({ ...surface, id: Block.Air });
    expect(seen).toContainEqual({ ...surface, y: surface.y + 2, id: Block.Stone });
    expect(a.rejects).toHaveLength(0);

    const c = await joinSandbox(SEED, 'Late', a.room.roomId);
    await until(() => c.world.length > 0);
    const snapshot = decodeEdits(c.world[0], true);
    expect(snapshot).toHaveLength(2);
    expect(snapshot).toContainEqual({ ...surface, id: Block.Air });
    await Promise.all([a.room.leave(), b.room.leave(), c.room.leave()]);
  });

  it('rejects invalid edits with the authoritative block', async () => {
    const a = await joinSandbox(SEED, 'Cheater');
    // Bedrock is unbreakable.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: surface.x, y: 0, z: surface.z, id: Block.Air }));
    // Out of reach.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: surface.x + 40, y: surface.y, z: surface.z, id: Block.Air }));
    // Not a placeable block.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ ...surface, y: surface.y + 3, id: Block.Bedrock }));
    // Placing into an existing block.
    a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ ...surface, id: Block.Stone }));
    await until(() => a.rejects.length === 4);
    const r = a.rejects.map(decodeEdit);
    expect(r[0].id).toBe(Block.Bedrock);
    expect(r[3].id).not.toBe(Block.Air); // the solid surface block that is really there
    await wait(100);
    expect(a.edits).toHaveLength(0);
    await a.room.leave();
  });

  it('rate limits edit spam', async () => {
    const a = await joinSandbox(SEED, 'Spammer');
    for (let i = 0; i < 60; i++) a.room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: surface.x, y: surface.y + 2 + (i % 3), z: surface.z + (i % 2), id: i % 2 ? Block.Stone : Block.Air }));
    await wait(300);
    expect(a.rejects.length).toBeGreaterThan(20);
    await a.room.leave();
  });

  it('snaps back impossible movement', async () => {
    const a = await joinSandbox(SEED, 'Speedy');
    await wait(3100); // past the spawn grace period
    a.room.sendBytes(VoxelMsg.Move, encodeMove({ x: spawn.x + 1, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0, flags: 0 }));
    await wait(100);
    a.room.sendBytes(VoxelMsg.Move, encodeMove({ x: spawn.x + 80, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0, flags: 0 }));
    await until(() => a.teleports.length > 0);
    const tp = decodeTeleport(a.teleports[0]);
    expect(tp.x).toBeCloseTo(spawn.x + 1, 1);
    expect(a.room.state.players.get(a.room.sessionId).x).toBeCloseTo(spawn.x + 1, 1);
    await a.room.leave();
  });

  it('relays chat, sanitises it and rate limits spam', async () => {
    const a = await joinSandbox(SEED, 'Talker');
    const b = await joinSandbox(SEED, 'Listener', a.room.roomId);
    a.room.send(VoxelMsg.Chat, { text: '  hello\nworld \u0000 ' });
    await until(() => b.chat.some((m) => !m.system));
    const msg = b.chat.find((m) => !m.system)!;
    expect(msg.text).toBe('hello world');
    expect(msg.name).toBe('Talker');
    for (let i = 0; i < 10; i++) a.room.send(VoxelMsg.Chat, { text: `spam ${i}` });
    await wait(300);
    const delivered = b.chat.filter((m) => m.text.startsWith('spam'));
    expect(delivered.length).toBeLessThanOrEqual(4);
    expect(a.chat.some((m) => m.system && /too fast/.test(m.text))).toBe(true);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });
});

describe('Voxelvale parkour room', () => {
  it('disables editing and validates finishes on the server clock', async () => {
    const room = await ts.client().create('voxel', { nickname: 'Runner', mode: 'parkour', private: true });
    const rejects = collect(room, VoxelMsg.Reject);
    await until(() => room.state.players?.size === 1);
    room.sendBytes(VoxelMsg.Edit, encodeEdit({ x: 0, y: 38, z: 0, id: Block.Air }));
    await until(() => rejects.length === 1);

    // A "finish" without having run the course is ignored.
    room.send(VoxelMsg.Parkour, { kind: 'start' });
    room.send(VoxelMsg.Parkour, { kind: 'finish' });
    await wait(150);
    expect(room.state.players.get(room.sessionId).bestMs).toBe(0);
    await room.leave();
  });
});
