/**
 * Item registry (WP-B owns this file; WP0 ships the shape and the block-item
 * half so every package can compile and resolve keys).
 *
 * One u16 item space:
 *   0..255   block items: item id = canonical block id, key 'block:<Block enum name>'
 *   256..383 survival items (materials, food, ammo, tools, weapons, mob drops, boss uniques)
 *   384..511 reserved (unused)
 * Ids are stored in saves and sent on the wire: append only.
 */
import { Block, blockDef, canonicalBlock, CREATIVE_BLOCKS, isPlaceable } from '../blocks';
import type { StatusEffect } from '../combat';
import type { ProjectileKind } from '../entities/api';

export type ItemId = number;
export const FIRST_ITEM = 256;
export const MAX_ITEM = 511;

export enum ItemKind { Block = 0, Material = 1, Food = 2, Ammo = 3, Tool = 4, Sword = 5, Shield = 6, Bow = 7, Crossbow = 8, Special = 9 }
/** Same scale as BlockDef.minTier: 0 hand, 1 wood, 2 stone, 3 iron, 4 cobalt. */
export type Tier = 0 | 1 | 2 | 3 | 4;

export interface MeleeStats {
  damage: number;
  cooldown: number;
  reach: number;
  knockback: number;
  lift: number;
  shieldDisable: number;
  wear: number;
}

export interface RangedStats {
  type: 'bow' | 'crossbow';
  drawTime: number;
  minCharge: number;
  speedMin: number;
  speedMax: number;
  damageMin: number;
  damageMax: number;
  knockMin: number;
  knockMax: number;
  lift: number;
  ammo: readonly ItemId[];
  pierce?: number;
}

export interface ItemDef {
  id: ItemId;
  /** Stable string key (loot tables, mob drops, likes). */
  key: string;
  name: string;
  kind: ItemKind;
  maxStack: number;
  /** Atlas sprite tile (160..239); -1 for block items. */
  tile: number;
  color: number;
  /** 0 = none. */
  durability: number;
  tool?: { kind: 'pick' | 'axe' | 'shovel'; tier: Tier; speed: number };
  melee?: MeleeStats;
  food?: { food: number; heal: number };
  ranged?: RangedStats;
  shield?: { block: number };
  ammo?: { projectile: ProjectileKind; damageMul: number; bonus: number };
  /** Applied to targets on a melee hit or by the weapon's projectiles (boss uniques). */
  effects?: StatusEffect[];
  /** Shown in the sandbox Block Picker "Items" tab. */
  sandbox: boolean;
  /** Never sits in an inventory (Lost Satchel). */
  special?: boolean;
}

const ITEM_TABLE: (ItemDef | undefined)[] = [];
const BY_KEY = new Map<string, ItemId>();

/** Survival registers its items (256..383) here; throws on id or key overlap. */
export function registerItem(d: ItemDef): void {
  if (d.id < FIRST_ITEM || d.id > MAX_ITEM) throw new Error(`item id ${d.id} out of range`);
  if (ITEM_TABLE[d.id] || BY_KEY.has(d.key)) throw new Error(`item ${d.id} / ${d.key} registered twice`);
  ITEM_TABLE[d.id] = d;
  BY_KEY.set(d.key, d.id);
}

// Block items: every picker block (ladders as LadderNZ) plus Water for the sandbox picker.
for (const b of CREATIVE_BLOCKS) {
  const key = `block:${Block[b]}`;
  ITEM_TABLE[b] = { id: b, key, name: blockDef(b).name, kind: ItemKind.Block, maxStack: 64, tile: -1, color: blockDef(b).color, durability: 0, sandbox: true };
  BY_KEY.set(key, b);
}

export function itemDef(id: ItemId): ItemDef | undefined {
  return ITEM_TABLE[id];
}

/** 'iron_sword' -> 306, 'block:Torch' -> 112, unknown -> null. */
export function itemFromKey(key: string): ItemId | null {
  return BY_KEY.get(key) ?? null;
}

