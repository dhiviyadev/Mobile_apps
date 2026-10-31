/**
 * Crafting and smelting (design-voxel-survival §8, §19.6): a recipe list with
 * three stations (hand anywhere, Workbench and Furnace within 4 blocks).
 * Smelting is instant and costs one fuel per item. Recipe ids travel on the
 * wire (`i` craft op): stable, append only.
 */
import { Block } from '../blocks';
import type { BlockQuery } from '../physics';
import { SURVIVAL } from './constants';
import type { Inventory, ItemStack } from './inventory';
import { Item, type ItemId } from './items';

export enum Station {
  Hand = 0,
  Workbench = 1,
  Furnace = 2,
}
export const StationFlags = { Workbench: 1, Furnace: 2 } as const;
const stationFlag = (s: Station): number => (s === Station.Workbench ? StationFlags.Workbench : s === Station.Furnace ? StationFlags.Furnace : 0);

export type ItemTag = 'planks' | 'logs' | 'rock' | 'cloth' | 'sand' | 'fuel';
export type Ingredient = { item: ItemId; n: number } | { tag: ItemTag; n: number };

const LOGS = [Block.Log, Block.AspenLog, Block.PineLog, Block.MahoganyLog, Block.ThornwoodLog, Block.DuskwoodLog];
const PLANKS = [Block.Planks, Block.AspenPlanks, Block.PinePlanks, Block.MahoganyPlanks, Block.ThornwoodPlanks, Block.DuskwoodPlanks];
export const TAGS: Readonly<Record<ItemTag, readonly ItemId[]>> = {
  planks: PLANKS,
  logs: LOGS,
  rock: [Block.Cobble, Block.MossyCobble, Block.Granite, Block.Basalt, Block.Slate],
  cloth: [Block.ClothWhite, Block.ClothRed, Block.ClothOrange, Block.ClothYellow, Block.ClothGreen, Block.ClothBlue, Block.ClothPurple, Block.ClothBlack],
  sand: [Block.Sand, Block.RedSand],
  fuel: [Item.Coal, ...LOGS, ...PLANKS],
};
export const TAG_LABELS: Readonly<Record<ItemTag, string>> = { planks: 'any planks', logs: 'any log', rock: 'any rock', cloth: 'any cloth', sand: 'any sand', fuel: 'fuel' };

export type RecipeCategory = 'tools' | 'weapons' | 'blocks' | 'food' | 'materials';
export interface Recipe {
  id: number;
  station: Station;
  /** At most 4 entries; furnace recipes list their fuel last. */
  inputs: readonly Ingredient[];
  output: ItemId;
  count: number;
  category: RecipeCategory;
}

const it = (item: ItemId, n = 1): Ingredient => ({ item, n });
const tg = (tag: ItemTag, n = 1): Ingredient => ({ tag, n });
const FUEL = tg('fuel');
const list: Recipe[] = [];
const add = (id: number, station: Station, output: ItemId, count: number, category: RecipeCategory, ...inputs: Ingredient[]) =>
  list.push({ id, station, inputs, output, count, category });
const H = Station.Hand;
const W = Station.Workbench;
const F = Station.Furnace;

// Hand.
LOGS.forEach((log, i) => add(1 + i, H, PLANKS[i], 4, 'blocks', it(log)));
add(7, H, Item.Stick, 4, 'materials', tg('planks', 2));
add(8, H, Block.Workbench, 1, 'blocks', tg('planks', 4));
add(9, H, Item.Twine, 1, 'materials', it(Item.PlantFiber, 3));
add(10, H, Block.Torch, 4, 'blocks', it(Item.Stick), it(Item.Coal));
add(11, H, Item.MushroomSkewer, 1, 'food', it(Item.Stick), it(Block.RedMushroom), it(Block.BrownMushroom));

