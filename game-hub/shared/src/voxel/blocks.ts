/**
 * Block registry. Ids are bytes stored in chunk arrays, sent over the network
 * and kept in saved worlds, so never renumber an existing block: append only.
 * 0..29 original, 30..126 world upgrade, 127 survival (Bedroll). Next free: 128.
 *
 * Texture tiles reference the procedural atlas generated on the client
 * (client/src/games/voxel/world/atlas.ts). Tile = row * ATLAS_COLS + col.
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
  // ---- world upgrade (design-voxel-world §2.3) ------------------------------------
  RedSand = 30,
  Sandstone = 31,
  RedSandstone = 32,
  Granite = 33,
  Basalt = 34,
  Slate = 35,
  Marble = 36,
  Obsidian = 37,
  Mud = 38,
  ForestFloor = 39,
  ParchedGrass = 40,
  MossyCobble = 41,
  CoalOre = 42,
  CopperOre = 43,
  IronOre = 44,
  GoldOre = 45,
  CobaltOre = 46,
  EmberOre = 47,
  OchreClay = 48,
  RustClay = 49,
  CreamClay = 50,
  UmberClay = 51,
  PackedIce = 52,
  /** Still liquid, generated only (deep caves, crypt braziers). Never placeable, never flows. */
  Lava = 53,
  AspenLog = 54,
  AspenLeaves = 55,
  AspenPlanks = 56,
  PineLog = 57,
  PineLeaves = 58,
  PinePlanks = 59,
  MahoganyLog = 60,
  MahoganyLeaves = 61,
  MahoganyPlanks = 62,
  ThornwoodLog = 63,
  ThornwoodLeaves = 64,
  ThornwoodPlanks = 65,
  DuskwoodLog = 66,
  DuskwoodLeaves = 67,
  DuskwoodPlanks = 68,
  TallGrass = 69,
  Fern = 70,
  DryGrass = 71,
  DeadBush = 72,
  Sunpetal = 73,
  Rosette = 74,
  Bluebell = 75,
  Frostbloom = 76,
  RedMushroom = 77,
  BrownMushroom = 78,
  Duskcap = 79,
  Reeds = 80,
  HangingMoss = 81,
  LilyPad = 82,
  Cactus = 83,
  Pumpkin = 84,
  Melon = 85,
  HayBale = 86,
  SnowLayer = 87,
  StoneBricks = 88,
  MossyStoneBricks = 89,
  PolishedStone = 90,
  MarblePillar = 91,
  SandstoneBricks = 92,
  MudBricks = 93,
  BasaltBricks = 94,
  IceBricks = 95,
  ClothWhite = 96,
  ClothRed = 97,
  ClothOrange = 98,
  ClothYellow = 99,
  ClothGreen = 100,
  ClothBlue = 101,
  ClothPurple = 102,
  ClothBlack = 103,
  GlassRed = 104,
  GlassBlue = 105,
  GlassGreen = 106,
  GlassAmber = 107,
  Bookshelf = 108,
  Workbench = 109,
  Furnace = 110,
  Chest = 111,
  Torch = 112,
  Lantern = 113,
  /** Ladders: one id per wall direction (no block state). NZ = wall at -Z. Items and drops use LadderNZ. */
  LadderNZ = 114,
  LadderPX = 115,
  LadderPZ = 116,
  LadderNX = 117,
  StoneSlab = 118,
  CobbleSlab = 119,
  PlankSlab = 120,
  SandstoneSlab = 121,
  StoneBrickSlab = 122,
  RuneBricks = 123,
  SealedRune = 124,
  /** Boss structure altar: active (boss not yet defeated). Unbreakable, never placeable. */
  BossAltar = 125,
  /** The altar after its boss was defeated (persisted as an ordinary edit). */
  BossAltarDormant = 126,
  // ---- survival (design-voxel-survival §4.5) --------------------------------------
  Bedroll = 127,
}

/** How a block is meshed, ray-tested and drawn as an icon. */
export enum BlockShape {
  Cube = 0,
  /** Two diagonal planes (plants). */
  Cross = 1,
  /** An axis-aligned box smaller than the cell (slabs, torch, lantern, chest, cactus, snow layer, bedroll). */
  Box = 2,
  /** One horizontal quad (lily pad). */
  Pad = 3,
  /** One vertical quad against a wall (ladders). */
  Ladder = 4,
}

/** What a block needs next to it to stay (support.ts, world area). */
export enum Support {
  None = 0,
  Below = 1,
  Above = 2,
  Wall = 3,
}

export type ToolKind = 'none' | 'pick' | 'axe' | 'shovel';
export type SoundMaterial = 'stone' | 'wood' | 'dirt' | 'grass' | 'sand' | 'snow' | 'glass' | 'cloth' | 'plant' | 'liquid';
export type BlockCategory = 'natural' | 'ore' | 'wood' | 'plant' | 'building' | 'colour' | 'light' | 'utility' | 'hidden';
/** Bounds in 1/16ths of a block: [x0, y0, z0, x1, y1, z1]. */
export type Box16 = readonly [number, number, number, number, number, number];

