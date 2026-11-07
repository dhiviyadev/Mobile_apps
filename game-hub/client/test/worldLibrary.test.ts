import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodePlayers,
  decodeWorld,
  encodePlayers,
  encodeWorld,
  Item,
  packPos,
  SECTION_TAGS,
  type SavedWorld,
} from '@hub/shared';
import { captureWorld, openWorld, type CapturedWorld } from '../src/games/voxel/library/codec';
import { playerRecordKey, sha256 } from '../src/games/voxel/library/keyHash';
import { LocalWorldStorage, MemoryWorldStorage } from '../src/games/voxel/library/storage';
import { ImportError, LEGACY_KEYS, seedFromText, WorldLibrary } from '../src/games/voxel/library/WorldLibrary';

const KEY = 'devicekeydevicekey0001';
const OTHER = 'otherdeviceotherdevice';

/** A localStorage stand-in. */
class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

const survivalSave = {
  seed: 4242,
  gen: 2,
  edits: [[packPos(3, 40, -7), 5], [packPos(-100, 12, 300), 0]],
  player: { x: 10.5, y: 41, z: -3.25, yaw: 1.5, pitch: -0.2 },
  time: 0.62,
  mobs: { v: 1, list: [{ k: 1, var: 0, f: 2, x: 4, y: 40, z: 4, yaw: 0, hp: 8, grow: 0, owner: 'E2E', name: 'Fluffy' }] },
  survival: {
    v: 1, day: 7, rules: { keepInventory: true }, vitals: { hp: 13, food: 9, air: 10, dead: false }, spawn: [1, 40, 2],
    inv: [[Item.Stick, 12, 0], 0, [Item.Bread, 3, 0]],
    chests: [[packPos(5, 40, 5), 0, [[0, Item.Stick, 4, 0]]]],
    satchels: [[8, 41, 8, [[Item.Bread, 1, 0]]]],
  },
};

describe('player record keys', () => {
  it('match the server (SHA-256 of the key, first 16 bytes as hex)', () => {
    for (const k of [KEY, OTHER, 'a'.repeat(32), 'Zz_-09'.repeat(4)]) {
      expect(playerRecordKey(k)).toBe(createHash('sha256').update(k).digest('hex').slice(0, 32));
    }
    const long = new Uint8Array(1000).map((_, i) => i * 7);
    expect(Buffer.from(sha256(long)).toString('hex')).toBe(createHash('sha256').update(long).digest('hex'));
  });
});

