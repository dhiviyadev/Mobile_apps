/**
 * Ashen Crypt, generator-4 version (temperate land): a walled graveyard of
 * tombstones and dead trees, a belfry mausoleum whose bell tower is the
 * landmark, a lit well-stair down to a basalt catacomb (corridor, two
 * ossuary side crypts) and the boss hall: sarcophagus alcoves, ember-rune
 * pillars, a stepped vault and four lava braziers. The surface gatehouse
 * (landmarks.ts) is added by placement. Geometry of the catacomb matches
 * generator 3's crypt, so the same site rules apply.
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { cryptShaft } from '../crypt';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 37;
const CAT_Y = 8;
const CAT_H = 13;
const BB = Block.BasaltBricks;
const ER = Block.EmberRune;
const RB = Block.RuneBricks;
const CB = Block.CinderBricks;

const origin = (ax: number, az: number) => ({ ox: ax - 18, oy: CAT_Y, oz: az - 18 });

function chests(ox: number, oy: number, oz: number, ax: number, az: number, F: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  const s = cryptShaft(ax, az);
  // The fourth chest stands in the mausoleum's north-east corner.
  return [at(18, 2, 27, 0, LootTableId.CryptBoss, true), at(9, 2, 3, 1, LootTableId.CryptCommon), at(27, 2, 3, 2, LootTableId.CryptCommon), { x: s.x + 4, y: F + 1, z: s.z - 4, index: 3, loot: LootTableId.CryptCommon, sealed: false }];
}

export const crypt2: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az);
    const s = cryptShaft(ax, az);
    return {
      bounds: { x0: Math.min(ox, s.x - 12), y0: oy, z0: s.z - 12, x1: Math.max(ox + S, s.x + 8), y1: F + 19, z1: oz + S },
      entrance: { x: s.x, y: F + 1, z: s.z + 6 },
      arena: box(ox, oy, oz, 9, 2, 9, 27, 9, 27),
      bossSpawn: { x: ox + 18.5, y: 10, z: oz + 18.5 },
      altar: { x: ox + 18, y: oy + 2, z: oz + 26 },
      doorways: [box(ox, oy, oz, 17, 2, 8, 19, 4, 8)],
      chests: chests(ox, oy, oz, ax, az, F),
      guardSpawns: [
        { x: ax + 0.5, y: 10, z: az - 13.5 },
        { x: ox + 11.5, y: 10, z: oz + 3.5 },
        { x: ox + 24.5, y: 10, z: oz + 3.5 },
        { x: s.x + 5.5, y: F + 1, z: s.z + 8.5 },
        { x: s.x - 7.5, y: F + 1, z: s.z + 6.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az);
    const cat = new StructureVolume(ox, oy, oz, S, CAT_H, S, null);
    const c = new Pen(cat);

    // ---- boss hall ---------------------------------------------------------------------------
    c.fill(8, 0, 8, 28, 12, 28, BB);
    c.fill(9, 2, 9, 27, 9, 27, Block.Air);
    // Floor: basalt flags with an ember-rune ring and spokes.
    for (let z = 9; z <= 27; z++) {
      for (let x = 9; x <= 27; x++) {
        const k = Math.hypot(x - 18, z - 18);
        c.set(x, 1, z, Math.abs(k - 5) < 0.7 || Math.abs(k - 8.5) < 0.6 ? ER : (x + z) % 6 === 0 ? RB : BB);
      }
    }
    // Vault: the ceiling steps in two rings, ember runes along the courses.
    for (let z = 9; z <= 27; z++) for (let x = 9; x <= 27; x++) {
      const d = Math.max(Math.abs(x - 18), Math.abs(z - 18));
      c.set(x, 10, z, d <= 5 ? CB : BB);
      if (d <= 5) c.set(x, 11, z, CB);
    }
    for (let i = 9; i <= 27; i++) {
      for (const [x, z] of [[i, 8], [i, 28], [8, i], [28, i]]) {
        c.set(x, 5, z, RB);
        c.set(x, 6, z, i % 4 === 2 ? ER : BB);
        c.set(x, 9, z, i % 2 === 0 ? CB : BB);
      }
    }
    // Sarcophagus alcoves in the north and south walls, rune-lit.
    for (const x of [11, 14, 22, 25]) {
      for (const [z, dz] of [[8, 1], [28, -1]]) {
        if (z === 8 && x > 15 && x < 21) continue;
        c.fill(x, 2, z, x + 1, 4, z, Block.Air);
        c.set(x, 5, z, ER);
        c.set(x + 1, 5, z, ER);
        c.furnish(x, 2, z + dz, BB);
        c.furnish(x + 1, 2, z + dz, BB);
        c.furnish(x, 3, z + dz, Block.StoneBrickSlab);
        c.furnish(x + 1, 3, z + dz, Block.StoneBrickSlab);
      }
    }
    // Pillars and braziers.
    for (const [x, z] of [[13, 13], [13, 23], [23, 13], [23, 23]]) for (let ly = 2; ly <= 9; ly++) c.furnish(x, ly, z, ly === 2 || ly === 9 ? CB : ly === 6 || ly === 7 ? ER : RB);
    for (const [x, z] of [[10, 10], [10, 26], [26, 10], [26, 26]]) {
      c.furnish(x, 2, z, BB);
      c.furnish(x, 3, z, Block.Lava);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (c.get(x + dx, 2, z + dz) === Block.Air && (x + dx !== 9 && x + dx !== 27) && (z + dz !== 9 && z + dz !== 27)) c.furnish(x + dx, 2, z + dz, Block.Air);
    }
    for (const [x, z] of [[18, 18], [13, 18], [23, 18], [18, 13], [18, 23]]) c.set(x, 11, z, Block.Lamp);
    for (const [x, z] of [[16, 16], [20, 16], [16, 20], [20, 20], [11, 18], [25, 18], [18, 11], [18, 25]]) c.furnish(x, 2, z, Block.Lantern);
    for (let i = 11; i <= 25; i += 4) {
      if (i !== 19) c.furnish(i, 2, 9, Block.Lantern);
      c.furnish(9, 2, i, Block.Lantern);
      c.furnish(27, 2, i, Block.Lantern);
      if (i < 17 || i > 19) c.furnish(i, 2, 27, Block.Lantern);
    }
    // Altar: a basalt dais at the south wall flanked by rune braziers; a mural above.
    c.furnish(18, 2, 26, Block.BossAltar);
    c.furnish(18, 2, 27, Block.Chest);
    for (const dx of [-3, 3]) for (let ly = 2; ly <= 5; ly++) c.furnish(18 + dx, ly, 27, ly === 4 ? ER : CB);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 3; ly <= 8; ly++) c.set(18 + dx, ly, 28, Math.abs(dx) === 2 || ly === 8 ? ER : (dx === 0 && ly >= 4 && ly <= 6 ? ER : CB));
    c.fill(17, 2, 8, 19, 4, 8, Block.Air);

    // ---- corridor and ossuary crypts ---------------------------------------------------------
    c.fill(16, 0, 0, 20, 7, 8, BB);
    c.fill(17, 2, 1, 19, 5, 7, Block.Air);
    c.fill(17, 2, 8, 19, 4, 8, Block.Air);
    for (const [x, z] of [[16, 2], [16, 6], [20, 2], [20, 6]]) c.set(x, 4, z, ER);
    for (let z = 1; z <= 7; z++) c.set(18, 1, z, z % 2 === 0 ? ER : BB);
    for (const west of [true, false]) {
      const [a, b] = west ? [8, 15] : [21, 28];
      c.fill(a, 0, 0, b, 7, 7, BB);
      c.fill(a + 1, 2, 1, b - 1, 5, 6, Block.Air);
      const [d0, d1] = west ? [15, 16] : [20, 21];
      c.fill(d0, 2, 3, d1, 3, 4, Block.Air);
      for (let z = 1; z <= 6; z++) {
        for (let x = a + 1; x <= b - 1; x++) {
          if (rng() < 0.3) c.set(x, 1, z, Block.MossyCobble);
          const wallSide = x === a + 1 || x === b - 1 || z === 1 || z === 6;
          if (!wallSide && rng() < 0.1) c.set(x, 2, z, Block.Duskcap);
          if (wallSide && z === 1 && rng() < 0.5) c.set(x, 2, z, Block.StoneBrickSlab);
        }
      }
      // Burial niches (slab shelves) and a rune light.
      for (const z of [2, 5]) c.set(west ? a + 1 : b - 1, 3, z, Block.StoneBrickSlab);
      c.set(west ? 8 : 28, 3, 4, ER);
      c.set(west ? 9 : 27, 2, 3, Block.Chest);
      c.set(west ? 12 : 24, 2, 5, Block.Lantern);
      c.set(west ? 12 : 24, 5, 3, Block.Lamp);
    }
    // Shaft bottom: ladder against the corridor's north wall.
    for (let ly = 2; ly <= 7; ly++) cat.set(18, ly, 1, Block.LadderNZ);

    // ---- the well and the mausoleum with its belfry -------------------------------------------
    const s = cryptShaft(ax, az);
    const shaftH = Math.max(0, F - 16);
    const shaft = new StructureVolume(s.x - 1, 16, s.z - 1, 3, Math.max(1, shaftH), 3, null);
    if (shaftH > 0) {
      shaft.fill(0, 0, 0, 2, shaftH - 1, 2, BB);
      shaft.fill(1, 0, 1, 1, shaftH - 1, 1, Block.LadderNZ);
      // Glowing runes in the shaft walls light the climb.
      for (let ly = 2; ly < shaftH; ly += 4) {
        shaft.set(0, ly, 1, ER);
        shaft.set(2, ly, 1, ER);
      }
    }
    const m = new StructureVolume(s.x - 6, F, s.z - 6, 13, 18, 13, Block.StoneBricks);
    const p = new Pen(m);
    m.fill(0, 0, 0, 12, 0, 12, Block.StoneBricks);
    // Hall of the mausoleum: 9x9, mossy walls, polished floor inlay, buttresses.
    for (let ly = 1; ly <= 5; ly++) {
      for (let z = 1; z <= 11; z++) {
        for (let x = 1; x <= 11; x++) {
          const ring = x === 1 || x === 11 || z === 1 || z === 11;
          m.set(x, ly, z, ring ? (rng() < 0.3 ? Block.MossyStoneBricks : Block.StoneBricks) : Block.Air);
        }
      }
    }
    for (let z = 2; z <= 10; z++) for (let x = 2; x <= 10; x++) m.set(x, 0, z, (x + z) % 2 === 0 ? Block.PolishedStone : Block.StoneBricks);
    for (let ly = 1; ly <= 5; ly++) for (const [x, z] of [[5, 5], [7, 5], [5, 7], [7, 7]]) m.set(x, ly, z, ly === 5 ? Block.EmberRune : Block.StoneBricks);
    // Door in the south wall with a pointed lintel.
    m.fill(5, 1, 11, 7, 3, 11, Block.Air);
    m.fill(6, 4, 11, 6, 4, 11, Block.Air);
    m.set(5, 4, 11, Block.StoneBricks);
    m.set(7, 4, 11, Block.StoneBricks);
    for (const x of [4, 8]) for (let ly = 1; ly <= 4; ly++) m.set(x, ly, 12, ly === 4 ? Block.Lantern : Block.StoneBricks);
    // Slab roof, then the belfry tower: 5x5, open bell chamber, spire.
    m.fill(0, 6, 0, 12, 6, 12, Block.StoneBrickSlab);
    m.fill(1, 6, 1, 11, 6, 11, Block.StoneBricks);
    m.fill(4, 7, 4, 8, 12, 8, Block.StoneBricks);
    m.fill(5, 7, 5, 7, 12, 7, Block.Air);
    for (const [x, z] of [[6, 4], [6, 8], [4, 6], [8, 6]]) m.fill(x, 9, z, x, 11, z, Block.Air);
    for (const [x, z] of [[4, 4], [8, 4], [4, 8], [8, 8]]) m.fill(x, 9, z, x, 12, z, Block.BasaltBricks);
    m.fill(3, 13, 3, 9, 13, 9, Block.StoneBrickSlab);
    m.fill(4, 13, 4, 8, 13, 8, Block.StoneBricks);
    m.fill(5, 14, 5, 7, 14, 7, Block.StoneBricks);
    m.fill(6, 15, 6, 6, 17, 6, BB);
    m.set(6, 17, 6, ER);
    m.set(6, 10, 6, Block.Lantern);
    // The shaft mouth: the ladder's top cell in the middle of the floor.
    m.set(6, 0, 6, Block.LadderNZ);
    m.set(6, 1, 5, Block.Torch);
    m.set(2, 1, 2, Block.Torch);
    m.set(10, 1, 2, Block.Chest);
    // Statues (weeping angels of stone) in the corners.
    for (const [x, z] of [[2, 10], [10, 10]]) {
      m.fill(x, 1, z, x, 2, z, Block.PolishedStone);
      m.set(x, 3, z, Block.StoneBricks);
    }
    p.furniture.length = 0;

    // ---- graveyard ---------------------------------------------------------------------------
    const yard = new StructureVolume(s.x - 12, F - 1, s.z - 12, 19, 8, 26, Block.Dirt);
    const y = new Pen(yard);
    for (let z = 0; z < 26; z++) {
      for (let x = 0; x < 19; x++) {
        y.set(x, 0, z, rng() < 0.35 ? Block.ForestFloor : Block.Dirt);
        for (let ly = 1; ly < 8; ly++) y.set(x, ly, z, Block.Air);
      }
    }
    // Fence posts and rails with lanterns at the gate.
    for (let i = 0; i < 19; i++) for (const z of [0, 25]) if (i % 3 === 0) y.fill(i, 1, z, i, 2, z, Block.Cobble);
    for (let i = 0; i < 26; i++) for (const x of [0, 18]) if (i % 3 === 0) y.fill(x, 1, i, x, 2, i, Block.Cobble);
    for (let i = 0; i < 19; i++) for (const z of [0, 25]) if (i % 3 !== 0 && rng() < 0.7) y.set(i, 1, z, Block.CobbleSlab);
    for (const [x, z] of [[0, 0], [18, 0], [0, 25], [18, 25]]) y.set(x, 3, z, Block.Lantern);
    // Tombstones in rows with a path to the mausoleum door.
    for (let z = 14; z <= 23; z += 3) {
      for (let x = 2; x <= 16; x += 3) {
        if (Math.abs(x - 12) <= 1 || rng() < 0.2) continue;
        const tall = rng() < 0.4;
        y.set(x, 1, z, Block.Slate);
        y.set(x, 2, z, tall ? Block.Slate : Block.StoneSlab);
        if (rng() < 0.35) y.set(x, 1, z + 1, Block.MossyCobble);
      }
    }
    // Dead trees.
    for (const [x, z] of [[2, 15], [16, 20], [3, 3]]) {
      for (let ly = 1; ly <= 5; ly++) y.set(x, ly, z, Block.DuskwoodLog);
      y.set(x + 1, 4, z, Block.DuskwoodLog);
      y.set(x - 1, 5, z, Block.DuskwoodLog);
    }
    // Path of flagstones, torches along it.
    for (let z = 13; z <= 24; z++) for (let x = 11; x <= 13; x++) y.set(x, 0, z, x === 12 ? Block.PolishedStone : Block.StoneBricks);
    for (let z = 15; z <= 24; z += 3) for (const x of [10, 14]) y.set(x, 1, z, Block.Torch);
    // Keep the mausoleum footprint clear of yard blocks (the mausoleum piece is copied after it).
    return { volumes: shaftH > 0 ? [cat, shaft, yard, m] : [cat, yard, m], furniture: c.furniture };
  },
};