export interface BlockDef {
  id: Block;
  name: string;
  /** Collides with players and mobs (up to collisionTop). */
  solid: boolean;
  /** Lets neighbours' faces show through (glass, leaves, water, every non-cube shape). */
  transparent: boolean;
  /** Rendered with the liquid rules (water: translucent pass; lava: opaque pass, world area). */
  liquid: boolean;
  /** Ignores day/night lighting. */
  emissive: boolean;
  /** Can players break it? */
  breakable: boolean;
  /** Seconds to break by hand (sandbox timing; survival scales it, see survival/mining.ts). */
  hardness: number;
  /** Atlas tile index per face: [top, bottom, side]. */
  tiles: [number, number, number];
  /** Representative colour for particles and map icons. */
  color: number;
  shape: BlockShape;
  /** Shape bounds in 1/16ths (cube: 0,0,0,16,16,16). Mesher (Box), raycast, highlight, icons. */
  box: Box16;
  /** Light emitted, 0..15. */
  light: number;
  /** Extra light levels lost entering this cell (leaves, ice, liquids: 1). */
  lightCost: number;
  /** Stops light. Default !transparent; slabs, chest and cactus stop it although transparent for culling. */
  lightOpaque: boolean;
  /** Rendered with the brightest neighbouring cell's light (light-opaque, render-transparent blocks). */
  useNeighbourLight: boolean;
  /** Placing a block into this cell replaces it (tall grass, ferns, snow layer, hanging moss; liquids always). */
  replaceable: boolean;
  support: Support;
  climbable: boolean;
  /** Top of the collision box, 0..1, for solid blocks (cube 1, slab 0.5, chest 0.875, bedroll 0.3125); 0 when not solid. */
  collisionTop: number;
  /** Fastest tool (survival). */
  tool: ToolKind;
  /** Lowest tool tier that gets drops: 0 hand, 1 wood, 2 stone, 3 iron, 4 cobalt (survival). */
  minTier: number;
  sound: SoundMaterial;
  /** Block picker tab; 'hidden' = never shown. */
  category: BlockCategory;
  /** Players may place it (server validation; PLACEABLE is derived from this). */
  placeable: boolean;
  /** Health per second while touching it (survival and mobs): cactus 1, lava 4. */
  contactDamage: number;
  /** Slabs: the full block two stacked slabs merge into. */
  slabFull: Block | null;
  /** Dense ground cover hidden on the 'low' quality preset. */
  decor: boolean;
}

type DefOpts = Partial<Omit<BlockDef, 'id' | 'name' | 'tiles' | 'color'>>;

const FULL_BOX: Box16 = [0, 0, 0, 16, 16, 16];

const def = (id: Block, name: string, tiles: [number, number, number], color: number, opts: DefOpts = {}): BlockDef => {
  const solid = opts.solid ?? true;
  const transparent = opts.transparent ?? false;
  return {
    id,
    name,
    tiles,
    color,
    solid,
    transparent,
    liquid: opts.liquid ?? false,
    emissive: opts.emissive ?? false,
    breakable: opts.breakable ?? true,
    hardness: opts.hardness ?? 0.35,
    shape: opts.shape ?? BlockShape.Cube,
    box: opts.box ?? FULL_BOX,
    light: opts.light ?? 0,
    lightCost: opts.lightCost ?? 0,
    lightOpaque: opts.lightOpaque ?? !transparent,
    useNeighbourLight: opts.useNeighbourLight ?? false,
    replaceable: opts.replaceable ?? false,
    support: opts.support ?? Support.None,
    climbable: opts.climbable ?? false,
    collisionTop: opts.collisionTop ?? (solid ? 1 : 0),
    tool: opts.tool ?? 'none',
    minTier: opts.minTier ?? 0,
    sound: opts.sound ?? 'stone',
    category: opts.category ?? 'building',
    placeable: opts.placeable ?? false,
    contactDamage: opts.contactDamage ?? 0,
    slabFull: opts.slabFull ?? null,
    decor: opts.decor ?? false,
  };
};

/**
 * Atlas tile indices. 0..22 are the original tiles (never moved); 23..132 are
 * painted by the world area (and 131..132 per the survival design); item
 * sprites use 160..239; the crack overlay uses 240..247.
 */
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
  RedSand: 23,
  SandstoneTop: 24,
  SandstoneSide: 25,
  RedSandstoneTop: 26,
  RedSandstoneSide: 27,
  Granite: 28,
  BasaltTop: 29,
  BasaltSide: 30,
  Slate: 31,
  Marble: 32,
  Obsidian: 33,
  Mud: 34,
  ForestFloorTop: 35,
  ForestFloorSide: 36,
  MossyCobble: 37,
  CoalOre: 38,
  CopperOre: 39,
  IronOre: 40,
  GoldOre: 41,
  CobaltOre: 42,
  EmberOre: 43,
  OchreClay: 44,
  RustClay: 45,
  CreamClay: 46,
  UmberClay: 47,
  PackedIce: 48,
  Lava: 49,
  ParchedGrassTop: 50,
  ParchedGrassSide: 51,
  AspenLogSide: 52,
  AspenLogTop: 53,
  AspenLeaves: 54,
  AspenPlanks: 55,
  PineLogSide: 56,
  PineLogTop: 57,
  PineLeaves: 58,
  PinePlanks: 59,
  MahoganyLogSide: 60,
  MahoganyLogTop: 61,
  MahoganyLeaves: 62,
  MahoganyPlanks: 63,
  ThornwoodLogSide: 64,
  ThornwoodLogTop: 65,
  ThornwoodLeaves: 66,
  ThornwoodPlanks: 67,
  DuskwoodLogSide: 68,
  DuskwoodLogTop: 69,
  DuskwoodLeaves: 70,
  DuskwoodPlanks: 71,
  TallGrass: 72,
  Fern: 73,
  DryGrass: 74,
  DeadBush: 75,
  Sunpetal: 76,
  Rosette: 77,
  Bluebell: 78,
  Frostbloom: 79,
  RedMushroom: 80,
  BrownMushroom: 81,
  Duskcap: 82,
  Reeds: 83,
  HangingMoss: 84,
  LilyPad: 85,
  CactusSide: 86,
  CactusTop: 87,
  PumpkinSide: 88,
  PumpkinTop: 89,
  MelonSide: 90,
  MelonTop: 91,
  HaySide: 92,
  HayTop: 93,
  StoneBricks: 94,
  MossyStoneBricks: 95,
  PolishedStone: 96,
  MarblePillarSide: 97,
  MarblePillarTop: 98,
  SandstoneBricks: 99,
  MudBricks: 100,
  BasaltBricks: 101,
  IceBricks: 102,
  ClothWhite: 103, // ..110: White, Red, Orange, Yellow, Green, Blue, Purple, Black
  GlassRed: 111, // ..114: Red, Blue, Green, Amber
  BookshelfSide: 115,
  WorkbenchTop: 116,
  WorkbenchSide: 117,
  FurnaceSide: 118,
  FurnaceTop: 119,
  ChestSide: 120,
  ChestTop: 121,
  Torch: 122,
  Lantern: 123,
  Ladder: 124,
  RuneBricks: 125,
  SealedRune: 126,
  AltarTop: 127,
  AltarSide: 128,
  AltarDormantTop: 129,
  AltarDormantSide: 130,
  BedrollTop: 131,
  BedrollSide: 132,
  /** First item sprite tile (survival registry: 160..239). */
  ItemSprites: 160,
  /** 8 break stages, 240..247. */
  Crack0: 240,
} as const;

