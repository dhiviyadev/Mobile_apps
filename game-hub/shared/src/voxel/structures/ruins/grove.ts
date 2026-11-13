/**
 * Hollowheart Grove (forests, generator 4): a colossal hollow tree. A
 * knot-hole door in the south opens into the hall inside the trunk (heartwood
 * floor, root pillars, glowcap lamps, hanging vines), whose domed ceiling is
 * the boss arena's roof; four root dens with loot sit between the buttress
 * roots, a ladder up the north side climbs to the canopy platform, and the
 * crown is a wide leafy canopy hung with glowing fungus. Glowcap stalks and
 * ferns dress the clearing. 45 x 28 x 45, ly0 = F - 1, centred on (22, 22).
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 45;
const SY = 28;
const C = 22;
const A = 9;
const MLOG = Block.MahoganyLog;
const HW = Block.Heartwood;
const GC = Block.GlowcapBlock;
const GM = Block.GlowMoss;
const LV = Block.Leaves;
const ML = Block.MahoganyLeaves;
/** Canopy platform height. */
const CAN = 21;
/** Root dens: centre and the way their door faces. */
const DENS: { x: number; z: number; dx: number; dz: number }[] = [
  { x: 6, z: 6, dx: 1, dz: 1 },
  { x: 38, z: 6, dx: -1, dz: 1 },
  { x: 6, z: 38, dx: 1, dz: -1 },
  { x: 38, z: 38, dx: -1, dz: -1 },
];

const origin = (ax: number, az: number, F: number) => ({ ox: ax - C, oy: F - 1, oz: az - C });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(C, 2, C - A + 1, 0, LootTableId.GroveBoss, true),
    at(C + 3, CAN + 1, C - 6, 1, LootTableId.GroveCommon),
    at(6, 2, 6, 2, LootTableId.GroveCommon),
    at(38, 2, 38, 3, LootTableId.GroveCommon),
  ];
}

