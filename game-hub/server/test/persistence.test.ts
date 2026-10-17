import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import {
  Block,
  type BlockEdit,
  type ChatMessage,
  decodeEdits,
  encodeEdit,
  encodeEdits,
  isValidRoomCode,
  TerrainGenerator,
  VoxelMsg,
} from '@hub/shared';
import { isWorldOpen, VoxelRoom } from '../src/rooms/VoxelRoom';
import { ServerVoxelWorld } from '../src/voxel/ServerVoxelWorld';
import {
  FileWorldStore,
  isValidWorldId,
  MemoryWorldStore,
  type SavedWorld,
  setWorldStore,
  type WorldStore,
  WorldStoreFullError,
  type WorldStoreLimits,
} from '../src/voxel/WorldStore';
import { startTestServer, type TestServer, until, wait } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

/** Every test store lives in the OS temp dir, never inside the repo. */
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-worlds-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function makeEdits(n: number): BlockEdit[] {
  const out: BlockEdit[] = [];
  for (let i = 0; i < n; i++) out.push({ x: (i % 200) - 100, y: 1 + (i % 60), z: Math.floor(i / 200) - 40, id: 1 + (i % 20) });
  return out;
}

function savedWorld(id: string, over: Partial<SavedWorld> = {}): SavedWorld {
  return { id, seed: 3_000_000_123, mode: 'sandbox', private: true, timeOfDay: 0.625, savedAt: Date.now(), edits: encodeEdits([], true), ...over };
}

