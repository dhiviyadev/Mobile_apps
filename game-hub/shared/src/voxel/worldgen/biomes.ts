/**
 * Biomes of the v2 generator: ids, display names, tags and fog, the climate
 * table, terrain shape parameters, and the plant and tree tables.
 * Names are original (design-voxel-world §6.2).
 */
import { Block } from '../blocks';

/**
 * Biome ids (sent nowhere, but used by mob spawn tables and banners). 0..6 are
 * produced by the v1 generator; 7..17 only by v2. Never renumber.
 */
export enum Biome {
  Plains = 0, // "Grasslands"
  Forest = 1, // "Oakwood"
  Desert = 2, // "Dunes"
  Snow = 3, // "Tundra"
  Beach = 4, // "Shore"
  Mountains = 5, // "Highlands"
  Ocean = 6,
  AspenGrove = 7,
  Duskwood = 8,
  Pinewood = 9,
  Frostpine = 10,
  Savanna = 11,
  Redrock = 12,
  Marshland = 13,
  Rainforest = 14,
  GlacierPeaks = 15,
  IcySea = 16,
  FrozenShore = 17,
}
export const BIOME_COUNT = 18;

export type BiomeTag = 'temperate' | 'cold' | 'hot' | 'wet' | 'dry' | 'snow' | 'forest' | 'open' | 'water' | 'coast' | 'mountain' | 'dark';

export interface BiomeInfo {
  name: string;
  tags: readonly BiomeTag[];
  /** Fog tint mixed into the horizon colour (0 = none). */
  fogTint: number;
}

const info = (name: string, tags: BiomeTag[], fogTint = 0): BiomeInfo => ({ name, tags, fogTint });

export const BIOME_INFO: readonly BiomeInfo[] = [
  info('Grasslands', ['temperate', 'open']),
  info('Oakwood', ['temperate', 'forest']),
  info('Dunes', ['hot', 'dry', 'open'], 0xf2d9a0),
  info('Tundra', ['cold', 'snow', 'open'], 0xe8f2ff),
  info('Shore', ['temperate', 'open', 'coast']),
  info('Highlands', ['temperate', 'mountain', 'open']),
  info('Ocean', ['water']),
  info('Aspen Grove', ['temperate', 'forest']),
  info('Duskwood', ['temperate', 'forest', 'dark'], 0x8c8aa8),
  info('Pinewood', ['cold', 'forest']),
  info('Frostpine', ['cold', 'snow', 'forest'], 0xe8f2ff),
  info('Thorn Savanna', ['hot', 'dry', 'open'], 0xe8d8a8),
  info('Redrock Canyons', ['hot', 'dry', 'open'], 0xe8a878),
  info('Marshland', ['wet', 'temperate'], 0x9fb58a),
  info('Rainforest', ['hot', 'wet', 'forest'], 0xa8d8a0),
  info('Glacier Peaks', ['cold', 'snow', 'mountain'], 0xe8f2ff),
  info('Icy Sea', ['water', 'cold'], 0xe8f2ff),
  info('Frozen Shore', ['cold', 'snow', 'coast'], 0xe8f2ff),
];

const B = Biome;
/** Land biome by temperature class (rows) and humidity class (columns): [main, alternate]. */
export const CLIMATE_TABLE: readonly (readonly (readonly [Biome, Biome])[])[] = [
  [[B.Snow, B.Snow], [B.Snow, B.Frostpine], [B.Frostpine, B.Snow], [B.Frostpine, B.Frostpine], [B.Frostpine, B.Frostpine]],
  [[B.Plains, B.Pinewood], [B.Pinewood, B.Plains], [B.Pinewood, B.AspenGrove], [B.Pinewood, B.Pinewood], [B.Pinewood, B.Duskwood]],
  [[B.Plains, B.Plains], [B.Plains, B.Forest], [B.Forest, B.AspenGrove], [B.AspenGrove, B.Forest], [B.Duskwood, B.Marshland]],
  [[B.Savanna, B.Desert], [B.Savanna, B.Plains], [B.Forest, B.Plains], [B.Marshland, B.Rainforest], [B.Rainforest, B.Marshland]],
  [[B.Desert, B.Redrock], [B.Desert, B.Redrock], [B.Desert, B.Savanna], [B.Savanna, B.Rainforest], [B.Rainforest, B.Rainforest]],
];

export const tClass = (t: number): number => (t < -0.36 ? 0 : t < -0.14 ? 1 : t < 0.14 ? 2 : t < 0.32 ? 3 : 4);
export const hClass = (h: number): number => (h < -0.3 ? 0 : h < -0.1 ? 1 : h < 0.1 ? 2 : h < 0.3 ? 3 : 4);

