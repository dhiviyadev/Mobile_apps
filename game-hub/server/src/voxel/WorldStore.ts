/**
 * Saved Voxelvale worlds: everything needed to rebuild a sandbox world after
 * its room closed or the server restarted (seed, mode, flags, time of day and
 * the edit list).
 *
 * Worlds are keyed by id: a private room's 6-character code, or one of the
 * public slots public-1..public-8. Ids are checked against a strict pattern
 * before any filesystem access, so a crafted id can never escape the save dir.
 *
 * FileWorldStore keeps one small binary file per world (<dir>/worlds/<id>.cvw):
 *   magic "CVW1", u8 version, u8 mode, u8 private, u32 seed, f32 timeOfDay,
 *   f64 savedAt, u32 editCount, editCount × (i16 x, u8 y, i16 z, u8 id)
 * all little-endian. The edit section is exactly encodeEdits(list, true).
 * MemoryWorldStore is used by tests and when persistence is disabled; its
 * worlds last until the server restarts (durable = false).
 *
 * Both stores can be bounded (WorldStoreLimits: number of worlds and bytes).
 * A save that would go over a limit first evicts the least recently saved
 * worlds that no open room holds, and is refused if that is not enough.
 * prune() still runs on a timer for the age limit.
 */
import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, VOXEL_MODES, type VoxelMode } from '@hub/shared';
import { logger } from '../log';

const log = logger('WorldStore');

/** Number of public sandbox worlds kept (public-1..public-N). */
export const PUBLIC_WORLD_SLOTS = 8;

export const publicWorldId = (slot: number): string => `public-${slot}`;

export interface SavedWorld {
  id: string;
  seed: number;
  mode: VoxelMode;
  private: boolean;
  /** Day/night cycle position, 0..1. */
  timeOfDay: number;
  /** When the world was saved (ms since the epoch); drives pruning. */
  savedAt: number;
  /** Edit list as encoded by encodeEdits(list, true): u32 count, then 6-byte edits. */
  edits: Uint8Array;
}

/** Tells prune() (and eviction) that an open room holds this world, so it must stay. */
export type WorldInUse = (id: string) => Promise<boolean>;

/**
 * Bounds on what a store keeps (unset: unbounded). A save that would break
 * one evicts the least recently saved worlds inUse() does not report as open;
 * if that is not enough it rejects with WorldStoreFullError.
 */
export interface WorldStoreLimits {
  /** Most worlds kept (checked when a save adds a new id). */
  maxWorlds?: number;
  /** Most bytes kept, counted as encoded (checked when a save adds bytes). */
  maxBytes?: number;
  inUse?: WorldInUse;
}

/** A save was refused: it does not fit within the limits and nothing more could be evicted. */
export class WorldStoreFullError extends Error {}

export interface WorldStore {
  /** True when saved worlds survive a server restart (false for the in-memory store). */
  readonly durable: boolean;
  /** The saved world, or null if there is none (or it could not be read). */
  load(id: string): Promise<SavedWorld | null>;
  save(world: SavedWorld): Promise<void>;
  exists(id: string): Promise<boolean>;
  /** savedAt of a saved world without loading its edits, or null. */
  savedAt(id: string): Promise<number | null>;
  /** Returns true if a world was deleted. */
  delete(id: string): Promise<boolean>;
  /**
   * Moves a save that cannot be used out of the way (the file store keeps it as
   * <id>.cvw.corrupt) so the id can start afresh. Resolves once nothing is
   * stored under id.
   */
  quarantine(id: string): Promise<void>;
  /**
   * Deletes worlds older than maxAgeMs, then the oldest beyond maxCount. Worlds
   * saved again while pruning runs, and worlds inUse() reports as open, are
   * kept. Returns how many went.
   */
  prune(maxAgeMs: number, maxCount: number, inUse?: WorldInUse): Promise<number>;
  /** Number of saved worlds and their total size in bytes (as encoded). */
  usage(): Promise<{ worlds: number; bytes: number }>;
  /** Resolves once every save and delete started so far has finished (used at shutdown). */
  flush(): Promise<void>;
}

const ID_PATTERN = new RegExp(`^(?:[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}|public-[1-${PUBLIC_WORLD_SLOTS}])$`);