/** Columns (and rows) of the 16x16 tile atlas: tile = row * ATLAS_COLS + col. */
export const ATLAS_COLS = 16;

const T = Tile;
const same = (t: number): [number, number, number] => [t, t, t];

const AIR = def(Block.Air, 'Air', [0, 0, 0], 0, { solid: false, transparent: true, breakable: false, category: 'hidden' });

const WATER_OPTS: DefOpts = { solid: false, transparent: true, liquid: true, breakable: false, lightCost: 1, sound: 'liquid', category: 'hidden' };
const WATER_TILES: [number, number, number] = [T.Water, T.Water, T.Water];

// Shared option bundles for the upgrade blocks.
const STONE1: DefOpts = { tool: 'pick', minTier: 1, sound: 'stone', placeable: true };
const WOOD: DefOpts = { tool: 'axe', sound: 'wood', placeable: true };
const LEAVES: DefOpts = { transparent: true, lightCost: 1, hardness: 0.1, sound: 'plant', category: 'wood', placeable: true };
const PLANT: DefOpts = { shape: BlockShape.Cross, solid: false, transparent: true, support: Support.Below, hardness: 0, sound: 'plant', category: 'plant', placeable: true };
const GRASS_BOX: Box16 = [2, 0, 2, 14, 13, 14];
const FLOWER_BOX: Box16 = [4, 0, 4, 12, 12, 12];
const SHROOM_BOX: Box16 = [4, 0, 4, 12, 10, 12];
const SLAB: DefOpts = { shape: BlockShape.Box, box: [0, 0, 0, 16, 8, 16], transparent: true, lightOpaque: true, useNeighbourLight: true, collisionTop: 0.5, category: 'building', placeable: true };
const LADDER: DefOpts = { shape: BlockShape.Ladder, solid: false, transparent: true, climbable: true, support: Support.Wall, hardness: 0.2, tool: 'axe', sound: 'wood', category: 'hidden', placeable: true };
const CLOTH: DefOpts = { hardness: 0.2, sound: 'cloth', category: 'colour', placeable: true };
const STAINED: DefOpts = { transparent: true, hardness: 0.15, sound: 'glass', category: 'building', placeable: true };