/** Terrain shape of a land biome: [offset, hillAmp, flatten, terrace, dune]. */
export const SHAPE_PARAMS: Readonly<Partial<Record<Biome, readonly [number, number, number, number, number]>>> = {
  [B.Plains]: [0, 3, 0, 0, 0],
  [B.Snow]: [0, 3, 0, 0, 0],
  [B.Forest]: [1, 5, 0, 0, 0],
  [B.AspenGrove]: [1, 5, 0, 0, 0],
  [B.Duskwood]: [2, 6, 0, 0, 0],
  [B.Pinewood]: [2, 6, 0, 0, 0],
  [B.Frostpine]: [2, 6, 0, 0, 0],
  [B.Savanna]: [2, 4, 0, 0, 0],
  [B.Desert]: [1, 3, 0, 0, 1],
  [B.Redrock]: [8, 9, 0, 1, 0],
  [B.Marshland]: [-1, 2, 0.85, 0, 0],
  [B.Rainforest]: [3, 8, 0, 0, 0],
};
export const SHAPE_PARAM_COUNT = 5;

/** Ground cover per biome: [block, probability] picked by one hash per column. */
export const PLANT_TABLE: Readonly<Partial<Record<Biome, readonly (readonly [Block, number])[]>>> = {
  [B.Plains]: [[Block.TallGrass, 0.2], [Block.Sunpetal, 0.015], [Block.Rosette, 0.012], [Block.Bluebell, 0.008], [Block.Pumpkin, 0.0015]],
  [B.Forest]: [[Block.TallGrass, 0.12], [Block.Fern, 0.03], [Block.Rosette, 0.01], [Block.Sunpetal, 0.006], [Block.BrownMushroom, 0.006], [Block.RedMushroom, 0.004], [Block.Pumpkin, 0.001]],
  [B.AspenGrove]: [[Block.TallGrass, 0.12], [Block.Bluebell, 0.025], [Block.Sunpetal, 0.02], [Block.Fern, 0.01]],
  [B.Duskwood]: [[Block.Fern, 0.08], [Block.TallGrass, 0.04], [Block.BrownMushroom, 0.03], [Block.RedMushroom, 0.02], [Block.Duskcap, 0.012]],
  [B.Pinewood]: [[Block.Fern, 0.08], [Block.TallGrass, 0.05], [Block.BrownMushroom, 0.005]],
  [B.Frostpine]: [[Block.Fern, 0.03], [Block.Frostbloom, 0.006]],
  [B.Snow]: [[Block.TallGrass, 0.01], [Block.Frostbloom, 0.008]],
  [B.Savanna]: [[Block.DryGrass, 0.22], [Block.TallGrass, 0.05], [Block.DeadBush, 0.006]],
  [B.Desert]: [[Block.DeadBush, 0.008], [Block.Cactus, 0.006]],
  [B.Redrock]: [[Block.DeadBush, 0.01], [Block.Cactus, 0.002]],
  [B.Marshland]: [[Block.Reeds, 0.12], [Block.TallGrass, 0.1], [Block.BrownMushroom, 0.01], [Block.Rosette, 0.005]],
  [B.Rainforest]: [[Block.TallGrass, 0.15], [Block.Fern, 0.12], [Block.Reeds, 0.1], [Block.Melon, 0.004]],
  [B.Mountains]: [[Block.TallGrass, 0.05]],
  [B.Beach]: [[Block.Reeds, 0.05]],
};

export enum TreeSpecies {
  Oak,
  SwampOak,
  Aspen,
  Pine,
  SnowyPine,
  Thornwood,
  Duskwood,
  GiantDuskwood,
  Mahogany,
  GiantMahogany,
  JungleBush,
}

/** Tree density per biome and how species are picked from one hash (0..1). */
export const TREE_TABLE: Readonly<Partial<Record<Biome, { density: number; pick(r: number): TreeSpecies }>>> = {
  [B.Plains]: { density: 0.06, pick: () => TreeSpecies.Oak },
  [B.Forest]: { density: 0.55, pick: (r) => (r < 0.85 ? TreeSpecies.Oak : TreeSpecies.Aspen) },
  [B.AspenGrove]: { density: 0.5, pick: (r) => (r < 0.9 ? TreeSpecies.Aspen : TreeSpecies.Oak) },
  [B.Duskwood]: { density: 0.85, pick: (r) => (r < 0.9 * 0.35 ? TreeSpecies.GiantDuskwood : r < 0.9 ? TreeSpecies.Duskwood : TreeSpecies.Oak) },
  [B.Pinewood]: { density: 0.5, pick: () => TreeSpecies.Pine },
  [B.Frostpine]: { density: 0.4, pick: () => TreeSpecies.SnowyPine },
  [B.Snow]: { density: 0.03, pick: () => TreeSpecies.SnowyPine },
  [B.Savanna]: { density: 0.08, pick: () => TreeSpecies.Thornwood },
  [B.Rainforest]: { density: 0.8, pick: (r) => (r < 0.6 * 0.2 ? TreeSpecies.GiantMahogany : r < 0.6 ? TreeSpecies.Mahogany : TreeSpecies.JungleBush) },
  [B.Marshland]: { density: 0.25, pick: () => TreeSpecies.SwampOak },
  [B.Mountains]: { density: 0.04, pick: () => TreeSpecies.Pine },
};
