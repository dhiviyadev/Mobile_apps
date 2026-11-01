/** What every structure template provides (temple.ts, citadel.ts, shrine.ts, crypt.ts). */
import type { LootTableId } from '../loot';
import type { Box3i, Vec3i } from './types';
import type { StructureVolume } from './volume';

export interface ChestSpec extends Vec3i {
  index: number;
  loot: LootTableId;
  sealed: boolean;
}

/** Where things are, from the anchor and floor alone (cheap: no blocks built). */
export interface Layout {
  bounds: Box3i;
  entrance: Vec3i;
  arena: Box3i;
  bossSpawn: { x: number; y: number; z: number };
  altar: Vec3i;
  doorways: Box3i[];
  chests: ChestSpec[];
  guardSpawns: { x: number; y: number; z: number }[];
}

export interface Built {
  volumes: StructureVolume[];
  /** Arena cells that are not air by design (pillars, lanterns, braziers, moss, altar, chests). */
  furniture: Vec3i[];
}

export interface Template {
  layout(ax: number, az: number, floor: number): Layout;
  build(ax: number, az: number, floor: number, rng: () => number): Built;
}

/** Box from inclusive local bounds of a piece at origin (ox, oy, oz). */
export const box = (ox: number, oy: number, oz: number, lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number): Box3i => ({
  x0: ox + lx0, y0: oy + ly0, z0: oz + lz0, x1: ox + lx1 + 1, y1: oy + ly1 + 1, z1: oz + lz1 + 1,
});