export function itemKey(id: ItemId): string | null {
  return ITEM_TABLE[id]?.key ?? null;
}

export function itemName(id: ItemId): string {
  return ITEM_TABLE[id]?.name ?? (id < FIRST_ITEM ? blockDef(id).name : 'Unknown item');
}

export function blockItem(block: number): ItemId {
  return canonicalBlock(block);
}

/** A block item a survival inventory may hold (placeable, not Water). */
export function isBlockItem(id: ItemId): boolean {
  return id < FIRST_ITEM && id !== Block.Water && isPlaceable(id) && canonicalBlock(id) === id;
}

/** Valid in a sandbox hotbar slot: a placeable block or a sandbox item. */
export function isSandboxSlotItem(id: ItemId): boolean {
  return (id < FIRST_ITEM && isPlaceable(id) && canonicalBlock(id) === id) || (id >= FIRST_ITEM && !!ITEM_TABLE[id]?.sandbox);
}

/** Items shown in the sandbox picker "Items" tab (ids >= 256 with sandbox), in id order. */
export function sandboxItems(): ItemId[] {
  const out: ItemId[] = [];
  for (let id = FIRST_ITEM; id <= MAX_ITEM; id++) if (ITEM_TABLE[id]?.sandbox) out.push(id);
  return out;
}

export function maxStack(id: ItemId): number {
  return ITEM_TABLE[id]?.maxStack ?? 1;
}

// ---- survival items (design-voxel-survival §5.2, §19.6) -------------------------------

/** Survival item ids (stored in saves, sent on the wire): append only. */
export enum Item {
  Stick = 256,
  PlantFiber = 257,
  Twine = 258,
  FlintShard = 259,
  Coal = 260,
  CopperIngot = 261,
  IronIngot = 262,
  GoldIngot = 263,
  CobaltGem = 264,
  EmberShard = 265,
  WildGrain = 266,
  Feather = 267,
  Fleece = 268,
  Hide = 269,
  Bone = 270,
  Silk = 271,
  Apple = 272,
  MelonSlice = 273,
  Bread = 274,
  MushroomSkewer = 275,
  RawMeat = 276,
  CookedMeat = 277,
  RawFish = 278,
  CookedFish = 279,
  Arrow = 280,
  EmberArrow = 281,
  Bolt = 282,
  GlowDust = 284,
  WoodenPickaxe = 288,
  StonePickaxe = 289,
  IronPickaxe = 290,
  CobaltPickaxe = 291,
  WoodenShovel = 292,
  StoneShovel = 293,
  IronShovel = 294,
  CobaltShovel = 295,
  WoodenAxe = 296,
  StoneAxe = 297,
  IronAxe = 298,
  CobaltAxe = 299,
  WoodenSword = 304,
  StoneSword = 305,
  IronSword = 306,
  CobaltSword = 307,
  WoodenShield = 308,
  IronShield = 309,
  CobaltShield = 310,
  Bow = 312,
  Crossbow = 313,
  CobaltCrossbow = 314,
  SunforgedSword = 316,
  RimeboundCrossbow = 317,
  ThornheartBow = 318,
  AshenAxe = 319,
  Satchel = 320,
  // package S: boss uniques of the generator-4 ruins, 321..336
  CoralfangBlade = 321,
  GaleshotBow = 322,
  RootsplitterAxe = 323,
  ForgeheartHammer = 324,
}

/** Fist (and any non-weapon item). */
export const FIST: MeleeStats = { damage: 1, cooldown: 0.35, reach: 2.8, knockback: 4.0, lift: 3.0, shieldDisable: 0, wear: 0 };

