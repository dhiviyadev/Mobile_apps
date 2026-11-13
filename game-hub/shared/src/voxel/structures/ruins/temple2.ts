/**
 * Sunscorch Temple, generator-4 version (Dunes, Redrock, Savanna): a five-tier
 * gilded step pyramid on a paved plaza. A processional avenue lined with sun
 * idols and lava braziers leads to a tunnel into the colonnaded boss hall at
 * the pyramid's heart, lit by a golden sunwell; a grand cleft stair on the
 * south face climbs to a crowned sun pavilion with a chest. Two vaults flank
 * the hall; four obelisks mark the plaza corners.
 * 45 x 26 x 57; the pyramid is centred on (22, 34); ly0 = F - 1.
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const SX = 45;
const SY = 26;
const SZ = 57;
const CX = 22;
const CZ = 34;
const TIERS = [17, 14, 11, 8, 5];
/** Hall interior (inclusive local): 21 wide x 16 deep, ly 2..9; the grand stair passes over its south end. */
const H0 = 12;
const H1 = 32;
const HZ0 = CZ - 10;
const HZ1 = CZ + 5;

const origin = (ax: number, az: number, F: number) => ({ ox: ax - CX, oy: F - 1, oz: az - CZ });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(CX, 2, HZ1, 0, LootTableId.TempleBoss, true),
    at(8, 2, CZ, 1, LootTableId.TempleCommon),
    at(36, 2, CZ, 2, LootTableId.TempleCommon),
    at(CX, 17, CZ - 2, 3, LootTableId.TempleCommon),
  ];
}

