/**
 * Block registry. Ids are bytes stored in chunk arrays and sent over the
 * network, so never renumber an existing block.
 *
 * Texture tiles reference the procedural atlas (8x8 tiles) generated on the client.
 */

export enum Block {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Water = 5,
  Log = 6,
  Leaves = 7,
  Planks = 8,
  Cobble = 9,
  Glass = 10,
  Brick = 11,
  Snow = 12,
  Lamp = 13,
  Bedrock = 14,
  Gravel = 15,
  Clay = 16,
  Checkpoint = 17,
  Finish = 18,
  Cloud = 19,
  SnowyGrass = 20,
  Ice = 21,
  /** Flowing water, level 1 (thinnest) to 7 (next to a source). Made by the fluid simulation only. */
  WaterFlow1 = 22,
  WaterFlow2 = 23,
  WaterFlow3 = 24,
  WaterFlow4 = 25,
  WaterFlow5 = 26,
  WaterFlow6 = 27,
  WaterFlow7 = 28,
  /** Water pouring down from the block above. Made by the fluid simulation only. */
  WaterFalling = 29,
}

export interface BlockDef {
  id: Block;
  name: string;
  /** Collides with players. */
  solid: boolean;
  /** Lets neighbours' faces show through (glass, leaves, water). */
  transparent: boolean;
  /** Rendered in the translucent pass (water). */
  liquid: boolean;
  /** Ignores day/night lighting. */
  emissive: boolean;
  /** Can players break it? */
  breakable: boolean;
  /** Seconds to break by hand. */
  hardness: number;
  /** Atlas tile index per face: [top, bottom, side]. Tile = row * 8 + col. */
  tiles: [number, number, number];
  /** Representative colour for particles and map icons. */
  color: number;
}

const def = (
  id: Block,
  name: string,
  tiles: [number, number, number],
  color: number,
  opts: Partial<Pick<BlockDef, 'solid' | 'transparent' | 'liquid' | 'emissive' | 'breakable' | 'hardness'>> = {},
): BlockDef => ({
  id,
  name,
  tiles,
  color,
  solid: opts.solid ?? true,
  transparent: opts.transparent ?? false,
  liquid: opts.liquid ?? false,
  emissive: opts.emissive ?? false,
  breakable: opts.breakable ?? true,
  hardness: opts.hardness ?? 0.35,
});

/** Atlas tile indices (row * 8 + col). Must match client/src/games/voxel/world/atlas.ts. */
export const Tile = {
  GrassTop: 0,
  GrassSide: 1,
  Dirt: 2,
  Stone: 3,
  Sand: 4,
  Water: 5,
  LogSide: 6,
  LogTop: 7,
  Leaves: 8,
  Planks: 9,
  Cobble: 10,
  Glass: 11,
  Brick: 12,
  Snow: 13,
  Lamp: 14,
  Bedrock: 15,
  Gravel: 16,
  Clay: 17,
  Checkpoint: 18,
  Finish: 19,
  Cloud: 20,
  SnowyGrassSide: 21,
  Ice: 22,
  Crack0: 56, // last row: 8 break stages
} as const;

const AIR = def(Block.Air, 'Air', [0, 0, 0], 0, { solid: false, transparent: true, breakable: false });

const WATER_OPTS = { solid: false, transparent: true, liquid: true, breakable: false };
const WATER_TILES: [number, number, number] = [Tile.Water, Tile.Water, Tile.Water];