/** True for a 6-character room code or a public slot id; everything else is rejected. */
export function isValidWorldId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/** Picks which worlds prune() removes: too old first, then the oldest beyond maxCount. */
function pickPruned(entries: { id: string; savedAt: number }[], maxAgeMs: number, maxCount: number, now: number): string[] {
  const cutoff = now - maxAgeMs;
  const doomed = entries.filter((e) => e.savedAt < cutoff).map((e) => e.id);
  const kept = entries.filter((e) => e.savedAt >= cutoff).sort((a, b) => b.savedAt - a.savedAt);
  for (const e of kept.slice(Math.max(0, maxCount))) doomed.push(e.id);
  return doomed;
}

// ---- limits -----------------------------------------------------------------------------

/** When and how big each stored world is, kept up to date by the store for its limits. */
class Usage {
  readonly worlds = new Map<string, { savedAt: number; bytes: number }>();
  bytes = 0;

  set(id: string, savedAt: number, bytes: number): void {
    this.bytes += bytes - (this.worlds.get(id)?.bytes ?? 0);
    this.worlds.set(id, { savedAt, bytes });
  }

  delete(id: string): void {
    const entry = this.worlds.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.worlds.delete(id);
  }

  clone(): Usage {
    const copy = new Usage();
    for (const [id, e] of this.worlds) copy.set(id, e.savedAt, e.bytes);
    return copy;
  }

  /** True if storing bytes under id breaks a limit. A save that adds no world and no bytes never does. */
  over(id: string, bytes: number, limits: WorldStoreLimits): boolean {
    const old = this.worlds.get(id);
    if (!old && this.worlds.size + 1 > (limits.maxWorlds ?? Infinity)) return true;
    const growth = bytes - (old?.bytes ?? 0);
    return growth > 0 && this.bytes + growth > (limits.maxBytes ?? Infinity);
  }
}

/** How a store evicts: canEvict() says no to worlds that are open in a room (or busy); evict() checks again. */
interface Evictor {
  canEvict(id: string): Promise<boolean>;
  evict(id: string): Promise<boolean>;
}

/**
 * Makes room for a save of bytes under id: picks other worlds, least
 * recently saved first and skipping those it cannot evict, until the save
 * fits, then evicts them. If it would never fit, nothing is evicted: logs a
 * warning and throws WorldStoreFullError.
 */
async function makeRoom(usage: Usage, id: string, bytes: number, limits: WorldStoreLimits, store: Evictor): Promise<void> {
  if (!usage.over(id, bytes, limits)) return;
  const after = usage.clone();
  const doomed: string[] = [];
  const oldestFirst = [...usage.worlds].filter(([other]) => other !== id).sort((a, b) => a[1].savedAt - b[1].savedAt);
  for (const [other] of oldestFirst) {
    if (!after.over(id, bytes, limits)) break;
    if (!(await store.canEvict(other))) continue;
    after.delete(other);
    doomed.push(other);
  }
  if (!after.over(id, bytes, limits)) {
    for (const other of doomed) {
      if (await store.evict(other)) log.info(`evicted saved world ${other} to make room for ${id}`);
    }
    // Only short if a world was opened (or got busy) since it was picked.
    if (!usage.over(id, bytes, limits)) return;
  }
  const mb = (usage.bytes / (1024 * 1024)).toFixed(1);
  log.warn(`not saving world ${id}: the store is full (${usage.worlds.size} worlds, ${mb} MB) and evicting the worlds not open in rooms would not make enough room`);
  throw new WorldStoreFullError(`no room to save world ${id}`);
}

/** Runs tasks one at a time, in the order they were handed in. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every task handed in so far has finished. */
  async idle(): Promise<void> {
    await this.tail;
  }
}

// ---- binary format ----------------------------------------------------------------

const MAGIC = [0x43, 0x56, 0x57, 0x31]; // "CVW1"
const FORMAT_VERSION = 1;
/** Bytes before the edit section (which starts with its u32 count). */
const HEADER_BYTES = 23;
const EDIT_BYTES = 6;

/** Size of a world as encodeWorld() writes it. */
const encodedSize = (world: SavedWorld): number => HEADER_BYTES + world.edits.byteLength;