/** Tool tier palettes (main, light, dark): models, sprites, particles. Index = tier (0 = handle wood, 1..4). */
export const TIER_COLORS: readonly (readonly [number, number, number])[] = [
  [0x8a5a32, 0xb07a50, 0x5a3a1e],
  [0xb08850, 0xd8b070, 0x6a4a2a],
  [0x8c8f99, 0xb4b7c0, 0x5a5c64],
  [0xd8dde6, 0xffffff, 0x8a909c],
  [0x2f6fe0, 0x9cc8ff, 0x1a3a8a],
];
/** Boss unique palettes (main, accent). */
export const UNIQUE_COLORS: Readonly<Record<number, readonly [number, number]>> = {
  [Item.SunforgedSword]: [0xf2c63a, 0xff8a2a],
  [Item.RimeboundCrossbow]: [0xbfe8ff, 0x5a9ad8],
  [Item.ThornheartBow]: [0x3f8a3a, 0xc83a2a],
  [Item.AshenAxe]: [0x3a3a40, 0xff6a2a],
  [Item.CoralfangBlade]: [0xe8e2d0, 0x2ab8c8],
  [Item.GaleshotBow]: [0xdff4ff, 0x6ad8ff],
  [Item.RootsplitterAxe]: [0x8a5a2a, 0x7ae86a],
  [Item.ForgeheartHammer]: [0x4a4a52, 0xff7a2a],
};

const TIER_NAMES = ['', 'Wooden', 'Stone', 'Iron', 'Cobalt'] as const;
const TIER_KEYS = ['', 'wooden', 'stone', 'iron', 'cobalt'] as const;
const TIER_SPEED = [1, 2, 3.5, 5, 7];
const TIER_DURABILITY = [0, 60, 130, 250, 1200];

type ItemSpec = Omit<ItemDef, 'tile' | 'durability' | 'sandbox' | 'maxStack'> & Partial<Pick<ItemDef, 'tile' | 'durability' | 'sandbox' | 'maxStack'>>;
/** Sprite tiles follow the ids (256 -> 160) unless given. */
function reg(d: ItemSpec): void {
  registerItem({ tile: d.id - 96, durability: 0, sandbox: false, maxStack: 64, ...d });
}

// Materials (mob drops included).
const MATERIALS: [Item, string, string, number][] = [
  [Item.Stick, 'stick', 'Stick', 0x8a6a3a],
  [Item.PlantFiber, 'plant_fiber', 'Plant Fiber', 0x8ac84a],
  [Item.Twine, 'twine', 'Twine', 0xd8c49a],
  [Item.FlintShard, 'flint_shard', 'Flint Shard', 0x4a4a52],
  [Item.Coal, 'coal', 'Coal', 0x2a2a2e],
  [Item.CopperIngot, 'copper_ingot', 'Copper Ingot', 0xc8743a],
  [Item.IronIngot, 'iron_ingot', 'Iron Ingot', 0xd8dde6],
  [Item.GoldIngot, 'gold_ingot', 'Gold Ingot', 0xf2c63a],
  [Item.CobaltGem, 'cobalt_gem', 'Cobalt Gem', 0x2f6fe0],
  [Item.EmberShard, 'ember_shard', 'Ember Shard', 0xff6a2a],
  [Item.WildGrain, 'wild_grain', 'Wild Grain', 0xc8a040],
  [Item.Feather, 'feather', 'Feather', 0xf4f4f4],
  [Item.Fleece, 'fleece', 'Fleece', 0xf4f1ea],
  [Item.Hide, 'hide', 'Hide', 0x8a5a3a],
  [Item.Bone, 'bone', 'Bone', 0xe8e0d0],
  [Item.Silk, 'silk', 'Silk', 0xf4f4ff],
  [Item.GlowDust, 'glow_dust', 'Glow Dust', 0xffe8a0],
];
for (const [id, key, name, color] of MATERIALS) reg({ id, key, name, color, kind: ItemKind.Material });

