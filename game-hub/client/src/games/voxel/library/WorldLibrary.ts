/**
 * The Voxelvale world library: every world this device keeps, as CVW world
 * files (library/codec.ts) in the best storage the browser has
 * (library/storage.ts). The hub's world menu lists, creates, renames,
 * duplicates, deletes, exports and imports them; the game loads one and saves
 * it back while playing; hosting uploads one and stores the saves the server
 * sends back.
 *
 * On first open the two saves of the old one-world-per-mode offline storage
 * become library worlds ("My Sandbox World", "My Survival World"); the old
 * keys are removed only once their world is safely written.
 */
import {
  cleanWorldName,
  decodeWorld,
  encodeSurv,
  encodeWorld,
  encodeWorldMeta,
  encodeEdits,
  type GenVersion,
  HOSTED_WORLD_MAX_BYTES,
  isGenVersion,
  LATEST_GEN_VERSION,
  RuleFlags,
  type SavedWorld,
  SECTION_TAGS,
  unpackPos,
  type WorldMeta,
} from '@hub/shared';
import { getPlayerKey } from '../../../core/playerKey';
import { captureWorld, worldDay, worldMeta, withMeta } from './codec';
import { playerRecordKey } from './keyHash';
import { openWorldStorage, type WorldEntry, type WorldStorage } from './storage';

export type { WorldEntry } from './storage';

/** Old offline saves (one world per mode), migrated into the library. */
export const LEGACY_KEYS = { sandbox: 'cobalt-hub.voxel.offline.v1', survival: 'cobalt-hub.voxel.offline.survival.v1' } as const;
const LEGACY_NAMES = { sandbox: 'My Sandbox World', survival: 'My Survival World' } as const;

/** File extension of exported worlds. */
export const WORLD_EXTENSION = '.voxelvale';

export interface NewWorldOptions {
  name: string;
  mode: 'sandbox' | 'survival';
  /** Any text; empty = random. */
  seedText: string;
  keepInventory?: boolean;
  pvp?: boolean;
}

/** An import that cannot become a world; the message is shown as is. */
export class ImportError extends Error {}

