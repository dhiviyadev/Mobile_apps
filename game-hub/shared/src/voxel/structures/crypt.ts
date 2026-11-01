/**
 * Ashen Crypt (temperate land): a small mausoleum on the surface hides a ladder
 * shaft down to a basalt catacomb: a corridor, two side rooms and the boss hall
 * with lava braziers, at y 8..19 (design-voxel-world §7.4). Three pieces: the
 * catacomb (no foundation), the shaft, and the mausoleum.
 */
import { Block } from '../blocks';
import { LootTableId } from '../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from './template';
import type { Vec3i } from './types';
import { StructureVolume } from './volume';

const S = 37;
const CAT_Y = 8;
const CAT_H = 12;
/** Shaft column relative to the anchor. */
const SHAFT_DZ = -17;

const origin = (ax: number, az: number) => ({ ox: ax - 18, oy: CAT_Y, oz: az - 18 });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [at(18, 2, 27, 0, LootTableId.CryptBoss, true), at(9, 2, 3, 1, LootTableId.CryptCommon), at(27, 2, 3, 2, LootTableId.CryptCommon)];
}

/** Mausoleum site of a crypt anchored at (ax, az): its centre column. */
export const cryptShaft = (ax: number, az: number) => ({ x: ax, z: az + SHAFT_DZ });

export const crypt: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az);
    const s = cryptShaft(ax, az);
    return {
      bounds: { x0: ox, y0: oy, z0: s.z - 4, x1: ox + S, y1: F + 7, z1: oz + S },
      entrance: { x: s.x, y: F + 1, z: s.z + 5 },
      arena: box(ox, oy, oz, 9, 2, 9, 27, 9, 27),
      bossSpawn: { x: ox + 18.5, y: 10, z: oz + 18.5 },
      altar: { x: ox + 18, y: oy + 2, z: oz + 26 },
      doorways: [box(ox, oy, oz, 17, 2, 8, 19, 4, 8)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ax + 0.5, y: 10, z: az - 13.5 },
        { x: ox + 11.5, y: 10, z: oz + 3.5 },
        { x: ox + 24.5, y: 10, z: oz + 3.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az);
    const furniture: Vec3i[] = [];
    const cat = new StructureVolume(ox, oy, oz, S, CAT_H, S, null);
    const furnish = (lx: number, ly: number, lz: number, id: number) => {
      cat.set(lx, ly, lz, id);
      furniture.push({ x: ox + lx, y: oy + ly, z: oz + lz });
    };
    // Boss hall shell and interior.
    cat.fill(8, 0, 8, 28, 11, 28, Block.BasaltBricks);
    cat.fill(9, 2, 9, 27, 9, 27, Block.Air);
    for (let i = 9; i <= 27; i++) {
      for (const [x, z] of [[i, 8], [i, 28], [8, i], [28, i]]) {
        cat.set(x, 5, z, Block.RuneBricks);
        if (i % 4 === 2) cat.set(x, 6, z, Block.SealedRune);
      }
    }
    for (let z = 9; z <= 27; z++) for (let x = 9; x <= 27; x++) if ((x + z) % 6 === 0) cat.set(x, 1, z, Block.RuneBricks);
    for (const [x, z] of [[10, 10], [10, 26], [26, 10], [26, 26]]) {
      furnish(x, 2, z, Block.BasaltBricks);
      furnish(x, 3, z, Block.Lava);
    }
    for (const [x, z] of [[13, 13], [13, 23], [23, 13], [23, 23]]) for (let ly = 2; ly <= 9; ly++) furnish(x, ly, z, Block.RuneBricks);
    // Light for the middle of the hall: lamps in the ceiling.
    for (const [x, z] of [[18, 18], [13, 18], [23, 18], [18, 13], [18, 23]]) cat.set(x, 10, z, Block.Lamp);
    cat.fill(17, 2, 8, 19, 4, 8, Block.Air);
    furnish(18, 2, 26, Block.BossAltar);
    furnish(18, 2, 27, Block.Chest);
    // Corridor from the shaft.
    cat.fill(16, 0, 0, 20, 7, 8, Block.BasaltBricks);
    cat.fill(17, 2, 1, 19, 5, 7, Block.Air);
    cat.fill(17, 2, 8, 19, 4, 8, Block.Air);
    for (const [x, z] of [[16, 2], [16, 6], [20, 2], [20, 6]]) cat.set(x, 4, z, Block.SealedRune);
    // Side rooms.
    for (const west of [true, false]) {
      const [a, b] = west ? [8, 15] : [21, 28];
      cat.fill(a, 0, 0, b, 7, 7, Block.BasaltBricks);
      cat.fill(a + 1, 2, 1, b - 1, 5, 6, Block.Air);
      const [d0, d1] = west ? [15, 16] : [20, 21];
      cat.fill(d0, 2, 3, d1, 3, 4, Block.Air);
      for (let z = 1; z <= 6; z++) {
        for (let x = a + 1; x <= b - 1; x++) {
          if (rng() < 0.3) cat.set(x, 1, z, Block.MossyCobble);
          const wallSide = x === a + 1 || x === b - 1 || z === 1 || z === 6;
          if (!wallSide && rng() < 0.12) cat.set(x, 2, z, Block.Duskcap);
        }
      }
      cat.set(west ? 8 : 28, 3, 4, Block.SealedRune);
      cat.set(west ? 9 : 27, 2, 3, Block.Chest);
    }
    // Shaft bottom: ladder against the corridor's north wall, through its roof.
    for (let ly = 2; ly <= 7; ly++) cat.set(18, ly, 1, Block.LadderNZ);

    // Shaft from y 16 up to the mausoleum floor.
    const s = cryptShaft(ax, az);
    const shaftH = Math.max(0, F - 16);
    const shaft = new StructureVolume(s.x - 1, 16, s.z - 1, 3, Math.max(1, shaftH), 3, null);
    if (shaftH > 0) {
      shaft.fill(0, 0, 0, 2, shaftH - 1, 2, Block.BasaltBricks);
      shaft.fill(1, 0, 1, 1, shaftH - 1, 1, Block.LadderNZ);
    }

    // Mausoleum.
    const m = new StructureVolume(s.x - 4, F, s.z - 4, 9, 7, 9, Block.StoneBricks);
    m.fill(0, 0, 0, 8, 0, 8, Block.StoneBricks);
    m.set(4, 0, 4, Block.LadderNZ);
    for (let ly = 1; ly <= 4; ly++) {
      for (let z = 0; z <= 8; z++) {
        for (let x = 0; x <= 8; x++) {
          const ring = x === 0 || x === 8 || z === 0 || z === 8;
          m.set(x, ly, z, ring ? (rng() < 0.3 ? Block.MossyStoneBricks : Block.StoneBricks) : Block.Air);
        }
      }
    }
    m.fill(4, 1, 8, 4, 2, 8, Block.Air);
    m.fill(0, 5, 0, 8, 5, 8, Block.StoneBrickSlab);
    m.fill(0, 6, 0, 8, 6, 8, Block.Air);
    m.fill(2, 6, 2, 6, 6, 6, Block.StoneBricks);
    m.set(2, 1, 6, Block.Torch);
    m.set(6, 1, 6, Block.Torch);
    m.set(2, 1, 2, Block.PolishedStone);
    m.set(6, 1, 2, Block.PolishedStone);
    return { volumes: shaftH > 0 ? [cat, shaft, m] : [cat, m], furniture };
  },
};
