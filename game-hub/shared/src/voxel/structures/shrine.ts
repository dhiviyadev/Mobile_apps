/**
 * Overgrown Shrine (Rainforest, Marshland): a mossy stepped shrine on a mud
 * brick platform ringed by a lily-covered moat. A tunnel from the south bridge
 * leads into the flooded boss hall; ladders on the north face climb to a small
 * room on top. 33 x 20 x 33, ly0 = F - 2 (design-voxel-world §7.4).
 */
import { Block } from '../blocks';
import { LootTableId } from '../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from './template';
import type { Vec3i } from './types';
import { StructureVolume } from './volume';

const S = 33;
const H = 20;

const origin = (ax: number, az: number, F: number) => ({ ox: ax - 16, oy: F - 2, oz: az - 16 });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(16, 3, 8, 0, LootTableId.ShrineBoss, true),
    at(8, 3, 16, 1, LootTableId.ShrineCommon),
    at(24, 3, 16, 2, LootTableId.ShrineCommon),
    at(16, 16, 18, 3, LootTableId.ShrineCommon),
  ];
}

export const shrine: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, H - 1, S - 1),
      entrance: { x: ox + 16, y: F + 1, z: oz + 32 },
      arena: box(ox, oy, oz, 8, 3, 8, 24, 10, 24),
      bossSpawn: { x: ox + 16.5, y: F + 1, z: oz + 16.5 },
      altar: { x: ox + 16, y: oy + 3, z: oz + 9 },
      doorways: [box(ox, oy, oz, 15, 3, 25, 17, 6, 25)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 16.5, y: F + 1, z: oz + 31.5 },
        { x: ox + 1.5, y: F + 1, z: oz + 16.5 },
        { x: ox + 31.5, y: F + 1, z: oz + 16.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, H, S, Block.MudBricks);
    const furniture: Vec3i[] = [];
    const furnish = (lx: number, ly: number, lz: number, id: number) => {
      v.set(lx, ly, lz, id);
      furniture.push({ x: ox + lx, y: oy + ly, z: oz + lz });
    };
    const stone = () => (rng() < 0.4 ? Block.MossyStoneBricks : Block.StoneBricks);
    v.fill(0, 0, 0, S - 1, 2, S - 1, Block.MudBricks);
    v.fill(0, 3, 0, S - 1, H - 1, S - 1, Block.Air);
    // Moat with lily pads; the bridge on the south side stays dry.
    for (let z = 2; z <= 30; z++) {
      for (let x = 2; x <= 30; x++) {
        if (!(x <= 3 || x >= 29 || z <= 3 || z >= 29)) continue;
        if (x >= 15 && x <= 17 && z >= 29) continue;
        v.set(x, 2, z, Block.Water);
        if (rng() < 0.15) v.set(x, 3, z, Block.LilyPad);
      }
    }
    // Three tiers of mossy stone.
    const tiers: [number, number, number, number][] = [[5, 27, 3, 11], [8, 24, 12, 15], [11, 21, 16, 18]];
    for (const [a, b, y0, y1] of tiers) for (let ly = y0; ly <= y1; ly++) for (let z = a; z <= b; z++) for (let x = a; x <= b; x++) v.set(x, ly, z, stone());
    // Top room.
    v.fill(13, 16, 13, 19, 17, 19, Block.Air);
    v.fill(16, 16, 11, 16, 17, 12, Block.Air);
    v.set(16, 16, 18, Block.Chest);
    v.set(14, 16, 14, Block.Lantern);
    v.set(18, 16, 14, Block.Lantern);
    // Leaves spilling over the tier tops.
    for (const [a, b, , y1] of tiers) {
      for (let z = a; z <= b; z++) {
        for (let x = a; x <= b; x++) {
          if (v.get(x, y1 + 1, z) === Block.Air && rng() < 0.22) v.set(x, y1 + 1, z, Block.MahoganyLeaves);
        }
      }
    }
    // The flooded hall.
    v.fill(8, 3, 8, 24, 10, 24, Block.Air);
    for (const [px, pz] of [[9, 9], [21, 9], [9, 21], [21, 21]]) v.fill(px, 2, pz, px + 2, 2, pz + 2, Block.Water);
    for (const [x, z] of [[12, 12], [12, 20], [20, 12], [20, 20]]) for (let ly = 3; ly <= 10; ly++) furnish(x, ly, z, stone());
    for (let i = 8; i <= 24; i++) {
      if (i % 3 !== 0) continue;
      v.set(i, 6, 7, Block.SealedRune);
      v.set(i, 6, 25, Block.SealedRune);
      v.set(7, 6, i, Block.SealedRune);
      v.set(25, 6, i, Block.SealedRune);
    }
    for (const [x, z] of [[16, 16], [12, 16], [20, 16], [16, 12], [16, 20]]) v.set(x, 11, z, Block.Lamp);
    for (const [x, z] of [[13, 13], [19, 13], [13, 19], [19, 19]]) furnish(x, 3, z, Block.Lantern);
    const pool = (x: number, z: number) => [[9, 9], [21, 9], [9, 21], [21, 21]].some(([px, pz]) => x >= px && x <= px + 2 && z >= pz && z <= pz + 2);
    for (let z = 8; z <= 24; z++) {
      for (let x = 8; x <= 24; x++) {
        if (pool(x, z) || v.get(x, 10, z) !== Block.Air || rng() >= 0.12) continue;
        furnish(x, 10, z, Block.HangingMoss);
        if (rng() < 0.4) furnish(x, 9, z, Block.HangingMoss);
      }
    }
    v.fill(15, 3, 25, 17, 6, 27, Block.Air);
    furnish(16, 3, 9, Block.BossAltar);
    furnish(16, 3, 8, Block.Chest);
    furnish(8, 3, 16, Block.Chest);
    furnish(24, 3, 16, Block.Chest);
    // Ladders up the north face: ground to tier 1, tier 1 to tier 2.
    for (let ly = 3; ly <= 11; ly++) v.set(16, ly, 4, Block.LadderPZ);
    for (let ly = 12; ly <= 15; ly++) v.set(16, ly, 7, Block.LadderPZ);
    return { volumes: [v], furniture };
  },
};
