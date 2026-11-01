/**
 * Frost Citadel (Tundra, Frostpine, Glacier Peaks): an ice-brick curtain wall
 * with four climbable corner towers around a snowy courtyard and the boss hall
 * under an ice roof. 35 x 15 x 35, ly0 = F - 1 (design-voxel-world §7.4).
 */
import { Block } from '../blocks';
import { LootTableId } from '../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from './template';
import type { Vec3i } from './types';
import { StructureVolume } from './volume';

const S = 35;
const H = 15;
const TOWERS: readonly [number, number][] = [[4, 4], [30, 4], [4, 30], [30, 30]];

const origin = (ax: number, az: number, F: number) => ({ ox: ax - 17, oy: F - 1, oz: az - 17 });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [at(17, 2, 9, 0, LootTableId.CitadelBoss, true), at(5, 2, 5, 1, LootTableId.CitadelCommon), at(29, 2, 5, 2, LootTableId.CitadelCommon)];
}

export const citadel: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, H - 1, S - 1),
      entrance: { x: ox + 17, y: F + 1, z: oz + 34 },
      arena: box(ox, oy, oz, 9, 2, 9, 25, 10, 25),
      bossSpawn: { x: ox + 17.5, y: F + 1, z: oz + 17.5 },
      altar: { x: ox + 17, y: oy + 2, z: oz + 10 },
      doorways: [box(ox, oy, oz, 16, 2, 26, 18, 5, 26)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 12.5, y: F + 1, z: oz + 29.5 },
        { x: ox + 22.5, y: F + 1, z: oz + 29.5 },
        { x: ox + 5.5, y: F + 1, z: oz + 17.5 },
        { x: ox + 29.5, y: F + 1, z: oz + 17.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, H, S, Block.StoneBricks);
    const furniture: Vec3i[] = [];
    const furnish = (lx: number, ly: number, lz: number, id: number) => {
      v.set(lx, ly, lz, id);
      furniture.push({ x: ox + lx, y: oy + ly, z: oz + lz });
    };
    v.fill(0, 0, 0, S - 1, 1, S - 1, Block.StoneBricks);
    v.fill(0, 2, 0, S - 1, H - 1, S - 1, Block.Air);
    // Courtyard snow (before walls and hall overwrite their cells).
    for (let z = 3; z <= 31; z++) for (let x = 3; x <= 31; x++) if (rng() < 0.6) v.set(x, 2, z, Block.SnowLayer);
    // Curtain wall: ice outside, stone inside, crenellations on top.
    for (let z = 1; z <= 33; z++) {
      for (let x = 1; x <= 33; x++) {
        if (!(x <= 2 || x >= 32 || z <= 2 || z >= 32)) continue;
        const outer = x === 1 || x === 33 || z === 1 || z === 33;
        v.fill(x, 2, z, x, 8, z, outer ? Block.IceBricks : Block.StoneBricks);
        if (outer && (x + z) % 2 === 0) v.set(x, 9, z, Block.IceBricks);
      }
    }
    v.fill(16, 2, 32, 18, 5, 33, Block.Air);
    // Corner towers with ladders up to a lookout.
    for (const [cx, cz] of TOWERS) {
      const west = cx < 17;
      for (let ly = 2; ly <= 14; ly++) {
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            const ax2 = Math.abs(dx), az2 = Math.abs(dz);
            if (ax2 === 3 && az2 === 3) continue;
            const shell = Math.max(ax2, az2) === 3;
            const x = cx + dx, z = cz + dz;
            if (ly === 14) {
              v.set(x, ly, z, shell && (dx + dz) % 2 === 0 ? Block.PackedIce : Block.Air);
            } else if (ly === 13) {
              v.set(x, ly, z, Block.PackedIce);
            } else if (shell) {
              v.set(x, ly, z, ly === 5 || ly === 9 ? Block.IceBricks : Block.PackedIce);
            } else {
              v.set(x, ly, z, Block.Air);
            }
          }
        }
      }
      const lx = west ? cx - 2 : cx + 2;
      for (let ly = 2; ly <= 13; ly++) v.set(lx, ly, cz, west ? Block.LadderNX : Block.LadderPX);
      const door = west ? cx + 3 : cx - 3;
      v.fill(door, 2, cz, door, 3, cz, Block.Air);
    }
    v.set(5, 2, 5, Block.Chest);
    v.set(29, 2, 5, Block.Chest);
    // The hall.
    for (let ly = 2; ly <= 11; ly++) {
      for (let z = 8; z <= 26; z++) {
        for (let x = 8; x <= 26; x++) {
          const wallX = x === 8 || x === 26;
          const wallZ = z === 8 || z === 26;
          if (ly === 11) v.set(x, ly, z, x > 8 && x < 26 && z > 8 && z < 26 && x % 4 === 1 && z % 4 === 1 ? Block.Ice : Block.PackedIce);
          else if (wallX && wallZ) v.set(x, ly, z, Block.IceBricks);
          else if (wallX || wallZ) {
            const along = wallX ? z : x;
            v.set(x, ly, z, ly === 6 && along % 4 === 1 ? Block.Lamp : Block.StoneBricks);
          } else v.set(x, ly, z, Block.Air);
        }
      }
    }
    v.fill(16, 2, 26, 18, 5, 26, Block.Air);
    for (const [x, z] of [[12, 12], [12, 22], [22, 12], [22, 22]]) for (let ly = 2; ly <= 10; ly++) furnish(x, ly, z, Block.IceBricks);
    for (const [x, z] of [[10, 10], [10, 24], [24, 10], [24, 24]]) furnish(x, 2, z, Block.Lantern);
    furnish(17, 2, 10, Block.BossAltar);
    furnish(17, 2, 9, Block.Chest);
    return { volumes: [v], furniture };
  },
};
