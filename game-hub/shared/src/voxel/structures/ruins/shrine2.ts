/**
 * Overgrown Shrine, generator-4 version (Rainforest, Marshland): a four-tier
 * mossy ziggurat on a mud platform inside a lily moat, guarded by four giant
 * mahogany trees. A bridge and tunnel from the south lead into the flooded
 * boss hall (glowing verdant runes, mossy columns, root beams, hanging moss
 * and pools in the floor); two root chambers flank it; ladders on the north
 * face climb four tiers to a leaf-roofed sky shrine.
 * 41 x 28 x 41, ly0 = F - 2, centred on (20, 20).
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 41;
const SY = 28;
const C = 20;
const MS = Block.MossyStoneBricks;
const SBR = Block.StoneBricks;
const MB = Block.MudBricks;
const VR = Block.VerdantRune;
const GM = Block.GlowMoss;
const ML = Block.MahoganyLeaves;
/** Hall interior (inclusive), ly 3..10. */
const A0 = 11;
const A1 = 29;
const TIERS: [number, number, number][] = [[14, 3, 6], [11, 7, 11], [8, 12, 15], [5, 16, 18]];
/** Pools in the hall floor (ly 2), 3x3, at [x0, z0]. */
const POOLS: [number, number][] = [[12, 13], [26, 13], [12, 25], [26, 25]];

const origin = (ax: number, az: number, F: number) => ({ ox: ax - C, oy: F - 2, oz: az - C });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(C, 3, A0, 0, LootTableId.ShrineBoss, true),
    at(7, 3, C, 1, LootTableId.ShrineCommon),
    at(33, 3, C, 2, LootTableId.ShrineCommon),
    at(C, 19, 21, 3, LootTableId.ShrineCommon),
  ];
}

