import { describe, expect, it } from 'vitest';
import { createSafeStorage, installStorageFallback, MemoryStorage } from '../src/platform/storage';

describe('safe storage', () => {
  it('falls back to memory when the storage getter throws', () => {
    const s = createSafeStorage(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(s.persistent).toBe(false);
    expect(s.set('a', '1')).toBe(true);
    expect(s.get('a')).toBe('1');
    s.remove('a');
    expect(s.get('a')).toBeNull();
  });

  it('falls back to memory when storage is null (DOM storage off in a WebView)', () => {
    const s = createSafeStorage(() => null);
    expect(s.persistent).toBe(false);
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
  });

  it('uses real storage when it works', () => {
    const store = new MemoryStorage();
    const s = createSafeStorage(() => store);
    expect(s.persistent).toBe(true);
    s.set('k', 'v');
    expect(store.getItem('k')).toBe('v');
    expect(s.get('k')).toBe('v');
    expect(store.getItem('__cobalt_probe__')).toBeNull();
  });

  it('reports a failed write when the quota is full but keeps reading real data', () => {
    const store = new MemoryStorage();
    store.setItem('save', 'world');
    store.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const s = createSafeStorage(() => store);
    expect(s.persistent).toBe(true);
    expect(s.get('save')).toBe('world');
    expect(s.set('k', 'v')).toBe(false);
  });

  it('installStorageFallback replaces only unusable storage', () => {
    const working = new MemoryStorage();
    const target: Record<string, unknown> = { sessionStorage: working };
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    installStorageFallback(target);
    const local = target.localStorage as Storage;
    local.setItem('cobalt-hub.settings.v1', '{}');
    expect(local.getItem('cobalt-hub.settings.v1')).toBe('{}');
    expect(target.sessionStorage).toBe(working);
  });
});
