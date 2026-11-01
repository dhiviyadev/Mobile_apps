import { describe, expect, it } from 'vitest';
import {
  applyInvOp,
  Block,
  blockDef,
  blockDrops,
  breakSeconds,
  canHarvest,
  Container,
  CREATIVE_BLOCKS,
  craftOp,
  FallTracker,
  Inventory,
  type InvEnv,
  Item,
  itemDef,
  itemFromKey,
  ItemKind,
  lootKeys,
  maxCraftable,
  mulberry32,
  OFFHAND,
  playerFallDamage,
  RECIPES,
  recipeById,
  registerItem,
  Station,
  StationFlags,
  stationsNear,
  survivalItemIds,
  TAGS,
} from '../src/index';

const env = (over: Partial<InvEnv> = {}): InvEnv => ({ selected: 0, container: null, stations: 0, sealedContainer: false, craft: craftOp, ...over });

describe('survival items', () => {
  it('has unique keys and sprite tiles in 160..239', () => {
    const ids = survivalItemIds();
    expect(ids.length).toBeGreaterThanOrEqual(55);
    const tiles = ids.map((id) => itemDef(id)!.tile);
    expect(new Set(tiles).size).toBe(tiles.length);
    for (const t of tiles) expect(t >= 160 && t <= 239).toBe(true);
    expect(new Set(ids.map((id) => itemDef(id)!.key)).size).toBe(ids.length);
  });

  it('resolves every loot, mob drop, like and boss key', () => {
    const mobKeys = ['raw_meat', 'fleece', 'feather', 'hide', 'raw_fish', 'bone', 'silk', 'glow_dust', 'arrow', 'bolt', 'bow', 'coal', 'iron_ingot', 'gold_ingot', 'cobalt_gem',
      'ember_shard', 'block:Mud', 'block:RedMushroom', 'block:Duskcap', 'block:Melon', 'block:HayBale', 'block:TallGrass', 'block:Sunpetal', 'apple', 'bread',
      'sunforged_sword', 'rimebound_crossbow', 'thornheart_bow', 'ashen_axe', 'cobalt_sword', 'cobalt_crossbow', 'cobalt_axe'];
    for (const k of [...lootKeys(), ...mobKeys]) expect(itemFromKey(k), k).not.toBeNull();
    for (const b of CREATIVE_BLOCKS) expect(itemDef(b)).toBeDefined();
    expect(itemFromKey('iron_sword')).toBe(306);
    expect(itemFromKey('block:Bedroll')).toBe(Block.Bedroll);
  });

  it('gives tools and weapons durability and a stack of 1; refuses overlaps', () => {
    for (const id of survivalItemIds()) {
      const d = itemDef(id)!;
      if (d.melee && d.kind !== ItemKind.Material) expect(d.durability).toBeGreaterThan(0);
      if (d.tool || d.ranged || d.shield) expect(d.maxStack).toBe(1);
    }
    expect(() => registerItem({ ...itemDef(Item.Stick)! })).toThrow();
  });
});