/** Polls an async predicate until it holds. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await wait(20);
  }
}

describe('FileWorldStore', () => {
  it('round-trips a world with 12k edits atomically, one save at a time', async () => {
    const dir = await tempDir();
    const store = new FileWorldStore(dir);
    const edits = makeEdits(12_000);
    const world = savedWorld('K7PX2M', { edits: encodeEdits(edits, true) });
    await store.save(world);

    const back = await store.load('K7PX2M');
    expect(back).not.toBeNull();
    expect({ ...back!, edits: undefined }).toEqual({ ...world, edits: undefined });
    expect(decodeEdits(back!.edits, true)).toEqual(edits);
    expect(await store.exists('K7PX2M')).toBe(true);
    expect(await store.savedAt('K7PX2M')).toBe(world.savedAt);
    expect(await fs.readdir(store.worldsDir)).toEqual(['K7PX2M.cvw']);
    const size = (await fs.stat(path.join(store.worldsDir, 'K7PX2M.cvw'))).size;
    expect(size).toBe(27 + 12_000 * 6);

    // Concurrent saves of one id land in call order; no temp files are left behind.
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save(savedWorld('K7PX2M', { savedAt: n, edits: encodeEdits(makeEdits(n * 1000), true) }))));
    const last = await store.load('K7PX2M');
    expect(last!.savedAt).toBe(5);
    expect(decodeEdits(last!.edits, true)).toHaveLength(5000);
    expect(await fs.readdir(store.worldsDir)).toEqual(['K7PX2M.cvw']);

    expect(await store.delete('K7PX2M')).toBe(true);
    expect(await store.delete('K7PX2M')).toBe(false);
    expect(await store.exists('K7PX2M')).toBe(false);
    expect(await store.load('K7PX2M')).toBeNull();
  });

  it('moves corrupt or truncated files aside instead of loading them', async () => {
    const dir = await tempDir();
    const store = new FileWorldStore(dir);
    await fs.mkdir(store.worldsDir, { recursive: true });
    await fs.writeFile(path.join(store.worldsDir, 'ABCDEF.cvw'), 'definitely not a world');
    expect(await store.load('ABCDEF')).toBeNull();

    await store.save(savedWorld('ABCDEG', { edits: encodeEdits(makeEdits(50), true) }));
    const file = path.join(store.worldsDir, 'ABCDEG.cvw');
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes.subarray(0, bytes.length - 3));
    expect(await store.load('ABCDEG')).toBeNull();

    expect((await fs.readdir(store.worldsDir)).sort()).toEqual(['ABCDEF.cvw.corrupt', 'ABCDEG.cvw.corrupt']);
    expect(await store.exists('ABCDEG')).toBe(false);
    // The id is free for a new save afterwards.
    await store.save(savedWorld('ABCDEG'));
    expect((await store.load('ABCDEG'))?.seed).toBe(3_000_000_123);
  });

  it('validates ids before touching the filesystem', async () => {
    for (const id of ['K7PX2M', 'ABCDEF', '234567', 'public-1', 'public-8']) expect(isValidWorldId(id)).toBe(true);
    const bad = ['../x', '../../etc/passwd', 'abcdef', 'k7px2m', 'ABCDE', 'ABCDEFG', 'ABCDE0', 'ABCDEI', 'ABC/EF', 'public-0', 'public-9', 'public-10', 'PUBLIC-1', 'K7PX2M.cvw', ' K7PX2M', '', 42, null];
    for (const id of bad) expect(isValidWorldId(id)).toBe(false);

    const dir = await tempDir();
    const store = new FileWorldStore(path.join(dir, 'store'));
    for (const id of ['../x', 'abcdef', 'ABCDE', 'ABCDEFG']) {
      expect(await store.load(id)).toBeNull();
      expect(await store.exists(id)).toBe(false);
      expect(await store.savedAt(id)).toBeNull();
      expect(await store.delete(id)).toBe(false);
      await expect(store.save(savedWorld(id))).rejects.toThrow(/invalid world id/);
    }
    // Nothing was created, not even the store directory.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('prunes worlds by age, then the oldest beyond the count limit', async () => {
    const now = Date.now();
    const ages: Record<string, number> = { AAAAAA: 40, BBBBBB: 10, CCCCCC: 5, DDDDDD: 1, 'public-1': 0 };
    const stores: WorldStore[] = [new FileWorldStore(await tempDir()), new MemoryWorldStore()];
    for (const store of stores) {
      for (const [id, days] of Object.entries(ages)) await store.save(savedWorld(id, { savedAt: now - days * DAY }));
      expect(await store.prune(30 * DAY, 3)).toBe(2);
      for (const id of ['AAAAAA', 'BBBBBB']) expect(await store.exists(id)).toBe(false);
      for (const id of ['CCCCCC', 'DDDDDD', 'public-1']) expect(await store.exists(id)).toBe(true);
      expect(await store.prune(30 * DAY, 3)).toBe(0);
    }

    // Stale temp files from an interrupted write are cleaned up too.
    const file = stores[0] as FileWorldStore;
    const tmp = path.join(file.worldsDir, 'CCCCCC.cvw.tmp');
    await fs.writeFile(tmp, 'partial');
    const old = new Date(now - 2 * 60 * 60 * 1000);
    await fs.utimes(tmp, old, old);
    await file.prune(30 * DAY, 3);
    expect((await fs.readdir(file.worldsDir)).sort()).toEqual(['CCCCCC.cvw', 'DDDDDD.cvw', 'public-1.cvw']);
  });

  it('prune keeps worlds saved again during the scan and worlds held by open rooms', async () => {
    const old = Date.now() - 31 * DAY;
    const inUse = async (id: string) => id === 'BBBBBB';
    const file = new FileWorldStore(await tempDir());
    const memory = new MemoryWorldStore();
    for (const store of [file, memory]) {
      for (const id of ['AAAAAA', 'BBBBBB', 'CCCCCC']) await store.save(savedWorld(id, { savedAt: old }));
    }

    // A closing room saves AAAAAA right after prune read its old header, before the delete runs.
    const internals = FileWorldStore.prototype as unknown as { readSavedAt(file: string): Promise<number | null> };
    const readSavedAt = internals.readSavedAt;
    const spy = vi.spyOn(internals, 'readSavedAt').mockImplementation(async function (this: FileWorldStore, target: string) {
      const savedAt = await readSavedAt.call(this, target);
      if (target.endsWith('AAAAAA.cvw') && savedAt === old) await file.save(savedWorld('AAAAAA', { savedAt: Date.now() }));
      return savedAt;
    });
    try {
      expect(await file.prune(30 * DAY, 500, inUse)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await file.exists('AAAAAA')).toBe(true);
    expect(await file.exists('BBBBBB')).toBe(true);
    expect(await file.exists('CCCCCC')).toBe(false);

    expect(await memory.prune(30 * DAY, 500, inUse)).toBe(2);
    expect(await memory.exists('BBBBBB')).toBe(true);
    // Once the room is gone, the old world goes too.
    expect(await file.prune(30 * DAY, 500)).toBe(1);
    expect(await file.exists('BBBBBB')).toBe(false);
  });

  it('quarantines a save so its id starts afresh, and reports which stores are durable', async () => {
    const store = new FileWorldStore(await tempDir());
    expect(store.durable).toBe(true);
    await store.save(savedWorld('public-3', { private: false }));
    await store.quarantine('public-3');
    expect(await store.exists('public-3')).toBe(false);
    expect(await fs.readdir(store.worldsDir)).toEqual(['public-3.cvw.corrupt']);
    await store.quarantine('public-3'); // nothing left to move
    await store.quarantine('../x'); // invalid ids never reach the filesystem

    const memory = new MemoryWorldStore();
    expect(memory.durable).toBe(false);
    await memory.save(savedWorld('public-3'));
    await memory.quarantine('public-3');
    expect(await memory.exists('public-3')).toBe(false);
  });
});

describe('saved-world limits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Encoded size of a world with n edits. */
  const size = (n: number) => 27 + n * 6;
  const world = (id: string, savedAt: number, edits = 0) => savedWorld(id, { savedAt, edits: encodeEdits(makeEdits(edits), true) });

  /** A file store and a memory store with the same limits. */
  async function bothStores(limits: WorldStoreLimits): Promise<WorldStore[]> {
    return [new FileWorldStore(await tempDir(), limits), new MemoryWorldStore(limits)];
  }

  /** Which of the test ids the store holds. */
  async function held(store: WorldStore): Promise<string[]> {
    const ids = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE'];
    const present = await Promise.all(ids.map((id) => store.exists(id)));
    return ids.filter((_, i) => present[i]);
  }

  it('evicts the least recently saved world when a new one would go over the count', async () => {
    for (const store of await bothStores({ maxWorlds: 3 })) {
      await store.save(world('AAAAAA', 1000));
      await store.save(world('BBBBBB', 3000));
      await store.save(world('CCCCCC', 2000));
      // Saving a world that is already stored needs no room.
      await store.save(world('AAAAAA', 4000));
      expect(await held(store)).toEqual(['AAAAAA', 'BBBBBB', 'CCCCCC']);
      await store.save(world('DDDDDD', 5000));
      expect(await held(store)).toEqual(['AAAAAA', 'BBBBBB', 'DDDDDD']);
      await store.save(world('EEEEEE', 6000));
      expect(await held(store)).toEqual(['AAAAAA', 'DDDDDD', 'EEEEEE']);
      expect(await store.usage()).toEqual({ worlds: 3, bytes: 3 * size(0) });
    }
  });

  it('never evicts worlds open in a room, and refuses a save when nothing else can go', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const open = new Set<string>();
    const inUse = async (id: string) => open.has(id);
    for (const store of await bothStores({ maxWorlds: 2, inUse })) {
      open.clear();
      open.add('AAAAAA').add('BBBBBB');
      await store.save(world('AAAAAA', 1000));
      await store.save(world('BBBBBB', 2000));
      await expect(store.save(world('CCCCCC', 3000))).rejects.toThrow(WorldStoreFullError);
      expect(await held(store)).toEqual(['AAAAAA', 'BBBBBB']);
      if (store instanceof FileWorldStore) expect((await fs.readdir(store.worldsDir)).sort()).toEqual(['AAAAAA.cvw', 'BBBBBB.cvw']);
      // Open worlds are still saved again.
      await store.save(world('AAAAAA', 4000, 5));
      // Once its room closes, a world can go, even if it is the most recently saved.
      open.delete('AAAAAA');
      await store.save(world('CCCCCC', 5000));
      expect(await held(store)).toEqual(['BBBBBB', 'CCCCCC']);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not saving world CCCCCC: the store is full/));
  });

  it('keeps the total size within the byte budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const store of await bothStores({ maxBytes: 3 * size(100) })) {
      await store.save(world('AAAAAA', 1000, 100));
      await store.save(world('BBBBBB', 2000, 100));
      await store.save(world('CCCCCC', 3000, 100));
      expect(await store.usage()).toEqual({ worlds: 3, bytes: 3 * size(100) });
      // A bigger world pushes out as many of the oldest as it needs.
      await store.save(world('DDDDDD', 4000, 150));
      expect(await held(store)).toEqual(['CCCCCC', 'DDDDDD']);
      expect(await store.usage()).toEqual({ worlds: 2, bytes: size(100) + size(150) });
      // So does a stored world that grows.
      await store.save(world('CCCCCC', 5000, 250));
      expect(await held(store)).toEqual(['CCCCCC']);
      // A world bigger than the whole budget is refused; shrinking is always allowed.
      await expect(store.save(world('EEEEEE', 6000, 400))).rejects.toThrow(WorldStoreFullError);
      await store.save(world('CCCCCC', 7000, 10));
      expect(await held(store)).toEqual(['CCCCCC']);
      expect(await store.usage()).toEqual({ worlds: 1, bytes: size(10) });
    }
  });

  it('counts the world files already on disk, and keeps the count as worlds go', async () => {
    const dir = await tempDir();
    const before = new FileWorldStore(dir);
    await before.save(world('AAAAAA', 1000, 50));
    await before.save(world('BBBBBB', 2000, 50));
    // Leftovers that are not saved worlds do not count.
    await fs.writeFile(path.join(before.worldsDir, 'CCCCCC.cvw.corrupt'), 'junk');
    await fs.writeFile(path.join(before.worldsDir, 'DDDDDD.cvw.tmp'), 'partial');

    const store = new FileWorldStore(dir, { maxWorlds: 2 });
    expect(await store.usage()).toEqual({ worlds: 2, bytes: 2 * size(50) });
    await store.save(world('CCCCCC', 3000));
    expect(await held(store)).toEqual(['BBBBBB', 'CCCCCC']);
    expect(await store.delete('BBBBBB')).toBe(true);
    await store.quarantine('CCCCCC');
    expect(await store.usage()).toEqual({ worlds: 0, bytes: 0 });
    expect(await store.prune(DAY, 2)).toBe(0);
    await store.save(world('DDDDDD', Date.now() - 2 * DAY));
    await store.save(world('EEEEEE', Date.now()));
    expect(await store.prune(DAY, 2)).toBe(1);
    expect(await store.usage()).toEqual({ worlds: 1, bytes: size(0) });
  });
});

