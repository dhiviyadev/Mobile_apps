/**
 * Chunk coordinate helpers. Block index layout: x fastest, then z, then y.
 *
 * A chunk's block array holds only its lower layers, in whole sections
 * (SECTION_HEIGHT): layers 0..chunkLayers(blocks)-1, with everything above
 * reading as air. Because y is the slowest axis, a shorter array is exactly a
 * prefix of the full-height one. Generated chunks are TERRAIN_HEIGHT tall;
 * building higher grows the array (ensureLayers).
 */
import { CHUNK_HEIGHT, CHUNK_LAYER, CHUNK_SIZE, SECTION_HEIGHT, WORLD_RADIUS_CHUNKS } from './constants';

export const blockIndex = (x: number, y: number, z: number): number => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;

/** Layers a chunk array holds (a multiple of SECTION_HEIGHT); higher cells are air. */
export const chunkLayers = (blocks: Uint8Array): number => (blocks.length / CHUNK_LAYER) | 0;

/** Block at chunk-local coordinates (y >= 0); air above the stored layers. */
export const chunkBlock = (blocks: Uint8Array, x: number, y: number, z: number): number => {
  const i = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
  return i < blocks.length ? blocks[i] : 0;
};

/**
 * A chunk array that holds layer `y` (0..CHUNK_HEIGHT-1): `blocks` itself when
 * it already does, else a copy grown to the section containing y (new cells air).
 * Callers keep the returned array in place of the old one.
 */
export function ensureLayers(blocks: Uint8Array, y: number): Uint8Array {
  if ((y + 1) * CHUNK_LAYER <= blocks.length) return blocks;
  const layers = Math.min(CHUNK_HEIGHT, Math.ceil((y + 1) / SECTION_HEIGHT) * SECTION_HEIGHT);
  const grown = new Uint8Array(layers * CHUNK_LAYER);
  grown.set(blocks);
  return grown;
}

/**
 * Highest non-air layer + 1 of a box laid out like chunks (`layer` cells per
 * layer), scanning down from the top 4 bytes at a time; 0 when all air. Cost
 * follows the empty space above the content, so tall empty arrays stay cheap.
 */
export function topOfContent(blocks: Uint8Array, layer: number, layers = Math.floor(blocks.length / layer)): number {
  const aligned = (blocks.byteOffset & 3) === 0 && (layer & 3) === 0;
  const words = aligned ? new Uint32Array(blocks.buffer, blocks.byteOffset, (layers * layer) >> 2) : null;
  for (let y = layers - 1; y >= 0; y--) {
    if (words) {
      for (let i = (y * layer) >> 2, end = ((y + 1) * layer) >> 2; i < end; i++) if (words[i] !== 0) return y + 1;
    } else {
      for (let i = y * layer, end = i + layer; i < end; i++) if (blocks[i] !== 0) return y + 1;
    }
  }
  return 0;
}

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

export const toChunkCoord = (v: number): number => Math.floor(v / CHUNK_SIZE);

/** Local coordinate (0..15) inside a chunk for a world coordinate. */
export const toLocal = (v: number): number => ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

/**
 * Chunk inside the world. `radius` is the world's size in chunks (WorldGenerator.radiusChunks:
 * WORLD_RADIUS_CHUNKS for generators 1-2 and parkour, ENDLESS_RADIUS_CHUNKS for generator 3).
 */
export function chunkInWorld(cx: number, cz: number, radius = WORLD_RADIUS_CHUNKS): boolean {
  return cx >= -radius && cx < radius && cz >= -radius && cz < radius;
}

export function blockInWorld(x: number, y: number, z: number, radius = WORLD_RADIUS_CHUNKS): boolean {
  return y >= 0 && y < CHUNK_HEIGHT && chunkInWorld(toChunkCoord(x), toChunkCoord(z), radius);
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