export function encodeWorld(world: SavedWorld): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + world.edits.byteLength);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, FORMAT_VERSION);
  view.setUint8(5, Math.max(0, VOXEL_MODES.indexOf(world.mode)));
  view.setUint8(6, world.private ? 1 : 0);
  view.setUint32(7, world.seed >>> 0, true);
  view.setFloat32(11, world.timeOfDay, true);
  view.setFloat64(15, world.savedAt, true);
  out.set(world.edits, HEADER_BYTES);
  return out;
}

/** Parses a world file. Throws on anything malformed, including truncation. */
export function decodeWorld(id: string, data: Uint8Array): SavedWorld {
  if (data.byteLength < HEADER_BYTES + 4) throw new Error('file too short');
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) throw new Error('bad magic');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(4) !== FORMAT_VERSION) throw new Error(`unsupported version ${view.getUint8(4)}`);
  const mode = VOXEL_MODES[view.getUint8(5)];
  if (!mode) throw new Error('bad mode');
  const flag = view.getUint8(6);
  if (flag > 1) throw new Error('bad private flag');
  const timeOfDay = view.getFloat32(11, true);
  const savedAt = view.getFloat64(15, true);
  if (!Number.isFinite(timeOfDay) || !Number.isFinite(savedAt)) throw new Error('bad header values');
  const count = view.getUint32(HEADER_BYTES, true);
  if (data.byteLength !== HEADER_BYTES + 4 + count * EDIT_BYTES) throw new Error(`expected ${count} edits, file is truncated or padded`);
  return {
    id,
    seed: view.getUint32(7, true),
    mode,
    private: flag === 1,
    timeOfDay: ((timeOfDay % 1) + 1) % 1,
    savedAt,
    edits: data.subarray(HEADER_BYTES),
  };
}

// ---- in-memory store -------------------------------------------------------------------

const copyWorld = (w: SavedWorld): SavedWorld => ({ ...w, edits: w.edits.slice() });

export class MemoryWorldStore implements WorldStore {
  readonly durable = false;
  private readonly worlds = new Map<string, SavedWorld>();
  private readonly sizes = new Usage();
  /** Saves run one at a time (in call order), so each one's limit check sees the ones before. */
  private readonly saves = new Serial();

  constructor(private readonly limits: WorldStoreLimits = {}) {}

  async load(id: string): Promise<SavedWorld | null> {
    const w = isValidWorldId(id) ? this.worlds.get(id) : undefined;
    return w ? copyWorld(w) : null;
  }

  async save(world: SavedWorld): Promise<void> {
    if (!isValidWorldId(world.id)) throw new Error(`invalid world id ${JSON.stringify(world.id)}`);
    const copy = copyWorld(world);
    const bytes = encodedSize(copy);
    await this.saves.run(async () => {
      await makeRoom(this.sizes, copy.id, bytes, this.limits, this.evictor);
      this.worlds.set(copy.id, copy);
      this.sizes.set(copy.id, copy.savedAt, bytes);
    });
  }

  async exists(id: string): Promise<boolean> {
    return isValidWorldId(id) && this.worlds.has(id);
  }

  async savedAt(id: string): Promise<number | null> {
    if (!isValidWorldId(id)) return null;
    return this.worlds.get(id)?.savedAt ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return isValidWorldId(id) && this.remove(id);
  }

  async quarantine(id: string): Promise<void> {
    await this.delete(id);
  }

  async prune(maxAgeMs: number, maxCount: number, inUse?: WorldInUse): Promise<number> {
    const entries = [...this.worlds.values()].map((w) => ({ id: w.id, savedAt: w.savedAt }));
    const scanned = new Map(entries.map((e) => [e.id, e.savedAt]));
    let removed = 0;
    for (const id of pickPruned(entries, maxAgeMs, maxCount, Date.now())) {
      if (inUse && (await inUse(id))) continue;
      // Saved again while inUse() was answering: keep it.
      const world = this.worlds.get(id);
      if (!world || world.savedAt > scanned.get(id)!) continue;
      this.remove(id);
      removed++;
    }
    return removed;
  }

  async usage(): Promise<{ worlds: number; bytes: number }> {
    return { worlds: this.sizes.worlds.size, bytes: this.sizes.bytes };
  }

  async flush(): Promise<void> {
    await this.saves.idle();
  }

