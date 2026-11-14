/** Picks the right world generator for a voxel room mode and generator version. */
import type { VoxelMode } from '../constants';
import { CHUNK_SIZE, ENDLESS_RADIUS_CHUNKS, SEA_LEVEL, WORLD_RADIUS_CHUNKS } from './constants';
import { generateParkourChunk, generateParkourCourse, type ParkourCourse } from './parkour';
import type { StructureInfo } from './structures/types';
import { Biome, TerrainGeneratorV1, TerrainGeneratorV2, TerrainGeneratorV3, TerrainGeneratorV4 } from './worldgen';

/**
 * Terrain generator version, stored with every saved world (CVW2 header, offline
 * save `gen`). 1 = the original generator, frozen byte-for-byte; 2 = biomes,
 * ores and structures (world area), frozen too; 3 = endless, 3x larger biomes,
 * cave systems; 4 = generator 3's overworld plus the Veil Wall and the Gloamreach
 * (realm.ts). Worlds without a version are 1.
 */
export type GenVersion = 1 | 2 | 3 | 4;
/** Version new worlds get. */
export const LATEST_GEN_VERSION: GenVersion = 4;

export function isGenVersion(v: unknown): v is GenVersion {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

/** World size in chunks for a mode and generator version (see chunkInWorld). */
export function worldRadiusChunks(mode: VoxelMode, genVersion: GenVersion): number {
  return mode !== 'parkour' && genVersion >= 3 ? ENDLESS_RADIUS_CHUNKS : WORLD_RADIUS_CHUNKS;
}

export interface WorldGenerator {
  readonly mode: VoxelMode;
  /** Terrain version (parkour: LATEST, unused). */
  readonly genVersion: GenVersion;
  /** World size: chunks from -radiusChunks to radiusChunks - 1 on X and Z (pass to chunkInWorld / blockInWorld). */
  readonly radiusChunks: number;
  /** The same in blocks: playable x, z in [-limit, limit). */
  readonly limit: number;
  generateChunk(cx: number, cz: number, out?: Uint8Array): Uint8Array;
  /** Memoized. */
  findSpawn(): { x: number; y: number; z: number };
  /** Only set in parkour mode. */
  readonly course: ParkourCourse | null;
  /** Generated biome of a column (parkour: Ocean). */
  biomeAt(x: number, z: number): Biome;
  /** Generated top solid y of a column (parkour: SEA_LEVEL - 8). */
  surfaceHeight(x: number, z: number): number;
  /**
   * Every boss structure of a bounded world (v1 and parkour: none). Endless
   * worlds (v3): only those around the origin; use structuresNear elsewhere.
   */
  structures(): readonly StructureInfo[];
  /** Structures whose bounds come within `radius` (horizontal) of (x, z). */
  structuresNear(x: number, z: number, radius: number): StructureInfo[];
  /** The structure whose bounds contain the cell, or null. */
  structureAt(x: number, y: number, z: number): StructureInfo | null;
}

const NO_STRUCTURES: readonly StructureInfo[] = [];
const bounds = (radiusChunks: number) => ({ radiusChunks, limit: radiusChunks * CHUNK_SIZE });

export function createWorldGenerator(seed: number, mode: VoxelMode, genVersion: GenVersion = LATEST_GEN_VERSION): WorldGenerator {
  if (mode === 'parkour') {
    const course = generateParkourCourse(seed);
    return {
      mode,
      genVersion: LATEST_GEN_VERSION,
      ...bounds(WORLD_RADIUS_CHUNKS),
      course,
      generateChunk: (cx, cz, out) => generateParkourChunk(course, cx, cz, out),
      findSpawn: () => ({ ...course.start }),
      biomeAt: () => Biome.Ocean,
      surfaceHeight: () => SEA_LEVEL - 8,
      structures: () => NO_STRUCTURES,
      structuresNear: () => [],
      structureAt: () => null,
    };
  }
  if (genVersion === 3 || genVersion === 4) {
    const v3 = genVersion === 4 ? new TerrainGeneratorV4(seed) : new TerrainGeneratorV3(seed);
    return {
      mode,
      genVersion,
      ...bounds(ENDLESS_RADIUS_CHUNKS),
      course: null,
      generateChunk: (cx, cz, out) => v3.generateChunk(cx, cz, out),
      findSpawn: () => v3.findSpawn(),
      biomeAt: (x, z) => v3.column(Math.floor(x), Math.floor(z)).biome,
      surfaceHeight: (x, z) => v3.column(Math.floor(x), Math.floor(z)).height,
      structures: () => v3.structures(),
      structuresNear: (x, z, radius) => v3.structuresNear(x, z, radius),
      structureAt: (x, y, z) => v3.structureAt(x, y, z),
    };
  }
  if (genVersion === 2) {
    const v2 = new TerrainGeneratorV2(seed);
    let list: readonly StructureInfo[] | null = null;
    const all = () => (list ??= v2.structures());
    return {
      mode,
      genVersion,
      ...bounds(WORLD_RADIUS_CHUNKS),
      course: null,
      generateChunk: (cx, cz, out) => v2.generateChunk(cx, cz, out),
      findSpawn: () => v2.findSpawn(),
      biomeAt: (x, z) => v2.column(Math.floor(x), Math.floor(z)).biome,
      surfaceHeight: (x, z) => v2.column(Math.floor(x), Math.floor(z)).height,
      structures: all,
      structuresNear: (x, z, radius) =>
        all().filter((s) => {
          const b = s.bounds;
          const dx = Math.max(b.x0 - x, 0, x - b.x1);
          const dz = Math.max(b.z0 - z, 0, z - b.z1);
          return dx * dx + dz * dz <= radius * radius;
        }),
      structureAt: (x, y, z) => {
        const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
        return all().find((s) => fx >= s.bounds.x0 && fx < s.bounds.x1 && fy >= s.bounds.y0 && fy < s.bounds.y1 && fz >= s.bounds.z0 && fz < s.bounds.z1) ?? null;
      },
    };
  }
  // Generator 1: frozen terrain, no structures.
  const terrain = new TerrainGeneratorV1(seed);
  let spawn: { x: number; y: number; z: number } | null = null;
  return {
    mode,
    genVersion,
    ...bounds(WORLD_RADIUS_CHUNKS),
    course: null,
    generateChunk: (cx, cz, out) => terrain.generateChunk(cx, cz, out),
    findSpawn: () => ({ ...(spawn ??= terrain.findSpawn()) }),
    biomeAt: (x, z) => terrain.column(Math.floor(x), Math.floor(z)).biome,
    surfaceHeight: (x, z) => terrain.column(Math.floor(x), Math.floor(z)).height,
    structures: () => NO_STRUCTURES,
    structuresNear: () => [],
    structureAt: () => null,
  };
}
