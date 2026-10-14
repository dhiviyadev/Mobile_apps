/**
 * Axis-aligned box geometry for arena maps: ray casts, player collision.
 * Maps are small (a few hundred boxes), so a uniform XZ grid keeps queries cheap.
 */

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface RayHit {
  t: number;
  /** Face normal axis/sign. */
  nx: number;
  ny: number;
  nz: number;
  index: number;
}

/** Slab test. Returns entry distance or -1. Rays starting inside a box hit at t = 0. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box, maxT: number, out?: { nx: number; ny: number; nz: number }): number {
  let tmin = 0;
  let tmax = maxT;
  let nAxis = -1;
  let nSign = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [b.minX, b.minY, b.minZ];
  const hi = [b.maxX, b.maxY, b.maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (lo[a] - o[a]) * inv;
    let t2 = (hi[a] - o[a]) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nAxis = a;
      nSign = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (out) {
    out.nx = nAxis === 0 ? nSign : 0;
    out.ny = nAxis === 1 ? nSign : 0;
    out.nz = nAxis === 2 ? nSign : 0;
  }
  return tmin;
}

const CELL = 4;

/** Static collision world built from a map's boxes. */
export class BoxWorld {
  private readonly grid = new Map<number, number[]>();
  private readonly cellKey = (cx: number, cz: number) => (cx + 512) * 1024 + (cz + 512);
  private stamp = 0;
  private readonly marks: Uint32Array;

  constructor(readonly boxes: readonly Box[]) {
    this.marks = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
        for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
          const k = this.cellKey(cx, cz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(i);
        }
      }
    });
  }

  /** Calls fn for every box whose XZ cells overlap the given XZ rectangle (each box once). */
  private forEachNear(minX: number, minZ: number, maxX: number, maxZ: number, fn: (i: number) => boolean | void): void {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.marks.fill(0);
      this.stamp = 1;
    }
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const list = this.grid.get(this.cellKey(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (this.marks[i] === this.stamp) continue;
          this.marks[i] = this.stamp;
          if (fn(i) === true) return;
        }
      }
    }
  }

  /** First box hit by the ray within maxT, or null. Walks the grid along the ray. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
    let best: RayHit | null = null;
    const n = { nx: 0, ny: 0, nz: 0 };
    // Step through the ray in cell-sized segments so long rays don't scan the whole map at once.
    const len = maxT;
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let s = 0; s < steps; s++) {
      const t0 = (s / steps) * len;
      const t1 = ((s + 1) / steps) * len;
      const ax = ox + dx * t0, az = oz + dz * t0;
      const bx = ox + dx * t1, bz = oz + dz * t1;
      this.forEachNear(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (i) => {
        const t = rayBox(ox, oy, oz, dx, dy, dz, this.boxes[i], best ? best.t : maxT, n);
        if (t >= 0 && (!best || t < best.t)) best = { t, nx: n.nx, ny: n.ny, nz: n.nz, index: i };
      });
      if (best && (best as RayHit).t <= t1) break;
    }
    return best;
  }

  /** True if an axis-aligned box overlaps any world box. */
  overlaps(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    let hit = false;
    this.forEachNear(minX, minZ, maxX, maxZ, (i) => {
      const b = this.boxes[i];
      if (minX < b.maxX && maxX > b.minX && minY < b.maxY && maxY > b.minY && minZ < b.maxZ && maxZ > b.minZ) {
        hit = true;
        return true;
      }
      return false;
    });
    return hit;
  }

  /** Highest box top under the XZ rectangle between y0 and y1 (for step-up / ground snap), or -Infinity. */
  highestTop(minX: number, minZ: number, maxX: number, maxZ: number, y0: number, y1: number): number {
    let top = -Infinity;
    this.forEachNear(minX, minZ, maxX, maxZ, (i) => {
      const b = this.boxes[i];
      if (minX < b.maxX && maxX > b.minX && minZ < b.maxZ && maxZ > b.minZ && b.maxY >= y0 && b.maxY <= y1 && b.maxY > top) top = b.maxY;
    });
    return top;
  }

  /** Line of sight between two points (no box in between). */
  visible(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d) === null;
  }
}