describe('inventory operations', () => {
  it('adds into stacks first, hotbar before main, and returns overflow', () => {
    const inv = new Inventory();
    inv.set(5, { item: Block.Dirt, count: 60, meta: 0 });
    expect(inv.add(Block.Dirt, 10)).toBe(0);
    expect(inv.get(5)!.count).toBe(64);
    expect(inv.get(0)!.count).toBe(6);
    const full = new Inventory();
    for (let i = 0; i < 36; i++) full.set(i, { item: Item.WoodenSword, count: 1, meta: 0 });
    expect(full.add(Item.Stick, 5)).toBe(5);
  });

  it('moves, merges, swaps, splits, quick-moves and drops; refuses bad ops untouched', () => {
    const inv = new Inventory();
    inv.set(0, { item: Block.Dirt, count: 10, meta: 0 });
    inv.set(1, { item: Block.Dirt, count: 60, meta: 0 });
    inv.set(2, { item: Item.Bow, count: 1, meta: 0 });
    const out = { thrown: [] as { item: number; count: number; meta: number }[] };
    expect(applyInvOp(inv, { op: 'move', from: 0, to: 1, count: 0 }, env(), out)).toBe(true);
    expect([inv.get(0)!.count, inv.get(1)!.count]).toEqual([6, 64]);
    expect(applyInvOp(inv, { op: 'move', from: 2, to: 0, count: 0 }, env(), out)).toBe(true);
    expect(inv.get(0)!.item).toBe(Item.Bow);
    expect(applyInvOp(inv, { op: 'split', from: 1, to: 20 }, env(), out)).toBe(true);
    expect(inv.get(20)!.count).toBe(32);
    expect(applyInvOp(inv, { op: 'quick', from: 20 }, env(), out)).toBe(true);
    expect(inv.get(20)).toBeNull();
    expect(applyInvOp(inv, { op: 'drop', from: 0, count: 1 }, env(), out)).toBe(true);
    expect(out.thrown[0].item).toBe(Item.Bow);
    const before = inv.clone();
    expect(applyInvOp(inv, { op: 'move', from: 1, to: 99, count: 0 }, env(), out)).toBe(false);
    expect(applyInvOp(inv, { op: 'move', from: 1, to: 3, count: 200 }, env(), out)).toBe(false);
    expect(applyInvOp(inv, { op: 'move', from: 1, to: OFFHAND, count: 0 }, env(), out)).toBe(false);
    expect(inv.counts).toEqual(before.counts);
  });

  it('takes only shields into the off-hand, swaps hands, and moves to and from containers', () => {
    const inv = new Inventory();
    inv.set(3, { item: Item.WoodenShield, count: 1, meta: 0 });
    expect(applyInvOp(inv, { op: 'swapHands' }, env({ selected: 3 }), { thrown: [] })).toBe(true);
    expect(inv.get(OFFHAND)!.item).toBe(Item.WoodenShield);
    const chest = new Container();
    inv.set(4, { item: Item.Apple, count: 5, meta: 0 });
    expect(applyInvOp(inv, { op: 'quick', from: 4 }, env({ container: chest }), { thrown: [] })).toBe(true);
    expect(chest.get(0)!.count).toBe(5);
    expect(applyInvOp(inv, { op: 'move', from: 64, to: 7, count: 2 }, env({ container: chest }), { thrown: [] })).toBe(true);
    expect(inv.get(7)!.count).toBe(2);
    expect(applyInvOp(inv, { op: 'quick', from: 64 }, env({ container: chest, sealedContainer: true }), { thrown: [] })).toBe(false);
  });
});

