/**
 * Voxel ray traversal (Amanatides & Woo). Returns the first non-air,
 * non-liquid block hit and the face normal (used to place against it).
 * Non-cube blocks (slabs, plants, torches...) are hit only inside their shape
 * box, so blocks behind tall grass or above a slab stay easy to target.
 */
import { BlockShape, IS_LIQUID, SHAPE, SHAPE_BOUNDS } from './blocks';
import type { BlockQuery } from './physics';

export interface VoxelHit {
  x: number;
  y: number;
  z: number;
  /** Face normal of the hit face (one of the 6 axis directions). */
  nx: number;
  ny: number;
  nz: number;
  block: number;
  distance: number;
}

export function raycastVoxels(
  get: BlockQuery,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): VoxelHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  while (t <= maxDistance) {
    const b = get(x, y, z);
    if (b !== 0 && !IS_LIQUID[b]) {
      if (SHAPE[b] === BlockShape.Cube) return { x, y, z, nx, ny, nz, block: b, distance: t };
      const hit = rayBox(b, x, y, z, ox, oy, oz, dx, dy, dz, maxDistance);
      if (hit) return hit;
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}

/** Slab-method ray / box test against the shape bounds of block `b` in cell (x, y, z). */
function rayBox(b: number, x: number, y: number, z: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): VoxelHit | null {
  const o = b * 6;
  const lo = [x + SHAPE_BOUNDS[o], y + SHAPE_BOUNDS[o + 1], z + SHAPE_BOUNDS[o + 2]];
  const hi = [x + SHAPE_BOUNDS[o + 3], y + SHAPE_BOUNDS[o + 4], z + SHAPE_BOUNDS[o + 5]];
  const org = [ox, oy, oz];
  const dir = [dx, dy, dz];
  let tEnter = 0;
  let tExit = maxDistance;
  let axis = -1;
  for (let a = 0; a < 3; a++) {
    if (dir[a] === 0) {
      if (org[a] < lo[a] || org[a] > hi[a]) return null;
      continue;
    }
    let t0 = (lo[a] - org[a]) / dir[a];
    let t1 = (hi[a] - org[a]) / dir[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) {
      tEnter = t0;
      axis = a;
    }
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  const n = [0, 0, 0];
  if (axis >= 0) n[axis] = dir[axis] > 0 ? -1 : 1;
  return { x, y, z, nx: n[0], ny: n[1], nz: n[2], block: b, distance: tEnter };
}
