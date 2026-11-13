/**
 * Rare boss structures: the contract between the world area (placement and
 * templates, structures/*.ts) and its consumers (mobs: bosses and guards;
 * survival: chests). Coordinates are world blocks.
 */
import { Block } from '../blocks';
import type { LootTableId } from '../loot';
import type { BlockQuery } from '../physics';
import type { Biome } from '../worldgen';

export enum StructureType {
  SunscorchTemple = 1,
  FrostCitadel = 2,
  OvergrownShrine = 3,
  AshenCrypt = 4,
  // ---- Gloamreach (package D: 9..12; 5..8 belong to package S) ----
  /** A fallen Lattice Ring in the overworld: whole but unlit, or missing stones. */
  FallenLattice = 9,
  /** A lit Lattice Ring in the Gloamreach: the way home. */
  TwilitLattice = 10,
  /** The Eclipse Orrery and its Colossus. */
  EclipseOrrery = 11,
}

export const STRUCTURE_NAMES: Partial<Record<StructureType, string>> = {
  [StructureType.SunscorchTemple]: 'Sunscorch Temple',
  [StructureType.FrostCitadel]: 'Frost Citadel',
  [StructureType.OvergrownShrine]: 'Overgrown Shrine',
  [StructureType.AshenCrypt]: 'Ashen Crypt',
  [StructureType.FallenLattice]: 'Fallen Lattice',
  [StructureType.TwilitLattice]: 'Twilit Lattice',
  [StructureType.EclipseOrrery]: 'Eclipse Orrery',
};

export interface Vec3i {
  x: number;
  y: number;
  z: number;
}

/** Integer box, min inclusive, max exclusive. */
export interface Box3i {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface StructureChest extends Vec3i {
  /** 0 = the boss chest. */
  index: number;
  loot: LootTableId;
  /** hash4(seed, structure.id, index, 0x100c): rollLoot seed. */
  lootSeed: number;
  /** Boss chest: opens only once the altar is dormant (survival enforces). */
  sealed: boolean;
}

export interface StructureInfo {
  /** ((regionX & 0xff) << 8) | (regionZ & 0xff): stable per world. */
  id: number;
  type: StructureType;
  name: string;
  /** Biome at the anchor column. */
  biome: Biome;
  anchor: { x: number; z: number };
  /** Union of all pieces. */
  bounds: Box3i;
  /** Cell just outside the main door / gate / tunnel. */
  entrance: Vec3i;
  /** Boss room interior (all air at generation). */
  arena: Box3i;
  /** Boss feet position (block centred, on the arena floor). */
  bossSpawn: { x: number; y: number; z: number };
  /** Cell holding Block.BossAltar (active) or Block.BossAltarDormant (defeated). */
  altar: Vec3i;
  /** Openings into the arena. */
  doorways: Box3i[];
  chests: StructureChest[];
  /** Minor-mob spawn points (feet positions). */
  guardSpawns: { x: number; y: number; z: number }[];
}

/** A defeated boss is recorded only by its altar block (an ordinary, saved edit). */
export function isBossDefeated(get: BlockQuery, s: StructureInfo): boolean {
  return get(s.altar.x, s.altar.y, s.altar.z) === Block.BossAltarDormant;
}