describe('ServerVoxelWorld persistence hooks', () => {
  it('tracks unsaved edits and restores saved ones without marking them dirty', () => {
    const world = new ServerVoxelWorld(99, 'sandbox', 3);
    const generated = world.getBlock(0, 10, 0);
    const other = generated === Block.Stone ? Block.Dirt : Block.Stone;
    expect(world.dirty).toBe(false);
    expect(world.setBlock(0, 10, 0, other)).toBe(true);
    expect(world.dirty).toBe(true);
    world.markClean();
    world.setBlock(0, 10, 0, other); // no change
    expect(world.dirty).toBe(false);
    world.setBlock(0, 10, 0, generated); // back to terrain: the edit is forgotten
    expect(world.dirty).toBe(true);
    expect(world.editCount).toBe(0);

    const restored = new ServerVoxelWorld(99, 'sandbox', 3);
    const edits = [
      { x: 1, y: 5, z: 1, id: Block.Stone },
      { x: 9999, y: 5, z: 1, id: Block.Stone }, // outside the world: skipped
      { x: 2, y: 5, z: 1, id: Block.Air },
      { x: 3, y: 5, z: 1, id: Block.Brick },
      { x: 4, y: 5, z: 1, id: Block.Brick }, // beyond the edit budget of 3
    ];
    expect(restored.loadEdits(edits)).toBe(3);
    expect(restored.editCount).toBe(3);
    expect(restored.dirty).toBe(false);
    expect(restored.getBlock(3, 5, 1)).toBe(Block.Brick);
    expect(restored.allEdits()).toEqual([edits[0], edits[2], edits[3]]);
  });

  it('encodes its edit list like encodeEdits() and reuses it until the next change', () => {
    const world = new ServerVoxelWorld(99, 'sandbox');
    expect(world.encodedEdits()).toEqual(encodeEdits([], true));
    world.loadEdits(makeEdits(3000));
    const first = world.encodedEdits();
    expect(first).toEqual(encodeEdits(world.allEdits(), true));
    expect(decodeEdits(first, true)).toHaveLength(3000);
    world.markClean();
    expect(world.encodedEdits()).toBe(first);

    const other = world.getBlock(0, 10, 0) === Block.Stone ? Block.Dirt : Block.Stone;
    world.setBlock(0, 10, 0, other);
    const second = world.encodedEdits();
    expect(second).not.toBe(first);
    expect(second).toEqual(encodeEdits(world.allEdits(), true));
    world.setBlock(0, 10, 0, other); // no change
    expect(world.encodedEdits()).toBe(second);
  });
});