// Workbench: tools and weapons (pickaxe, shovel, axe, sword per tier).
const HEADS = [3, 1, 3, 2];
const STICKS = [2, 2, 2, 1];
const FIRSTS = [Item.WoodenPickaxe, Item.WoodenShovel, Item.WoodenAxe, Item.WoodenSword];
const tierMaterial: Ingredient[] = [tg('planks'), tg('rock'), it(Item.IronIngot), it(Item.CobaltGem)];
for (let tier = 0; tier < 4; tier++) {
  for (let k = 0; k < 4; k++) {
    const head = { ...tierMaterial[tier], n: HEADS[k] } as Ingredient;
    const extra = tier === 3 ? [it(Item.GoldIngot)] : [];
    add(20 + tier * 4 + k, W, FIRSTS[k] + tier, 1, k === 3 ? 'weapons' : 'tools', head, ...extra, it(Item.Stick, STICKS[k]));
  }
}
add(36, W, Item.WoodenShield, 1, 'weapons', tg('planks', 6), it(Item.CopperIngot));
add(37, W, Item.IronShield, 1, 'weapons', it(Item.IronIngot, 4), tg('planks', 2));
add(38, W, Item.CobaltShield, 1, 'weapons', it(Item.CobaltGem, 4), it(Item.GoldIngot, 2), tg('planks', 2));
add(39, W, Item.Bow, 1, 'weapons', it(Item.Stick, 3), it(Item.Twine, 3));
add(40, W, Item.Crossbow, 1, 'weapons', tg('planks', 3), it(Item.IronIngot), it(Item.CopperIngot), it(Item.Twine, 2));
add(41, W, Item.CobaltCrossbow, 1, 'weapons', it(Item.Crossbow), it(Item.CobaltGem, 3), it(Item.GoldIngot));
add(42, W, Item.Arrow, 4, 'weapons', it(Item.Stick), it(Item.FlintShard), it(Item.PlantFiber));
add(43, W, Item.Arrow, 6, 'weapons', it(Item.Stick), it(Item.FlintShard), it(Item.Feather));
add(44, W, Item.EmberArrow, 4, 'weapons', it(Item.Arrow, 4), it(Item.EmberShard));
add(45, W, Item.Bolt, 4, 'weapons', it(Item.CopperIngot), it(Item.Stick, 2));

