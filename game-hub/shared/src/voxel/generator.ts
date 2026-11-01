/** Picks the right world generator for a voxel room mode and generator version. */
import type { VoxelMode } from '../constants';
import { SEA_LEVEL } from './constants';
import { generateParkourChunk, generateParkourCourse, type ParkourCourse } from './parkour';
import type { StructureInfo } from './structures/types';
import { Biome, TerrainGenerator } from './worldgen';

/**
 * Terrain generator version, stored with every saved world (CVW2 header, offline
 * save `gen`). 1 = the original generator, frozen byte-for-byte; 2 = biomes,
 * ores and structures (world area). Worlds without a version are 1.
 */
export type GenVersion = 1 | 2;
/**
 * Version new worlds get. WP0 keeps 1 (v2 does not exist yet); WP-A flips it to
 * 2 in the same change that adds TerrainGeneratorV2.
 */
export const LATEST_GEN_VERSION: GenVersion = 1;

export function isGenVersion(v: unknown): v is GenVersion {
  return v === 1 || v === 2;
}

export interface WorldGenerator {
  readonly mode: VoxelMode;
  /** Terrain version (parkour: LATEST, unused). */
  readonly genVersion: GenVersion;
  generateChunk(cx: number, cz: number, out?: Uint8Array): Uint8Array;
  /** Memoized. */
  findSpawn(): { x: number; y: number; z: number };
  /** Only set in parkour mode. */
  readonly course: ParkourCourse | null;
  /** Generated biome of a column (parkour: Ocean). */
  biomeAt(x: number, z: number): Biome;
  /** Generated top solid y of a column (parkour: SEA_LEVEL - 8). */
  surfaceHeight(x: number, z: number): number;
  /** Every boss structure of the world (v1 and parkour: none). */
  structures(): readonly StructureInfo[];
  /** Structures whose bounds come within `radius` (horizontal) of (x, z). */
  structuresNear(x: number, z: number, radius: number): StructureInfo[];
  /** The structure whose bounds contain the cell, or null. */
  structureAt(x: number, y: number, z: number): StructureInfo | null;
}

const NO_STRUCTURES: readonly StructureInfo[] = [];

export function createWorldGenerator(seed: number, mode: VoxelMode, genVersion: GenVersion = LATEST_GEN_VERSION): WorldGenerator {
  if (mode === 'parkour') {
    const course = generateParkourCourse(seed);
    return {
      mode,
      genVersion: LATEST_GEN_VERSION,
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
  // Sandbox and survival. WP-A: genVersion 2 -> TerrainGeneratorV2 (with structures).
  const terrain = new TerrainGenerator(seed);
  let spawn: { x: number; y: number; z: number } | null = null;
  return {
    mode,
    genVersion,
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
