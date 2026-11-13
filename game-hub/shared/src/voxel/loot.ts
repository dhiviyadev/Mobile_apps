/**
 * Structure chest loot (data owned by the world area). Items are string keys:
 * survival item keys ('iron_sword') or 'block:<Block enum name>'. The survival
 * registry resolves them (itemFromKey); unknown keys are skipped with a dev warning.
 * A unit test (survival) asserts that every key here resolves.
 */
import { mulberry32 } from '../util/rng';

export enum LootTableId {
  TempleCommon = 1,
  TempleBoss = 2,
  CitadelCommon = 3,
  CitadelBoss = 4,
  ShrineCommon = 5,
  ShrineBoss = 6,
  CryptCommon = 7,
  CryptBoss = 8,
  // package S (generator 4): 9..16
  LighthouseCommon = 9,
  LighthouseBoss = 10,
  AerieCommon = 11,
  AerieBoss = 12,
  GroveCommon = 13,
  GroveBoss = 14,
  ForgeCommon = 15,
  ForgeBoss = 16,
}

export interface LootEntry {
  item: string;
  weight: number;
  count: [number, number];
}

export interface LootTable {
  rolls: [number, number];
  guaranteed: { oneOf: string[]; count: [number, number] }[];
  entries: LootEntry[];
}

const e = (item: string, weight: number, min: number, max = min): LootEntry => ({ item, weight, count: [min, max] });
const g = (oneOf: string[], min = 1, max = min) => ({ oneOf, count: [min, max] as [number, number] });

export const LOOT_TABLES: Partial<Record<LootTableId, LootTable>> = {
  [LootTableId.TempleCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('gold_ingot', 4, 1, 3), e('copper_ingot', 4, 2, 4), e('bread', 5, 1, 3), e('arrow', 5, 4, 10), e('bow', 1, 1), e('iron_sword', 1, 1), e('block:SandstoneBricks', 2, 8, 16), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.TempleBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_sword', 'cobalt_axe', 'cobalt_crossbow']), g(['gold_ingot'], 4, 8)],
    entries: [e('cobalt_gem', 4, 1, 3), e('gold_ingot', 4, 2, 5), e('arrow', 3, 8, 16), e('iron_shield', 2, 1)],
  },
  [LootTableId.CitadelCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('iron_ingot', 5, 2, 4), e('bolt', 4, 6, 12), e('cooked_meat', 4, 1, 3), e('crossbow', 1, 1), e('iron_axe', 1, 1), e('block:Lantern', 2, 1, 2), e('block:PackedIce', 2, 4, 8)],
  },
  [LootTableId.CitadelBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_shield']), g(['cobalt_crossbow', 'cobalt_sword'])],
    entries: [e('cobalt_gem', 4, 1, 3), e('iron_ingot', 4, 4, 8), e('bolt', 3, 12, 20)],
  },
  [LootTableId.ShrineCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('arrow', 5, 6, 12), e('apple', 4, 2, 4), e('block:Melon', 3, 1, 2), e('copper_ingot', 3, 2, 5), e('bow', 2, 1), e('block:MossyStoneBricks', 2, 8, 16), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.ShrineBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_sword', 'cobalt_axe']), g(['arrow'], 16, 32)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 4), e('ember_shard', 1, 1)],
  },
  [LootTableId.CryptCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('coal', 5, 3, 8), e('block:Torch', 4, 4, 8), e('iron_ingot', 4, 1, 3), e('bread', 3, 1, 2), e('ember_shard', 1, 1), e('iron_axe', 1, 1), e('iron_sword', 1, 1)],
  },
  [LootTableId.CryptBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_axe', 'cobalt_sword', 'cobalt_shield']), g(['ember_shard'], 1, 2)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 4), e('iron_ingot', 3, 3, 6)],
  },
  [LootTableId.LighthouseCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('raw_fish', 4, 2, 4), e('cooked_fish', 4, 1, 3), e('iron_ingot', 4, 2, 4), e('arrow', 4, 6, 12), e('block:Lantern', 3, 1, 2), e('block:WhitewashBricks', 3, 8, 16), e('bow', 1, 1), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.LighthouseBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_sword', 'cobalt_shield', 'cobalt_crossbow']), g(['cooked_fish'], 4, 8)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 5), e('block:BeaconLens', 2, 1, 2)],
  },
  [LootTableId.AerieCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('feather', 5, 4, 10), e('arrow', 5, 6, 14), e('iron_ingot', 4, 2, 4), e('bow', 2, 1), e('block:CloudstoneBricks', 3, 8, 16), e('cooked_meat', 3, 1, 3), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.AerieBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_crossbow', 'cobalt_sword', 'cobalt_axe']), g(['feather'], 8, 16)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 5), e('block:GaleRune', 2, 2, 4)],
  },
  [LootTableId.GroveCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('apple', 5, 2, 5), e('block:Heartwood', 3, 8, 16), e('arrow', 4, 6, 12), e('copper_ingot', 3, 2, 5), e('bread', 3, 1, 3), e('block:GlowcapBlock', 2, 2, 4), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.GroveBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_axe', 'cobalt_shield', 'cobalt_sword']), g(['apple'], 4, 8)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 4), e('block:VerdantRune', 2, 2, 4)],
  },
  [LootTableId.ForgeCommon]: {
    rolls: [3, 5],
    guaranteed: [],
    entries: [e('coal', 5, 4, 10), e('iron_ingot', 5, 2, 5), e('ember_shard', 3, 1, 2), e('iron_axe', 1, 1), e('iron_sword', 1, 1), e('block:SlagBricks', 3, 8, 16), e('cooked_meat', 3, 1, 3), e('cobalt_gem', 1, 1)],
  },
  [LootTableId.ForgeBoss]: {
    rolls: [4, 6],
    guaranteed: [g(['cobalt_axe', 'cobalt_sword', 'cobalt_shield']), g(['ember_shard'], 2, 4)],
    entries: [e('cobalt_gem', 4, 2, 3), e('gold_ingot', 3, 2, 5), e('iron_ingot', 3, 4, 8)],
  },
};