const DEFS: BlockDef[] = [];
for (const d of [
  AIR,
  def(Block.Grass, 'Grass', [Tile.GrassTop, Tile.Dirt, Tile.GrassSide], 0x6abf4b, { hardness: 0.3 }),
  def(Block.Dirt, 'Dirt', [Tile.Dirt, Tile.Dirt, Tile.Dirt], 0x8a5a3b, { hardness: 0.25 }),
  def(Block.Stone, 'Stone', [Tile.Stone, Tile.Stone, Tile.Stone], 0x8c8f99, { hardness: 0.6 }),
  def(Block.Sand, 'Sand', [Tile.Sand, Tile.Sand, Tile.Sand], 0xe8d39a, { hardness: 0.2 }),
  def(Block.Water, 'Water', WATER_TILES, 0x3f8fd8, WATER_OPTS),
  def(Block.Log, 'Log', [Tile.LogTop, Tile.LogTop, Tile.LogSide], 0x8b6340, { hardness: 0.5 }),
  def(Block.Leaves, 'Leaves', [Tile.Leaves, Tile.Leaves, Tile.Leaves], 0x4f9a3a, { transparent: true, hardness: 0.1 }),
  def(Block.Planks, 'Planks', [Tile.Planks, Tile.Planks, Tile.Planks], 0xc49a5c, { hardness: 0.4 }),
  def(Block.Cobble, 'Cobblestone', [Tile.Cobble, Tile.Cobble, Tile.Cobble], 0x7d7f87, { hardness: 0.6 }),
  def(Block.Glass, 'Glass', [Tile.Glass, Tile.Glass, Tile.Glass], 0xbfe8ff, { transparent: true, hardness: 0.15 }),
  def(Block.Brick, 'Brick', [Tile.Brick, Tile.Brick, Tile.Brick], 0xb5523b, { hardness: 0.6 }),
  def(Block.Snow, 'Snow', [Tile.Snow, Tile.Snow, Tile.Snow], 0xf4f8ff, { hardness: 0.15 }),
  def(Block.Lamp, 'Lamp', [Tile.Lamp, Tile.Lamp, Tile.Lamp], 0xffd166, { emissive: true, hardness: 0.25 }),
  def(Block.Bedrock, 'Bedrock', [Tile.Bedrock, Tile.Bedrock, Tile.Bedrock], 0x33343a, { breakable: false }),
  def(Block.Gravel, 'Gravel', [Tile.Gravel, Tile.Gravel, Tile.Gravel], 0x8e8680, { hardness: 0.25 }),
  def(Block.Clay, 'Clay', [Tile.Clay, Tile.Clay, Tile.Clay], 0x5fa8c8, { hardness: 0.3 }),
  def(Block.Checkpoint, 'Checkpoint', [Tile.Checkpoint, Tile.Checkpoint, Tile.Checkpoint], 0x5fd17a, { emissive: true, breakable: false }),
  def(Block.Finish, 'Finish', [Tile.Finish, Tile.Finish, Tile.Finish], 0xffd166, { emissive: true, breakable: false }),
  def(Block.Cloud, 'Cloud', [Tile.Cloud, Tile.Cloud, Tile.Cloud], 0xffffff, { breakable: false }),
  def(Block.SnowyGrass, 'Snowy Grass', [Tile.Snow, Tile.Dirt, Tile.SnowyGrassSide], 0xe9f1ff, { hardness: 0.3 }),
  def(Block.Ice, 'Ice', [Tile.Ice, Tile.Ice, Tile.Ice], 0x9fd8ff, { transparent: true, hardness: 0.3 }),
  ...Array.from({ length: 7 }, (_, i) => def(Block.WaterFlow1 + i, 'Flowing Water', WATER_TILES, 0x3f8fd8, WATER_OPTS)),
  def(Block.WaterFalling, 'Falling Water', WATER_TILES, 0x3f8fd8, WATER_OPTS),
]) {
  DEFS[d.id] = d;
}

export const BLOCKS: readonly BlockDef[] = DEFS;
export const BLOCK_COUNT = DEFS.length;

export function blockDef(id: number): BlockDef {
  return DEFS[id] ?? AIR;
}

/** Fast lookup tables used in hot loops (meshing, physics). */
export const IS_SOLID = new Uint8Array(256);
export const IS_TRANSPARENT = new Uint8Array(256);
export const IS_LIQUID = new Uint8Array(256);
export const IS_EMISSIVE = new Uint8Array(256);
export const TILE_TOP = new Uint8Array(256);
export const TILE_BOTTOM = new Uint8Array(256);
export const TILE_SIDE = new Uint8Array(256);
IS_TRANSPARENT.fill(1);
for (const d of DEFS) {
  if (!d) continue;
  IS_SOLID[d.id] = d.solid ? 1 : 0;
  IS_TRANSPARENT[d.id] = d.transparent ? 1 : 0;
  IS_LIQUID[d.id] = d.liquid ? 1 : 0;
  IS_EMISSIVE[d.id] = d.emissive ? 1 : 0;
  TILE_TOP[d.id] = d.tiles[0];
  TILE_BOTTOM[d.id] = d.tiles[1];
  TILE_SIDE[d.id] = d.tiles[2];
}

/** Blocks available in the hotbar, in order. */
export const HOTBAR_BLOCKS: readonly Block[] = [
  Block.Grass,
  Block.Dirt,
  Block.Stone,
  Block.Cobble,
  Block.Planks,
  Block.Log,
  Block.Leaves,
  Block.Glass,
  Block.Brick,
  Block.Sand,
  Block.Water,
  Block.Lamp,
];

/** Blocks players may place (server validation). Flowing and falling water never are. */
export const PLACEABLE = new Set<number>([...HOTBAR_BLOCKS, Block.Snow, Block.Gravel, Block.Ice, Block.Clay]);

export function isPlaceable(id: number): boolean {
  return PLACEABLE.has(id);
}

// ---- water -------------------------------------------------------------------------

/** Any kind of water: the still source, flowing levels 1..7 or falling. */
export function isWater(id: number): boolean {
  return id === Block.Water || (id >= Block.WaterFlow1 && id <= Block.WaterFalling);
}

/** Water level for the fluid simulation: sources and falling water 8, flowing water 1..7, anything else 0. */
export function waterLevel(id: number): number {
  if (id === Block.Water || id === Block.WaterFalling) return 8;
  if (id >= Block.WaterFlow1 && id <= Block.WaterFlow7) return id - Block.WaterFlow1 + 1;
  return 0;
}

/** Flowing water block for a level (clamped to 1..7); level 0 or below is air. */
export function flowingWater(level: number): Block {
  if (level <= 0) return Block.Air;
  return Block.WaterFlow1 + Math.min(7, Math.floor(level)) - 1;
}

/**
 * Height of a block's liquid surface in block units (for meshing and swimming):
 * sources and falling water 0.875, flowing water level / 8 (level 7 lines up
 * with its source), anything else 1.
 */
export const LIQUID_HEIGHT = new Float32Array(256).fill(1);
LIQUID_HEIGHT[Block.Water] = 0.875;
LIQUID_HEIGHT[Block.WaterFalling] = 0.875;
for (let level = 1; level <= 7; level++) LIQUID_HEIGHT[flowingWater(level)] = level / 8;
