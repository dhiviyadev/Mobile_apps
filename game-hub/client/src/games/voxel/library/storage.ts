/**
 * Where the world library keeps its files on this device. IndexedDB when the
 * browser has it (two object stores: a small index record per world and the
 * world file bytes); otherwise localStorage (base64, a few MB at most), and as
 * a last resort memory (gone when the page closes). The menu warns about the
 * last two.
 */

/** What the menu lists without opening world files. */
export interface WorldEntry {
  id: string;
  name: string;
  mode: 'sandbox' | 'survival';
  createdAt: number;
  lastPlayed: number;
  playtimeMs: number;
  seed: number;
  genVersion: number;
  /** Survival day counter. */
  day: number;
  /** Code the world was last hosted under. */
  hostCode?: string;
  /** Size of the world file in bytes. */
  bytes: number;
}

export type StorageKind = 'indexeddb' | 'local' | 'memory';

export interface WorldStorage {
  readonly kind: StorageKind;
  list(): Promise<WorldEntry[]>;
  read(id: string): Promise<Uint8Array | null>;
  /** Writes the entry and the file together. */
  write(entry: WorldEntry, file: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryWorldStorage implements WorldStorage {
  readonly kind: StorageKind = 'memory';
  private readonly entries = new Map<string, WorldEntry>();
  private readonly files = new Map<string, Uint8Array>();

  async list(): Promise<WorldEntry[]> {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
  async read(id: string): Promise<Uint8Array | null> {
    return this.files.get(id)?.slice() ?? null;
  }
  async write(entry: WorldEntry, file: Uint8Array): Promise<void> {
    this.entries.set(entry.id, { ...entry });
    this.files.set(entry.id, file.slice());
  }
  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.files.delete(id);
  }
}

const LS_INDEX = 'cobalt-hub.worlds.index.v1';
const LS_FILE = 'cobalt-hub.worlds.file.';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** localStorage: the index as one JSON value, each file as base64. */
export class LocalWorldStorage implements WorldStorage {
  readonly kind: StorageKind = 'local';
  constructor(private readonly ls: Storage) {}

  private index(): Record<string, WorldEntry> {
    try {
      return JSON.parse(this.ls.getItem(LS_INDEX) ?? '{}') as Record<string, WorldEntry>;
    } catch {
      return {};
    }
  }
  async list(): Promise<WorldEntry[]> {
    return Object.values(this.index());
  }
  async read(id: string): Promise<Uint8Array | null> {
    const raw = this.ls.getItem(LS_FILE + id);
    return raw ? fromBase64(raw) : null;
  }
  async write(entry: WorldEntry, file: Uint8Array): Promise<void> {
    // Throws when storage is full: the caller says so.
    this.ls.setItem(LS_FILE + entry.id, toBase64(file));
    const index = this.index();
    index[entry.id] = entry;
    this.ls.setItem(LS_INDEX, JSON.stringify(index));
  }
  async remove(id: string): Promise<void> {
    const index = this.index();
    delete index[id];
    this.ls.setItem(LS_INDEX, JSON.stringify(index));
    this.ls.removeItem(LS_FILE + id);
  }
}

const DB_NAME = 'cobalt-hub-worlds';
const ENTRIES = 'entries';
const FILES = 'files';

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });

export class IdbWorldStorage implements WorldStorage {
  readonly kind: StorageKind = 'indexeddb';
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory): Promise<IdbWorldStorage> {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    return new IdbWorldStorage(db);
  }

  async list(): Promise<WorldEntry[]> {
    return done(this.db.transaction(ENTRIES).objectStore(ENTRIES).getAll() as IDBRequest<WorldEntry[]>);
  }
  async read(id: string): Promise<Uint8Array | null> {
    const v = await done(this.db.transaction(FILES).objectStore(FILES).get(id));
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  }
  async write(entry: WorldEntry, file: Uint8Array): Promise<void> {
    const tx = this.db.transaction([ENTRIES, FILES], 'readwrite');
    tx.objectStore(ENTRIES).put(entry);
    tx.objectStore(FILES).put(file, entry.id);
    await finished(tx);
  }
  async remove(id: string): Promise<void> {
    const tx = this.db.transaction([ENTRIES, FILES], 'readwrite');
    tx.objectStore(ENTRIES).delete(id);
    tx.objectStore(FILES).delete(id);
    await finished(tx);
  }
}

/** The best storage this browser has. */
export async function openWorldStorage(): Promise<WorldStorage> {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) {
      const s = await Promise.race([
        IdbWorldStorage.open(indexedDB),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      // Some webviews open a database that then fails every request: check once.
      await s.list();
      return s;
    }
  } catch {
    /* fall through */
  }
  try {
    const ls = window.localStorage;
    const probe = '__cobalt_probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return new LocalWorldStorage(ls);
  } catch {
    return new MemoryWorldStorage();
  }
}