const DEFS: BlockDef[] = [];
for (const d of [
  AIR,
  def(Block.Grass, 'Grass', [T.GrassTop, T.Dirt, T.GrassSide], 0x6abf4b, { hardness: 0.3, tool: 'shovel', sound: 'grass', category: 'natural', placeable: true }),
  def(Block.Dirt, 'Dirt', same(T.Dirt), 0x8a5a3b, { hardness: 0.25, tool: 'shovel', sound: 'dirt', category: 'natural', placeable: true }),
  def(Block.Stone, 'Stone', same(T.Stone), 0x8c8f99, { hardness: 0.6, ...STONE1, category: 'natural' }),
  def(Block.Sand, 'Sand', same(T.Sand), 0xe8d39a, { hardness: 0.2, tool: 'shovel', sound: 'sand', category: 'natural', placeable: true }),
  def(Block.Water, 'Water', WATER_TILES, 0x3f8fd8, { ...WATER_OPTS, category: 'natural', placeable: true }),
  def(Block.Log, 'Oak Log', [T.LogTop, T.LogTop, T.LogSide], 0x8b6340, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.Leaves, 'Oak Leaves', same(T.Leaves), 0x4f9a3a, { ...LEAVES }),
  def(Block.Planks, 'Oak Planks', same(T.Planks), 0xc49a5c, { hardness: 0.4, ...WOOD, category: 'wood' }),
  def(Block.Cobble, 'Cobblestone', same(T.Cobble), 0x7d7f87, { hardness: 0.6, ...STONE1, category: 'natural' }),
  def(Block.Glass, 'Glass', same(T.Glass), 0xbfe8ff, { transparent: true, hardness: 0.15, sound: 'glass', placeable: true }),
  def(Block.Brick, 'Brick', same(T.Brick), 0xb5523b, { hardness: 0.6, ...STONE1 }),
  def(Block.Snow, 'Snow', same(T.Snow), 0xf4f8ff, { hardness: 0.15, tool: 'shovel', sound: 'snow', category: 'natural', placeable: true }),
  def(Block.Lamp, 'Lamp', same(T.Lamp), 0xffd166, { emissive: true, hardness: 0.25, light: 15, sound: 'glass', category: 'light', placeable: true }),
  def(Block.Bedrock, 'Bedrock', same(T.Bedrock), 0x33343a, { breakable: false, category: 'hidden' }),
  def(Block.Gravel, 'Gravel', same(T.Gravel), 0x8e8680, { hardness: 0.25, tool: 'shovel', sound: 'sand', category: 'natural', placeable: true }),
  def(Block.Clay, 'Clay', same(T.Clay), 0x5fa8c8, { hardness: 0.3, tool: 'shovel', sound: 'dirt', category: 'natural', placeable: true }),
  def(Block.Checkpoint, 'Checkpoint', same(T.Checkpoint), 0x5fd17a, { emissive: true, breakable: false, light: 10, sound: 'cloth', category: 'hidden' }),
  def(Block.Finish, 'Finish', same(T.Finish), 0xffd166, { emissive: true, breakable: false, light: 10, sound: 'cloth', category: 'hidden' }),
  def(Block.Cloud, 'Cloud', same(T.Cloud), 0xffffff, { breakable: false, sound: 'cloth', category: 'hidden' }),
  def(Block.SnowyGrass, 'Snowy Grass', [T.Snow, T.Dirt, T.SnowyGrassSide], 0xe9f1ff, { hardness: 0.3, tool: 'shovel', sound: 'snow', category: 'natural', placeable: true }),
  def(Block.Ice, 'Ice', same(T.Ice), 0x9fd8ff, { transparent: true, hardness: 0.3, lightCost: 1, tool: 'pick', sound: 'glass', category: 'natural', placeable: true }),
  ...Array.from({ length: 7 }, (_, i) => def(Block.WaterFlow1 + i, 'Flowing Water', WATER_TILES, 0x3f8fd8, WATER_OPTS)),
  def(Block.WaterFalling, 'Falling Water', WATER_TILES, 0x3f8fd8, WATER_OPTS),

  // ---- natural --------------------------------------------------------------------
  def(Block.RedSand, 'Red Sand', same(T.RedSand), 0xc8743a, { hardness: 0.2, tool: 'shovel', sound: 'sand', category: 'natural', placeable: true }),
  def(Block.Sandstone, 'Sandstone', [T.SandstoneTop, T.SandstoneTop, T.SandstoneSide], 0xdcc58a, { hardness: 0.45, ...STONE1, category: 'natural' }),
  def(Block.RedSandstone, 'Red Sandstone', [T.RedSandstoneTop, T.RedSandstoneTop, T.RedSandstoneSide], 0xb8643a, { hardness: 0.45, ...STONE1, category: 'natural' }),
  def(Block.Granite, 'Granite', same(T.Granite), 0xa8786a, { hardness: 0.7, ...STONE1, category: 'natural' }),
  def(Block.Basalt, 'Basalt', [T.BasaltTop, T.BasaltTop, T.BasaltSide], 0x4a4c54, { hardness: 0.7, ...STONE1, category: 'natural' }),
  def(Block.Slate, 'Slate', same(T.Slate), 0x4a4f5c, { hardness: 0.8, ...STONE1, category: 'natural' }),
  def(Block.Marble, 'Marble', same(T.Marble), 0xece8e0, { hardness: 0.7, ...STONE1, category: 'natural' }),
  def(Block.Obsidian, 'Obsidian', same(T.Obsidian), 0x1e1726, { hardness: 3.0, ...STONE1, minTier: 4, category: 'natural' }),
  def(Block.Mud, 'Mud', same(T.Mud), 0x4f3b2c, { hardness: 0.2, tool: 'shovel', sound: 'dirt', category: 'natural', placeable: true }),
  def(Block.ForestFloor, 'Forest Floor', [T.ForestFloorTop, T.Dirt, T.ForestFloorSide], 0x6b4a2a, { hardness: 0.3, tool: 'shovel', sound: 'grass', category: 'natural', placeable: true }),
  def(Block.ParchedGrass, 'Parched Grass', [T.ParchedGrassTop, T.Dirt, T.ParchedGrassSide], 0xb6b04a, { hardness: 0.3, tool: 'shovel', sound: 'grass', category: 'natural', placeable: true }),
  def(Block.MossyCobble, 'Mossy Cobblestone', same(T.MossyCobble), 0x6f7f5f, { hardness: 0.6, ...STONE1, category: 'building' }),
  // ---- ores -----------------------------------------------------------------------
  def(Block.CoalOre, 'Coal Ore', same(T.CoalOre), 0x3a3a40, { hardness: 0.8, ...STONE1, category: 'ore' }),
  def(Block.CopperOre, 'Copper Ore', same(T.CopperOre), 0xc8743a, { hardness: 0.9, ...STONE1, minTier: 2, category: 'ore' }),
  def(Block.IronOre, 'Iron Ore', same(T.IronOre), 0xd8b49a, { hardness: 1.0, ...STONE1, minTier: 2, category: 'ore' }),
  def(Block.GoldOre, 'Gold Ore', same(T.GoldOre), 0xf2c63a, { hardness: 1.1, ...STONE1, minTier: 3, category: 'ore' }),
  def(Block.CobaltOre, 'Cobalt Ore', same(T.CobaltOre), 0x2f6fe0, { hardness: 1.4, ...STONE1, minTier: 3, category: 'ore' }),
  def(Block.EmberOre, 'Ember Ore', same(T.EmberOre), 0xff6a2a, { hardness: 1.6, ...STONE1, minTier: 3, light: 6, category: 'ore' }),
  def(Block.OchreClay, 'Ochre Clay', same(T.OchreClay), 0xc98a3a, { hardness: 0.5, ...STONE1, category: 'natural' }),
  def(Block.RustClay, 'Rust Clay', same(T.RustClay), 0xa04a2a, { hardness: 0.5, ...STONE1, category: 'natural' }),
  def(Block.CreamClay, 'Cream Clay', same(T.CreamClay), 0xe0c9a0, { hardness: 0.5, ...STONE1, category: 'natural' }),
  def(Block.UmberClay, 'Umber Clay', same(T.UmberClay), 0x6e4a32, { hardness: 0.5, ...STONE1, category: 'natural' }),
  def(Block.PackedIce, 'Packed Ice', same(T.PackedIce), 0x8fc4ee, { hardness: 0.4, ...STONE1, sound: 'glass', category: 'natural' }),
  def(Block.Lava, 'Lava', same(T.Lava), 0xe0561a, {
    solid: false, transparent: true, liquid: true, emissive: true, breakable: false, light: 15, lightCost: 1, contactDamage: 4, sound: 'liquid', category: 'hidden',
  }),
  // ---- wood -----------------------------------------------------------------------
  def(Block.AspenLog, 'Aspen Log', [T.AspenLogTop, T.AspenLogTop, T.AspenLogSide], 0xd9d4c4, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.AspenLeaves, 'Aspen Leaves', same(T.AspenLeaves), 0x9cc84a, LEAVES),
  def(Block.AspenPlanks, 'Aspen Planks', same(T.AspenPlanks), 0xe2d3a8, { hardness: 0.4, ...WOOD, category: 'wood' }),
  def(Block.PineLog, 'Pine Log', [T.PineLogTop, T.PineLogTop, T.PineLogSide], 0x5a3e26, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.PineLeaves, 'Pine Needles', same(T.PineLeaves), 0x2f5d3a, LEAVES),
  def(Block.PinePlanks, 'Pine Planks', same(T.PinePlanks), 0x9a6b3c, { hardness: 0.4, ...WOOD, category: 'wood' }),
  def(Block.MahoganyLog, 'Mahogany Log', [T.MahoganyLogTop, T.MahoganyLogTop, T.MahoganyLogSide], 0x6a3a26, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.MahoganyLeaves, 'Mahogany Leaves', same(T.MahoganyLeaves), 0x3fa83a, LEAVES),
  def(Block.MahoganyPlanks, 'Mahogany Planks', same(T.MahoganyPlanks), 0xa4553a, { hardness: 0.4, ...WOOD, category: 'wood' }),
  def(Block.ThornwoodLog, 'Thornwood Log', [T.ThornwoodLogTop, T.ThornwoodLogTop, T.ThornwoodLogSide], 0x8a7a6a, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.ThornwoodLeaves, 'Thornwood Leaves', same(T.ThornwoodLeaves), 0x7a9a3a, LEAVES),
  def(Block.ThornwoodPlanks, 'Thornwood Planks', same(T.ThornwoodPlanks), 0xc2783e, { hardness: 0.4, ...WOOD, category: 'wood' }),
  def(Block.DuskwoodLog, 'Duskwood Log', [T.DuskwoodLogTop, T.DuskwoodLogTop, T.DuskwoodLogSide], 0x3a2e36, { hardness: 0.5, ...WOOD, category: 'wood' }),
  def(Block.DuskwoodLeaves, 'Duskwood Leaves', same(T.DuskwoodLeaves), 0x3b4a3f, LEAVES),
  def(Block.DuskwoodPlanks, 'Duskwood Planks', same(T.DuskwoodPlanks), 0x5a4a5e, { hardness: 0.4, ...WOOD, category: 'wood' }),
  // ---- plants ---------------------------------------------------------------------
  def(Block.TallGrass, 'Tall Grass', same(T.TallGrass), 0x6abf4b, { ...PLANT, box: GRASS_BOX, replaceable: true, decor: true }),
  def(Block.Fern, 'Fern', same(T.Fern), 0x3f8a3a, { ...PLANT, box: GRASS_BOX, replaceable: true, decor: true }),
  def(Block.DryGrass, 'Dry Grass', same(T.DryGrass), 0xc8b45a, { ...PLANT, box: GRASS_BOX, replaceable: true, decor: true }),
  def(Block.DeadBush, 'Dead Bush', same(T.DeadBush), 0x7a5a3a, { ...PLANT, box: GRASS_BOX, replaceable: true }),
  def(Block.Sunpetal, 'Sunpetal', same(T.Sunpetal), 0xf2d22a, { ...PLANT, box: FLOWER_BOX }),
  def(Block.Rosette, 'Rosette', same(T.Rosette), 0xd23a3a, { ...PLANT, box: FLOWER_BOX }),
  def(Block.Bluebell, 'Bluebell', same(T.Bluebell), 0x5a7ae0, { ...PLANT, box: FLOWER_BOX }),
  def(Block.Frostbloom, 'Frostbloom', same(T.Frostbloom), 0xe8f8ff, { ...PLANT, box: FLOWER_BOX }),
  def(Block.RedMushroom, 'Red Mushroom', same(T.RedMushroom), 0xc83a2a, { ...PLANT, box: SHROOM_BOX }),
  def(Block.BrownMushroom, 'Brown Mushroom', same(T.BrownMushroom), 0x8a6a4a, { ...PLANT, box: SHROOM_BOX }),
  def(Block.Duskcap, 'Duskcap', same(T.Duskcap), 0x7a5ad8, { ...PLANT, box: SHROOM_BOX, emissive: true, light: 7, category: 'light' }),
  def(Block.Reeds, 'Reeds', same(T.Reeds), 0x8ac84a, { ...PLANT, box: [2, 0, 2, 14, 16, 14] }),
  def(Block.HangingMoss, 'Hanging Moss', same(T.HangingMoss), 0x4a7a3a, { ...PLANT, box: [3, 0, 3, 13, 16, 13], replaceable: true, support: Support.Above }),
  def(Block.LilyPad, 'Lily Pad', same(T.LilyPad), 0x3a8a3a, { ...PLANT, shape: BlockShape.Pad, box: [1, -2, 1, 15, -1, 15] }),
  def(Block.Cactus, 'Cactus', [T.CactusTop, T.CactusTop, T.CactusSide], 0x4a8a3a, {
    shape: BlockShape.Box, box: [1, 0, 1, 15, 16, 15], transparent: true, lightOpaque: true, useNeighbourLight: true, support: Support.Below,
    contactDamage: 1, hardness: 0.2, sound: 'cloth', category: 'plant', placeable: true,
  }),
  def(Block.Pumpkin, 'Pumpkin', [T.PumpkinTop, T.PumpkinTop, T.PumpkinSide], 0xe08a1f, { hardness: 0.4, ...WOOD, category: 'plant' }),
  def(Block.Melon, 'Melon', [T.MelonTop, T.MelonTop, T.MelonSide], 0x5aa03a, { hardness: 0.4, ...WOOD, category: 'plant' }),
  def(Block.HayBale, 'Hay Bale', [T.HayTop, T.HayTop, T.HaySide], 0xd8b84a, { hardness: 0.25, sound: 'grass', category: 'plant', placeable: true }),
  def(Block.SnowLayer, 'Snow Layer', same(T.Snow), 0xf4f8ff, {
    shape: BlockShape.Box, box: [0, 0, 0, 16, 2, 16], solid: false, transparent: true, replaceable: true, support: Support.Below,
    hardness: 0.05, tool: 'shovel', sound: 'snow', category: 'natural', placeable: true,
  }),
  // ---- building -------------------------------------------------------------------
  def(Block.StoneBricks, 'Stone Bricks', same(T.StoneBricks), 0x8c8f99, { hardness: 0.7, ...STONE1 }),
  def(Block.MossyStoneBricks, 'Mossy Stone Bricks', same(T.MossyStoneBricks), 0x7a8a6a, { hardness: 0.7, ...STONE1 }),
  def(Block.PolishedStone, 'Polished Stone', same(T.PolishedStone), 0x9a9da6, { hardness: 0.7, ...STONE1 }),
  def(Block.MarblePillar, 'Marble Pillar', [T.MarblePillarTop, T.MarblePillarTop, T.MarblePillarSide], 0xf0ece4, { hardness: 0.7, ...STONE1 }),
  def(Block.SandstoneBricks, 'Sandstone Bricks', same(T.SandstoneBricks), 0xdcc58a, { hardness: 0.5, ...STONE1 }),
  def(Block.MudBricks, 'Mud Bricks', same(T.MudBricks), 0x7a5a42, { hardness: 0.4, ...STONE1 }),
  def(Block.BasaltBricks, 'Basalt Bricks', same(T.BasaltBricks), 0x45474e, { hardness: 0.8, ...STONE1 }),
  def(Block.IceBricks, 'Ice Bricks', same(T.IceBricks), 0xa8d8f8, { hardness: 0.4, ...STONE1, sound: 'glass' }),
  def(Block.ClothWhite, 'White Cloth', same(T.ClothWhite), 0xe9ecec, CLOTH),
  def(Block.ClothRed, 'Red Cloth', same(T.ClothWhite + 1), 0xb3312c, CLOTH),
  def(Block.ClothOrange, 'Orange Cloth', same(T.ClothWhite + 2), 0xe07a1f, CLOTH),
  def(Block.ClothYellow, 'Yellow Cloth', same(T.ClothWhite + 3), 0xe8c52a, CLOTH),
  def(Block.ClothGreen, 'Green Cloth', same(T.ClothWhite + 4), 0x4f8f2f, CLOTH),
  def(Block.ClothBlue, 'Blue Cloth', same(T.ClothWhite + 5), 0x2f5fb3, CLOTH),
  def(Block.ClothPurple, 'Purple Cloth', same(T.ClothWhite + 6), 0x7b3fb0, CLOTH),
  def(Block.ClothBlack, 'Black Cloth', same(T.ClothWhite + 7), 0x26262b, CLOTH),
  def(Block.GlassRed, 'Red Glass', same(T.GlassRed), 0xd2423c, STAINED),
  def(Block.GlassBlue, 'Blue Glass', same(T.GlassRed + 1), 0x3c6ed2, STAINED),
  def(Block.GlassGreen, 'Green Glass', same(T.GlassRed + 2), 0x4caf50, STAINED),
  def(Block.GlassAmber, 'Amber Glass', same(T.GlassRed + 3), 0xe0a030, STAINED),
  // ---- utility and light ----------------------------------------------------------
  def(Block.Bookshelf, 'Bookshelf', [T.Planks, T.Planks, T.BookshelfSide], 0xa8743a, { hardness: 0.4, ...WOOD, category: 'utility' }),
  def(Block.Workbench, 'Workbench', [T.WorkbenchTop, T.Planks, T.WorkbenchSide], 0xb08850, { hardness: 0.5, ...WOOD, category: 'utility' }),
  def(Block.Furnace, 'Furnace', [T.FurnaceTop, T.FurnaceTop, T.FurnaceSide], 0x7a7c84, { hardness: 0.8, ...STONE1, category: 'utility' }),
  def(Block.Chest, 'Chest', [T.ChestTop, T.ChestTop, T.ChestSide], 0xa8743a, {
    shape: BlockShape.Box, box: [1, 0, 1, 15, 14, 15], transparent: true, lightOpaque: true, useNeighbourLight: true, collisionTop: 0.875,
    hardness: 0.5, ...WOOD, category: 'utility',
  }),
  def(Block.Torch, 'Torch', same(T.Torch), 0xffd84a, {
    shape: BlockShape.Box, box: [7, 0, 7, 9, 10, 9], solid: false, transparent: true, emissive: true, light: 14, support: Support.Below,
    hardness: 0, sound: 'wood', category: 'light', placeable: true,
  }),
  def(Block.Lantern, 'Lantern', same(T.Lantern), 0xffd88a, {
    shape: BlockShape.Box, box: [5, 0, 5, 11, 9, 11], solid: false, transparent: true, emissive: true, light: 15, support: Support.Below,
    hardness: 0.2, tool: 'pick', sound: 'stone', category: 'light', placeable: true,
  }),
  def(Block.LadderNZ, 'Ladder', same(T.Ladder), 0x9a7a4a, { ...LADDER, box: [0, 0, 0, 16, 16, 2], category: 'utility' }),
  def(Block.LadderPX, 'Ladder', same(T.Ladder), 0x9a7a4a, { ...LADDER, box: [14, 0, 0, 16, 16, 16] }),
  def(Block.LadderPZ, 'Ladder', same(T.Ladder), 0x9a7a4a, { ...LADDER, box: [0, 0, 14, 16, 16, 16] }),
  def(Block.LadderNX, 'Ladder', same(T.Ladder), 0x9a7a4a, { ...LADDER, box: [0, 0, 0, 2, 16, 16] }),
  def(Block.StoneSlab, 'Stone Slab', same(T.Stone), 0x8c8f99, { ...SLAB, slabFull: Block.Stone, hardness: 0.6, tool: 'pick', minTier: 1, sound: 'stone' }),
  def(Block.CobbleSlab, 'Cobblestone Slab', same(T.Cobble), 0x7d7f87, { ...SLAB, slabFull: Block.Cobble, hardness: 0.6, tool: 'pick', minTier: 1, sound: 'stone' }),
  def(Block.PlankSlab, 'Oak Plank Slab', same(T.Planks), 0xc49a5c, { ...SLAB, slabFull: Block.Planks, hardness: 0.4, tool: 'axe', sound: 'wood' }),
  def(Block.SandstoneSlab, 'Sandstone Slab', [T.SandstoneTop, T.SandstoneTop, T.SandstoneSide], 0xdcc58a, {
    ...SLAB, slabFull: Block.Sandstone, hardness: 0.45, tool: 'pick', minTier: 1, sound: 'stone',
  }),
  def(Block.StoneBrickSlab, 'Stone Brick Slab', same(T.StoneBricks), 0x8c8f99, { ...SLAB, slabFull: Block.StoneBricks, hardness: 0.7, tool: 'pick', minTier: 1, sound: 'stone' }),
  def(Block.RuneBricks, 'Rune Bricks', same(T.RuneBricks), 0x3a3648, { hardness: 1.5, ...STONE1, minTier: 2 }),
  def(Block.SealedRune, 'Sealed Rune', same(T.SealedRune), 0x4a6a8a, { hardness: 1.5, ...STONE1, minTier: 2, light: 10, category: 'light' }),
  def(Block.BossAltar, 'Ancient Altar', [T.AltarTop, T.RuneBricks, T.AltarSide], 0x9a6aff, { breakable: false, emissive: true, light: 12, category: 'hidden' }),
  def(Block.BossAltarDormant, 'Dormant Altar', [T.AltarDormantTop, T.RuneBricks, T.AltarDormantSide], 0x6a6a74, { breakable: false, light: 4, category: 'hidden' }),
  def(Block.Bedroll, 'Bedroll', [T.BedrollTop, T.BedrollSide, T.BedrollSide], 0xb3312c, {
    shape: BlockShape.Box, box: [0, 0, 0, 16, 5, 16], transparent: true, collisionTop: 0.3125, support: Support.Below,
    hardness: 0.2, sound: 'cloth', category: 'utility', placeable: true,
  }),
]) {
  DEFS[d.id] = d;
}