// Workbench: utility and building.
add(46, W, Block.Chest, 1, 'blocks', tg('planks', 8));
add(47, W, Block.Furnace, 1, 'blocks', tg('rock', 8));
add(48, W, Block.LadderNZ, 3, 'blocks', it(Item.Stick, 7));
add(49, W, Block.Bedroll, 1, 'blocks', tg('cloth', 3), tg('planks', 3));
add(50, W, Block.ClothWhite, 1, 'blocks', it(Item.PlantFiber, 4));
add(51, W, Block.ClothWhite, 1, 'blocks', it(Item.Fleece, 2));
add(52, W, Block.ClothRed, 1, 'blocks', it(Block.ClothWhite), it(Block.Rosette));
add(53, W, Block.ClothOrange, 2, 'blocks', it(Block.ClothWhite, 2), it(Block.Sunpetal), it(Block.Rosette));
add(54, W, Block.ClothYellow, 1, 'blocks', it(Block.ClothWhite), it(Block.Sunpetal));
add(55, W, Block.ClothGreen, 1, 'blocks', it(Block.ClothWhite), it(Block.Fern));
add(56, W, Block.ClothBlue, 1, 'blocks', it(Block.ClothWhite), it(Block.Bluebell));
add(57, W, Block.ClothPurple, 1, 'blocks', it(Block.ClothWhite), it(Block.Duskcap));
add(58, W, Block.ClothBlack, 1, 'blocks', it(Block.ClothWhite), it(Item.Coal));
add(59, W, Item.Bread, 1, 'food', it(Item.WildGrain, 3));
add(60, W, Block.HayBale, 1, 'blocks', it(Item.WildGrain, 9));
add(61, W, Block.StoneBricks, 4, 'blocks', it(Block.Stone, 4));
add(62, W, Block.PolishedStone, 4, 'blocks', it(Block.StoneBricks, 4));
add(63, W, Block.MossyStoneBricks, 1, 'blocks', it(Block.StoneBricks), it(Block.HangingMoss));
add(64, W, Block.MossyCobble, 1, 'blocks', it(Block.Cobble), it(Block.HangingMoss));
add(65, W, Block.Sandstone, 1, 'blocks', it(Block.Sand, 4));
add(66, W, Block.RedSandstone, 1, 'blocks', it(Block.RedSand, 4));
add(67, W, Block.SandstoneBricks, 4, 'blocks', it(Block.Sandstone, 4));
add(68, W, Block.BasaltBricks, 4, 'blocks', it(Block.Basalt, 4));
add(69, W, Block.IceBricks, 4, 'blocks', it(Block.PackedIce, 4));
add(70, W, Block.MarblePillar, 2, 'blocks', it(Block.Marble, 2));
const SLABS: [Block, Block][] = [[Block.StoneSlab, Block.Stone], [Block.CobbleSlab, Block.Cobble], [Block.PlankSlab, Block.Planks], [Block.SandstoneSlab, Block.Sandstone], [Block.StoneBrickSlab, Block.StoneBricks]];
SLABS.forEach(([slab, from], i) => add(71 + i, W, slab, 6, 'blocks', it(from, 3)));
add(76, W, Block.Bookshelf, 1, 'blocks', tg('planks', 6), it(Block.Reeds, 3));
add(77, W, Block.Lantern, 1, 'blocks', it(Block.Torch), it(Item.CopperIngot));
add(78, W, Block.Lamp, 1, 'blocks', it(Block.Glass), it(Block.Torch), it(Item.GoldIngot));
const TINTS: [Block, Block][] = [[Block.GlassRed, Block.Rosette], [Block.GlassBlue, Block.Bluebell], [Block.GlassGreen, Block.Fern], [Block.GlassAmber, Block.Sunpetal]];
TINTS.forEach(([glass, dye], i) => add(79 + i, W, glass, 4, 'blocks', it(Block.Glass, 4), it(dye)));

// Mob-drop recipes (§19.6).
add(84, H, Item.Twine, 2, 'materials', it(Item.Silk));
add(85, W, Item.Arrow, 4, 'weapons', it(Item.Stick), it(Item.Bone), it(Item.PlantFiber));
add(86, W, Block.Lamp, 1, 'blocks', it(Block.Glass), it(Item.GlowDust, 2));
add(87, W, Block.Bedroll, 1, 'blocks', it(Item.Hide, 2), tg('planks', 3));
add(88, H, Block.Torch, 6, 'blocks', it(Item.Stick, 2), it(Item.GlowDust));

// Furnace (one fuel each).
add(100, F, Item.CopperIngot, 1, 'materials', it(Block.CopperOre), FUEL);
add(101, F, Item.IronIngot, 1, 'materials', it(Block.IronOre), FUEL);
add(102, F, Item.GoldIngot, 1, 'materials', it(Block.GoldOre), FUEL);
add(103, F, Block.Stone, 1, 'blocks', it(Block.Cobble), FUEL);
add(104, F, Block.Glass, 1, 'blocks', tg('sand'), FUEL);
add(105, F, Block.Brick, 1, 'blocks', it(Block.Clay), FUEL);
add(106, F, Block.MudBricks, 1, 'blocks', it(Block.Mud), FUEL);
add(107, F, Item.CookedMeat, 1, 'food', it(Item.RawMeat), FUEL);
add(108, F, Item.Coal, 1, 'materials', tg('logs'), FUEL);
add(109, F, Item.CookedFish, 1, 'food', it(Item.RawFish), FUEL);

export const RECIPES: readonly Recipe[] = list;
const BY_ID = new Map(list.map((r) => [r.id, r]));

export function recipeById(id: number): Recipe | undefined {
  return BY_ID.get(id);
}

export const STATION_BLOCKS: Readonly<Record<number, Station>> = { [Block.Workbench]: Station.Workbench, [Block.Furnace]: Station.Furnace };

