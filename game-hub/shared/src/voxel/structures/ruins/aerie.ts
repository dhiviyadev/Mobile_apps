/**
 * Stormcrown Aerie (mountain peaks, generator 4): a cloudstone summit
 * platform crowned by a broken ring of twelve pillars (crystal-tipped, some
 * joined by lintels), four banner-hung crystal pillars at the compass points,
 * a woven nest of logs and hay in the middle (the boss arena, open to the
 * sky, rimmed and strewn with giant eggs), a perch tower with a ladder and
 * chest, and two wind-shelter huts. The summit is a pedestal: its foundation
 * fills down to the mountain. 45 x 17 x 45, ly0 = F - 1, centred on (22, 22).
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 45;
const SY = 17;
const C = 22;
const CS = Block.CloudstoneBricks;
const GR = Block.GaleRune;
const FC = Block.FrostCrystal;
/** Nest interior half-width: arena box is 19 x 19, ly 2..9. */
const A = 9;
const PERCH = { x: 10, z: 10 };

const origin = (ax: number, az: number, F: number) => ({ ox: ax - C, oy: F - 1, oz: az - C });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(C, 2, C - A + 1, 0, LootTableId.AerieBoss, true),
    at(PERCH.x + 1, 14, PERCH.z, 1, LootTableId.AerieCommon),
    at(36, 3, 11, 2, LootTableId.AerieCommon),
    at(9, 3, 34, 3, LootTableId.AerieCommon),
  ];
}