export const BLOCKS: readonly BlockDef[] = DEFS;
/** One past the highest defined id (128). */
export const BLOCK_COUNT = DEFS.length;

export function blockDef(id: number): BlockDef {
  return DEFS[id] ?? AIR;
}

/** Fast lookup tables used in hot loops (meshing, physics, light, mobs). Indexed by block id. */
export const IS_SOLID = new Uint8Array(256);
export const IS_TRANSPARENT = new Uint8Array(256);
export const IS_LIQUID = new Uint8Array(256);
export const IS_EMISSIVE = new Uint8Array(256);
export const TILE_TOP = new Uint8Array(256);
export const TILE_BOTTOM = new Uint8Array(256);
export const TILE_SIDE = new Uint8Array(256);
/** BlockShape per id. */
export const SHAPE = new Uint8Array(256);
/** Shape bounds / 16, 6 floats per id: x0, y0, z0, x1, y1, z1 (cube 0..1). */
export const SHAPE_BOUNDS = new Float32Array(256 * 6);
/** Top of the collision box (0 for non-solid ids). */
export const COLLISION_TOP = new Float32Array(256);
/** Placing into this cell replaces it (replaceable or liquid). */
export const IS_REPLACEABLE = new Uint8Array(256);
export const IS_CLIMBABLE = new Uint8Array(256);
/** Support per id. */
export const SUPPORT = new Uint8Array(256);
export const IS_DECOR = new Uint8Array(256);
export const USE_NEIGHBOUR_LIGHT = new Uint8Array(256);
/** Slab id -> the full block two slabs make (0 = not a slab). */
export const SLAB_FULL = new Uint8Array(256);
/** Health per second while touching the block (0 = harmless). */
export const CONTACT_DAMAGE = new Float32Array(256);
IS_TRANSPARENT.fill(1);
for (let id = 0; id < 256; id++) {
  SHAPE_BOUNDS.set([0, 0, 0, 1, 1, 1], id * 6);
}
for (const d of DEFS) {
  if (!d) continue;
  IS_SOLID[d.id] = d.solid ? 1 : 0;
  IS_TRANSPARENT[d.id] = d.transparent ? 1 : 0;
  IS_LIQUID[d.id] = d.liquid ? 1 : 0;
  IS_EMISSIVE[d.id] = d.emissive ? 1 : 0;
  TILE_TOP[d.id] = d.tiles[0];
  TILE_BOTTOM[d.id] = d.tiles[1];
  TILE_SIDE[d.id] = d.tiles[2];
  SHAPE[d.id] = d.shape;
  SHAPE_BOUNDS.set(d.box.map((v) => v / 16), d.id * 6);
  COLLISION_TOP[d.id] = d.solid ? d.collisionTop : 0;
  IS_REPLACEABLE[d.id] = d.replaceable || d.liquid ? 1 : 0;
  IS_CLIMBABLE[d.id] = d.climbable ? 1 : 0;
  SUPPORT[d.id] = d.support;
  IS_DECOR[d.id] = d.decor ? 1 : 0;
  USE_NEIGHBOUR_LIGHT[d.id] = d.useNeighbourLight ? 1 : 0;
  SLAB_FULL[d.id] = d.slabFull ?? 0;
  CONTACT_DAMAGE[d.id] = d.contactDamage;
}

