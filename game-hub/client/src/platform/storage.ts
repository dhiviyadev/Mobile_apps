/**
 * Web Storage that never throws. Some in-app browsers and Android WebViews
 * turn DOM storage off: `localStorage` is then null (so `.getItem` throws) or
 * its getter throws outright. Everything falls back to memory there, which
 * keeps the games playable; saves just don't outlive the page.
 */

export interface SafeStorage {
  get(key: string): string | null;
  /** False when the write failed (quota); the memory fallback always succeeds. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** True when backed by real Web Storage. */
  readonly persistent: boolean;
}

const PROBE_KEY = '__cobalt_probe__';

/** Real storage if it can be read, or null. A full store (quota) still counts as usable. */
function usableStore(getStore: () => Storage | null | undefined): Storage | null {
  try {
    const s = getStore();
    if (!s) return null;
    s.getItem(PROBE_KEY);
    try {
      s.setItem(PROBE_KEY, '1');
      s.removeItem(PROBE_KEY);
    } catch (e) {
      if (!isQuotaError(e)) return null;
    }
    return s;
  } catch {
    return null;
  }
}

const isQuotaError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

export function createSafeStorage(getStore: () => Storage | null | undefined): SafeStorage {
  let store: Storage | null = null;
  const memory = new Map<string, string>();
  // Probed until it works, so storage swapped in by installStorageFallback() is picked up.
  const real = () => store ?? (store = usableStore(getStore));
  return {
    get(key) {
      const s = real();
      if (!s) return memory.get(key) ?? null;
      try {
        return s.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      const s = real();
      if (!s) {
        memory.set(key, value);
        return true;
      }
      try {
        s.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      const s = real();
      if (!s) memory.delete(key);
      else {
        try {
          s.removeItem(key);
        } catch {
          /* ignore */
        }
      }
    },
    get persistent() {
      return real() !== null;
    },
  };
}

export const safeLocal: SafeStorage = createSafeStorage(() => globalThis.localStorage);
export const safeSession: SafeStorage = createSafeStorage(() => globalThis.sessionStorage);

/** In-memory Storage with the standard interface. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  [name: string]: unknown;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

let storageFallback = false;

/**
 * Replaces an unusable window.localStorage / sessionStorage with memory, so
 * code anywhere in the games that calls them directly keeps working. Real,
 * readable storage is never replaced (not even a full one). Call at boot.
 */
export function installStorageFallback(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (usableStore(() => target[name] as Storage | null)) continue;
    try {
      Object.defineProperty(target, name, { value: new MemoryStorage(), configurable: true, enumerable: true, writable: false });
      if (name === 'localStorage') storageFallback = true;
    } catch {
      /* non-configurable: the safe wrappers still fall back to memory */
    }
  }
}

/** True when settings and offline worlds can be kept after the page closes. */
export const storagePersists = (): boolean => !storageFallback && safeLocal.persistent;

// ---- small JSON record for the install/offline UI ---------------------------------

export interface PwaPrefs {
  promoSnoozedUntil?: number;
  fsTipShownAt?: number;
  offlineToastShown?: boolean;
}

const PREFS_KEY = 'cobalt-hub.pwa.v1';

export function pwaPrefs(): PwaPrefs {
  try {
    const v = JSON.parse(safeLocal.get(PREFS_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as PwaPrefs) : {};
  } catch {
    return {};
  }
}

export function updatePwaPrefs(patch: PwaPrefs): void {
  safeLocal.set(PREFS_KEY, JSON.stringify({ ...pwaPrefs(), ...patch }));
}