// Food: [id, key, name, colour, food, heal].
const FOODS: [Item, string, string, number, number, number][] = [
  [Item.Apple, 'apple', 'Apple', 0xd23a3a, 4, 1],
  [Item.MelonSlice, 'melon_slice', 'Melon Slice', 0xe8584a, 2, 0],
  [Item.Bread, 'bread', 'Bread', 0xc8903a, 6, 1],
  [Item.MushroomSkewer, 'mushroom_skewer', 'Mushroom Skewer', 0xc83a2a, 6, 2],
  [Item.RawMeat, 'raw_meat', 'Raw Meat', 0xd86a6a, 2, 0],
  [Item.CookedMeat, 'cooked_meat', 'Cooked Meat', 0x8a4a2a, 8, 2],
  [Item.RawFish, 'raw_fish', 'Raw Fish', 0x6aa8c8, 2, 0],
  [Item.CookedFish, 'cooked_fish', 'Cooked Fish', 0xb07a4a, 6, 1],
];
for (const [id, key, name, color, food, heal] of FOODS) reg({ id, key, name, color, kind: ItemKind.Food, maxStack: 16, food: { food, heal }, sandbox: true });

// Ammo (WP0 ProjectileKind values: Arrow 1, Bolt 2, EmberArrow 8).
reg({ id: Item.Arrow, key: 'arrow', name: 'Arrow', color: 0x9a7a4a, kind: ItemKind.Ammo, ammo: { projectile: 1, damageMul: 1, bonus: 0 }, sandbox: true });
reg({ id: Item.EmberArrow, key: 'ember_arrow', name: 'Ember Arrow', color: 0xff6a2a, kind: ItemKind.Ammo, maxStack: 32, ammo: { projectile: 8, damageMul: 1, bonus: 3 }, sandbox: true });
reg({ id: Item.Bolt, key: 'bolt', name: 'Bolt', color: 0x6a4a2a, kind: ItemKind.Ammo, ammo: { projectile: 2, damageMul: 1, bonus: 0 }, sandbox: true });

// Tools and weapons by tier.
const SWORD_DMG = [0, 4, 5, 6, 8];
const AXE_DMG = [0, 5, 6, 7, 9];
const AXE_CD = [0, 0.9, 0.9, 0.85, 0.8];
for (const t of [1, 2, 3, 4] as const) {
  const [color] = TIER_COLORS[t];
  const common = { kind: ItemKind.Tool, maxStack: 1, color, durability: TIER_DURABILITY[t], sandbox: true };
  reg({ ...common, id: Item.WoodenPickaxe + t - 1, key: `${TIER_KEYS[t]}_pickaxe`, name: `${TIER_NAMES[t]} Pickaxe`, tool: { kind: 'pick', tier: t, speed: TIER_SPEED[t] },
    melee: { damage: t + 1, cooldown: 0.75, reach: 2.9, knockback: 4.2, lift: 3.2, shieldDisable: 0, wear: 2 } });
  reg({ ...common, id: Item.WoodenShovel + t - 1, key: `${TIER_KEYS[t]}_shovel`, name: `${TIER_NAMES[t]} Shovel`, tool: { kind: 'shovel', tier: t, speed: TIER_SPEED[t] },
    melee: { damage: t + 0.5, cooldown: 0.75, reach: 2.9, knockback: 4.2, lift: 3.2, shieldDisable: 0, wear: 2 } });
  reg({ ...common, id: Item.WoodenAxe + t - 1, key: `${TIER_KEYS[t]}_axe`, name: `${TIER_NAMES[t]} Axe`, tool: { kind: 'axe', tier: t, speed: TIER_SPEED[t] },
    melee: { damage: AXE_DMG[t], cooldown: AXE_CD[t], reach: 3.0, knockback: 5.8, lift: 4.0, shieldDisable: 1.6, wear: 1 } });
  reg({ ...common, kind: ItemKind.Sword, id: Item.WoodenSword + t - 1, key: `${TIER_KEYS[t]}_sword`, name: `${TIER_NAMES[t]} Sword`,
    melee: { damage: SWORD_DMG[t], cooldown: t === 4 ? 0.5 : 0.55, reach: 3.2, knockback: 5.0, lift: 3.6, shieldDisable: 0, wear: 1 } });
}

