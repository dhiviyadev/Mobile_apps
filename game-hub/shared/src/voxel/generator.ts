/** Picks the right world generator for a voxel room mode. */
import type { VoxelMode } from '../constants';
import { generateParkourChunk, generateParkourCourse, type ParkourCourse } from './parkour';
import { TerrainGenerator } from './worldgen';

export interface WorldGenerator {
  readonly mode: VoxelMode;
  generateChunk(cx: number, cz: number, out?: Uint8Array): Uint8Array;
  findSpawn(): { x: number; y: number; z: number };
  /** Only set in parkour mode. */
  readonly course: ParkourCourse | null;
}

export function createWorldGenerator(seed: number, mode: VoxelMode): WorldGenerator {
  if (mode === 'parkour') {
    const course = generateParkourCourse(seed);
    return {
      mode,
      course,
      generateChunk: (cx, cz, out) => generateParkourChunk(course, cx, cz, out),
      findSpawn: () => ({ ...course.start }),
    };
  }
  const terrain = new TerrainGenerator(seed);
  return {
    mode,
    course: null,
    generateChunk: (cx, cz, out) => terrain.generateChunk(cx, cz, out),
    findSpawn: () => terrain.findSpawn(),
  };
}