describe('recipes', () => {
  it('has 89 recipes with unique ids, at most 4 inputs and valid items', () => {
    expect(RECIPES).toHaveLength(89);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(89);
    for (const r of RECIPES) {
      expect(r.inputs.length).toBeLessThanOrEqual(4);
      expect(itemDef(r.output), `recipe ${r.id}`).toBeDefined();
      for (const i of r.inputs) if ('item' in i) expect(itemDef(i.item), `recipe ${r.id}`).toBeDefined();
    }
  });

  it('reaches every tool tier, both crossbows, bow, ammo, shields and the bedroll from natural drops (no mob drops)', () => {
    // Natural sources: blocks broken with a tool tier gives their drops.
    const have = new Set<number>([0]);
    let tier = 0;
    const naturals = [Block.Log, Block.Dirt, Block.Stone, Block.Gravel, Block.TallGrass, Block.Sand, Block.CoalOre, Block.CopperOre, Block.IronOre, Block.GoldOre,
      Block.CobaltOre, Block.EmberOre, Block.Rosette, Block.Sunpetal, Block.Fern, Block.Bluebell, Block.Clay, Block.Basalt, Block.Obsidian];
    const tools: [number, number][] = [[Item.WoodenPickaxe, 1], [Item.StonePickaxe, 2], [Item.IronPickaxe, 3], [Item.CobaltPickaxe, 4]];
    const always = () => 0; // every random drop happens
    for (let round = 0; round < 12; round++) {
      for (const [pick, t] of tools) if (have.has(pick)) tier = Math.max(tier, t);
      const pick = tier ? tools[tier - 1][0] : 0;
      for (const b of naturals) for (const s of blockDrops(b, canHarvest(b, pick) ? pick : 0, always)) have.add(s.item);
      for (const r of RECIPES) {
        if (r.inputs.every((i) => ('item' in i ? have.has(i.item) : TAGS[i.tag].some((m) => have.has(m))))) {
          if (r.station === Station.Hand || have.has(r.station === Station.Workbench ? Block.Workbench : Block.Furnace)) have.add(r.output);
        }
      }
    }
    for (const id of [Item.CobaltPickaxe, Item.CobaltSword, Item.CobaltAxe, Item.Crossbow, Item.CobaltCrossbow, Item.Bow, Item.Arrow, Item.Bolt, Item.EmberArrow,
      Item.WoodenShield, Item.IronShield, Item.CobaltShield, Block.Bedroll]) expect(have.has(id), `reach ${id}`).toBe(true);
  });

  it('crafts with tags, counts fuel after the main input, returns overflow, needs stations', () => {
    const inv = new Inventory();
    inv.set(0, { item: Block.Log, count: 2, meta: 0 });
    const coal = recipeById(108)!;
    expect(maxCraftable(inv, coal)).toBe(1);
    expect(craftOp(inv, 108, 1, 0, [])).toBe(false);
    expect(craftOp(inv, 108, 5, StationFlags.Furnace, [])).toBe(true);
    expect(inv.count(Item.Coal)).toBe(1);
    expect(inv.count(Block.Log)).toBe(0);
    const planks = new Inventory();
    planks.set(0, { item: Block.PinePlanks, count: 1, meta: 0 });
    planks.set(1, { item: Block.Planks, count: 1, meta: 0 });
    expect(craftOp(planks, 7, 1, 0, [])).toBe(true);
    expect(planks.count(Item.Stick)).toBe(4);
  });

  it('finds a workbench at Chebyshev 4 but not 5', () => {
    const get = (bx: number) => (x: number, y: number, z: number) => (x === bx && y === 10 && z === 0 ? Block.Workbench : 0);
    expect(stationsNear(get(4), 0.5, 10, 0.5) & StationFlags.Workbench).toBeTruthy();
    expect(stationsNear(get(5), 0.5, 10, 0.5)).toBe(0);
  });
});

describe('mining', () => {
  it('matches the break-time table and harvest rules', () => {
    expect(breakSeconds(Block.Stone, 0)).toBeCloseTo(blockDef(Block.Stone).hardness * 2.5 * 3.33, 2);
    expect(breakSeconds(Block.Stone, Item.WoodenPickaxe)).toBeCloseTo((blockDef(Block.Stone).hardness * 2.5) / 2, 2);
    expect(canHarvest(Block.Stone, 0)).toBe(false);
    expect(canHarvest(Block.IronOre, Item.WoodenPickaxe)).toBe(false);
    expect(canHarvest(Block.IronOre, Item.StonePickaxe)).toBe(true);
    const rng = mulberry32(1);
    expect(blockDrops(Block.Stone, 0, rng)).toEqual([]);
    expect(blockDrops(Block.Stone, Item.WoodenPickaxe, rng)[0].item).toBe(Block.Cobble);
    expect(blockDrops(Block.Grass, 0, rng)[0].item).toBe(Block.Dirt);
    expect(blockDrops(Block.LadderPX, 0, rng)[0].item).toBe(Block.LadderNZ);
    const m = blockDrops(Block.Melon, 0, rng)[0];
    expect(m.item).toBe(Item.MelonSlice);
    expect(m.count >= 3 && m.count <= 5).toBe(true);
  });

  it('drops flint from gravel about 15% of the time', () => {
    const rng = mulberry32(42);
    let flint = 0;
    for (let i = 0; i < 2000; i++) if (blockDrops(Block.Gravel, 0, rng)[0].item === Item.FlintShard) flint++;
    expect(flint / 2000).toBeGreaterThan(0.12);
    expect(flint / 2000).toBeLessThan(0.18);
  });
});

describe('falls', () => {
  it('measures falls, cushions in water and resets', () => {
    const f = new FallTracker();
    for (let y = 40; y >= 32; y -= 0.5) f.update(y, false, false);
    expect(playerFallDamage(f.update(32, true, false))).toBe(4);
    f.update(33, false, false);
    expect(playerFallDamage(f.update(32, true, false))).toBe(0);
    for (let y = 40; y >= 30; y--) f.update(y, false, false);
    expect(f.update(30, false, true)).toBe(0);
    expect(f.update(30, true, false)).toBe(0);
  });
});