  private remove(id: string): boolean {
    this.sizes.delete(id);
    return this.worlds.delete(id);
  }

  /** For makeRoom(): worlds open in a room stay; evicting checks that again. */
  private readonly evictor: Evictor = {
    canEvict: async (id) => !(this.limits.inUse && (await this.limits.inUse(id))),
    evict: async (id) => (await this.evictor.canEvict(id)) && this.remove(id),
  };
}

// ---- file store ---------------------------------------------------------------------------

const EXT = '.cvw';
/** Leftover temp files (from a crash mid-write) older than this are removed by prune(). */
const STALE_TMP_MS = 60 * 60 * 1000;

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export class FileWorldStore implements WorldStore {
  readonly durable = true;
  readonly worldsDir: string;
  /** Per-id queue: loads, saves and deletes of one world run strictly in order. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private dirReady: Promise<void> | null = null;
  /** Size and age of every world file (read from the directory once, then kept up to date). */
  private sizes: Promise<Usage> | null = null;
  /** Saves check the limits (and reserve their room) one at a time. */
  private readonly admissions = new Serial();

  constructor(
    readonly dir: string,
    private readonly limits: WorldStoreLimits = {},
  ) {
    this.worldsDir = path.join(dir, 'worlds');
  }

  load(id: string): Promise<SavedWorld | null> {
    if (!isValidWorldId(id)) return Promise.resolve(null);
    // Queued like a write, so moving a corrupt file aside can never race a save.
    return this.enqueue(id, async () => {
      const file = this.file(id);
      let data: Uint8Array;
      try {
        data = await fs.readFile(file);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      try {
        return decodeWorld(id, data);
      } catch (err) {
        log.warn(`saved world ${id} is unreadable (${(err as Error).message}); moving it to ${id}${EXT}.corrupt`);
        try {
          await this.moveAside(file);
          await this.forget(id);
        } catch (e) {
          log.warn(`could not move ${file} aside`, e);
        }
        return null;
      }
    });
  }

  save(world: SavedWorld): Promise<void> {
    if (!isValidWorldId(world.id)) return Promise.reject(new Error(`invalid world id ${JSON.stringify(world.id)}`));
    // Encode now so later changes to the caller's data cannot leak into this save.
    const bytes = encodeWorld(world);
    return this.enqueue(world.id, async () => {
      const sizes = await this.loadSizes();
      const before = sizes.worlds.get(world.id);
      // One at a time, so saves of different worlds cannot overrun the limits together.
      await this.admissions.run(async () => {
        await makeRoom(sizes, world.id, bytes.byteLength, this.limits, this.evictor);
        sizes.set(world.id, world.savedAt, bytes.byteLength);
      });
      try {
        await this.writeAtomic(this.file(world.id), bytes);
      } catch (err) {
        // The old file (if any) is untouched: count it again instead.
        if (before) sizes.set(world.id, before.savedAt, before.bytes);
        else sizes.delete(world.id);
        throw err;
      }
    });
  }

  async exists(id: string): Promise<boolean> {
    if (!isValidWorldId(id)) return false;
    await this.settled(id);
    try {
      await fs.access(this.file(id), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async savedAt(id: string): Promise<number | null> {
    if (!isValidWorldId(id)) return null;
    await this.settled(id);
    return this.readSavedAt(this.file(id));
  }

  delete(id: string): Promise<boolean> {
    if (!isValidWorldId(id)) return Promise.resolve(false);
    return this.enqueue(id, async () => {
      const removed = await this.unlink(this.file(id));
      await this.forget(id);
      return removed;
    });
  }

  quarantine(id: string): Promise<void> {
    if (!isValidWorldId(id)) return Promise.resolve();
    return this.enqueue(id, async () => {
      try {
        await this.moveAside(this.file(id));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      await this.forget(id);
    });
  }

  async prune(maxAgeMs: number, maxCount: number, inUse?: WorldInUse): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.worldsDir);
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
    const now = Date.now();
    const entries: { id: string; savedAt: number }[] = [];
    for (const name of names) {
      const full = path.join(this.worldsDir, name);
      if (name.endsWith(EXT)) {
        const id = name.slice(0, -EXT.length);
        if (!isValidWorldId(id)) continue;
        const savedAt = (await this.readSavedAt(full)) ?? (await this.mtime(full));
        if (savedAt !== null) entries.push({ id, savedAt });
      } else if (name.endsWith('.tmp') || name.endsWith('.corrupt')) {
        // Interrupted writes and quarantined files are only kept for a while.
        const mtime = await this.mtime(full);
        const limit = name.endsWith('.tmp') ? STALE_TMP_MS : maxAgeMs;
        if (mtime !== null && now - mtime > limit) await fs.unlink(full).catch(() => undefined);
      }
    }
    const scanned = new Map(entries.map((e) => [e.id, e.savedAt]));
    let removed = 0;
    for (const id of pickPruned(entries, maxAgeMs, maxCount, now)) {
      if (await this.pruneOne(id, scanned.get(id)!, inUse)) removed++;
    }
    return removed;
  }

  async usage(): Promise<{ worlds: number; bytes: number }> {
    const sizes = await this.loadSizes();
    return { worlds: sizes.worlds.size, bytes: sizes.bytes };
  }

  async flush(): Promise<void> {
    while (this.queues.size > 0) await Promise.all(this.queues.values());
  }

  // ---- internals ---------------------------------------------------------------------

  private file(id: string): string {
    return path.join(this.worldsDir, id + EXT);
  }

  /** Sizes of the world files: read from the directory the first time they are needed, then kept up to date. */
  private loadSizes(): Promise<Usage> {
    if (!this.sizes) {
      this.sizes = this.scanSizes();
      // Read the directory again next time if it could not be read now.
      this.sizes.catch(() => (this.sizes = null));
    }
    return this.sizes;
  }

  private async scanSizes(): Promise<Usage> {
    const sizes = new Usage();
    let names: string[];
    try {
      names = await fs.readdir(this.worldsDir);
    } catch (err) {
      if (isNotFound(err)) return sizes;
      throw err;
    }
    for (const name of names) {
      const id = name.endsWith(EXT) ? name.slice(0, -EXT.length) : '';
      if (!isValidWorldId(id)) continue;
      const full = path.join(this.worldsDir, name);
      try {
        const { size, mtimeMs } = await fs.stat(full);
        sizes.set(id, (await this.readSavedAt(full)) ?? mtimeMs, size);
      } catch {
        // Deleted while scanning.
      }
    }
    return sizes;
  }

  /**
   * Drops id from the sizes once its file is gone. Waits for a scan that is
   * still running, so the scan cannot add it back afterwards.
   */
  private async forget(id: string): Promise<void> {
    try {
      (await this.loadSizes()).delete(id);
    } catch {
      // Not read yet: the next scan will not find the file.
    }
  }

  /** For makeRoom(): worlds open in a room, or with anything queued (e.g. being saved or opened), stay. */
  private readonly evictor: Evictor = {
    canEvict: async (id) => !this.queues.has(id) && !(this.limits.inUse && (await this.limits.inUse(id))),
    evict: (id) => this.evict(id),
  };

  /** Deletes a world to make room for another, checking again that it is neither busy nor open. */
  private evict(id: string): Promise<boolean> {
    if (this.queues.has(id)) return Promise.resolve(false);
    return this.enqueue(id, async () => {
      if (this.limits.inUse && (await this.limits.inUse(id))) return false;
      try {
        await this.unlink(this.file(id));
      } catch (err) {
        log.warn(`could not evict saved world ${id}`, err);
        return false;
      }
      await this.forget(id);
      return true;
    });
  }

  /**
   * Deletes a world prune() picked, unless an open room holds it or it was
   * saved again after the scan read scannedAt. Queued like a save, so a save
   * that started first (e.g. a closing room's final save) is seen here.
   */
  private pruneOne(id: string, scannedAt: number, inUse?: WorldInUse): Promise<boolean> {
    return this.enqueue(id, async () => {
      if (inUse && (await inUse(id))) return false;
      const file = this.file(id);
      const savedAt = (await this.readSavedAt(file)) ?? (await this.mtime(file));
      if (savedAt === null || savedAt > scannedAt) return false;
      const removed = await this.unlink(file);
      await this.forget(id);
      return removed;
    });
  }

  private async unlink(file: string): Promise<boolean> {
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Renames file to <file>.corrupt (replacing an older one), where prune() expires it. */
  private async moveAside(file: string): Promise<void> {
    const target = `${file}.corrupt`;
    await fs.rename(file, target);
    // rename keeps the old mtime: restart the expiry clock for the quarantined copy.
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => undefined);
  }

  /** Runs task after every operation already queued for the same id. */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  /** Waits for queued writes of id, so reads see the latest save. */
  private async settled(id: string): Promise<void> {
    await this.queues.get(id);
  }

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = fs.mkdir(this.worldsDir, { recursive: true }).then(() => undefined);
      // Retry on the next save if creating it failed (e.g. a volume that mounted late).
      this.dirReady.catch(() => (this.dirReady = null));
    }
    return this.dirReady;
  }

  /** Writes to <file>.tmp, flushes it, then renames over the old file. */
  private async writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir();
    const tmp = `${file}.tmp`;
    let handle: FileHandle;
    try {
      handle = await fs.open(tmp, 'w');
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // The directory vanished after it was created: make it again and retry once.
      this.dirReady = null;
      await this.ensureDir();
      handle = await fs.open(tmp, 'w');
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private async readSavedAt(file: string): Promise<number | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(file, 'r');
      const head = new Uint8Array(HEADER_BYTES);
      const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0);
      if (bytesRead < HEADER_BYTES || MAGIC.some((b, i) => head[i] !== b)) return null;
      const savedAt = new DataView(head.buffer).getFloat64(15, true);
      return Number.isFinite(savedAt) ? savedAt : null;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  private async mtime(file: string): Promise<number | null> {
    try {
      return (await fs.stat(file)).mtimeMs;
    } catch {
      return null;
    }
  }
}

// ---- process-wide store -------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 5000;

let current: WorldStore | null = null;

/** The store rooms save into. Defaults to an in-memory store until setWorldStore() is called. */
export function getWorldStore(): WorldStore {
  return (current ??= new MemoryWorldStore());
}

export function setWorldStore(store: WorldStore): void {
  current = store;
}

export interface WorldStoreOptions {
  dir: string;
  persist: boolean;
  /** Most saved worlds kept (either store). */
  maxWorlds?: number;
  /** Byte budget of the in-memory store (also when falling back to it). */
  maxMemoryBytes?: number;
  /** Byte budget of the world files on disk. */
  maxFileBytes?: number;
  /** Worlds held by open rooms, which are never evicted to make room. */
  inUse?: WorldInUse;
}

/**
 * Opens the store configured for this server. Falls back to memory (worlds then
 * last until the server restarts) if persistence is off or the directory is not
 * writable; never throws.
 */
export async function openWorldStore(options: WorldStoreOptions): Promise<WorldStore> {
  const memory = () => new MemoryWorldStore({ maxWorlds: options.maxWorlds, maxBytes: options.maxMemoryBytes, inUse: options.inUse });
  if (!options.persist) {
    log.info('world persistence disabled (PERSIST_WORLDS); saved worlds last until the server restarts');
    return memory();
  }
  const store = new FileWorldStore(options.dir, { maxWorlds: options.maxWorlds, maxBytes: options.maxFileBytes, inUse: options.inUse });
  const probe = path.join(store.worldsDir, `.probe-${process.pid}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const check = async () => {
      await fs.mkdir(store.worldsDir, { recursive: true });
      await fs.writeFile(probe, '');
      await fs.unlink(probe);
    };
    // Some odd mounts (e.g. under /proc) make mkdir hang rather than fail: give up after a while.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${PROBE_TIMEOUT_MS / 1000} s`)), PROBE_TIMEOUT_MS);
    });
    await Promise.race([check(), timeout]);
  } catch (err) {
    log.warn(`cannot write to ${store.worldsDir} (${(err as Error).message}); saving worlds in memory only, they will be lost on restart`);
    return memory();
  } finally {
    clearTimeout(timer);
  }
  try {
    // Reads the size of every saved world now, for the limits.
    const { worlds, bytes } = await store.usage();
    log.info(`saving worlds to ${store.worldsDir} (${worlds} saved, ${(bytes / (1024 * 1024)).toFixed(1)} MB)`);
  } catch (err) {
    log.warn(`saving worlds to ${store.worldsDir}, but could not list the saved ones yet`, err);
  }
  return store;
}