/** Every item key the loot tables can produce (tests: all must resolve in the survival registry). */
export function lootKeys(): string[] {
  const keys = new Set<string>();
  for (const t of Object.values(LOOT_TABLES) as LootTable[]) {
    for (const gr of t.guaranteed) for (const k of gr.oneOf) keys.add(k);
    for (const en of t.entries) keys.add(en.item);
  }
  return [...keys];
}

/**
 * Deterministic loot: mulberry32(seed). Guaranteed picks first, then `rolls`
 * weighted picks; the same item is merged; at most 12 stacks.
 */
export function rollLoot(id: LootTableId, seed: number): { item: string; count: number }[] {
  const table = LOOT_TABLES[id];
  if (!table) return [];
  const rnd = mulberry32(seed >>> 0);
  const range = (r: [number, number]) => r[0] + Math.floor(rnd() * (r[1] - r[0] + 1));
  const out = new Map<string, number>();
  const add = (item: string, n: number) => {
    if (n <= 0 || (!out.has(item) && out.size >= 12)) return;
    out.set(item, (out.get(item) ?? 0) + n);
  };
  for (const gr of table.guaranteed) add(gr.oneOf[Math.floor(rnd() * gr.oneOf.length)], range(gr.count));
  const total = table.entries.reduce((s, en) => s + en.weight, 0);
  const rolls = range(table.rolls);
  for (let i = 0; i < rolls; i++) {
    let r = rnd() * total;
    for (const en of table.entries) {
      r -= en.weight;
      if (r < 0) {
        add(en.item, range(en.count));
        break;
      }
    }
  }
  return [...out].map(([item, count]) => ({ item, count }));
}