export const aerie: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, SY - 1, S - 1),
      entrance: { x: ox + C, y: F + 1, z: oz + 40 },
      arena: box(ox, oy, oz, C - A, 2, C - A, C + A, 9, C + A),
      bossSpawn: { x: ox + C + 0.5, y: F + 1, z: oz + C + 0.5 },
      altar: { x: ox + C, y: oy + 2, z: oz + C - A + 2 },
      doorways: [box(ox, oy, oz, C - 1, 2, C + 10, C + 1, 5, C + 11)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + C + 6.5, y: F + 1, z: oz + 36.5 },
        { x: ox + C - 6.5, y: F + 1, z: oz + 36.5 },
        { x: ox + 37.5, y: F + 1, z: oz + 22.5 },
        { x: ox + 7.5, y: F + 1, z: oz + 22.5 },
        { x: ox + 33.5, y: F + 1, z: oz + 8.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, SY, S, Block.Stone);
    const p = new Pen(v);
    const stone = () => (rng() < 0.25 ? Block.Marble : rng() < 0.3 ? Block.Stone : CS);

    // ---- summit platform: a pedestal of two terraces and a compass-rose plaza ------------------
    p.cyl(C, C, 0, 0, 21.5, Block.Stone);
    p.disc(C, C, 1, 20.5, CS);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (p.get(x, 1, z) !== CS) continue;
        const d = Math.hypot(x - C, z - C);
        const a = Math.atan2(z - C, x - C);
        let id: number = rng() < 0.12 ? Block.Marble : CS;
        if (Math.abs(d - 18.5) < 0.7) id = GR;
        else if (d > 19.5) id = Block.PolishedStone;
        else if (Math.abs(Math.sin(a * 4)) < 0.1 && d > 11.5 && d < 18) id = Block.Marble;
        p.set(x, 1, z, id);
      }
    }
    p.fill(0, 2, 0, S - 1, SY - 1, S - 1, Block.Air);

    // ---- the nest: a woven bowl of logs and hay, open to the sky ----------------------------------
    for (let z = C - 12; z <= C + 12; z++) {
      for (let x = C - 12; x <= C + 12; x++) {
        const d = Math.hypot(x - C, z - C);
        if (d <= 9.6) p.set(x, 1, z, (x + z) % 3 === 0 ? Block.Log : (x * 3 + z) % 5 === 0 ? Block.Planks : Block.HayBale);
        else if (d <= 11.6) {
          const h = 4;
          for (let ly = 1; ly <= h; ly++) p.set(x, ly, z, (ly + x + z) % 2 === 0 ? Block.Log : Block.HayBale);
          if (rng() < 0.35) p.set(x, h + 1, z, Block.DryGrass);
        }
      }
    }
    // Chamfer cells of the arena box beyond the nest are rim: mark the solid ones as furniture.
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) for (let ly = 2; ly <= 9; ly++) {
      if (p.get(C + dx, ly, C + dz) !== Block.Air) p.furniture.push({ x: ox + C + dx, y: oy + ly, z: oz + C + dz });
    }
    // The south gap through the rim, paved.
    p.fill(C - 1, 2, C + 10, C + 1, 5, C + 11, Block.Air);
    for (let z = C + 10; z <= C + 12; z++) for (let x = C - 1; x <= C + 1; x++) p.set(x, 1, z, x === C ? Block.Marble : CS);
    // Giant eggs and downy tufts inside the nest.
    for (const [dx, dz, w] of [[-6, -3, 2], [6, -4, 2], [-5, 5, 1], [7, 3, 2], [0, -6, 1]]) {
      for (let ly = 2; ly <= 3 + (w === 2 ? 1 : 0); ly++) for (let x = 0; x < w; x++) for (let z = 0; z < w; z++) p.furnish(C + dx + x, ly, C + dz + z, ly === 4 ? Block.ClothWhite : ly === 3 ? Block.Marble : Block.ClothWhite);
    }
    // Altar throne against the north side of the nest: a cloudstone seat.
    p.furnish(C, 2, C - A + 2, Block.BossAltar);
    p.furnish(C, 2, C - A + 1, Block.Chest);
    for (const dx of [-2, 2]) for (let ly = 2; ly <= 7; ly++) p.furnish(C + dx, ly, C - A + 1, ly % 3 === 0 ? GR : CS);
    // Light: crystal posts and lanterns around the rim.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26;
      const x = Math.round(C + Math.cos(a) * 8.7);
      const z = Math.round(C + Math.sin(a) * 8.7);
      if (p.get(x, 2, z) === Block.Air) p.furnish(x, 2, z, Block.Lantern);
    }
    for (const [dx, dz] of [[-4, 0], [4, 0], [0, 4], [0, -4], [-3, -4], [3, -4]]) p.furnish(C + dx, 2, C + dz, Block.Lantern);

    // ---- the crown: a broken ring of pillars ---------------------------------------------------------
    const crown: [number, number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = Math.round(C + Math.cos(a) * 16.5);
      const z = Math.round(C + Math.sin(a) * 16.5);
      const broken = rng() < 0.3;
      const h = broken ? 4 + Math.floor(rng() * 3) : 11 + Math.floor(rng() * 3);
      crown.push([x, z, h]);
      for (let ly = 2; ly <= 1 + h; ly++) {
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) p.set(x + dx, ly, z + dz, ly === 2 ? Block.PolishedStone : ly % 4 === 3 ? GR : stone());
      }
      if (!broken) {
        p.set(x, 2 + h, z, FC);
        p.set(x, 3 + h, z, FC);
        p.set(x + 1, 2 + h, z + 1, Block.Lamp);
      } else if (rng() < 0.5) p.set(x, 2 + h, z, Block.MossyCobble);
    }
    // Lintels between neighbouring tall pillars.
    for (let i = 0; i < 12; i++) {
      const [x0, z0, h0] = crown[i];
      const [x1, z1, h1] = crown[(i + 1) % 12];
      if (h0 < 10 || h1 < 10) continue;
      p.line(x0, h0, z0, x1, h1, z1, CS);
      p.line(x0 + 1, h0, z0 + 1, x1 + 1, h1, z1 + 1, Block.PolishedStone);
    }
    // Compass crystal pillars with banners.
    for (const [dx, dz] of [[0, -19], [19, 0], [0, 19], [-19, 0]]) {
      const x = C + dx;
      const z = C + dz;
      for (let ly = 2; ly <= 12; ly++) p.set(x, ly, z, ly === 2 ? Block.PolishedStone : ly % 3 === 0 ? GR : CS);
      p.fill(x, 13, z, x, 15, z, FC);
      const sx = dx === 0 ? 1 : 0;
      const sz = dz === 0 ? 1 : 0;
      for (const side of [-1, 1]) {
        for (let ly = 10; ly >= 5; ly--) p.set(x + sx * side, ly, z + sz * side, ly > 7 ? Block.ClothBlue : ly > 5 ? Block.ClothWhite : Block.ClothBlue);
      }
    }

    // ---- perch tower, huts -------------------------------------------------------------------------
    const t = PERCH;
    p.room(t.x - 2, 2, t.z - 2, t.x + 2, 13, t.z + 2, CS, CS, CS);
    p.fill(t.x - 1, 3, t.z - 1, t.x + 1, 12, t.z + 1, Block.Air);
    p.fill(t.x - 2, 13, t.z - 2, t.x + 2, 13, t.z + 2, CS);
    p.fill(t.x - 1, 13, t.z - 1, t.x + 1, 13, t.z + 1, Block.Planks);
    p.fill(t.x, 3, t.z - 1, t.x, 12, t.z - 1, Block.LadderNZ);
    p.fill(t.x + 2, 3, t.z, t.x + 2, 4, t.z, Block.Air);
    for (const ly of [5, 8, 11]) for (const [dx, dz] of [[0, 2], [2, 0], [-2, 0]]) p.set(t.x + dx, ly, t.z + dz, GR);
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      p.fill(t.x + dx, 14, t.z + dz, t.x + dx, 15, t.z + dz, CS);
      p.set(t.x + dx, 16, t.z + dz, FC);
    }
    for (let x = t.x - 2; x <= t.x + 2; x++) for (const z of [t.z - 2, t.z + 2]) if (x !== t.x - 2 && x !== t.x + 2) p.set(x, 14, z, x % 2 === 0 ? CS : Block.StoneBrickSlab);
    for (let z = t.z - 2; z <= t.z + 2; z++) for (const x of [t.x - 2, t.x + 2]) if (z !== t.z - 2 && z !== t.z + 2) p.set(x, 14, z, z % 2 === 0 ? CS : Block.StoneBrickSlab);
    p.set(t.x + 1, 14, t.z, Block.Chest);
    p.set(t.x - 1, 14, t.z + 1, Block.Lantern);
    p.set(t.x, 4, t.z + 1, Block.Lantern);
    // Huts.
    for (const [hx, hz, door, cx, cz] of [[34, 9, 0, 36, 11], [7, 32, 1, 9, 34]] as const) {
      p.room(hx, 2, hz, hx + 5, 6, hz + 5, CS, Block.Planks, Block.Planks);
      p.fill(hx + 1, 3, hz + 1, hx + 4, 5, hz + 4, Block.Air);
      if (door === 0) p.fill(hx, 3, hz + 2, hx, 4, hz + 3, Block.Air);
      else p.fill(hx + 5, 3, hz + 2, hx + 5, 4, hz + 3, Block.Air);
      p.set(cx, 3, cz, Block.Chest);
      p.set(hx + 2, 3, hz + 4, Block.Lantern);
      p.set(hx + 2, 5, hz + 2, GR);
      p.set(hx + 5 - (door === 0 ? 0 : 5), 4, hz + 1, Block.GlassBlue);
    }
    // Snow drifts and frost on the exposed upper blocks.
    for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
      if (Math.hypot(x - C, z - C) < 14) continue;
      for (let ly = SY - 2; ly >= 2; ly--) {
        if (p.get(x, ly, z) === Block.Air) continue;
        if (p.get(x, ly + 1, z) === Block.Air && [CS, Block.Marble, Block.Stone].includes(p.get(x, ly, z)) && rng() < 0.12) p.set(x, ly + 1, z, Block.SnowLayer);
        break;
      }
    }
    return { volumes: [v], furniture: p.furniture };
  },
};
