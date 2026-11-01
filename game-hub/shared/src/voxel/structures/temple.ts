/**
 * Sunscorch Temple (Dunes, Redrock, Savanna): a weathered four-tier sandstone
 * pyramid on a plaza. A tunnel from the north leads into the boss hall inside;
 * ladders on the south face climb to a small shrine on top.
 * 35 x 18 x 35, ly0 = F - 1 (design-voxel-world §7.4).
 */
import { Block, IS_SOLID } from '../blocks';
import { LootTableId } from '../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from './template';
import type { Vec3i } from './types';
import { StructureVolume } from './volume';

const S = 35;
const H = 18;
const C = 17;
const TIERS = [15, 12, 9, 6];

const origin = (ax: number, az: number, F: number) => ({ ox: ax - C, oy: F - 1, oz: az - C });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(17, 2, 24, 0, LootTableId.TempleBoss, true),
    at(10, 2, 17, 1, LootTableId.TempleCommon),
    at(24, 2, 17, 2, LootTableId.TempleCommon),
    at(17, 14, 19, 3, LootTableId.TempleCommon),
  ];
}

export const temple: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, H - 1, S - 1),
      entrance: { x: ox + 17, y: F + 1, z: oz + 1 },
      arena: box(ox, oy, oz, 10, 2, 10, 24, 9, 24),
      bossSpawn: { x: ox + 17.5, y: F + 1, z: oz + 17.5 },
      altar: { x: ox + 17, y: oy + 2, z: oz + 23 },
      doorways: [box(ox, oy, oz, 16, 2, 9, 18, 4, 9)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 14.5, y: F + 1, z: oz + 0.5 },
        { x: ox + 20.5, y: F + 1, z: oz + 0.5 },
        { x: ox + 11.5, y: F + 1, z: oz + 11.5 },
        { x: ox + 23.5, y: F + 1, z: oz + 11.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, H, S, Block.Sandstone);
    const furniture: Vec3i[] = [];
    const furnish = (lx: number, ly: number, lz: number, id: number) => {
      v.set(lx, ly, lz, id);
      furniture.push({ x: ox + lx, y: oy + ly, z: oz + lz });
    };
    // Plaza and clearing.
    v.fill(0, 0, 0, S - 1, 0, S - 1, Block.Sandstone);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const edge = x <= 1 || z <= 1 || x >= S - 2 || z >= S - 2;
        v.set(x, 1, z, edge && rng() < 0.3 ? Block.Sand : Block.SandstoneBricks);
      }
    }
    v.fill(0, 2, 0, S - 1, H - 1, S - 1, Block.Air);
    // Pyramid tiers: bricks, the top ring of each tier in plain sandstone.
    TIERS.forEach((hw, t) => {
      for (let ly = 2 + 3 * t; ly <= 4 + 3 * t; ly++) {
        for (let z = C - hw; z <= C + hw; z++) {
          for (let x = C - hw; x <= C + hw; x++) {
            const ring = Math.max(Math.abs(x - C), Math.abs(z - C)) === hw;
            v.set(x, ly, z, ly === 4 + 3 * t && ring ? Block.Sandstone : Block.SandstoneBricks);
          }
        }
      }
    });
    // Weathering of the upper tiers (away from the hall).
    for (let ly = 8; ly < 14; ly++) {
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const id = v.get(x, ly, z);
          if (id !== Block.SandstoneBricks && id !== Block.Sandstone) continue;
          const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => v.get(x + dx, ly + dy, z + dz) === Block.Air);
          const nearHall = Math.max(Math.max(9 - x, x - 25, 0), Math.max(9 - z, z - 25, 0), Math.max(0, ly - 10)) <= 2;
          if (!exposed || nearHall) continue;
          const r = rng();
          if (r < 0.2) v.set(x, ly, z, Block.Sandstone);
          else if (r < 0.28) v.set(x, ly, z, Block.Sand);
          else if (r < 0.34) v.set(x, ly, z, Block.Air);
        }
      }
    }
    // Drifted sand against the base.
    for (let z = 1; z < S - 1; z++) {
      for (let x = 1; x < S - 1; x++) {
        const d = Math.max(Math.abs(x - C), Math.abs(z - C));
        if (d !== 16 || (x >= 15 && x <= 19 && z <= 2)) continue;
        if (rng() < 0.45) v.set(x, 2, z, Block.Sand);
      }
    }
    // Top shrine.
    for (let ly = 14; ly <= 16; ly++) {
      for (let z = C - 3; z <= C + 3; z++) {
        for (let x = C - 3; x <= C + 3; x++) {
          const ring = Math.max(Math.abs(x - C), Math.abs(z - C)) === 3;
          if (ly === 16) v.set(x, ly, z, Math.abs(x - C) <= 1 && Math.abs(z - C) <= 1 ? Block.GlassAmber : Block.SandstoneBricks);
          else v.set(x, ly, z, ring ? Block.SandstoneBricks : Block.Air);
        }
      }
    }
    v.fill(17, 14, 14, 17, 15, 14, Block.Air);
    v.set(17, 14, 19, Block.Chest);
    // Boss hall.
    for (let ly = 1; ly <= 10; ly++) {
      for (let z = 9; z <= 25; z++) {
        for (let x = 9; x <= 25; x++) {
          const wall = x === 9 || x === 25 || z === 9 || z === 25;
          let id: Block;
          if (ly === 1) id = x === 17 || z === 17 ? Block.Marble : Block.SandstoneBricks;
          else if (ly === 10) id = Block.SandstoneBricks;
          else if (!wall) id = Block.Air;
          else if (ly === 5) id = Block.Marble;
          else if (ly === 6 && (x + z) % 4 === 0) id = Block.SealedRune;
          else id = Block.SandstoneBricks;
          v.set(x, ly, z, id);
        }
      }
    }
    for (const [x, z] of [[12, 12], [12, 22], [22, 12], [22, 22]]) for (let ly = 2; ly <= 9; ly++) furnish(x, ly, z, Block.MarblePillar);
    for (const [x, z] of [[13, 13], [13, 21], [21, 13], [21, 21], [17, 17]]) v.set(x, 10, z, Block.Lamp);
    for (const [x, z] of [[10, 10], [24, 10], [10, 24], [24, 24], [10, 13], [10, 21], [24, 13], [24, 21], [13, 24], [21, 24]]) furnish(x, 2, z, Block.Lantern);
    furnish(17, 2, 23, Block.BossAltar);
    furnish(17, 2, 24, Block.Chest);
    furnish(10, 2, 17, Block.Chest);
    furnish(24, 2, 17, Block.Chest);
    // Entrance tunnel from the north.
    v.fill(16, 2, 9, 18, 4, 9, Block.Air);
    v.fill(16, 2, 2, 18, 4, 8, Block.Air);
    v.fill(15, 5, 2, 19, 5, 2, Block.Marble);
    v.set(15, 2, 1, Block.Torch);
    v.set(19, 2, 1, Block.Torch);
    // Ladders up the south face to the top shrine.
    TIERS.forEach((hw, t) => {
      const lz = C + hw + 1;
      for (let ly = 2 + 3 * t; ly <= 4 + 3 * t; ly++) {
        if (IS_SOLID[v.get(C, ly, lz - 1)]) v.set(C, ly, lz, Block.LadderNZ);
        else v.set(C, ly, lz - 1, Block.SandstoneBricks), v.set(C, ly, lz, Block.LadderNZ);
      }
    });
    return { volumes: [v], furniture };
  },
};