describe('world library', () => {
  it('creates, renames, duplicates, deletes, sorted by last played', async () => {
    const lib = new WorldLibrary(new MemoryWorldStorage(), KEY);
    expect(await lib.defaultName()).toBe('New World');
    const a = await lib.create({ name: 'New World', mode: 'sandbox', seedText: 'hello' });
    expect(await lib.defaultName()).toBe('New World 2');
    const b = await lib.create({ name: 'Keep', mode: 'survival', seedText: '', keepInventory: true });
    expect(a.seed).toBe(seedFromText('hello'));
    expect(seedFromText('12345')).toBe(12345);
    expect(b).toMatchObject({ name: 'Keep', mode: 'survival', day: 1 });
    expect((await lib.list())[0].id).toBe(b.id);

    await lib.rename(a.id, '  Castle\u0000  ');
    const copy = await lib.duplicate(a.id);
    expect(copy?.name).toBe('Castle copy');
    expect((await lib.list()).map((e) => e.name).sort()).toEqual(['Castle', 'Castle copy', 'Keep']);
    await lib.remove(a.id);
    expect((await lib.list()).map((e) => e.name).sort()).toEqual(['Castle copy', 'Keep']);
    const loaded = await lib.load(b.id);
    expect(loaded?.world.seed).toBe(b.seed);
  });

  it('exports and imports, validating files and renaming on collision', async () => {
    const lib = new WorldLibrary(new LocalWorldStorage(new FakeStorage()), KEY);
    const a = await lib.create({ name: 'Island', mode: 'survival', seedText: 'x' });
    const file = (await lib.exportFile(a.id))!;
    expect(file.fileName).toBe('Island.voxelvale');
    const imported = await lib.importFile(file.bytes, file.fileName);
    expect(imported.name).toBe('Island (2)');
    expect(imported.id).not.toBe(a.id);
    expect(imported.seed).toBe(a.seed);
    await expect(lib.importFile(new Uint8Array([1, 2, 3]), 'junk.voxelvale')).rejects.toBeInstanceOf(ImportError);
    const parkour = encodeWorld({ id: 'x', seed: 1, mode: 'parkour', private: false, timeOfDay: 0, savedAt: 1, edits: new Uint8Array(4) });
    await expect(lib.importFile(parkour)).rejects.toThrow(/Sandbox and Survival/);
    // A bare server save (no META) takes the file's name.
    const bare = encodeWorld({ id: 'x', seed: 9, mode: 'sandbox', private: false, timeOfDay: 0, savedAt: 1, edits: new Uint8Array(4) });
    expect((await lib.importFile(bare, 'Friends base.voxelvale')).name).toBe('Friends base');
  });

  it('migrates the old offline saves, keeping everything, then removes them', async () => {
    const ls = new FakeStorage();
    ls.setItem(LEGACY_KEYS.survival, JSON.stringify(survivalSave));
    ls.setItem(LEGACY_KEYS.sandbox, JSON.stringify({ seed: 1234, edits: [[packPos(1, 30, 1), 7]], player: { x: 0.5, y: 40, z: 0.5, yaw: 0, pitch: 0 }, time: 0.3 }));
    const lib = new WorldLibrary(new MemoryWorldStorage(), KEY);
    expect(await lib.migrateLegacy(ls)).toBe(2);
    expect(ls.getItem(LEGACY_KEYS.survival)).toBeNull();
    expect(ls.getItem(LEGACY_KEYS.sandbox)).toBeNull();
    const list = await lib.list();
    expect(list.map((e) => e.name).sort()).toEqual(['My Sandbox World', 'My Survival World']);

    const sandbox = (await lib.load(list.find((e) => e.mode === 'sandbox')!.id))!;
    expect(sandbox.world.genVersion).toBe(1); // no `gen`: from before the world upgrade
    const sb = openWorld(sandbox.world, lib.myKey).world;
    expect(sb.edits).toEqual([[1, 30, 1, 7]]);
    expect(sb.player).toMatchObject({ x: 0.5, y: 40, z: 0.5 });

    const surv = (await lib.load(list.find((e) => e.mode === 'survival')!.id))!;
    expect(surv.entry.day).toBe(7);
    const w = openWorld(surv.world, lib.myKey).world;
    expect(w.seed).toBe(4242);
    expect(w.genVersion).toBe(2);
    expect(w.time).toBeCloseTo(0.62);
    expect(w.edits).toEqual([[3, 40, -7, 5], [-100, 12, 300, 0]]);
    expect(w.player).toMatchObject({ x: 10.5, y: 41, z: -3.25 });
    expect(w.survival).toMatchObject({ day: 7, rules: { keepInventory: true }, vitals: { hp: 13, food: 9, dead: false }, spawn: [1, 40, 2] });
    expect(w.survival!.inv[0]).toEqual([Item.Stick, 12, 0]);
    expect(w.survival!.inv[2]).toEqual([Item.Bread, 3, 0]);
    expect(w.survival!.chests).toEqual([[packPos(5, 40, 5), 0, [[0, Item.Stick, 4, 0]]]]);
    expect(w.survival!.satchels).toEqual([[8, 41, 8, [[Item.Bread, 1, 0]]]]);
    expect((w.mobs as { list: { name: string }[] }).list[0].name).toBe('Fluffy');
  });

  it('a migration that cannot be written keeps the old save', async () => {
    const ls = new FakeStorage();
    ls.setItem(LEGACY_KEYS.sandbox, JSON.stringify({ seed: 5, edits: [], player: { x: 0, y: 40, z: 0, yaw: 0, pitch: 0 }, time: 0.3 }));
    const broken = new MemoryWorldStorage();
    broken.write = async () => {
      throw new Error('quota');
    };
    expect(await new WorldLibrary(broken, KEY).migrateLegacy(ls)).toBe(0);
    expect(ls.getItem(LEGACY_KEYS.sandbox)).not.toBeNull();
  });
});

