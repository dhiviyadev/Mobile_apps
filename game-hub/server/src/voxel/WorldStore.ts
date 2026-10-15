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
 * MemoryWorldStore is used by tests and when persistence is disabled.
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

export interface WorldStore {
  /** The saved world, or null if there is none (or it could not be read). */
  load(id: string): Promise<SavedWorld | null>;
  save(world: SavedWorld): Promise<void>;
  exists(id: string): Promise<boolean>;
  /** savedAt of a saved world without loading its edits, or null. */
  savedAt(id: string): Promise<number | null>;
  /** Returns true if a world was deleted. */
  delete(id: string): Promise<boolean>;
  /** Deletes worlds older than maxAgeMs, then the oldest beyond maxCount. Returns how many went. */
  prune(maxAgeMs: number, maxCount: number): Promise<number>;
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

// ---- binary format ----------------------------------------------------------------

const MAGIC = [0x43, 0x56, 0x57, 0x31]; // "CVW1"
const FORMAT_VERSION = 1;
/** Bytes before the edit section (which starts with its u32 count). */
const HEADER_BYTES = 23;
const EDIT_BYTES = 6;

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
  private readonly worlds = new Map<string, SavedWorld>();

  async load(id: string): Promise<SavedWorld | null> {
    const w = isValidWorldId(id) ? this.worlds.get(id) : undefined;
    return w ? copyWorld(w) : null;
  }

  async save(world: SavedWorld): Promise<void> {
    if (!isValidWorldId(world.id)) throw new Error(`invalid world id ${JSON.stringify(world.id)}`);
    this.worlds.set(world.id, copyWorld(world));
  }

  async exists(id: string): Promise<boolean> {
    return isValidWorldId(id) && this.worlds.has(id);
  }

  async savedAt(id: string): Promise<number | null> {
    if (!isValidWorldId(id)) return null;
    return this.worlds.get(id)?.savedAt ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return isValidWorldId(id) && this.worlds.delete(id);
  }

  async prune(maxAgeMs: number, maxCount: number): Promise<number> {
    const entries = [...this.worlds.values()].map((w) => ({ id: w.id, savedAt: w.savedAt }));
    const doomed = pickPruned(entries, maxAgeMs, maxCount, Date.now());
    for (const id of doomed) this.worlds.delete(id);
    return doomed.length;
  }

  async flush(): Promise<void> {}
}

// ---- file store ---------------------------------------------------------------------------

const EXT = '.cvw';
/** Leftover temp files (from a crash mid-write) older than this are removed by prune(). */
const STALE_TMP_MS = 60 * 60 * 1000;

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export class FileWorldStore implements WorldStore {
  readonly worldsDir: string;
  /** Per-id queue: loads, saves and deletes of one world run strictly in order. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private dirReady: Promise<void> | null = null;

  constructor(readonly dir: string) {
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
        await fs.rename(file, `${file}.corrupt`).catch((e) => log.warn(`could not move ${file} aside`, e));
        return null;
      }
    });
  }

  save(world: SavedWorld): Promise<void> {
    if (!isValidWorldId(world.id)) return Promise.reject(new Error(`invalid world id ${JSON.stringify(world.id)}`));
    // Encode now so later changes to the caller's data cannot leak into this save.
    const bytes = encodeWorld(world);
    return this.enqueue(world.id, () => this.writeAtomic(this.file(world.id), bytes));
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
      try {
        await fs.unlink(this.file(id));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  }

  async prune(maxAgeMs: number, maxCount: number): Promise<number> {
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
    let removed = 0;
    for (const id of pickPruned(entries, maxAgeMs, maxCount, now)) {
      if (await this.delete(id)) removed++;
    }
    return removed;
  }

  async flush(): Promise<void> {
    while (this.queues.size > 0) await Promise.all(this.queues.values());
  }

  // ---- internals ---------------------------------------------------------------------

  private file(id: string): string {
    return path.join(this.worldsDir, id + EXT);
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

/**
 * Opens the store configured for this server. Falls back to memory (worlds then
 * last until the server restarts) if persistence is off or the directory is not
 * writable; never throws.
 */
export async function openWorldStore(options: { dir: string; persist: boolean }): Promise<WorldStore> {
  if (!options.persist) {
    log.info('world persistence disabled (PERSIST_WORLDS); saved worlds last until the server restarts');
    return new MemoryWorldStore();
  }
  const store = new FileWorldStore(options.dir);
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
    return new MemoryWorldStore();
  } finally {
    clearTimeout(timer);
  }
  log.info(`saving worlds to ${store.worldsDir}`);
  return store;
}