// ---- rooms ------------------------------------------------------------------------------

const SEED = 4242;
const gen = new TerrainGenerator(SEED);
const spawn = gen.findSpawn();
/** The surface block next to spawn (breakable, within reach), as in voxel.test.ts. */
const surface = { x: Math.floor(spawn.x) + 1, y: gen.column(Math.floor(spawn.x) + 1, Math.floor(spawn.z)).height, z: Math.floor(spawn.z) };
const PUBLIC_SLOT_SET = 'voxel:public-worlds';

async function track(room: Room) {
  const world: Uint8Array[] = [];
  const edits: Uint8Array[] = [];
  const chat: ChatMessage[] = [];
  room.onMessage(VoxelMsg.World, (b: Uint8Array) => world.push(b));
  room.onMessage(VoxelMsg.Edits, (b: Uint8Array) => edits.push(b));
  room.onMessage(VoxelMsg.Reject, () => undefined);
  room.onMessage(VoxelMsg.Chat, (m: ChatMessage) => chat.push(m));
  await until(() => room.state.players?.get(room.sessionId) !== undefined && world.length > 0);
  const snapshot = () => decodeEdits(world[world.length - 1], true);
  const edit = async (e: BlockEdit) => {
    room.sendBytes(VoxelMsg.Edit, encodeEdit(e));
    await until(() => edits.some((b) => decodeEdits(b).some((x) => x.x === e.x && x.y === e.y && x.z === e.z && x.id === e.id)));
  };
  return { room, chat, snapshot, edit };
}