/** Text -> seed: whole numbers as themselves, anything else hashed (FNV-1a), empty = random. */
export function seedFromText(text: string, random: () => number = Math.random): number {
  const t = text.trim();
  if (!t) return (random() * 0xffffffff) >>> 0;
  if (/^-?\d{1,10}$/.test(t)) return Number(t) >>> 0;
  let h = 0x811c9dc5;
  for (const ch of t) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const newId = () => `w${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;

/** Runs writes one at a time, in order. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async idle(): Promise<void> {
    await this.tail;
  }
}

export function entryOf(id: string, world: SavedWorld, bytes: number): WorldEntry {
  const meta = worldMeta(world);
  return {
    id,
    name: meta.name,
    mode: world.mode === 'survival' ? 'survival' : 'sandbox',
    createdAt: meta.createdAt,
    lastPlayed: meta.lastPlayed,
    playtimeMs: meta.playtimeMs,
    seed: world.seed,
    genVersion: world.genVersion ?? 1,
    day: world.mode === 'survival' ? worldDay(world) : 0,
    ...(meta.hostCode ? { hostCode: meta.hostCode } : {}),
    ...(meta.hostPublic !== undefined ? { hostPublic: meta.hostPublic } : {}),
    bytes,
  };
}

export class WorldLibrary {
  private readonly writes = new Serial();
  private persistAsked = false;
  /** PLYR / WAYP key of this device's player. */
  readonly myKey: string;

  constructor(
    readonly storage: WorldStorage,
    playerKey: string,
  ) {
    this.myKey = playerRecordKey(playerKey);
  }

  /** True when worlds survive closing the app (IndexedDB). */
  get durable(): boolean {
    return this.storage.kind === 'indexeddb';
  }

  /** Newest played first. */
  async list(): Promise<WorldEntry[]> {
    await this.writes.idle();
    return (await this.storage.list()).sort((a, b) => b.lastPlayed - a.lastPlayed || b.createdAt - a.createdAt);
  }

  async load(id: string): Promise<{ entry: WorldEntry; world: SavedWorld } | null> {
    await this.writes.idle();
    const bytes = await this.storage.read(id);
    if (!bytes) return null;
    const world = decodeWorld(id, bytes);
    return { entry: entryOf(id, world, bytes.byteLength), world };
  }

  /** Writes a world (the game's autosave, a host save). Resolves with its entry. */
  save(id: string, world: SavedWorld): Promise<WorldEntry> {
    return this.writes.run(async () => {
      const bytes = encodeWorld({ ...world, id });
      const entry = entryOf(id, world, bytes.byteLength);
      await this.storage.write(entry, bytes);
      return entry;
    });
  }

  /** "New World", then "New World 2"... the first name not taken. */
  async defaultName(base = 'New World'): Promise<string> {
    return this.uniqueName(base, await this.list(), true);
  }

  async create(o: NewWorldOptions): Promise<WorldEntry> {
    const list = await this.list();
    const name = this.uniqueName(cleanWorldName(o.name) || 'New World', list);
    const now = Date.now();
    const meta: WorldMeta = { name, createdAt: now, lastPlayed: now, playtimeMs: 0, ownerKey: this.myKey };
    const sections = new Map<string, Uint8Array>([[SECTION_TAGS.meta, encodeWorldMeta(meta)]]);
    if (o.mode === 'survival') sections.set(SECTION_TAGS.survival, encodeSurv((o.keepInventory ? RuleFlags.KeepInventory : 0) | (o.pvp ? RuleFlags.PvP : 0), 1));
    const world: SavedWorld = {
      id: 'local',
      seed: seedFromText(o.seedText),
      mode: o.mode,
      private: true,
      timeOfDay: 0.3,
      savedAt: now,
      edits: encodeEdits([], true),
      genVersion: LATEST_GEN_VERSION,
      sections,
    };
    this.askPersist();
    return this.save(newId(), world);
  }

  async rename(id: string, name: string): Promise<WorldEntry | null> {
    const clean = cleanWorldName(name);
    const got = await this.load(id);
    if (!got || !clean) return null;
    return this.save(id, withMeta(got.world, { ...worldMeta(got.world), name: clean }));
  }

  /** Updates META (play time, host code...) without touching the rest. */
  async updateMeta(id: string, change: (meta: WorldMeta) => WorldMeta): Promise<WorldEntry | null> {
    const got = await this.load(id);
    if (!got) return null;
    return this.save(id, withMeta(got.world, change(worldMeta(got.world))));
  }

  async duplicate(id: string): Promise<WorldEntry | null> {
    const got = await this.load(id);
    if (!got) return null;
    const meta = worldMeta(got.world);
    const now = Date.now();
    const name = this.uniqueName(`${meta.name} copy`, await this.list());
    // A copy is a new world: it does not share the original's online code.
    const copy = withMeta(got.world, { ...meta, name, createdAt: now, lastPlayed: now, playtimeMs: meta.playtimeMs, hostCode: undefined });
    return this.save(newId(), copy);
  }

  async remove(id: string): Promise<void> {
    await this.writes.run(() => this.storage.remove(id));
  }

  /** The world file to download, named after the world. */
  async exportFile(id: string): Promise<{ fileName: string; bytes: Uint8Array } | null> {
    await this.writes.idle();
    const bytes = await this.storage.read(id);
    const got = bytes ? decodeWorld(id, bytes) : null;
    if (!bytes || !got) return null;
    const safe = worldMeta(got).name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'world';
    return { fileName: `${safe}${WORLD_EXTENSION}`, bytes };
  }

  /** Adds a world file (from Export, or a hosted save) as a new world. */
  async importFile(bytes: Uint8Array, fileName = ''): Promise<WorldEntry> {
    if (bytes.byteLength > HOSTED_WORLD_MAX_BYTES * 4) throw new ImportError('That file is too big to be a Voxelvale world.');
    let world: SavedWorld;
    try {
      world = decodeWorld('import', bytes);
    } catch {
      throw new ImportError('That file is not a Voxelvale world, or it is damaged.');
    }
    if (world.mode !== 'sandbox' && world.mode !== 'survival') throw new ImportError('Only Sandbox and Survival worlds can be imported.');
    const meta = worldMeta(world);
    const fromFile = cleanWorldName(fileName.replace(/\.[^.]*$/, ''));
    const base = decodeHasName(world) ? meta.name : fromFile || meta.name;
    const name = this.uniqueName(base, await this.list());
    const now = Date.now();
    this.askPersist();
    return this.save(newId(), withMeta(world, { ...meta, name, lastPlayed: now, createdAt: meta.createdAt || now }));
  }

  /** Turns the old offline saves into library worlds (once; the old keys go after a successful write). */
  async migrateLegacy(ls: Storage | null): Promise<number> {
    if (!ls) return 0;
    let n = 0;
    for (const mode of ['sandbox', 'survival'] as const) {
      let raw: string | null = null;
      try {
        raw = ls.getItem(LEGACY_KEYS[mode]);
      } catch {
        continue;
      }
      if (!raw) continue;
      const world = legacyWorld(raw, mode, this.myKey, LEGACY_NAMES[mode]);
      if (!world) continue;
      try {
        const list = await this.list();
        await this.save(newId(), withMeta(world, { ...worldMeta(world), name: this.uniqueName(LEGACY_NAMES[mode], list) }));
        ls.removeItem(LEGACY_KEYS[mode]);
        n++;
      } catch (err) {
        console.warn(`[worlds] could not move the old ${mode} save into the library; keeping it`, err);
      }
    }
    return n;
  }

  private uniqueName(base: string, list: readonly WorldEntry[], numberFirst = false): string {
    const taken = new Set(list.map((e) => e.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const name = numberFirst ? `${base} ${i}` : `${base} (${i})`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  /** Installed apps usually get durable storage; ask once, when the first world is made. */
  private askPersist(): void {
    if (this.persistAsked) return;
    this.persistAsked = true;
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      /* not offered */
    }
  }
}

/** True when the file carries its own name (META). */
function decodeHasName(world: SavedWorld): boolean {
  return !!world.sections?.has(SECTION_TAGS.meta) && worldMeta(world).name !== 'Imported World';
}

/** One old offline save (JSON) as a world file, or null when unreadable. */
export function legacyWorld(raw: string, mode: 'sandbox' | 'survival', myKey: string, name: string): SavedWorld | null {
  let save: {
    seed?: unknown; edits?: unknown; player?: unknown; time?: unknown; gen?: unknown; mobs?: unknown; survival?: unknown;
  };
  try {
    save = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!save || typeof save !== 'object' || typeof save.seed !== 'number') return null;
  const edits: [number, number, number, number][] = [];
  for (const e of Array.isArray(save.edits) ? save.edits : []) {
    if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number') edits.push([...unpackPos(e[0]), e[1]]);
  }
  const p = save.player as { x?: number; y?: number; z?: number; yaw?: number; pitch?: number } | undefined;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const player = p && ok(p.x) && ok(p.y) && ok(p.z) ? { x: p.x, y: p.y, z: p.z, yaw: ok(p.yaw) ? p.yaw : 0, pitch: ok(p.pitch) ? p.pitch : 0 } : null;
  const now = Date.now();
  const meta: WorldMeta = { name, createdAt: now, lastPlayed: now, playtimeMs: 0, ownerKey: myKey };
  // A save without `gen` predates the world upgrade: it keeps generator 1.
  const genVersion: GenVersion = isGenVersion(save.gen) ? save.gen : 1;
  const world = captureWorld(
    null,
    {
      seed: save.seed,
      mode,
      genVersion,
      edits,
      player: player ?? { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
      time: ok(save.time) ? save.time : 0.3,
      survival: mode === 'survival' ? save.survival : undefined,
      mobs: save.mobs,
    },
    myKey,
    meta,
    now,
  );
  // No saved position: the game picks the spawn.
  return player ? world : withMeta(world, { ...meta, ownerKey: myKey });
}

let shared: Promise<WorldLibrary> | null = null;

/** The device's library (opened and migrated once per page). */
export function getLibrary(): Promise<WorldLibrary> {
  shared ??= (async () => {
    const lib = new WorldLibrary(await openWorldStorage(), getPlayerKey());
    let ls: Storage | null = null;
    try {
      ls = window.localStorage;
    } catch {
      /* blocked */
    }
    await lib.migrateLegacy(ls);
    return lib;
  })();
  return shared;
}