/** Default sandbox hotbar, in order (unchanged 12 entries). */
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

/** Blocks players may place (server validation): every def with placeable. Flowing/falling water, lava and altars never are. */
export const PLACEABLE = new Set<number>(DEFS.filter((d) => d?.placeable).map((d) => d.id));

export function isPlaceable(id: number): boolean {
  return PLACEABLE.has(id);
}

/** Block picker order ("All" tab). Ladders appear once, as LadderNZ. */
export const CREATIVE_BLOCKS: readonly Block[] = [
  // natural
  Block.Grass, Block.Dirt, Block.Stone, Block.Cobble, Block.Sand, Block.Gravel, Block.Clay, Block.Snow, Block.SnowyGrass, Block.Ice, Block.Water,
  Block.RedSand, Block.Sandstone, Block.RedSandstone, Block.Granite, Block.Basalt, Block.Slate, Block.Marble, Block.Obsidian, Block.Mud,
  Block.ForestFloor, Block.ParchedGrass, Block.PackedIce, Block.OchreClay, Block.RustClay, Block.CreamClay, Block.UmberClay, Block.SnowLayer,
  // ores
  Block.CoalOre, Block.CopperOre, Block.IronOre, Block.GoldOre, Block.CobaltOre, Block.EmberOre,
  // wood
  Block.Log, Block.Leaves, Block.Planks, Block.AspenLog, Block.AspenLeaves, Block.AspenPlanks, Block.PineLog, Block.PineLeaves, Block.PinePlanks,
  Block.MahoganyLog, Block.MahoganyLeaves, Block.MahoganyPlanks, Block.ThornwoodLog, Block.ThornwoodLeaves, Block.ThornwoodPlanks,
  Block.DuskwoodLog, Block.DuskwoodLeaves, Block.DuskwoodPlanks,
  // plants
  Block.TallGrass, Block.Fern, Block.DryGrass, Block.DeadBush, Block.Sunpetal, Block.Rosette, Block.Bluebell, Block.Frostbloom, Block.RedMushroom,
  Block.BrownMushroom, Block.Reeds, Block.HangingMoss, Block.LilyPad, Block.Cactus, Block.Pumpkin, Block.Melon, Block.HayBale,
  // building
  Block.Brick, Block.MossyCobble, Block.StoneBricks, Block.MossyStoneBricks, Block.PolishedStone, Block.MarblePillar, Block.SandstoneBricks,
  Block.MudBricks, Block.BasaltBricks, Block.IceBricks, Block.RuneBricks, Block.StoneSlab, Block.CobbleSlab, Block.PlankSlab, Block.SandstoneSlab,
  Block.StoneBrickSlab, Block.Glass, Block.GlassRed, Block.GlassBlue, Block.GlassGreen, Block.GlassAmber,
  // colours
  Block.ClothWhite, Block.ClothRed, Block.ClothOrange, Block.ClothYellow, Block.ClothGreen, Block.ClothBlue, Block.ClothPurple, Block.ClothBlack,
  // lights and utility
  Block.Lamp, Block.Torch, Block.Lantern, Block.Duskcap, Block.SealedRune, Block.Bookshelf, Block.Workbench, Block.Furnace, Block.Chest,
  Block.Bedroll, Block.LadderNZ,
];

