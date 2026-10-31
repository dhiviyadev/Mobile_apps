/**
 * Survival mining: break times by tool, harvest rules and block drops
 * (design-voxel-survival §7). Sandbox keeps the plain hardness timing.
 */
import { Block, blockDef, canonicalBlock } from '../blocks';
import { SURVIVAL } from './constants';
import type { ItemStack } from './inventory';
import { Item, type ItemId, itemDef } from './items';

/** True when breaking `block` with `held` gives drops (right tool of a high enough tier, or no tier needed). */
export function canHarvest(block: number, held: ItemId): boolean {
  const d = blockDef(block);
  if (d.minTier === 0) return true;
  const t = itemDef(held)?.tool;
  return !!t && t.kind === d.tool && t.tier >= d.minTier;
}

/** Seconds to break `block` holding `held` in survival. */
export function breakSeconds(block: number, held: ItemId): number {
  const d = blockDef(block);
  const t = itemDef(held)?.tool;
  let s = d.hardness * SURVIVAL.hardnessScale;
  if (t && d.tool !== 'none' && t.kind === d.tool) s /= t.speed;
  if (!canHarvest(block, held)) s *= SURVIVAL.wrongToolPenalty;
  return Math.max(0.05, s);
}

/** Durability used by breaking `block` with `held`: 1 with the matching tool, 2 with any other tool or weapon, 0 by hand or for instant blocks. */
export function breakWear(block: number, held: ItemId): number {
  const def = itemDef(held);
  if (!def || def.durability === 0 || blockDef(block).hardness <= 0 || def.ranged || def.shield) return 0;
  return def.tool && def.tool.kind === blockDef(block).tool ? 1 : 2;
}

const LEAVES = new Set<number>([Block.Leaves, Block.AspenLeaves, Block.PineLeaves, Block.MahoganyLeaves, Block.ThornwoodLeaves, Block.DuskwoodLeaves]);
const APPLE_LEAVES = new Set<number>([Block.Leaves, Block.AspenLeaves, Block.MahoganyLeaves]);
const NO_DROP = new Set<number>([Block.Glass, Block.GlassRed, Block.GlassBlue, Block.GlassGreen, Block.GlassAmber, Block.Ice, Block.SnowLayer]);
const SOIL = new Set<number>([Block.Grass, Block.SnowyGrass, Block.ForestFloor, Block.ParchedGrass]);
const SIMPLE: Readonly<Record<number, ItemId>> = {
  [Block.Stone]: Block.Cobble,
  [Block.CoalOre]: Item.Coal,
  [Block.CobaltOre]: Item.CobaltGem,
  [Block.EmberOre]: Item.EmberShard,
};

/**
 * What breaking `block` with `held` drops (nothing unless canHarvest).
 * Chest contents are spilled by the sim, not here.
 */
export function blockDrops(block: number, held: ItemId, rng: () => number): ItemStack[] {
  if (!canHarvest(block, held) || !blockDef(block).breakable) return [];
  const one = (item: ItemId, count = 1): ItemStack => ({ item, count, meta: 0 });
  const out: ItemStack[] = [];
  if (NO_DROP.has(block)) return out;
  if (SOIL.has(block)) return [one(Block.Dirt)];
  if (SIMPLE[block] !== undefined) return [one(SIMPLE[block])];
  if (LEAVES.has(block)) {
    if (rng() < 0.15) out.push(one(block));
    if (rng() < 0.06) out.push(one(Item.Stick));
    if (APPLE_LEAVES.has(block) && rng() < 0.04) out.push(one(Item.Apple));
    return out;
  }
  switch (block) {
    case Block.Gravel:
      return [rng() < 0.15 ? one(Item.FlintShard) : one(Block.Gravel)];
    case Block.TallGrass:
      if (rng() < 0.12) out.push(one(Item.WildGrain));
      if (rng() < 0.2) out.push(one(Item.PlantFiber));
      return out;
    case Block.DryGrass:
      if (rng() < 0.3) out.push(one(Item.PlantFiber));
      if (rng() < 0.08) out.push(one(Item.WildGrain));
      return out;
    case Block.Fern:
      if (rng() < 0.5) out.push(one(Block.Fern));
      if (rng() < 0.15) out.push(one(Item.PlantFiber));
      return out;
    case Block.DeadBush:
      return [one(Item.Stick, rng() < 0.5 ? 1 : 2)];
    case Block.Reeds:
      out.push(one(Block.Reeds));
      if (rng() < 0.2) out.push(one(Item.PlantFiber));
      return out;
    case Block.Melon:
      return [one(Item.MelonSlice, 3 + Math.floor(rng() * 3))];
  }
  return [one(canonicalBlock(block))];
}
