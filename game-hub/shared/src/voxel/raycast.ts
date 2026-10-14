/**
 * Voxel ray traversal (Amanatides & Woo). Returns the first non-air,
 * non-liquid block hit and the face normal (used to place against it).
 */
import { IS_LIQUID } from './blocks';
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
    if (b !== 0 && !IS_LIQUID[b]) return { x, y, z, nx, ny, nz, block: b, distance: t };
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