export const shrine2: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, SY - 1, S - 1),
      entrance: { x: ox + C, y: F + 1, z: oz + 39 },
      arena: box(ox, oy, oz, A0, 3, A0, A1, 10, A1),
      bossSpawn: { x: ox + C + 0.5, y: F + 1, z: oz + C + 0.5 },
      altar: { x: ox + C, y: oy + 3, z: oz + A0 + 1 },
      doorways: [box(ox, oy, oz, C - 1, 3, A1 + 1, C + 1, 6, A1 + 1)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + C + 0.5, y: F + 1, z: oz + 38.5 },
        { x: ox + 15.5, y: F + 1, z: oz + 36.5 },
        { x: ox + 25.5, y: F + 1, z: oz + 36.5 },
        { x: ox + 17.5, y: F + 1, z: oz + 4.5 },
        { x: ox + 23.5, y: F + 1, z: oz + 4.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, SY, S, MB);
    const p = new Pen(v);
    const stone = () => (rng() < 0.45 ? MS : SBR);

    // ---- platform and moat ------------------------------------------------------------------
    p.fill(0, 0, 0, S - 1, 2, S - 1, MB);
    p.fill(0, 3, 0, S - 1, SY - 1, S - 1, Block.Air);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const d = Math.max(Math.abs(x - C), Math.abs(z - C));
        if (d >= 17 && d <= 19) {
          if (Math.abs(x - C) <= 1 && z > C) continue; // the bridge
          p.set(x, 2, z, Block.Water);
          if (rng() < 0.16) p.set(x, 3, z, Block.LilyPad);
        } else if (d <= 16 && rng() < 0.1) p.set(x, 2, z, MS);
      }
    }
    // Bridge: paved, with mossy posts and lanterns.
    for (let z = C + 15; z < S; z++) {
      for (let x = C - 1; x <= C + 1; x++) p.set(x, 2, z, z % 2 === 0 ? SBR : MS);
    }
    for (const z of [C + 17, C + 20]) {
      for (const sx of [-2, 2]) {
        p.pillar(C + sx, z, 3, 5, MS, SBR, SBR);
        p.set(C + sx, 6, z, Block.Lantern);
      }
    }
    for (const sx of [-2, 2]) p.fill(C + sx, 3, C + 18, C + sx, 3, C + 19, MS);

    // ---- the ziggurat ------------------------------------------------------------------------
    for (const [hw, y0, y1] of TIERS) {
      for (let ly = y0; ly <= y1; ly++) {
        for (let z = C - hw; z <= C + hw; z++) for (let x = C - hw; x <= C + hw; x++) p.set(x, ly, z, stone());
      }
      // Rune course and corner stones.
      for (let i = -hw; i <= hw; i++) {
        const ly = y0 + 1;
        for (const [x, z] of [[C + i, C - hw], [C + i, C + hw], [C - hw, C + i], [C + hw, C + i]]) {
          if (Math.abs(i) % 4 === 2) p.set(x, ly, z, VR);
        }
      }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) p.pillar(C + sx * hw, C + sz * hw, y0, y1, SBR, MB, MB);
      // Leaves and plants spilling over the tier top.
      for (let z = C - hw; z <= C + hw; z++) {
        for (let x = C - hw; x <= C + hw; x++) {
          if (p.get(x, y1 + 1, z) !== Block.Air) continue;
          const r = rng();
          if (r < 0.2) p.set(x, y1 + 1, z, ML);
          else if (r < 0.3) p.set(x, y1 + 1, z, Block.Fern);
          else if (r < 0.34) p.set(x, y1 + 1, z, GM);
        }
      }
    }
    // Vines down the faces.
    for (const [hw, y0] of TIERS) {
      for (let i = -hw; i <= hw; i++) {
        if (rng() > 0.35) continue;
        const len = 1 + Math.floor(rng() * 3);
        for (const [x, z] of [[C + i, C + hw + 1], [C + i, C - hw - 1], [C - hw - 1, C + i], [C + hw + 1, C + i]]) {
          if (rng() < 0.5) continue;
          for (let k = 0; k < len; k++) if (p.get(x, y0 + 3 - k, z) === Block.Air) p.set(x, y0 + 3 - k, z, Block.HangingMoss);
        }
      }
    }

    // ---- the flooded hall --------------------------------------------------------------------
    p.fill(A0 - 1, 2, A0 - 1, A1 + 1, 2, A1 + 1, SBR);
    p.fill(A0, 3, A0, A1, 10, A1, Block.Air);
    for (let z = A0; z <= A1; z++) {
      for (let x = A0; x <= A1; x++) {
        const d = Math.hypot(x - C, z - C);
        p.set(x, 2, z, Math.abs(d - 4) < 0.7 ? VR : (x + z) % 5 === 0 ? SBR : MS);
        p.set(x, 11, z, stone());
      }
    }
    for (const [px, pz] of POOLS) p.fill(px, 2, pz, px + 2, 2, pz + 2, Block.Water);
    // Wall courses: runes at eye level, moss.
    for (let i = A0; i <= A1; i++) {
      for (const [x, z] of [[i, A0 - 1], [i, A1 + 1], [A0 - 1, i], [A1 + 1, i]]) {
        p.set(x, 6, z, i % 3 === 0 ? VR : MS);
        p.set(x, 10, z, MS);
        if (i % 4 === 1) p.set(x, 8, z, GM);
      }
    }
    // Columns, root beams and hanging moss.
    for (const [x, z] of [[14, 14], [26, 14], [14, 26], [26, 26], [20, 15], [20, 25], [15, 20], [25, 20]]) {
      for (let ly = 3; ly <= 10; ly++) p.furnish(x, ly, z, ly === 3 || ly === 10 ? SBR : ly === 6 ? VR : MS);
    }
    for (const dz of [-6, 0, 6]) for (let x = A0; x <= A1; x++) p.set(x, 11, C + dz, Block.MahoganyLog);
    for (let z = A0; z <= A1; z++) for (let x = A0; x <= A1; x++) {
      if (p.get(x, 10, z) !== Block.Air) continue;
      const inPool = POOLS.some(([px, pz]) => x >= px && x <= px + 2 && z >= pz && z <= pz + 2);
      const r = rng();
      if (!inPool && r < 0.14) {
        p.furnish(x, 10, z, Block.HangingMoss);
        if (rng() < 0.4) p.furnish(x, 9, z, Block.HangingMoss);
      } else if (r > 0.97) p.furnish(x, 10, z, GM);
    }
    for (let z = A0 + 2; z <= A1; z += 4) for (let x = A0 + 2; x <= A1; x += 4) if (p.get(x, 11, z) !== Block.Air) p.set(x, 11, z, Block.Lamp);
    for (const [x, z] of [[17, 17], [23, 17], [17, 23], [23, 23], [A0, A0], [A1, A0], [A0, A1], [A1, A1], [C, A1], [11, C], [29, C]]) p.furnish(x, 3, z, Block.Lantern);
    for (let i = A0 + 3; i <= A1 - 3; i += 5) {
      p.furnish(i, 3, A0, Block.Lantern);
      if (Math.abs(i - C) > 2) p.furnish(i, 3, A1, Block.Lantern);
    }
    // Altar at the north wall, framed by a verdant arch.
    p.furnish(C, 3, A0 + 1, Block.BossAltar);
    p.furnish(C, 3, A0, Block.Chest);
    for (const sx of [-3, 3]) for (let ly = 3; ly <= 9; ly++) p.furnish(C + sx, ly, A0, ly % 3 === 0 ? VR : MS);
    for (let dx = -3; dx <= 3; dx++) p.furnish(C + dx, 10, A0, Math.abs(dx) <= 1 ? VR : MS);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 4; ly <= 9; ly++) p.set(C + dx, ly, A0 - 1, (Math.abs(dx) === 2 || ly === 9) ? VR : (dx === 0 && ly >= 5 && ly <= 7 ? GM : MS));
    // Entrance tunnel from the bridge.
    p.fill(C - 1, 3, A1 + 1, C + 1, 6, 34, Block.Air);
    p.fill(C - 1, 2, 31, C + 1, 2, 38, MS);
    for (const sx of [-2, 2]) for (let ly = 3; ly <= 6; ly++) p.set(C + sx, ly, 33, ly === 4 ? VR : SBR);
    p.fill(C - 2, 7, 33, C + 2, 7, 33, SBR);
    p.set(C - 1, 3, 31, Block.Lantern);
    p.set(C + 1, 3, 31, Block.Lantern);

    // ---- root chambers -----------------------------------------------------------------------
    for (const west of [true, false]) {
      const [a, b] = west ? [7, 9] : [31, 33];
      p.fill(a, 3, 17, b, 5, 23, Block.Air);
      for (let z = 17; z <= 23; z++) for (let x = a; x <= b; x++) p.set(x, 2, z, z % 2 === 0 ? MS : SBR);
      const door = west ? 10 : 30;
      p.fill(door, 3, 19, door, 4, 21, Block.Air);
      p.set(west ? 7 : 33, 3, C, Block.Chest);
      p.set(west ? 9 : 31, 3, 18, Block.Lantern);
      p.set(west ? 9 : 31, 3, 22, Block.Lantern);
      p.set(west ? 6 : 34, 4, C, VR);
      for (let z = 17; z <= 23; z++) p.set(west ? 8 : 32, 5, z, z % 2 === 0 ? Block.MahoganyLog : Block.Air);
    }

    // ---- sky shrine and ladders --------------------------------------------------------------
    p.fill(C - 4, 19, C - 4, C + 4, 22, C + 4, SBR);
    p.fill(C - 3, 19, C - 3, C + 3, 21, C + 3, Block.Air);
    p.fill(C - 1, 19, C - 4, C + 1, 20, C - 4, Block.Air);
    for (let x = C - 4; x <= C + 4; x++) p.set(x, 22, C - 4, x % 2 === 0 ? VR : SBR);
    p.set(C, 19, 21, Block.Chest);
    for (const [x, z] of [[C - 3, C - 3], [C + 3, C - 3], [C - 3, C + 3], [C + 3, C + 3]]) p.set(x, 19, z, Block.Lantern);
    for (let x = C - 4; x <= C + 4; x++) for (let z = C - 4; z <= C + 4; z++) {
      if (Math.max(Math.abs(x - C), Math.abs(z - C)) > 3) continue;
      p.set(x, 22, z, x === C && z === C ? Block.Lamp : MS);
    }
    for (const [hw, y0, y1] of TIERS) {
      const z = C - hw - 1;
      for (let ly = y0; ly <= y1; ly++) p.set(C, ly, z, Block.LadderPZ);
      if (hw === 14) for (let ly = 3; ly <= 6; ly++) p.set(C, ly, z, Block.LadderPZ);
    }
    // Canopy over the sky shrine.
    for (let r = 0; r < 4; r++) p.disc(C, C, 23 + r, 6 - r * 1.4, r % 2 === 0 ? ML : Block.Leaves);
    for (let i = 0; i < 20; i++) {
      const x = C - 5 + Math.floor(rng() * 11);
      const z = C - 5 + Math.floor(rng() * 11);
      if (p.get(x, 23, z) === ML) p.set(x, 22, z, Block.HangingMoss);
    }
    p.set(C, 24, C, Block.AspenLog);

    // ---- guardian trees ----------------------------------------------------------------------
    for (const [tx, tz] of [[4, 4], [36, 4], [4, 36], [36, 36]]) {
      for (let ly = 3; ly <= 17; ly++) {
        const w = ly < 9 ? 1 : 0;
        p.fill(tx - w, ly, tz - w, tx + w, ly, tz + w, Block.MahoganyLog);
      }
      // Roots.
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        p.fill(tx + dx, 3, tz + dz, tx + dx, 3, tz + dz, Block.MahoganyLog);
        p.set(tx + dx * 2, 3, tz + dz * 2, Block.MahoganyLog);
      }
      for (let dy = -3; dy <= 4; dy++) {
        const r = 5.5 - Math.abs(dy) * 0.9;
        p.disc(tx, tz, 17 + dy, r, rng() < 0.5 ? ML : Block.Leaves);
      }
      // Re-open the trunk through the canopy and add glow and vines.
      p.fill(tx, 17, tz, tx, 20, tz, Block.MahoganyLog);
      for (let i = 0; i < 14; i++) {
        const a = rng() * Math.PI * 2;
        const rr = 2 + rng() * 3.5;
        const x = Math.round(tx + Math.cos(a) * rr);
        const z = Math.round(tz + Math.sin(a) * rr);
        for (let k = 0; k < 2 + Math.floor(rng() * 4); k++) if (p.get(x, 16 - k, z) === Block.Air) p.set(x, 16 - k, z, Block.HangingMoss);
      }
      p.set(tx + 2, 14, tz + 2, GM);
    }
    return { volumes: [v], furniture: p.furniture };
  },
};
