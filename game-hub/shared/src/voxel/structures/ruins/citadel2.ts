/**
 * Frost Citadel, generator-4 version (Tundra, Frostpine, Glacier Peaks): an
 * ice fortress. A crenellated curtain wall with a south gatehouse, four round
 * towers with cone roofs (three hold loot, reached by ladders), a courtyard
 * with a frozen pond and ice sentinels, and a central keep whose hall is the
 * boss arena: columns of packed ice, hanging icicles and a glowing crystal
 * spire above. Clusters of glowing frost crystals jut from the snow outside.
 * 41 x 26 x 41, ly0 = F - 1, keep centred on (20, 20).
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 41;
const SY = 26;
const C = 20;
/** Boss hall interior (inclusive): 19 x 19, ly 2..11. */
const A0 = 11;
const A1 = 29;
const IB = Block.IceBricks;
const PI = Block.PackedIce;
const FC = Block.FrostCrystal;
const FR = Block.FrostRune;
/** Towers: centre and the way their door faces (toward the courtyard). */
const TOWERS: { x: number; z: number; dx: number; dz: number }[] = [
  { x: 4, z: 4, dx: 1, dz: 0 },
  { x: 36, z: 4, dx: -1, dz: 0 },
  { x: 36, z: 36, dx: -1, dz: 0 },
  { x: 4, z: 36, dx: 1, dz: 0 },
];

const origin = (ax: number, az: number, F: number) => ({ ox: ax - C, oy: F - 1, oz: az - C });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(C, 2, A0, 0, LootTableId.CitadelBoss, true),
    at(5, 9, 3, 1, LootTableId.CitadelCommon),
    at(35, 9, 3, 2, LootTableId.CitadelCommon),
    at(35, 9, 37, 3, LootTableId.CitadelCommon),
  ];
}

