/**
 * Spatial hash of live mobs (4x4-block cells, rebuilt every tick with reused
 * arrays) and the u16 id allocator shared by mobs, projectiles and hazards.
 */
import type { Mob } from './types';

const CELL = 4;
const key = (cx: number, cz: number) => (cx + 256) * 512 + (cz + 256);

export class SpatialHash {
  private readonly cells = new Map<number, Mob[]>();
  private readonly pool: Mob[][] = [];

  clear(): void {
    for (const list of this.cells.values()) {
      list.length = 0;
      this.pool.push(list);
    }
    this.cells.clear();
  }

  insert(m: Mob): void {
    const k = key(Math.floor(m.x / CELL), Math.floor(m.z / CELL));
    let list = this.cells.get(k);
    if (!list) {
      list = this.pool.pop() ?? [];
      this.cells.set(k, list);
    }
    list.push(m);
  }

  /** Mobs whose cell lies within `radius` of (x, z) (callers filter by exact distance). */
  query(x: number, z: number, radius: number, out: Mob[] = []): Mob[] {
    out.length = 0;
    const c0x = Math.floor((x - radius) / CELL);
    const c1x = Math.floor((x + radius) / CELL);
    const c0z = Math.floor((z - radius) / CELL);
    const c1z = Math.floor((z + radius) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.cells.get(key(cx, cz));
        if (list) for (const m of list) out.push(m);
      }
    }
    return out;
  }
}

/** u16 ids (1..65535), skipping ids still in use. */
export class IdAllocator {
  private next = 1;
  private readonly used = new Set<number>();

  take(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.next;
      this.next = this.next >= 65535 ? 1 : this.next + 1;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    return 0;
  }

  release(id: number): void {
    this.used.delete(id);
  }

  get size(): number {
    return this.used.size;
  }
}
