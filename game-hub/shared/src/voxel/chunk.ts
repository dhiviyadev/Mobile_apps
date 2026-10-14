/** Chunk coordinate helpers. Block index layout: x fastest, then z, then y. */
import { CHUNK_HEIGHT, CHUNK_SIZE, WORLD_RADIUS_CHUNKS } from './constants';

export const blockIndex = (x: number, y: number, z: number): number => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

export const toChunkCoord = (v: number): number => Math.floor(v / CHUNK_SIZE);

/** Local coordinate (0..15) inside a chunk for a world coordinate. */
export const toLocal = (v: number): number => ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

export function chunkInWorld(cx: number, cz: number): boolean {
  return cx >= -WORLD_RADIUS_CHUNKS && cx < WORLD_RADIUS_CHUNKS && cz >= -WORLD_RADIUS_CHUNKS && cz < WORLD_RADIUS_CHUNKS;
}

export function blockInWorld(x: number, y: number, z: number): boolean {
  return y >= 0 && y < CHUNK_HEIGHT && chunkInWorld(toChunkCoord(x), toChunkCoord(z));
}

/**
 * Packs integer world coordinates into one number (used as a Map key for edits).
 * Range: x,z in [-32768, 32767], y in [0, 255].
 */
export function packPos(x: number, y: number, z: number): number {
  return ((x + 32768) * 65536 + (z + 32768)) * 256 + y;
}

export function unpackPos(key: number): [number, number, number] {
  const y = key % 256;
  const rest = (key - y) / 256;
  const z = (rest % 65536) - 32768;
  const x = Math.floor(rest / 65536) - 32768;
  return [x, y, z];
}
