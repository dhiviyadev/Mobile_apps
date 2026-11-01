/**
 * Lag tolerance for player hit tests (design-voxel-survival §19.2): a short
 * position history per player (8 samples at 20 Hz), ray-box tests and a
 * solid-only block ray for occlusion (plants and torches never block a hit).
 */
import { IS_SOLID, SHAPE_BOUNDS } from '../blocks';
import type { BlockQuery } from '../physics';

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function boxAt(x: number, y: number, z: number, half: number, height: number, pad = 0): Aabb {
  return { minX: x - half - pad, minY: y - pad, minZ: z - half - pad, maxX: x + half + pad, maxY: y + height + pad, maxZ: z + half + pad };
}

/** Entry distance of a ray (unit direction) into a box, or Infinity. Origin inside = 0. */
export function rayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Aabb): number {
  let t0 = 0;
  let t1 = Infinity;
  const axes: [number, number, number, number][] = [
    [ox, dx, b.minX, b.maxX],
    [oy, dy, b.minY, b.maxY],
    [oz, dz, b.minZ, b.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let a = (lo - o) / d;
    let c = (hi - o) / d;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Distance along the ray to the first solid block shape (IS_SOLID, SHAPE_BOUNDS), or Infinity within maxDist. */
export function solidRayDistance(get: BlockQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
  let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
  let tmz = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
  let t = 0;
  while (t <= maxDist) {
    const b = get(x, y, z);
    if (IS_SOLID[b]) {
      const i = b * 6;
      const hit = rayAabb(ox, oy, oz, dx, dy, dz, {
        minX: x + SHAPE_BOUNDS[i], minY: y + SHAPE_BOUNDS[i + 1], minZ: z + SHAPE_BOUNDS[i + 2],
        maxX: x + SHAPE_BOUNDS[i + 3], maxY: y + SHAPE_BOUNDS[i + 4], maxZ: z + SHAPE_BOUNDS[i + 5],
      });
      if (hit <= maxDist) return hit;
    }
    if (tmx < tmy && tmx < tmz) {
      x += sx;
      t = tmx;
      tmx += tdx;
    } else if (tmy < tmz) {
      y += sy;
      t = tmy;
      tmy += tdy;
    } else {
      z += sz;
      t = tmz;
      tmz += tdz;
    }
  }
  return Infinity;
}

const HISTORY = 8;

/** Feet positions of one player at the last 8 sim ticks (ring buffer). */
export class PlayerHistory {
  private readonly t = new Float64Array(HISTORY).fill(-Infinity);
  private readonly p = new Float32Array(HISTORY * 3);
  private head = 0;

  record(now: number, x: number, y: number, z: number): void {
    this.head = (this.head + 1) % HISTORY;
    this.t[this.head] = now;
    this.p[this.head * 3] = x;
    this.p[this.head * 3 + 1] = y;
    this.p[this.head * 3 + 2] = z;
  }

  /** Calls fn with every recorded position younger than windowMs. */
  within(now: number, windowMs: number, fn: (x: number, y: number, z: number) => void): void {
    for (let i = 0; i < HISTORY; i++) {
      if (now - this.t[i] <= windowMs) fn(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
    }
  }

  clear(): void {
    this.t.fill(-Infinity);
  }
}