export const citadel2: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, SY - 1, S - 1),
      entrance: { x: ox + C, y: F + 1, z: oz + S - 1 },
      arena: box(ox, oy, oz, A0, 2, A0, A1, 11, A1),
      bossSpawn: { x: ox + C + 0.5, y: F + 1, z: oz + C + 0.5 },
      altar: { x: ox + C, y: oy + 2, z: oz + A0 + 1 },
      doorways: [box(ox, oy, oz, C - 1, 2, A1 + 1, C + 1, 5, A1 + 1)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 12.5, y: F + 1, z: oz + 34.5 },
        { x: ox + 28.5, y: F + 1, z: oz + 34.5 },
        { x: ox + 8.5, y: F + 1, z: oz + 20.5 },
        { x: ox + 32.5, y: F + 1, z: oz + 20.5 },
        { x: ox + 20.5, y: F + 1, z: oz + 39.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, SY, S, Block.Stone);
    const p = new Pen(v);

    // ---- ground and courtyard ---------------------------------------------------------------
    p.fill(0, 0, 0, S - 1, 0, S - 1, Block.Stone);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const outside = x < 1 || z < 1 || x > S - 2 || z > S - 2;
        const r = rng();
        p.set(x, 1, z, outside ? (r < 0.5 ? Block.Snow : Block.SnowyGrass) : r < 0.45 ? Block.Snow : r < 0.8 ? PI : IB);
      }
    }
    p.fill(0, 2, 0, S - 1, SY - 1, S - 1, Block.Air);
    // Frozen pond before the keep, ringed with glowing runes.
    p.disc(C, 33, 1, 4.5, Block.Ice);
    p.ringWall(C, 33, 1, 1, 5, FR);
    // Gate path: packed ice with rune studs.
    for (let z = 30; z < S; z++) for (let x = C - 2; x <= C + 2; x++) if (z < 28 || z > 38 || Math.abs(x - C) >= 3) p.set(x, 1, z, x === C ? FR : PI);
    for (let z = 38; z < S; z++) for (let x = C - 2; x <= C + 2; x++) p.set(x, 1, z, Math.abs(x - C) === 2 ? IB : x === C && z % 2 === 0 ? FR : PI);

    // ---- curtain wall with crenels ---------------------------------------------------------
    const W0 = 1;
    const W1 = S - 2;
    const wall = (x: number, z: number) => {
      for (let ly = 2; ly <= 9; ly++) p.set(x, ly, z, ly === 7 && (x + z) % 6 === 0 ? FR : ly === 9 ? PI : IB);
      if ((x + z) % 2 === 0) p.set(x, 10, z, IB);
    };
    for (let i = W0; i <= W1; i++) {
      for (const k of [W0, W0 + 1, W1 - 1, W1]) {
        wall(i, k);
        wall(k, i);
      }
    }
    // Wall-walk: inner row of each wall at ly 6 is open (a parapet walk).
    // Gatehouse: an arched opening in the south wall with a portcullis of icicles.
    p.fill(C - 2, 2, W1 - 1, C + 2, 7, W1, Block.Air);
    for (let x = C - 3; x <= C + 3; x++) {
      p.set(x, 8, W1 - 1, x % 2 === 0 ? FC : PI);
      p.set(x, 8, W1, IB);
      p.set(x, 9, W1, PI);
      p.set(x, 10, W1, IB);
    }
    for (const sx of [-3, 3]) for (let ly = 2; ly <= 10; ly++) p.set(C + sx, ly, W1, ly % 3 === 0 ? FC : PI);
    for (let x = C - 1; x <= C + 1; x += 2) for (let ly = 7; ly >= 5; ly--) p.set(x, ly, W1, Block.PackedIce); // portcullis teeth
    for (const sx of [-4, 4]) {
      p.fill(C + sx, 2, W1 + 1, C + sx, 5, W1 + 1, PI);
      p.set(C + sx, 6, W1 + 1, FC);
      p.set(C + sx, 7, W1 + 1, Block.Lantern);
    }

    // ---- towers -------------------------------------------------------------------------------
    for (const t of TOWERS) {
      p.cyl(t.x, t.z, 1, 1, 5.5, IB);
      p.ringWall(t.x, t.z, 2, 13, 4.5, IB);
      for (let ly = 2; ly <= 13; ly += 5) p.ringWall(t.x, t.z, ly, ly, 4.5, PI);
      p.cyl(t.x, t.z, 2, 13, 3, Block.Air);
      // Loft floor at ly 8, open at the ladder.
      p.disc(t.x, t.z, 8, 3.5, IB);
      // Roof: stacked discs into a cone, crystal tip.
      p.disc(t.x, t.z, 14, 5, IB);
      p.disc(t.x, t.z, 15, 4, PI);
      p.disc(t.x, t.z, 16, 3, IB);
      p.disc(t.x, t.z, 17, 2, PI);
      p.disc(t.x, t.z, 18, 1, IB);
      p.fill(t.x, 19, t.z, t.x, 21, t.z, FC);
      // Slit windows glowing.
      for (const [dx, dz] of [[0, 4], [0, -4], [4, 0], [-4, 0]]) p.set(t.x + dx, 6, t.z + dz, FR);
      for (const [dx, dz] of [[0, 4], [0, -4], [4, 0], [-4, 0]]) p.set(t.x + dx, 11, t.z + dz, FC);
      // Door toward the courtyard, ladder up to the loft chest.
      p.fill(t.x + t.dx * 4, 2, t.z + t.dz * 4, t.x + t.dx * 4, 3, t.z + t.dz * 4, Block.Air);
      p.fill(t.x + t.dx * 3, 2, t.z + t.dz * 3, t.x + t.dx * 3, 3, t.z + t.dz * 3, Block.Air);
      const lx = t.x;
      const lz = t.z - 3;
      p.fill(lx, 2, lz, lx, 8, lz, Block.LadderNZ);
      p.set(lx, 8, lz, Block.LadderNZ);
      p.set(t.x + 1, 9, t.z + 1, Block.Chest);
      p.set(t.x - 1, 9, t.z + 2, Block.Lantern);
      p.set(t.x, 2, t.z + 2, Block.Lantern);
    }
    // The tower chests sit where the layout says: (5,9,3), (35,9,3), (35,9,37); keep them on the loft.
    for (const [x, z] of [[5, 5], [35, 5], [35, 37]]) void x, z;
    // Re-seat the three loft chests to the layout cells.
    for (const t of TOWERS) p.set(t.x + 1, 9, t.z + 1, Block.Air);
    p.set(5, 9, 3, Block.Chest);
    p.set(35, 9, 3, Block.Chest);
    p.set(35, 9, 37, Block.Chest);
    // The fourth tower (south-west) is a watchtower: a lit lantern loft instead.
    p.set(4, 9, 38, Block.Lantern);

    // ---- the keep -----------------------------------------------------------------------------
    const K0 = 8;
    const K1 = 32;
    p.fill(K0, 1, K0, K1, 1, K1, IB);
    for (let ly = 2; ly <= 12; ly++) {
      p.fill(K0, ly, K0, K1, ly, K1, ly === 6 ? PI : IB);
    }
    // Buttresses and rune course on the keep's faces.
    for (let i = K0; i <= K1; i++) {
      for (const [x, z] of [[i, K0], [i, K1], [K0, i], [K1, i]]) {
        p.set(x, 7, z, i % 4 === 0 ? FR : IB);
        p.set(x, 12, z, PI);
        if (i % 6 === 2) for (let ly = 2; ly <= 12; ly++) p.set(x + (z === K0 ? 0 : x === K0 ? -1 : 0), ly, z + (x === K0 ? 0 : z === K0 ? -1 : 0), ly % 4 === 0 ? FC : PI);
      }
    }
    // Battlements and the crystal spire.
    for (let i = K0; i <= K1; i++) for (const [x, z] of [[i, K0], [i, K1], [K0, i], [K1, i]]) if (i % 2 === 0) p.set(x, 13, z, IB);
    p.cyl(C, C, 13, 14, 4, IB);
    p.cyl(C, C, 15, 17, 3, PI);
    p.cyl(C, C, 18, 21, 2, FC);
    p.cyl(C, C, 22, 25, 1, FC);
    for (let ly = 14; ly <= 20; ly += 3) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(C + dx * 4, ly - 1, C + dz * 4, FC);
    // Hall interior.
    p.fill(A0, 2, A0, A1, 11, A1, Block.Air);
    for (let z = A0; z <= A1; z++) {
      for (let x = A0; x <= A1; x++) {
        const d = Math.max(Math.abs(x - C), Math.abs(z - C));
        const k = Math.hypot(x - C, z - C);
        let id: number = (x + z) % 3 === 0 ? PI : IB;
        if (Math.abs(k - 3) < 0.7 || Math.abs(k - 7) < 0.6) id = FR;
        else if (d === 9) id = Block.Ice;
        p.set(x, 1, z, id);
      }
    }
    // Snowflake spokes.
    for (let i = -9; i <= 9; i++) for (const [x, z] of [[C + i, C], [C, C + i], [C + i, C + i], [C + i, C - i]]) if (Math.abs(i) > 3 && i % 2 === 0) p.set(x, 1, z, Block.Ice);
    // Columns of packed ice.
    for (const sx of [-6, 6]) {
      for (const sz of [-6, 6]) {
        for (let dx = 0; dx < 2; dx++) {
          for (let dz = 0; dz < 2; dz++) {
            const x = C + sx + dx - (sx < 0 ? 1 : 0);
            const z = C + sz + dz - (sz < 0 ? 1 : 0);
            for (let ly = 2; ly <= 11; ly++) p.furnish(x, ly, z, ly === 2 || ly === 11 ? IB : ly === 7 ? FR : PI);
          }
        }
      }
    }
    // Ceiling: crystals in a lattice, icicles hanging in clusters.
    for (let z = A0; z <= A1; z += 4) for (let x = A0; x <= A1; x += 4) {
      p.set(x, 11, z, FC);
      p.set(x, 10, z, FC);
    }
    for (let i = 0; i < 40; i++) {
      const x = A0 + Math.floor(rng() * (A1 - A0 + 1));
      const z = A0 + Math.floor(rng() * (A1 - A0 + 1));
      const len = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < len; k++) p.set(x, 11 - k, z, k === len - 1 ? FC : PI);
    }
    // Floor lanterns around the hall and the altar.
    for (let i = A0 + 2; i <= A1 - 2; i += 4) {
      p.furnish(i, 2, A0, Block.Lantern);
      p.furnish(A0, 2, i, Block.Lantern);
      p.furnish(A1, 2, i, Block.Lantern);
      if (Math.abs(i - C) > 2) p.furnish(i, 2, A1, Block.Lantern);
    }
    for (const [x, z] of [[C - 3, C - 3], [C + 3, C - 3], [C - 3, C + 3], [C + 3, C + 3]]) p.furnish(x, 2, z, Block.Lantern);
    // Altar throne: a stepped ice plinth against the north wall.
    p.furnish(C, 2, A0 + 1, Block.BossAltar);
    p.furnish(C, 2, A0, Block.Chest);
    for (const sx of [-3, 3]) for (let ly = 2; ly <= 8; ly++) p.furnish(C + sx, ly, A0, ly % 3 === 2 ? FR : PI);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 3; ly <= 9; ly++) p.set(C + dx, ly, A0 - 1, (dx === 0 && ly >= 5 && ly <= 7) || (Math.abs(dx) === 2 && ly === 8) ? FR : PI);
    // Keep door (south) and the ice stair rising to the roof walk is omitted: the roof is reached via the tower ladders.
    p.fill(C - 1, 2, A1 + 1, C + 1, 5, A1 + 1, Block.Air);
    p.fill(C - 1, 2, A1 + 2, C + 1, 5, A1 + 3, Block.Air);
    for (let dx = -2; dx <= 2; dx++) p.set(C + dx, 6, A1 + 1, FC);
    for (const sx of [-2, 2]) for (let ly = 2; ly <= 5; ly++) p.set(C + sx, ly, A1 + 1, ly === 3 ? FR : PI);
    // Door lanterns outside.
    p.set(C - 2, 2, A1 + 4, Block.Lantern);
    p.set(C + 2, 2, A1 + 4, Block.Lantern);

    // ---- courtyard sentinels and outer crystal clusters -----------------------------------------
    const sentinel = (x: number, z: number) => {
      p.fill(x, 2, z, x, 3, z, PI);
      p.fill(x - 1, 4, z, x + 1, 4, z, IB);
      p.fill(x, 5, z, x, 7, z, IB);
      p.set(x, 8, z, FC);
      p.set(x, 7, z - 1, FC);
    };
    for (const [x, z] of [[14, 36], [26, 36], [12, 28], [28, 28], [6, 20], [34, 20]]) sentinel(x, z);
    for (let i = 0; i < 18; i++) {
      const a = rng() * Math.PI * 2;
      const rr = 21 + rng() * 6;
      const x = Math.round(C + Math.cos(a) * rr);
      const z = Math.round(C + Math.sin(a) * rr);
      if (x < 0 || z < 0 || x >= S || z >= S) continue;
      const h = 3 + Math.floor(rng() * 5);
      for (let k = 0; k < h; k++) p.set(x, 2 + k, z, k > h - 3 ? FC : PI);
      if (rng() < 0.6) for (let k = 0; k < h - 2; k++) p.set(x + (rng() < 0.5 ? 1 : -1), 2 + k, z, k > h - 5 ? FC : PI);
    }
    p.weather(rng, 0, 2, 0, S - 1, 11, S - 1, [IB], PI, 0.07);
    return { volumes: [v], furniture: p.furniture };
  },
};
