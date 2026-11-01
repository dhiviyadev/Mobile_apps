/**
 * Rock pockets (granite, basalt, marble) and ore veins of the v2 generator.
 * Pockets stay inside their chunk; veins are short random walks that every
 * chunk replays for its 3x3 neighbourhood, writing only its own cells, so a
 * vein crossing a border is identical on both sides.
 */
import { hash4, mulberry32 } from '../../util/rng';
import { Block } from '../blocks';
import { blockIndex } from '../chunk';
import { CHUNK_SIZE } from '../constants';

interface Pocket {
  block: Block;
  attempts: number;
  chance: number;
  radius: [number, number];
  y: [number, number];
}
const POCKETS: readonly Pocket[] = [
  { block: Block.Granite, attempts: 3, chance: 1, radius: [2, 3.5], y: [12, 44] },
  { block: Block.Basalt, attempts: 2, chance: 1, radius: [2, 3.5], y: [2, 16] },
  { block: Block.Marble, attempts: 1, chance: 0.4, radius: [2, 3], y: [14, 36] },
];

export function placeRockPockets(cx: number, cz: number, seed: number, out: Uint8Array): void {
  POCKETS.forEach((p, kind) => {
    const rng = mulberry32(hash4(cx, cz, seed, 0x70c0 + kind));
    for (let a = 0; a < p.attempts; a++) {
      const roll = rng();
      const px = 3 + Math.floor(rng() * 10);
      const pz = 3 + Math.floor(rng() * 10);
      const py = p.y[0] + Math.floor(rng() * (p.y[1] - p.y[0] + 1));
      const r = p.radius[0] + rng() * (p.radius[1] - p.radius[0]);
      if (roll >= p.chance) continue;
      const ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++) {
        const y = py + dy;
        if (y < 1 || y > 62) continue;
        for (let dz = -ri; dz <= ri; dz++) {
          for (let dx = -ri; dx <= ri; dx++) {
            if (dx * dx + dy * dy * 1.3 + dz * dz > r * r) continue;
            const x = px + dx;
            const z = pz + dz;
            if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) continue;
            const i = blockIndex(x, y, z);
            if (out[i] === Block.Stone || (p.block === Block.Basalt && out[i] === Block.Slate)) out[i] = p.block;
          }
        }
      }
    }
  });
}

interface Ore {
  block: Block;
  attempts: number;
  chance: number;
  size: [number, number];
  y: [number, number];
}
export const ORES: readonly Ore[] = [
  { block: Block.CoalOre, attempts: 16, chance: 1, size: [5, 10], y: [5, 52] },
  { block: Block.CopperOre, attempts: 9, chance: 1, size: [4, 8], y: [10, 44] },
  { block: Block.IronOre, attempts: 9, chance: 1, size: [3, 7], y: [3, 38] },
  { block: Block.GoldOre, attempts: 3, chance: 1, size: [3, 6], y: [2, 20] },
  { block: Block.CobaltOre, attempts: 1, chance: 0.9, size: [2, 4], y: [2, 12] },
  { block: Block.EmberOre, attempts: 1, chance: 0.4, size: [1, 3], y: [1, 8] },
];
const GOLD = 3;
/** Extra gold veins in Redrock canyons, higher up. */
const REDROCK_GOLD: Ore = { block: Block.GoldOre, attempts: 5, chance: 1, size: [3, 6], y: [20, 44] };

/**
 * Ore veins of chunk (cx, cz) and its 8 neighbours, written into `out` (the
 * chunk cx, cz) where they meet Stone or Slate. `redrock(vcx, vcz)` says whether
 * a vein chunk's centre column is Redrock.
 */
export function placeOres(cx: number, cz: number, seed: number, out: Uint8Array, redrock: (vcx: number, vcz: number) => boolean): void {
  for (let vz = cz - 1; vz <= cz + 1; vz++) {
    for (let vx = cx - 1; vx <= cx + 1; vx++) {
      const ox = (vx - cx) * CHUNK_SIZE;
      const oz = (vz - cz) * CHUNK_SIZE;
      const list = redrock(vx, vz) ? [...ORES, REDROCK_GOLD] : ORES;
      list.forEach((ore, index) => {
        const oreIndex = ore === REDROCK_GOLD ? GOLD + 8 : index;
        for (let a = 0; a < ore.attempts; a++) {
          const rng = mulberry32(hash4(vx, vz, seed, 0x0e00 + oreIndex * 64 + a));
          if (rng() >= ore.chance) continue;
          let x = ox + Math.floor(rng() * CHUNK_SIZE);
          let z = oz + Math.floor(rng() * CHUNK_SIZE);
          let y = ore.y[0] + Math.floor(rng() * (ore.y[1] - ore.y[0] + 1));
          const size = ore.size[0] + Math.floor(rng() * (ore.size[1] - ore.size[0] + 1));
          for (let s = 0; s < size; s++) {
            if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y >= 1 && y <= 62) {
              const i = blockIndex(x, y, z);
              if (out[i] === Block.Stone || out[i] === Block.Slate) out[i] = ore.block;
            }
            const step = rng();
            const dir = rng() < 0.5 ? -1 : 1;
            if (step < 1 / 3) x += dir;
            else if (step < 2 / 3) y += dir;
            else z += dir;
          }
        }
      });
    }
  }
}