/** True while an open room still holds member in a presence set. */
const held = async (set: string, member: string) => !!(await matchMaker.presence.sismember(set, member));

describe('persistent Voxelvale rooms', () => {
  let ts: TestServer;
  let dir: string;
  let store: FileWorldStore;

  beforeAll(async () => {
    dir = await tempDir();
    store = new FileWorldStore(dir);
    ts = await startTestServer({ worldStore: store });
  });
  afterAll(async () => {
    await ts.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Waits until a closed room has saved its world and given its code back. */
  async function closedAndSaved(id: string, set = 'hub:room-codes', member = id): Promise<void> {
    await eventually(async () => (await store.exists(id)) && !(await held(set, member)));
  }

  it('saves a private world when everyone leaves and reopens it by code', async () => {
    const a = await track(await ts.client().create('voxel', { nickname: 'Builder', mode: 'sandbox', private: true, seed: SEED }));
    const code = a.room.roomId;
    expect(a.room.state.worldKind).toBe('saved');
    expect(a.room.state.saveDays).toBe(30);
    expect(a.room.state.privateRoom).toBe(true);
    const broken = { ...surface, id: Block.Air };
    await a.edit(broken);
    await a.room.leave();
    await closedAndSaved(code);

    const saved = await store.load(code);
    expect(saved).toMatchObject({ id: code, seed: SEED, mode: 'sandbox', private: true });
    expect(decodeEdits(saved!.edits, true)).toEqual([broken]);

    // Codes are case-insensitive when reviving. The restore hook sees the saved edits.
    let seen: readonly BlockEdit[] = [];
    vi.spyOn(VoxelRoom.prototype as unknown as { onWorldRestored(): void }, 'onWorldRestored').mockImplementationOnce(function (this: { restoredEdits: readonly BlockEdit[] }) {
      seen = this.restoredEdits;
    });
    const b = await track(await ts.client().create('voxel', { nickname: 'Returner', reviveCode: code.toLowerCase() }));
    expect(b.room.roomId).toBe(code);
    expect(seen).toEqual([broken]);
    // ...and later systems can still read them (decoded from the compact save bytes).
    expect((matchMaker.getLocalRoomById(code) as unknown as { restoredEdits: readonly BlockEdit[] }).restoredEdits).toEqual([broken]);
    expect(b.room.state.seed).toBe(SEED);
    expect(b.room.state.mode).toBe('sandbox');
    expect(b.room.state.privateRoom).toBe(true);
    expect(b.room.state.worldKind).toBe('saved');
    expect(b.snapshot()).toEqual([broken]);
    await until(() => b.chat.some((m) => m.system && /restored/.test(m.text)));

    // While it is open, reviving again is refused and joining by code works (with the restored edit).
    await expect(ts.client().create('voxel', { nickname: 'Twin', reviveCode: code })).rejects.toThrow(/ROOM_ALREADY_OPEN/);
    const c = await track(await ts.client().joinById(code, { nickname: 'Friend' }));
    expect(c.snapshot()).toEqual([broken]);
    await Promise.all([b.room.leave(), c.room.leave()]);
    await closedAndSaved(code);
  });

  it('refuses to revive codes without a saved world', async () => {
    await expect(ts.client().create('voxel', { nickname: 'Lost', reviveCode: 'ZZZZZZ' })).rejects.toThrow(/NO_SAVED_WORLD/);
    await expect(ts.client().create('voxel', { nickname: 'Sneaky', reviveCode: '../../etc' })).rejects.toThrow(/NO_SAVED_WORLD/);
    // A failed revive must not leave the code claimed.
    expect(await held('hub:room-codes', 'ZZZZZZ')).toBe(false);
  });

  it('never hands out a saved world code to a new room', async () => {
    await store.save(savedWorld('AAAAAA', { seed: 77 }));
    const exists = vi.spyOn(store, 'exists');
    for (const game of ['arena', 'voxel']) {
      // generateRoomCode() draws from Math.random: make the first six draws spell AAAAAA.
      const random = vi.spyOn(Math, 'random');
      for (let i = 0; i < 6; i++) random.mockReturnValueOnce(0);
      const room = await ts.client().create(game, { nickname: 'Fresh', mode: game === 'arena' ? '1v1' : 'sandbox', private: true });
      random.mockRestore();
      expect(room.roomId).not.toBe('AAAAAA');
      expect(isValidRoomCode(room.roomId)).toBe(true);
      await room.leave();
    }
    expect(exists).toHaveBeenCalledWith('AAAAAA');
    expect((await store.load('AAAAAA'))?.seed).toBe(77);
  });

  it('public rooms save into a public slot that the next public room restores', async () => {
    const a = await track(await ts.client().create('voxel', { nickname: 'Settler', mode: 'sandbox', seed: SEED }));
    expect(isValidRoomCode(a.room.roomId)).toBe(true);
    expect(a.room.state.worldKind).toBe('saved');
    expect(a.room.state.privateRoom).toBe(false);
    expect(await held(PUBLIC_SLOT_SET, 'public-1')).toBe(true);
    const pillar = { ...surface, y: surface.y + 2, id: Block.Stone };
    await a.edit(pillar);
    await a.room.leave();
    await closedAndSaved('public-1', PUBLIC_SLOT_SET);

    const b = await track(await ts.client().joinOrCreate('voxel', { nickname: 'Visitor', mode: 'sandbox' }));
    expect(b.room.roomId).not.toBe(a.room.roomId);
    expect(b.room.state.seed).toBe(SEED);
    expect(b.snapshot()).toEqual([pillar]);
    expect(await held(PUBLIC_SLOT_SET, 'public-1')).toBe(true);
    await b.room.leave();
    await closedAndSaved('public-1', PUBLIC_SLOT_SET);
  });

  it('gives concurrent public rooms distinct slots and makes the ninth temporary', async () => {
    const rooms = await Promise.all(Array.from({ length: 9 }, (_, i) => ts.client().create('voxel', { nickname: `Crowd${i}`, mode: 'sandbox' })));
    await until(() => rooms.every((r) => r.state.players?.size === 1));
    const kinds = rooms.map((r) => r.state.worldKind as string).sort();
    expect(kinds).toEqual([...Array(8).fill('saved'), 'temporary']);
    expect(rooms.find((r) => r.state.worldKind === 'temporary')!.state.saveDays).toBe(0);
    const slots = await matchMaker.presence.smembers(PUBLIC_SLOT_SET);
    expect(new Set(slots).size).toBe(8);
    await Promise.all(rooms.map((r) => r.leave()));
    await eventually(async () => (await matchMaker.presence.smembers(PUBLIC_SLOT_SET)).length === 0);
  });

  it('never saves parkour rooms', async () => {
    const room = await ts.client().create('voxel', { nickname: 'Runner', mode: 'parkour', private: true });
    await until(() => room.state.players?.size === 1);
    expect(room.state.worldKind).toBe('temporary');
    expect(room.state.saveDays).toBe(0);
    const code = room.roomId;
    await room.leave();
    await eventually(async () => !(await held('hub:room-codes', code)));
    expect(await store.exists(code)).toBe(false);
    await expect(ts.client().create('voxel', { nickname: 'Runner', reviveCode: code })).rejects.toThrow(/NO_SAVED_WORLD/);
  });

  it('writes no file for worlds nobody built in, but re-saves restored ones', async () => {
    // Joined and left without building.
    const room = await ts.client().create('voxel', { nickname: 'Looker', mode: 'sandbox', private: true });
    await until(() => room.state.players?.size === 1);
    const code = room.roomId;
    await room.leave();
    await eventually(async () => !(await held('hub:room-codes', code)));
    expect(await store.exists(code)).toBe(false);

    // Created but never joined (disposed when its seat reservation runs out).
    const reserved = await matchMaker.createRoom('voxel', { nickname: 'Nobody', mode: 'sandbox', private: true });
    await matchMaker.getLocalRoomById(reserved.roomId).disconnect();
    await eventually(async () => !(await held('hub:room-codes', reserved.roomId)));
    expect(await store.exists(reserved.roomId)).toBe(false);

    // A restored world is written again on close even without new edits, so its age starts over.
    const old = Date.now() - 5 * DAY;
    await store.save(savedWorld('EEEEEE', { savedAt: old }));
    const back = await track(await ts.client().create('voxel', { nickname: 'Returner', reviveCode: 'EEEEEE' }));
    await back.room.leave();
    await eventually(async () => !(await held('hub:room-codes', 'EEEEEE')));
    expect(await store.savedAt('EEEEEE')).toBeGreaterThan(old);
  });

  it('autosaves changed worlds while players are still in the room', async () => {
    VoxelRoom.autosaveMs = 100;
    try {
      const a = await track(await ts.client().create('voxel', { nickname: 'Builder', mode: 'sandbox', private: true, seed: SEED }));
      const code = a.room.roomId;
      const live = matchMaker.getLocalRoomById(code) as unknown as VoxelRoom;
      expect(await isWorldOpen(code)).toBe(true);
      const saves = vi.spyOn(store, 'save');

      const broken = { ...surface, id: Block.Air };
      await a.edit(broken);
      await eventually(() => store.exists(code));
      expect(decodeEdits((await store.load(code))!.edits, true)).toEqual([broken]);
      expect(live.world.dirty).toBe(false);

      // Nothing changed since: no more saves.
      const count = saves.mock.calls.length;
      await wait(400);
      expect(saves.mock.calls.length).toBe(count);

      const pillar = { ...surface, y: surface.y + 2, id: Block.Stone };
      await a.edit(pillar);
      await eventually(async () => decodeEdits((await store.load(code))!.edits, true).length === 2);
      expect(saves.mock.calls.length).toBe(count + 1);

      await a.room.leave();
      await closedAndSaved(code);
      expect(await isWorldOpen(code)).toBe(false);
    } finally {
      VoxelRoom.autosaveMs = 30_000;
    }
  });

  it('finishes the final save before giving the code or slot back', async () => {
    const events: string[] = [];
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async (world) => {
      await wait(150);
      await save(world);
      events.push(`saved ${world.id}`);
    });
    const srem = matchMaker.presence.srem.bind(matchMaker.presence);
    vi.spyOn(matchMaker.presence, 'srem').mockImplementation((set: string, member: string) => {
      events.push(`released ${member}`);
      return srem(set, member);
    });

    const priv = await track(await ts.client().create('voxel', { nickname: 'Closer', mode: 'sandbox', private: true, seed: SEED }));
    const pub = await track(await ts.client().create('voxel', { nickname: 'Closer2', mode: 'sandbox', seed: SEED }));
    const code = priv.room.roomId;
    const [slot] = await matchMaker.presence.smembers(PUBLIC_SLOT_SET);
    await priv.edit({ ...surface, id: Block.Air });
    await pub.edit({ ...surface, id: Block.Air });
    await Promise.all([priv.room.leave(), pub.room.leave()]);
    await eventually(async () => !(await held('hub:room-codes', code)) && !(await held(PUBLIC_SLOT_SET, slot)));
    expect(events.filter((e) => e.endsWith(` ${code}`))).toEqual([`saved ${code}`, `released ${code}`]);
    expect(events.filter((e) => e.endsWith(` ${slot}`))).toEqual([`saved ${slot}`, `released ${slot}`]);
  });

  it('moves a public save that fails to restore aside and starts afresh in its slot', async () => {
    // The newest public save, so the next public room picks it.
    await store.save(savedWorld('public-5', { private: false, seed: 99, savedAt: Date.now() + 60_000, edits: encodeEdits(makeEdits(10), true) }));
    const hook = vi.spyOn(VoxelRoom.prototype as unknown as { onWorldRestored(): void }, 'onWorldRestored').mockImplementationOnce(() => {
      throw new Error('restore hook failed');
    });
    const a = await track(await ts.client().create('voxel', { nickname: 'Unlucky', mode: 'sandbox', seed: SEED }));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(a.room.state.worldKind).toBe('saved');
    expect(a.room.state.seed).toBe(SEED);
    expect(a.snapshot()).toEqual([]);
    expect(await isWorldOpen('public-5')).toBe(true);
    expect(await store.exists('public-5')).toBe(false);
    expect(await fs.readdir(store.worldsDir)).toContain('public-5.cvw.corrupt');

    const pillar = { ...surface, y: surface.y + 2, id: Block.Stone };
    await a.edit(pillar);
    await a.room.leave();
    await closedAndSaved('public-5', PUBLIC_SLOT_SET);

    // The slot now holds the fresh world, and the next public room restores it as usual.
    const b = await track(await ts.client().create('voxel', { nickname: 'Next', mode: 'sandbox' }));
    expect(await held(PUBLIC_SLOT_SET, 'public-5')).toBe(true);
    expect(b.room.state.seed).toBe(SEED);
    expect(b.snapshot()).toEqual([pillar]);
    await b.room.leave();
    await closedAndSaved('public-5', PUBLIC_SLOT_SET);
  });

  it('tells players that worlds in a memory store last only until a restart', async () => {
    setWorldStore(new MemoryWorldStore());
    try {
      const room = await ts.client().create('voxel', { nickname: 'Brief', mode: 'sandbox', private: true });
      await until(() => room.state.players?.size === 1);
      expect(room.state.worldKind).toBe('saved');
      expect(room.state.saveDays).toBe(0);
      await room.leave();
      await eventually(async () => !(await held('hub:room-codes', room.roomId)));
    } finally {
      setWorldStore(store);
    }
  });

  it('saves open worlds on graceful shutdown so they survive a restart', async () => {
    const a = await track(await ts.client().create('voxel', { nickname: 'Stayer', mode: 'sandbox', private: true, seed: SEED }));
    const code = a.room.roomId;
    const pillar = { ...surface, y: surface.y + 2, id: Block.Stone };
    await a.edit(pillar);
    await ts.close(); // the player is still connected

    // A new store instance reads the file exactly like a restarted server would.
    const restarted = new FileWorldStore(dir);
    const saved = await restarted.load(code);
    expect(saved).not.toBeNull();
    expect(decodeEdits(saved!.edits, true)).toEqual([pillar]);

    ts = await startTestServer({ worldStore: restarted });
    const b = await track(await ts.client().create('voxel', { nickname: 'Stayer', reviveCode: code }));
    expect(b.room.roomId).toBe(code);
    expect(b.room.state.seed).toBe(SEED);
    expect(b.snapshot()).toEqual([pillar]);

    // Shutting down right after the last player left still waits for that room's save.
    const broken = { ...surface, id: Block.Air };
    await b.edit(broken);
    await b.room.leave();
    await ts.close();
    const final = await new FileWorldStore(dir).load(code);
    expect(decodeEdits(final!.edits, true)).toEqual(expect.arrayContaining([pillar, broken]));
  });
});

describe('graceful shutdown with a pending seat reservation', () => {
  it('saves the world as soon as shutdown starts, not when the reservation runs out', async () => {
    const store = new MemoryWorldStore();
    const server = await startTestServer({ worldStore: store });
    const a = await track(await server.client().create('voxel', { nickname: 'Holder', mode: 'sandbox', private: true, seed: SEED }));
    const code = a.room.roomId;
    // A seat reserved for someone who never connects keeps the room from disposing until it expires.
    matchMaker.getLocalRoomById(code).seatReservationTimeout = 4;
    const res = await fetch(`http://127.0.0.1:${server.port}/matchmake/joinById/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Ghost' }),
    });
    expect(((await res.json()) as { sessionId?: string }).sessionId).toBeTruthy();
    const pillar = { ...surface, y: surface.y + 2, id: Block.Stone };
    await a.edit(pillar);

    const started = Date.now();
    const closing = server.close();
    await eventually(async () => {
      const saved = await store.load(code);
      return !!saved && decodeEdits(saved.edits, true).length === 1;
    }, 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    await closing; // finishes once the reservation has run out and the room disposed
    expect(decodeEdits((await store.load(code))!.edits, true)).toEqual([pillar]);
  });
});