/** Station bits within stationRadius (Chebyshev 4 horizontally, |dy| <= 3) of the feet cell. */
export function stationsNear(get: BlockQuery, x: number, y: number, z: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const r = SURVIVAL.stationRadius;
  let flags = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = get(fx + dx, fy + dy, fz + dz);
        if (b === Block.Workbench) flags |= StationFlags.Workbench;
        else if (b === Block.Furnace) flags |= StationFlags.Furnace;
        if (flags === 3) return flags;
      }
    }
  }
  return flags;
}

export function canUseStation(r: Recipe, stations: number): boolean {
  return r.station === Station.Hand || (stations & stationFlag(r.station)) !== 0;
}

const members = (ing: Ingredient): readonly ItemId[] => ('item' in ing ? [ing.item] : TAGS[ing.tag]);

/**
 * How many times the recipe can be made from these counts (<= 64). Specific
 * items are counted first, then tags (fuel last), so a log used as the input
 * of "log -> coal" is not also counted as its fuel.
 */
function timesFrom(counts: Map<ItemId, number>, r: Recipe): number {
  const order = [...r.inputs].sort((a, b) => ('item' in a ? 0 : 1) - ('item' in b ? 0 : 1));
  let lo = 0;
  let hi = 64;
  // Binary search on the times (consumption is greedy and monotone).
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const left = new Map(counts);
    let ok = true;
    for (const ing of order) {
      let need = ing.n * mid;
      for (const m of members(ing)) {
        const have = left.get(m) ?? 0;
        const k = Math.min(have, need);
        left.set(m, have - k);
        need -= k;
        if (need === 0) break;
      }
      if (need > 0) {
        ok = false;
        break;
      }
    }
    if (ok) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function countsOf(inv: Inventory): Map<ItemId, number> {
  const m = new Map<ItemId, number>();
  for (let i = 0; i < inv.size; i++) if (inv.counts[i]) m.set(inv.items[i], (m.get(inv.items[i]) ?? 0) + inv.counts[i]);
  return m;
}

export function maxCraftable(inv: Inventory, r: Recipe): number {
  return timesFrom(countsOf(inv), r);
}

/**
 * Consumes the inputs `times` times and adds the output. Returns the output
 * that did not fit (the sim drops it at the feet). Call only after maxCraftable.
 * A loaded crossbow upgraded into a cobalt one gives its ammo back.
 */
export function craft(inv: Inventory, r: Recipe, times: number): ItemStack[] {
  const order = [...r.inputs].sort((a, b) => ('item' in a ? 0 : 1) - ('item' in b ? 0 : 1));
  const overflow: ItemStack[] = [];
  for (const ing of order) {
    let need = ing.n * times;
    for (const m of members(ing)) {
      if (need === 0) break;
      if (m === Item.Crossbow) {
        // Return a loaded bolt/arrow before the crossbow is consumed.
        for (let i = 0; i < inv.size && need > 0; i++) {
          if (inv.items[i] !== Item.Crossbow || !inv.counts[i]) continue;
          const load = (inv.metas[i] >> 12) & 3;
          if (load) overflow.push({ item: load === 2 ? Item.Bolt : load === 3 ? Item.EmberArrow : Item.Arrow, count: 1, meta: 0 });
          inv.set(i, null);
          need--;
        }
      } else need -= inv.take(m, need);
    }
  }
  const left = inv.add(r.output, r.count * times, 0);
  const out: ItemStack[] = [];
  for (const s of overflow) {
    const l = inv.add(s.item, s.count, 0);
    if (l > 0) out.push({ ...s, count: l });
  }
  if (left > 0) out.push({ item: r.output, count: left, meta: 0 });
  return out;
}

/** The InvEnv craft hook: validates station and counts, then crafts. */
export function craftOp(inv: Inventory, recipe: number, times: number, stations: number, out: ItemStack[]): boolean {
  const r = recipeById(recipe);
  if (!r || !canUseStation(r, stations)) return false;
  const n = Math.min(times, maxCraftable(inv, r));
  if (n < 1) return false;
  out.push(...craft(inv, r, n));
  return true;
}
