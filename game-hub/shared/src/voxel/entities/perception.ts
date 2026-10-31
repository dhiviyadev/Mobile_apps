/**
 * What creatures can see and where projectiles stop (design-voxel-mobs §4.6):
 * line of sight, segment-vs-block tests with real block shapes, open sky and
 * spawn light.
 */
import { IS_SOLID, IS_TRANSPARENT, SHAPE_BOUNDS } from '../blocks';
import { approxLight, LIGHT_OPAQUE } from '../light';
import type { BlockQuery } from '../physics';

/** Segment p0 + t (p1 - p0) against an axis-aligned box: entry t in [0, 1], or -1. */
export function segmentBox(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number,
): number {
  let tmin = 0;
  let tmax = 1;
  const d = [x1 - x0, y1 - y0, z1 - z0];
  const o = [x0, y0, z0];
  const lo = [bx0, by0, bz0];
  const hi = [bx1, by1, bz1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
      continue;
    }
    let t0 = (lo[a] - o[a]) / d[a];
    let t1 = (hi[a] - o[a]) / d[a];
    if (t0 > t1) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Result of segmentHitSolid: t along the segment (0..1) and the cell hit. */
export interface SolidHit {
  t: number;
  x: number;
  y: number;
  z: number;
  block: number;
}

/**
 * First solid block (by its shape box) the segment hits, or null. DDA over the
 * cells; plants, torches and other non-solid blocks are passed through.
 */
export function segmentHitSolid(get: BlockQuery, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidHit | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  let x = Math.floor(x0);
  let y = Math.floor(y0);
  let z = Math.floor(z0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const ez = Math.floor(z1);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? x + 1 - x0 : x0 - x) * tdx : Infinity;
  let tmy = dy !== 0 ? (dy > 0 ? y + 1 - y0 : y0 - y) * tdy : Infinity;
  let tmz = dz !== 0 ? (dz > 0 ? z + 1 - z0 : z0 - z) * tdz : Infinity;
  for (let guard = 0; guard < 256; guard++) {
    const b = get(x, y, z);
    if (IS_SOLID[b]) {
      const o = b * 6;
      const t = segmentBox(x0, y0, z0, x1, y1, z1, x + SHAPE_BOUNDS[o], y + SHAPE_BOUNDS[o + 1], z + SHAPE_BOUNDS[o + 2], x + SHAPE_BOUNDS[o + 3], y + SHAPE_BOUNDS[o + 4], z + SHAPE_BOUNDS[o + 5]);
      if (t >= 0) return { t, x, y, z, block: b };
    }
    if (x === ex && y === ey && z === ez) return null;
    if (tmx < tmy && tmx < tmz) {
      if (tmx > 1) return null;
      x += sx;
      tmx += tdx;
    } else if (tmy < tmz) {
      if (tmy > 1) return null;
      y += sy;
      tmy += tdy;
    } else {
      if (tmz > 1) return null;
      z += sz;
      tmz += tdz;
    }
  }
  return null;
}

/**
 * Line of sight between two points. 'see': blocked by opaque cells (creatures
 * see through glass and leaves). 'shoot': blocked by solid block shapes.
 */
export function lineOfSight(get: BlockQuery, ax: number, ay: number, az: number, bx: number, by: number, bz: number, mode: 'see' | 'shoot'): boolean {
  if (mode === 'shoot') return segmentHitSolid(get, ax, ay, az, bx, by, bz) === null;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(len / 0.4);
  let lx = NaN;
  let ly = NaN;
  let lz = NaN;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + dx * t);
    const y = Math.floor(ay + dy * t);
    const z = Math.floor(az + dz * t);
    if (x === lx && y === ly && z === lz) continue;
    lx = x;
    ly = y;
    lz = z;
    const b = get(x, y, z);
    if (!IS_TRANSPARENT[b] && b !== 0) return false;
  }
  return true;
}

/** No light-opaque block above the cell in its column (leaves are not light-opaque, so forests count as open). */
export function openSky(get: BlockQuery, x: number, y: number, z: number): boolean {
  for (let yy = y + 1; yy < 64; yy++) if (LIGHT_OPAQUE[get(x, yy, z)]) return false;
  return true;
}

/** Light a hostile spawn check sees at a cell (sky = the current sky level). */
export function spawnLight(get: BlockQuery, x: number, y: number, z: number, skyLevel: number): number {
  return approxLight(get, x, y, z, skyLevel);
}