// Shields.
reg({ id: Item.WoodenShield, key: 'wooden_shield', name: 'Wooden Shield', color: 0x9a6b3c, kind: ItemKind.Shield, maxStack: 1, durability: 150, shield: { block: 0.7 }, sandbox: true });
reg({ id: Item.IronShield, key: 'iron_shield', name: 'Iron Shield', color: 0xb8bec8, kind: ItemKind.Shield, maxStack: 1, durability: 336, shield: { block: 0.85 }, sandbox: true });
reg({ id: Item.CobaltShield, key: 'cobalt_shield', name: 'Cobalt Shield', color: 0x2f6fe0, kind: ItemKind.Shield, maxStack: 1, durability: 1000, shield: { block: 1 }, sandbox: true });

// Bows and crossbows (ammo lists = accepted ammo).
const BOW_AMMO = [Item.Arrow, Item.EmberArrow] as const;
const XBOW_AMMO = [Item.Bolt, Item.EmberArrow, Item.Arrow] as const;
reg({ id: Item.Bow, key: 'bow', name: 'Bow', color: 0x8a5a32, kind: ItemKind.Bow, maxStack: 1, durability: 220, sandbox: true,
  ranged: { type: 'bow', drawTime: 0.9, minCharge: 0.2, speedMin: 12, speedMax: 38, damageMin: 2, damageMax: 9, knockMin: 2, knockMax: 5, lift: 2, ammo: BOW_AMMO } });
reg({ id: Item.Crossbow, key: 'crossbow', name: 'Crossbow', color: 0xd8dde6, kind: ItemKind.Crossbow, maxStack: 1, durability: 300, sandbox: true,
  ranged: { type: 'crossbow', drawTime: 1.25, minCharge: 1, speedMin: 48, speedMax: 48, damageMin: 11, damageMax: 11, knockMin: 4.5, knockMax: 4.5, lift: 2.5, ammo: XBOW_AMMO } });
reg({ id: Item.CobaltCrossbow, key: 'cobalt_crossbow', name: 'Cobalt Crossbow', color: 0x2f6fe0, kind: ItemKind.Crossbow, maxStack: 1, durability: 900, sandbox: true,
  ranged: { type: 'crossbow', drawTime: 1.0, minCharge: 1, speedMin: 54, speedMax: 54, damageMin: 14, damageMax: 14, knockMin: 5, knockMax: 5, lift: 2.5, ammo: XBOW_AMMO } });

// Boss uniques (design-voxel-survival §19.6). Effects: StatusKind Slow 1, Burn 2.
reg({ id: Item.SunforgedSword, key: 'sunforged_sword', name: 'Sunforged Sword', tile: 221, color: 0xf2c63a, kind: ItemKind.Sword, maxStack: 1, durability: 1500, sandbox: true,
  melee: { damage: 8, cooldown: 0.6, reach: 3.3, knockback: 5.0, lift: 3.6, shieldDisable: 0, wear: 1 }, effects: [{ kind: 2, strength: 1, seconds: 3 }] });
reg({ id: Item.RimeboundCrossbow, key: 'rimebound_crossbow', name: 'Rimebound Crossbow', tile: 222, color: 0xbfe8ff, kind: ItemKind.Crossbow, maxStack: 1, durability: 1200, sandbox: true,
  ranged: { type: 'crossbow', drawTime: 1.1, minCharge: 1, speedMin: 52, speedMax: 52, damageMin: 12, damageMax: 12, knockMin: 5, knockMax: 5, lift: 2.5, ammo: XBOW_AMMO },
  effects: [{ kind: 1, strength: 0.35, seconds: 2.5 }] });
reg({ id: Item.ThornheartBow, key: 'thornheart_bow', name: 'Thornheart Bow', tile: 223, color: 0x3f8a3a, kind: ItemKind.Bow, maxStack: 1, durability: 1200, sandbox: true,
  ranged: { type: 'bow', drawTime: 0.75, minCharge: 0.2, speedMin: 12, speedMax: 40, damageMin: 2, damageMax: 10, knockMin: 2, knockMax: 5, lift: 2, ammo: BOW_AMMO, pierce: 1 } });