/** Picker category per id ('hidden' for undefined ids). */
export const BLOCK_CATEGORY: readonly BlockCategory[] = Array.from({ length: 256 }, (_, id) => DEFS[id]?.category ?? 'hidden');

/** Ladder variants map to LadderNZ (items, drops, picker, hotbar); every other id maps to itself. */
export function canonicalBlock(id: number): Block {
  return id >= Block.LadderNZ && id <= Block.LadderNX ? Block.LadderNZ : (id as Block);
}

const LADDER_WALLS: readonly [Block, number, number][] = [
  [Block.LadderNZ, 0, -1],
  [Block.LadderPX, 1, 0],
  [Block.LadderPZ, 0, 1],
  [Block.LadderNX, -1, 0],
];

/** Ladder id for a wall direction: (dx, dz) = offset from the ladder cell to the block it leans on. */
export function ladderFacing(dx: number, dz: number): Block {
  for (const [id, wx, wz] of LADDER_WALLS) if (wx === Math.sign(dx) && wz === Math.sign(dz)) return id;
  return Block.LadderNZ;
}

/** Offset from a ladder cell to its wall, or null for non-ladders. */
export function ladderWall(id: number): [number, number] | null {
  for (const [lid, wx, wz] of LADDER_WALLS) if (lid === id) return [wx, wz];
  return null;
}

export function isLava(id: number): boolean {
  return id === Block.Lava;
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
 * sources, falling water and lava 0.875, flowing water level / 8 (level 7 lines
 * up with its source), anything else 1.
 */
export const LIQUID_HEIGHT = new Float32Array(256).fill(1);
LIQUID_HEIGHT[Block.Water] = 0.875;
LIQUID_HEIGHT[Block.WaterFalling] = 0.875;
LIQUID_HEIGHT[Block.Lava] = 0.875;
for (let level = 1; level <= 7; level++) LIQUID_HEIGHT[flowingWater(level)] = level / 8;