export const grove: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, SY - 1, S - 1),
      entrance: { x: ox + C, y: F + 1, z: oz + 43 },
      arena: box(ox, oy, oz, C - A, 2, C - A, C + A, 9, C + A),
      bossSpawn: { x: ox + C + 0.5, y: F + 1, z: oz + C + 0.5 },
      altar: { x: ox + C, y: oy + 2, z: oz + C - A + 2 },
      doorways: [box(ox, oy, oz, C - 1, 2, C + 10, C + 1, 5, C + 13)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + C + 0.5, y: F + 1, z: oz + 40.5 },
        { x: ox + 12.5, y: F + 1, z: oz + 36.5 },
        { x: ox + 32.5, y: F + 1, z: oz + 36.5 },
        { x: ox + 4.5, y: F + 1, z: oz + 22.5 },
        { x: ox + 40.5, y: F + 1, z: oz + 22.5 },
        { x: ox + 22.5, y: F + 1, z: oz + 4.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, SY, S, Block.Dirt);
    const p = new Pen(v);

    // ---- clearing -------------------------------------------------------------------------------
    p.fill(0, 0, 0, S - 1, 0, S - 1, Block.Dirt);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - C, z - C);
        const r = rng();
        p.set(x, 1, z, d < 14 ? (r < 0.5 ? Block.ForestFloor : Block.Dirt) : r < 0.3 ? Block.ForestFloor : r < 0.5 ? Block.Grass : Block.Dirt);
      }
    }
    p.fill(0, 2, 0, S - 1, SY - 1, S - 1, Block.Air);

    // ---- trunk: tapering ring of mahogany with a heartwood skin ----------------------------------
    for (let ly = 1; ly <= CAN - 1; ly++) {
      const r = 13.5 - Math.max(0, ly - 6) * 0.2;
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const d = Math.hypot(x - C, z - C);
          const wob = Math.sin(Math.atan2(z - C, x - C) * 7 + ly * 0.4) * 0.6;
          if (d <= r + wob) p.set(x, ly, z, d > r + wob - 1.2 && rng() < 0.25 ? HW : MLOG);
        }
      }
    }
    // Buttress roots flaring from the trunk: eight roots wind out along the ground.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      for (let t = 12; t <= 20; t++) {
        const x = Math.round(C + Math.cos(a) * t);
        const z = Math.round(C + Math.sin(a) * t);
        const h = Math.max(1, 7 - Math.floor((t - 12) * 0.8));
        for (let ly = 2; ly <= 1 + h; ly++) for (const [dx, dz] of [[0, 0], [1, 0]]) if (ly <= 1 + h - Math.abs(dz) * 1) p.set(x + dx, ly, z + dz, MLOG);
      }
    }
    // Hall: circular, floor of heartwood with glowing rings, domed ceiling.
    for (let z = C - 10; z <= C + 10; z++) {
      for (let x = C - 10; x <= C + 10; x++) {
        const d = Math.hypot(x - C, z - C);
        if (d <= 9.7) {
          for (let ly = 2; ly <= 11; ly++) p.set(x, ly, z, Block.Air);
          p.set(x, 1, z, Math.abs(d - 4) < 0.7 || Math.abs(d - 8) < 0.5 ? GM : (x + z) % 4 === 0 ? MLOG : HW);
          // Dome: ceiling steps up toward the middle.
          const top = d < 4 ? 12 : d < 7 ? 11 : 10;
          for (let ly = top; ly <= top + 1; ly++) p.set(x, ly, z, HW);
          if (d < 4) p.set(x, 13, z, MLOG);
        }
      }
    }
    // Arena-box corners beyond the circle are trunk wall: furniture.
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) for (let ly = 2; ly <= 9; ly++) {
      if (p.get(C + dx, ly, C + dz) !== Block.Air) p.furniture.push({ x: ox + C + dx, y: oy + ly, z: oz + C + dz });
    }
    // Ceiling and wall lights: glowcaps, lamps, hanging vines.
    for (const [dx, dz] of [[0, 0], [-5, 0], [5, 0], [0, 5], [0, -5], [-8, 0], [8, 0], [0, 8]]) {
      const d = Math.hypot(dx, dz);
      const top = d < 4 ? 12 : d < 7 ? 11 : 10;
      p.set(C + dx, top, C + dz, GC);
      p.furnish(C + dx, top - 1, C + dz, Block.Lamp);
    }
    for (let i = 0; i < 24; i++) {
      const a = rng() * Math.PI * 2;
      const rr = rng() * 9;
      const x = Math.round(C + Math.cos(a) * rr);
      const z = Math.round(C + Math.sin(a) * rr);
      const top = rr < 4 ? 12 : rr < 7 ? 11 : 10;
      const len = 1 + Math.floor(rng() * 3);
      for (let k = 1; k <= len; k++) if (p.get(x, top - k, z) === Block.Air) p.furnish(x, top - k, z, Block.HangingMoss);
    }
    // Root pillars (twin logs), glowcap stalks and lanterns on the floor.
    for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      for (let ly = 2; ly <= 9; ly++) for (const [ex, ez] of [[0, 0], [1, 0], [0, 1]]) p.furnish(C + dx + ex, ly, C + dz + ez, ly === 5 ? GC : MLOG);
      p.furnish(C + dx - 1, 2, C + dz, Block.Lantern);
    }
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2 + 0.13;
      const x = Math.round(C + Math.cos(ang) * 8.6);
      const z = Math.round(C + Math.sin(ang) * 8.6);
      if (p.get(x, 2, z) === Block.Air && !(Math.abs(x - C) <= 2 && z > C)) p.furnish(x, 2, z, a % 3 === 0 ? Block.Lantern : Block.BrownMushroom);
    }
    for (const [dx, dz] of [[-3, 3], [3, 3], [-3, -3], [3, -3], [0, 3]]) p.furnish(C + dx, 2, C + dz, Block.Lantern);
    // Altar: a dais of logs against the north wall, framed by two glowing arches.
    p.furnish(C, 2, C - A + 2, Block.BossAltar);
    p.furnish(C, 2, C - A + 1, Block.Chest);
    for (const dx of [-3, 3]) for (let ly = 2; ly <= 8; ly++) p.furnish(C + dx, ly, C - A + 1, ly % 3 === 2 ? GC : MLOG);
    for (let dx = -3; dx <= 3; dx++) p.furnish(C + dx, 9, C - A + 1, Math.abs(dx) <= 1 ? GC : MLOG);
    // Knot-hole door in the south: a wide arch cut through the trunk wall, with root steps outside.
    for (let dz = 9; dz <= 15; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.abs(dx) > 1) continue;
      for (let ly = 2; ly <= 5; ly++) p.set(C + dx, ly, C + dz, Block.Air);
    }
    for (let dz = 9; dz <= 16; dz++) for (let dx = -1; dx <= 1; dx++) p.set(C + dx, 1, C + dz, dx === 0 ? Block.Heartwood : Block.ForestFloor);
    for (const sx of [-3, 3]) for (let ly = 2; ly <= 4; ly++) p.set(C + sx, ly, C + 12, ly === 4 ? GC : MLOG);
    p.set(C - 2, 2, C + 14, Block.Lantern);
    p.set(C + 2, 2, C + 14, Block.Lantern);
    for (let dz = 17; dz <= 21; dz++) for (let dx = -1; dx <= 1; dx++) p.set(C + dx, 1, C + dz, dx === 0 ? Block.Heartwood : Block.ForestFloor);

    // ---- root dens ----------------------------------------------------------------------------------
    for (const d of DENS) {
      p.cyl(d.x, d.z, 2, 5, 4.2, Block.Dirt);
      p.disc(d.x, d.z, 6, 3, Block.ForestFloor);
      p.cyl(d.x, d.z, 2, 4, 2.6, Block.Air);
      for (let i = 0; i < 6; i++) p.set(d.x - 3 + Math.floor(rng() * 7), 6, d.z - 3 + Math.floor(rng() * 7), rng() < 0.5 ? Block.Fern : ML);
      // Door cut toward the trunk's outside, and root frame.
      p.fill(d.x - 0, 2, d.z, d.x + d.dx * 4, 3, d.z + d.dz * 4, Block.Air);
      p.fill(d.x + d.dx * 3, 2, d.z, d.x + d.dx * 4, 3, d.z, Block.Air);
      p.fill(d.x, 2, d.z + d.dz * 3, d.x, 3, d.z + d.dz * 4, Block.Air);
      p.set(d.x + d.dx * 3, 4, d.z, MLOG);
      p.set(d.x, 4, d.z + d.dz * 3, MLOG);
      p.set(d.x, 2, d.z + 0, Block.Chest);
      p.set(d.x + d.dx, 2, d.z + d.dz, Block.Lantern);
      p.set(d.x - d.dx, 5, d.z - d.dz, GC);
      p.set(d.x - d.dx, 4, d.z - d.dz, Block.Lamp);
    }

    // ---- ladder to the canopy and the platform ---------------------------------------------------------
    for (let ly = 2; ly <= CAN; ly++) {
      p.set(C, ly, C - 14, MLOG);
      p.set(C, ly, C - 15, Block.LadderPZ);
    }
    p.set(C - 1, 3, C - 15, Block.Lantern);
    for (const ly of [6, 11, 16]) p.set(C + 1, ly, C - 15, Block.Lantern);
    // Platform of planks on the great limbs, with a rail and a hut-like chest nook.
    p.disc(C, C, CAN, 11.5, Block.Planks);
    p.disc(C, C, CAN, 8, HW);
    p.fill(C - 1, CAN, C - 14, C + 1, CAN, C - 12, Block.Planks);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const x = Math.round(C + Math.cos(a) * 11.3);
      const z = Math.round(C + Math.sin(a) * 11.3);
      if (Math.abs(x - C) <= 1 && z < C) continue;
      p.set(x, CAN + 1, z, i % 2 === 0 ? MLOG : Block.PlankSlab);
    }
    p.set(C + 3, CAN + 1, C - 6, Block.Chest);
    for (const [dx, dz] of [[2, -5], [4, -5], [-3, -3], [3, 3], [-4, 4]]) p.set(C + dx, CAN + 1, C + dz, Block.Lantern);
    // Limbs: logs fanning out under the platform, with fruit and glowing fungus in the leaves.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      for (let t = 10; t <= 19; t++) {
        const x = Math.round(C + Math.cos(a) * t);
        const z = Math.round(C + Math.sin(a) * t);
        const y = CAN - 2 + Math.floor((t - 10) / 3);
        if (x < 1 || z < 1 || x > S - 2 || z > S - 2) continue;
        p.set(x, y, z, MLOG);
        p.set(x + 1, y, z, MLOG);
      }
    }
    // The canopy: leaf discs with holes, vines, glowcaps and melons.
    for (let ly = CAN + 1; ly <= SY - 2; ly++) {
      const r = 20 - (ly - CAN) * 2.6;
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const d = Math.hypot(x - C, z - C);
          if (d > r || d < (ly === CAN + 1 ? 12 : 5) - 0) continue;
          if (p.get(x, ly, z) !== Block.Air) continue;
          const n = Math.sin(x * 0.7 + ly) + Math.cos(z * 0.6 - ly * 0.5);
          if (ly <= CAN + 3 ? n < -0.4 : n < 0.3 && rng() < 0.9) continue;
          if (d < 10.5 && ly <= CAN + 2) continue;
          p.set(x, ly, z, rng() < 0.55 ? ML : LV);
        }
      }
    }
    for (let i = 0; i < 70; i++) {
      const a = rng() * Math.PI * 2;
      const rr = 11 + rng() * 8;
      const x = Math.round(C + Math.cos(a) * rr);
      const z = Math.round(C + Math.sin(a) * rr);
      for (let ly = CAN + 3; ly >= CAN; ly--) {
        if (p.get(x, ly, z) === ML || p.get(x, ly, z) === LV) {
          const len = 2 + Math.floor(rng() * 4);
          for (let k = 1; k <= len; k++) if (p.get(x, ly - k, z) === Block.Air) p.set(x, ly - k, z, k === len && rng() < 0.4 ? GC : Block.HangingMoss);
          break;
        }
      }
    }
    // Clearing dressing: glowcap stalks, ferns, mushrooms.
    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2;
      const rr = 15 + rng() * 6.5;
      const x = Math.round(C + Math.cos(a) * rr);
      const z = Math.round(C + Math.sin(a) * rr);
      if (x < 1 || z < 1 || x > S - 2 || z > S - 2 || p.get(x, 2, z) !== Block.Air) continue;
      const r = rng();
      if (r < 0.16) {
        const h = 2 + Math.floor(rng() * 3);
        p.fill(x, 2, z, x, 1 + h, z, Block.Log);
        p.disc(x, z, 2 + h, 1.6, GC);
      } else p.set(x, 2, z, r < 0.6 ? Block.Fern : r < 0.8 ? Block.Duskcap : Block.RedMushroom);
    }
    return { volumes: [v], furniture: p.furniture };
  },
};