describe('world file codec', () => {
  const base = (): SavedWorld => {
    const guestKey = playerRecordKey(OTHER);
    return {
      id: 'x', seed: 77, mode: 'survival', private: true, timeOfDay: 0.5, savedAt: 1, edits: new Uint8Array(4), genVersion: 2,
      sections: new Map([
        [SECTION_TAGS.players, encodePlayers([{ key: guestKey, lastSeen: 5, saved: { x: 1, y: 40, z: 1, yaw: 0, pitch: 0, health: 6, food: 7, dead: false, spawn: null, slots: [[0, Item.Bread, 2, 0]] } }])],
        ['ZZZZ', new Uint8Array([1, 2, 3])],
      ]),
    };
  };
  const game = (over: Partial<CapturedWorld> = {}): CapturedWorld => ({
    seed: 77, mode: 'survival', genVersion: 2, edits: [[1, 2, 3, 4]], player: { x: 5, y: 40, z: 6, yaw: 0.5, pitch: 0 }, time: 0.25,
    survival: survivalSave.survival, mobs: undefined, places: [{ name: 'Home', x: 5, y: 40, z: 6, color: 1 }], autoDecline: true, ...over,
  });

  it('round-trips the owner, keeps other players and unknown sections byte-exact through the file', () => {
    const meta = { name: 'W', createdAt: 1, lastPlayed: 2, playtimeMs: 3 };
    const saved = captureWorld(base(), game(), playerRecordKey(KEY), meta);
    const bytes = encodeWorld(saved);
    const back = decodeWorld('x', bytes);
    expect(encodeWorld(back)).toEqual(bytes);
    expect(back.sections!.get('ZZZZ')).toEqual(new Uint8Array([1, 2, 3]));
    const recs = decodePlayers(back.sections!.get(SECTION_TAGS.players)!);
    expect(recs.map((r) => r.key).sort()).toEqual([playerRecordKey(KEY), playerRecordKey(OTHER)].sort());
    const opened = openWorld(back, playerRecordKey(KEY));
    expect(opened.meta.name).toBe('W');
    expect(opened.world.player).toMatchObject({ x: 5, y: 40, z: 6 });
    expect(opened.world.places).toEqual([{ name: 'Home', x: 5, y: 40, z: 6, color: 1 }]);
    expect(opened.world.autoDecline).toBe(true);
    expect(opened.world.survival!.inv[0]).toEqual([Item.Stick, 12, 0]);
  });

  it('another device opening the world takes over the owner record (export between apps)', () => {
    const meta = { name: 'W', createdAt: 1, lastPlayed: 2, playtimeMs: 3 };
    const file = captureWorld(base(), game(), playerRecordKey(KEY), meta);
    const elsewhere = playerRecordKey('brandnewdevicekey00001');
    const opened = openWorld(file, elsewhere);
    expect(opened.world.survival!.inv[0]).toEqual([Item.Stick, 12, 0]);
    expect(opened.world.places).toHaveLength(1);
    // Saved there: one owner record (the new key), the guest's untouched.
    const again = captureWorld(file, game(), elsewhere, opened.meta);
    const keys = decodePlayers(again.sections!.get(SECTION_TAGS.players)!).map((r) => r.key).sort();
    expect(keys).toEqual([elsewhere, playerRecordKey(OTHER)].sort());
  });
});
