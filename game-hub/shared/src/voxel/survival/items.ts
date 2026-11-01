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