export const temple2: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, SX - 1, SY - 1, SZ - 1),
      entrance: { x: ox + CX, y: F + 1, z: oz + 2 },
      arena: box(ox, oy, oz, H0, 2, HZ0, H1, 9, HZ1),
      bossSpawn: { x: ox + CX + 0.5, y: F + 1, z: oz + CZ + 0.5 - 2 },
      altar: { x: ox + CX, y: oy + 2, z: oz + HZ1 - 1 },
      doorways: [box(ox, oy, oz, CX - 2, 2, CZ - 11, CX + 2, 5, CZ - 11)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 12.5, y: F + 1, z: oz + 9.5 },
        { x: ox + 32.5, y: F + 1, z: oz + 9.5 },
        { x: ox + 8.5, y: F + 1, z: oz + 26.5 },
        { x: ox + 36.5, y: F + 1, z: oz + 26.5 },
        { x: ox + 14.5, y: F + 1, z: oz + 53.5 },
        { x: ox + 30.5, y: F + 1, z: oz + 53.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, SX, SY, SZ, Block.Sandstone);
    const p = new Pen(v);
    const SB = Block.SandstoneBricks;

    // ---- plaza -------------------------------------------------------------------------------
    p.fill(0, 0, 0, SX - 1, 0, SZ - 1, Block.Sandstone);
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const d = Math.max(Math.abs(x - CX), Math.abs(z - CZ));
        let id: number = SB;
        if (d === 20) id = Block.GildedBricks;
        else if (d === 22 || d === 19) id = Block.Sandstone;
        else if (d >= 23 && (x + z) % 5 === 0) id = Block.Sandstone;
        // Avenue: a marble spine with gilded edges.
        if (z < CZ - 17 && Math.abs(x - CX) <= 2) id = Math.abs(x - CX) === 2 ? Block.GildedBricks : x === CX ? Block.Marble : Block.Sandstone;
        const edge = x <= 1 || z <= 1 || x >= SX - 2 || z >= SZ - 2;
        if (edge && rng() < 0.3) id = Block.Sand;
        p.set(x, 1, z, id);
      }
    }
    p.fill(0, 2, 0, SX - 1, SY - 1, SZ - 1, Block.Air);

    // ---- the pyramid -------------------------------------------------------------------------
    TIERS.forEach((hw, t) => {
      for (let ly = 2 + 3 * t; ly <= 4 + 3 * t; ly++) {
        p.fill(CX - hw, ly, CZ - hw, CX + hw, ly, CZ + hw, SB);
      }
      const top = 4 + 3 * t;
      // Coping: the outer ring of the top layer is gilded, the rest plain sandstone.
      p.fill(CX - hw, top, CZ - hw, CX + hw, top, CZ + hw, Block.Sandstone);
      for (let i = -hw; i <= hw; i++) {
        for (const [x, z] of [[CX + i, CZ - hw], [CX + i, CZ + hw], [CX - hw, CZ + i], [CX + hw, CZ + i]]) p.set(x, top, z, Block.GildedBricks);
      }
      // Frieze of glowing sun runes on the faces of the middle layer.
      const mid = 3 + 3 * t;
      for (let i = -hw + 1; i < hw; i++) {
        const id = (i + hw) % 3 === 1 ? Block.SunRune : (i + hw) % 3 === 2 ? Block.GildedBricks : SB;
        p.set(CX + i, mid, CZ - hw, id);
        p.set(CX + i, mid, CZ + hw, id);
        p.set(CX - hw, mid, CZ + i, id);
        p.set(CX + hw, mid, CZ + i, id);
      }
      // Corner posts.
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) p.pillar(CX + sx * hw, CZ + sz * hw, 2 + 3 * t, 5 + 3 * t, Block.MarblePillar, Block.GildedBricks, Block.GildedBricks);
    });
    // Weathering of the upper tiers.
    for (let ly = 5; ly < 17; ly++) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          const id = v.get(x, ly, z);
          if (id !== SB && id !== Block.Sandstone) continue;
          const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => v.get(x + dx, ly + dy, z + dz) === Block.Air);
          if (!exposed) continue;
          const r = rng();
          if (r < 0.14) v.set(x, ly, z, Block.Sandstone);
          else if (r < 0.19) v.set(x, ly, z, Block.Sand);
        }
      }
    }

    // ---- the cleft stair up the south face ---------------------------------------------------
    const surf = (z: number) => 1 + (CZ + 18 - z);
    for (let z = CZ + 18; z >= CZ + 3; z--) {
      const s = surf(z);
      for (let x = CX - 2; x <= CX + 2; x++) {
        for (let ly = 2; ly <= SY - 1; ly++) {
          if (ly <= s) p.set(x, ly, z, ly === s ? (x === CX ? Block.Marble : Block.Sandstone) : SB);
          else if (ly <= s + 4 || v.get(x, ly, z) !== Block.Air) p.set(x, ly, z, Block.Air);
        }
      }
      // Gilded cheeks and lanterns up the stair.
      for (const sx of [-3, 3]) {
        const cell = v.get(CX + sx, s, z);
        if (cell !== Block.Air) p.set(CX + sx, s, z, Block.GildedBricks);
        if (z % 3 === 0 && v.get(CX + sx, s + 1, z) === Block.Air) p.set(CX + sx, s + 1, z, Block.Lantern);
      }
    }
    // ---- boss hall ---------------------------------------------------------------------------
    p.fill(H0 - 1, 1, HZ0 - 1, H1 + 1, 1, HZ1 + 1, SB);
    p.fill(H0, 2, HZ0, H1, 9, HZ1, Block.Air);
    for (let z = HZ0; z <= HZ1; z++) {
      for (let x = H0; x <= H1; x++) {
        const d = Math.max(Math.abs(x - CX), Math.abs(z - CZ));
        let id: number = SB;
        if (d <= 1) id = Block.GildedBricks;
        else if (d === 3 || d === 4) id = Block.Marble;
        else if (d === 7) id = Block.SunRune;
        else if (x === CX || z === CZ) id = Block.GildedBricks;
        else if ((x + z) % 7 === 0) id = Block.Sandstone;
        p.set(x, 1, z, id);
        p.set(x, 10, z, SB);
      }
    }
    // Wall band: marble course and glowing runes; coffered ceiling.
    for (let i = H0; i <= H1; i++) {
      for (const [x, z] of [[i, HZ0 - 1], [i, HZ1 + 1]]) {
        p.set(x, 5, z, Block.Marble);
        p.set(x, 6, z, i % 4 === 0 ? Block.SunRune : SB);
        p.set(x, 9, z, Block.GildedBricks);
      }
    }
    for (let i = HZ0; i <= HZ1; i++) {
      for (const [x, z] of [[H0 - 1, i], [H1 + 1, i]]) {
        p.set(x, 5, z, Block.Marble);
        p.set(x, 6, z, i % 4 === 0 ? Block.SunRune : SB);
        p.set(x, 9, z, Block.GildedBricks);
      }
    }
    for (let z = HZ0; z <= HZ1; z += 4) for (let x = H0; x <= H1; x += 4) p.set(x, 10, z, Block.Lamp);
    // Colonnade.
    for (const sx of [-8, 8]) {
      for (const dz of [-8, -4, 0, 4]) {
        const x = CX + sx;
        const z = CZ + dz;
        p.fill(x, 2, z, x, 9, z, Block.MarblePillar);
        for (let ly = 2; ly <= 9; ly++) p.furnish(x, ly, z, ly === 2 ? Block.GildedBricks : ly === 9 ? Block.GildedBricks : ly === 6 ? Block.SunRune : Block.MarblePillar);
        // A lantern at the foot of every column, on the hall side.
        p.furnish(x + (sx < 0 ? 1 : -1), 2, z, Block.Lantern);
        if (dz === 4) p.furnish(x, 2, z + 1, Block.Lantern);
      }
    }
    // Sun idols flanking the altar and lit floor lanterns along the south and north walls.
    for (const sx of [-6, 6]) {
      const x = CX + sx;
      const z = HZ1;
      for (let ly = 2; ly <= 6; ly++) p.furnish(x, ly, z, ly < 4 ? Block.GildedBricks : ly === 5 ? Block.SunRune : Block.Marble);
      p.furnish(x, 7, z, Block.GlassAmber);
    }
    for (const dx of [-8, -4, 4, 8]) p.furnish(CX + dx, 2, HZ1, Block.Lantern);
    for (const dx of [-10, -6, 6, 10]) p.furnish(CX + dx, 2, HZ0, Block.Lantern);
    for (const dx of [-10, 10]) p.furnish(CX + dx, 2, HZ1, Block.Lantern);
    // Altar and chest at the south end, a gilded mural behind them.
    p.furnish(CX, 2, HZ1 - 1, Block.BossAltar);
    p.furnish(CX, 2, HZ1, Block.Chest);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 3; ly <= 8; ly++) {
      const edge = Math.abs(dx) === 2 || ly === 3 || ly === 8;
      p.set(CX + dx, ly, HZ1 + 1, edge ? Block.GildedBricks : Math.abs(dx) <= 1 && ly >= 5 && ly <= 6 ? Block.SunRune : SB);
    }
    // Sunwell: a shaft of daylight from the hall ceiling to the pavilion floor.
    for (let ly = 10; ly <= 16; ly++) p.disc(CX, CZ, ly, 2.2, ly === 16 ? Block.GlassAmber : Block.Air);
    for (let ly = 10; ly <= 15; ly++) p.ringWall(CX, CZ, ly, ly, 3.2, ly % 2 === 0 ? Block.GildedBricks : SB, 1);
    p.set(CX, 10, CZ, Block.Air);

    // ---- entrance tunnel from the avenue -----------------------------------------------------
    p.fill(CX - 2, 2, CZ - 17, CX + 2, 5, CZ - 11, Block.Air);
    p.fill(CX - 3, 6, CZ - 17, CX + 3, 6, CZ - 11, Block.Marble);
    for (let z = CZ - 17; z <= CZ - 11; z++) {
      p.set(CX - 2, 1, z, z % 2 === 0 ? Block.GildedBricks : Block.Marble);
      p.set(CX + 2, 1, z, z % 2 === 0 ? Block.GildedBricks : Block.Marble);
      if (z % 3 === 0) {
        p.set(CX - 2, 4, z, Block.SunRune);
        p.set(CX + 2, 4, z, Block.SunRune);
      }
    }
    // Entrance portal: two tall gilded pylons and a lintel.
    for (const sx of [-4, 4]) {
      for (let ly = 2; ly <= 9; ly++) p.set(CX + sx, ly, CZ - 18, ly === 9 ? Block.SunRune : ly % 3 === 0 ? Block.GildedBricks : SB);
      p.set(CX + sx, 10, CZ - 18, Block.Lamp);
    }
    for (let dx = -4; dx <= 4; dx++) p.set(CX + dx, 6, CZ - 18, dx % 2 === 0 ? Block.GildedBricks : Block.Marble);
    p.fill(CX - 3, 7, CZ - 18, CX + 3, 7, CZ - 18, SB);
    p.fill(CX - 2, 8, CZ - 18, CX + 2, 8, CZ - 18, Block.GildedBricks);

    // ---- side vaults -------------------------------------------------------------------------
    for (const west of [true, false]) {
      const [a, b] = west ? [8, 10] : [34, 36];
      p.fill(a, 2, CZ - 4, b, 4, CZ + 4, Block.Air);
      for (let z = CZ - 4; z <= CZ + 4; z++) for (let x = a; x <= b; x++) p.set(x, 1, z, z % 2 === 0 ? Block.Marble : SB);
      const door = west ? 11 : 33;
      p.fill(door, 2, CZ - 1, door, 3, CZ + 1, Block.Air);
      p.set(west ? 7 : 37, 3, CZ, Block.SunRune);
      p.set(west ? 9 : 35, 4, CZ - 3, Block.Lamp);
      p.set(west ? 9 : 35, 4, CZ + 3, Block.Lamp);
      p.set(west ? 8 : 36, 2, CZ, Block.Chest);
      p.set(west ? 9 : 35, 2, CZ - 3, Block.Lantern);
      p.set(west ? 9 : 35, 2, CZ + 3, Block.Lantern);
    }

    // ---- sun pavilion crowning the pyramid ----------------------------------------------------
    p.fill(CX - 4, 16, CZ - 4, CX + 4, 16, CZ + 4, Block.GildedBricks);
    p.fill(CX - 3, 16, CZ - 3, CX + 3, 16, CZ + 3, Block.Marble);
    p.disc(CX, CZ, 16, 2.2, Block.GlassAmber);
    for (const [sx, sz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      p.pillar(CX + sx, CZ + sz, 17, 20, Block.MarblePillar, Block.GildedBricks, Block.SunRune);
    }
    p.fill(CX - 4, 21, CZ - 4, CX + 4, 21, CZ + 4, Block.GildedBricks);
    p.fill(CX - 3, 21, CZ - 3, CX + 3, 21, CZ + 3, SB);
    p.set(CX, 21, CZ, Block.GlassAmber);
    p.pillar(CX, CZ, 22, 24, Block.GildedBricks);
    p.set(CX, 25, CZ, Block.SunRune);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(CX + dx, 23, CZ + dz, Block.Lamp);
    p.set(CX, 17, CZ - 2, Block.Chest);
    p.set(CX, 17, CZ + 2, Block.Lantern);
    // Open south side for the stair: clear the pillar line there.
    p.fill(CX - 1, 17, CZ + 3, CX + 1, 20, CZ + 3, Block.Air);

    // ---- avenue dressing: idols, braziers, obelisks -----------------------------------------
    const idol = (x: number, z: number) => {
      p.fill(x - 1, 2, z - 1, x + 1, 3, z + 1, Block.GildedBricks);
      p.fill(x - 1, 4, z - 1, x + 1, 6, z + 1, SB);
      p.set(x, 5, z - 2 + (x < CX ? 3 : 0) * 0, SB);
      p.fill(x, 7, z, x, 8, z, SB);
      p.fill(x - 1, 9, z - 1, x + 1, 10, z + 1, Block.GildedBricks);
      p.set(x, 10, z, Block.SunRune);
      p.set(x, 11, z, Block.Lamp);
    };
    for (const z of [6, 13]) for (const sx of [-6, 6]) idol(CX + sx, z);
    for (const z of [3, 9, 16]) {
      for (const sx of [-4, 4]) {
        const x = CX + sx;
        p.fill(x, 2, z, x, 3, z, Block.GildedBricks);
        p.set(x, 4, z, Block.Sandstone);
        p.set(x, 5, z, Block.Lava);
        p.set(x - 1, 5, z, SB);
        p.set(x + 1, 5, z, SB);
        p.set(x, 5, z - 1, SB);
        p.set(x, 5, z + 1, SB);
      }
    }
    for (const [x, z] of [[3, 3], [SX - 4, 3], [3, SZ - 4], [SX - 4, SZ - 4]]) {
      p.fill(x - 1, 2, z - 1, x + 1, 3, z + 1, SB);
      p.fill(x, 4, z, x, 12, z, Block.GildedBricks);
      p.fill(x - 1, 4, z - 1, x + 1, 5, z + 1, SB);
      for (let ly = 6; ly <= 12; ly++) p.fill(x, ly, z, x, ly, z, ly % 3 === 0 ? Block.SunRune : Block.GildedBricks);
      p.set(x, 13, z, Block.Lamp);
    }
    // Drifted sand against the base.
    for (let z = 1; z < SZ - 1; z++) {
      for (let x = 1; x < SX - 1; x++) {
        const d = Math.max(Math.abs(x - CX), Math.abs(z - CZ));
        if (d !== 18 || (Math.abs(x - CX) <= 2)) continue;
        if (v.get(x, 2, z) === Block.Air && rng() < 0.4) p.set(x, 2, z, Block.Sand);
      }
    }
    return { volumes: [v], furniture: p.furniture };
  },
};