reg({ id: Item.AshenAxe, key: 'ashen_axe', name: 'Ashen Axe', tile: 224, color: 0x3a3a40, kind: ItemKind.Tool, maxStack: 1, durability: 1500, sandbox: true,
  tool: { kind: 'axe', tier: 4, speed: 8 }, melee: { damage: 10, cooldown: 0.95, reach: 3.0, knockback: 6.2, lift: 4.2, shieldDisable: 2.5, wear: 1 } });

// Package S uniques. Effects: StatusKind Slow 1, Burn 2.
reg({ id: Item.CoralfangBlade, key: 'coralfang_blade', name: 'Coralfang Blade', color: 0xe8e2d0, kind: ItemKind.Sword, maxStack: 1, durability: 1500, sandbox: true,
  melee: { damage: 8, cooldown: 0.5, reach: 3.4, knockback: 4.5, lift: 3.4, shieldDisable: 0, wear: 1 }, effects: [{ kind: 1, strength: 0.4, seconds: 2.5 }] });
reg({ id: Item.GaleshotBow, key: 'galeshot_bow', name: 'Galeshot Bow', color: 0xdff4ff, kind: ItemKind.Bow, maxStack: 1, durability: 1300, sandbox: true,
  ranged: { type: 'bow', drawTime: 0.6, minCharge: 0.2, speedMin: 18, speedMax: 52, damageMin: 3, damageMax: 11, knockMin: 2, knockMax: 6, lift: 2, ammo: BOW_AMMO, pierce: 2 } });
reg({ id: Item.RootsplitterAxe, key: 'rootsplitter_axe', name: 'Rootsplitter Axe', color: 0x8a5a2a, kind: ItemKind.Tool, maxStack: 1, durability: 1600, sandbox: true,
  tool: { kind: 'axe', tier: 4, speed: 9 }, melee: { damage: 10, cooldown: 0.9, reach: 3.1, knockback: 6.4, lift: 4.2, shieldDisable: 2.5, wear: 1 } });
reg({ id: Item.ForgeheartHammer, key: 'forgeheart_hammer', name: 'Forgeheart Hammer', color: 0x4a4a52, kind: ItemKind.Tool, maxStack: 1, durability: 1800, sandbox: true,
  tool: { kind: 'pick', tier: 4, speed: 10 }, melee: { damage: 11, cooldown: 1.0, reach: 3.0, knockback: 7.0, lift: 4.6, shieldDisable: 3, wear: 1 }, effects: [{ kind: 2, strength: 1, seconds: 3 }] });

reg({ id: Item.Satchel, key: 'satchel', name: 'Lost Satchel', tile: 220, color: 0x8a6a3a, kind: ItemKind.Special, maxStack: 1, special: true });

/** Melee stats of what is held (fist for non-weapons). */
export function meleeOf(id: ItemId): MeleeStats {
  return ITEM_TABLE[id]?.melee ?? FIST;
}

/** Tier of a tool, weapon or shield item (0 for anything else); boss uniques count as cobalt. */
export function itemTier(id: ItemId): Tier {
  if (id >= Item.WoodenPickaxe && id <= Item.CobaltSword) return (((id - Item.WoodenPickaxe) % 4) + 1) as Tier;
  if (id === Item.WoodenShield) return 1;
  if (id === Item.IronShield || id === Item.Crossbow) return 3;
  if (id === Item.CobaltShield || id === Item.CobaltCrossbow || (id >= Item.SunforgedSword && id <= Item.AshenAxe) || (id >= Item.CoralfangBlade && id <= Item.ForgeheartHammer)) return 4;
  return 0;
}

/** Every registered survival item id (256..511), in id order. */
export function survivalItemIds(): ItemId[] {
  const out: ItemId[] = [];
  for (let id = FIRST_ITEM; id <= MAX_ITEM; id++) if (ITEM_TABLE[id]) out.push(id);
  return out;
}
