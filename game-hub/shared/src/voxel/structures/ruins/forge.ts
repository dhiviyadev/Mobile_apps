/**
 * Cinderdeep Forge (red-rock canyons and savanna, generator 4): an abandoned
 * titan's smithy of slag and cinder bricks. A lava canal crosses the approach
 * (a stone bridge leads over it to the gate), two workshops with furnaces and
 * loot flank the great hall, four smelter stacks glow at the corners, and a
 * giant anvil crowns the roof. The great hall (floor vents, lava braziers,
 * anvil statues, riveted trusses) is the boss arena.
 * 45 x 24 x 45, ly0 = F - 1, hall centred on (22, 19).
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const S = 45;
const SY = 24;
const CX = 22;
const CZ = 19;
const A = 9;
const SL = Block.SlagBricks;
const CB = Block.CinderBricks;
const FV = Block.ForgeVent;
const ER = Block.EmberRune;
const BB = Block.BasaltBricks;
/** Lava canal rows. */
const CANAL0 = 35;
const CANAL1 = 37;

const origin = (ax: number, az: number, F: number) => ({ ox: ax - CX, oy: F - 1, oz: az - 22 });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(CX, 2, CZ - A, 0, LootTableId.ForgeBoss, true),
    at(3, 2, 15, 1, LootTableId.ForgeCommon),
    at(41, 2, 15, 2, LootTableId.ForgeCommon),
    at(CX + 9, 13, CZ - 2, 3, LootTableId.ForgeCommon),
  ];
}

export const forge: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, S - 1, SY - 1, S - 1),
      entrance: { x: ox + CX, y: F + 1, z: oz + 43 },
      arena: box(ox, oy, oz, CX - A, 2, CZ - A, CX + A, 9, CZ + A),
      bossSpawn: { x: ox + CX + 0.5, y: F + 1, z: oz + CZ + 0.5 },
      altar: { x: ox + CX, y: oy + 2, z: oz + CZ - A + 1 },
      doorways: [box(ox, oy, oz, CX - 1, 2, CZ + A + 1, CX + 1, 5, CZ + A + 2)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + 14.5, y: F + 1, z: oz + 32.5 },
        { x: ox + 30.5, y: F + 1, z: oz + 32.5 },
        { x: ox + CX + 0.5, y: F + 1, z: oz + 42.5 },
        { x: ox + 5.5, y: F + 1, z: oz + 29.5 },
        { x: ox + 39.5, y: F + 1, z: oz + 29.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, S, SY, S, Block.RedSandstone);
    const p = new Pen(v);

    // ---- terrace, plaza and canal ---------------------------------------------------------------
    p.fill(0, 0, 0, S - 1, 0, S - 1, Block.RedSandstone);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const r = rng();
        p.set(x, 1, z, r < 0.25 ? Block.Basalt : r < 0.4 ? Block.Slate : BB);
        if ((x + z) % 9 === 0 && z > 29) p.set(x, 1, z, CB);
      }
    }
    p.fill(0, 2, 0, S - 1, SY - 1, S - 1, Block.Air);
    // Canal: lava in a stone trough, parapets, a stone bridge in the middle.
    for (let x = 0; x < S; x++) {
      for (let z = CANAL0; z <= CANAL1; z++) {
        p.set(x, 1, z, Block.Lava);
        p.set(x, 0, z, BB);
      }
      for (const z of [CANAL0 - 1, CANAL1 + 1]) {
        p.set(x, 1, z, SL);
        p.set(x, 2, z, x % 2 === 0 ? CB : Block.StoneBrickSlab);
      }
    }
    for (let z = CANAL0 - 1; z <= CANAL1 + 1; z++) for (let x = CX - 2; x <= CX + 2; x++) {
      p.set(x, 1, z, Math.abs(x - CX) === 2 ? SL : x === CX ? ER : Block.StoneBricks);
      p.set(x, 2, z, Block.Air);
    }
    for (const z of [CANAL0, CANAL1]) for (const sx of [-3, 3]) {
      p.fill(CX + sx, 2, z, CX + sx, 4, z, SL);
      p.set(CX + sx, 5, z, Block.Lantern);
    }
    // Slag falls feeding the canal from the west edge: a spout block and glow.
    p.fill(0, 2, CANAL0, 0, 4, CANAL1, CB);
    for (let z = CANAL0; z <= CANAL1; z++) p.set(0, 3, z, FV);

    // ---- great hall ------------------------------------------------------------------------------
    const H0 = CX - A;
    const H1 = CX + A;
    const Z0 = CZ - A;
    const Z1 = CZ + A;
    p.fill(H0 - 3, 1, Z0 - 3, H1 + 3, 1, Z1 + 3, SL);
    for (let ly = 2; ly <= 12; ly++) p.fill(H0 - 3, ly, Z0 - 3, H1 + 3, ly, Z1 + 3, ly === 6 ? SL : CB);
    p.fill(H0, 2, Z0, H1, 11, Z1, Block.Air);
    // Floor: slag flags with glowing vent rings and spokes.
    for (let z = Z0; z <= Z1; z++) {
      for (let x = H0; x <= H1; x++) {
        const k = Math.hypot(x - CX, z - CZ);
        p.set(x, 1, z, Math.abs(k - 5.5) < 0.6 || ((x === CX || z === CZ) && k > 6.5 && k < 8.5) ? FV : (x + z) % 5 === 0 ? CB : SL);
      }
    }
    // Wall courses: ember runes, riveted bands, vent windows.
    for (let i = -A - 3; i <= A + 3; i++) {
      for (const [x, z] of [[CX + i, Z0 - 3], [CX + i, Z1 + 3], [H0 - 3, CZ + i], [H1 + 3, CZ + i]]) {
        p.set(x, 5, z, i % 4 === 0 ? ER : SL);
        p.set(x, 9, z, i % 3 === 0 ? FV : CB);
        p.set(x, 12, z, i % 2 === 0 ? SL : BB);
      }
    }
    for (let i = -A; i <= A; i++) {
      for (const [x, z] of [[CX + i, Z0 - 1], [CX + i, Z1 + 1], [H0 - 1, CZ + i], [H1 + 1, CZ + i]]) {
        p.set(x, 6, z, i % 3 === 0 ? ER : SL);
        p.set(x, 9, z, i % 2 === 0 ? FV : CB);
      }
    }
    // Trusses and lights in the ceiling.
    for (let z = Z0; z <= Z1; z++) for (let x = H0; x <= H1; x++) p.set(x, 12, z, BB);
    for (const dz of [-6, 0, 6]) for (let x = H0; x <= H1; x++) p.set(x, 11, CZ + dz, BB);
    for (const dx of [-6, 0, 6]) for (let z = Z0; z <= Z1; z++) p.set(CX + dx, 11, z, BB);
    for (const dz of [-6, 0, 6]) for (const dx of [-6, 0, 6]) p.set(CX + dx, 10, CZ + dz, Block.Lamp);
    // Lava braziers in the corners, anvil statues, columns.
    for (const [dx, dz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
      p.furnish(CX + dx, 2, CZ + dz, BB);
      p.furnish(CX + dx, 3, CZ + dz, Block.Lava);
      for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.furnish(CX + dx + ex, 2, CZ + dz + ez, CB);
    }
    for (const sx of [-1, 1]) {
      const x = CX + sx * 8;
      for (const [ex, ez, ly] of [[0, 0, 2], [0, 0, 3], [0, 1, 3], [0, -1, 3], [0, 0, 4], [0, 1, 4]] as const) p.furnish(x + ex * 0, ly, CZ + ez, ly === 4 ? Block.PolishedStone : BB);
      p.furnish(x, 5, CZ, ER);
    }
    for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) for (let ly = 2; ly <= 9; ly++) p.furnish(CX + dx, ly, CZ + dz, ly === 2 || ly === 9 ? CB : ly === 6 ? FV : SL);
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2], [0, -7], [-8, 0], [8, 0], [0, 8], [-5, 8], [5, 8], [-5, -8], [5, -8]]) p.furnish(CX + dx, 2, CZ + dz, Block.Lantern);
    // Altar on a slag dais, flanked by chimney-breast furnaces.
    p.furnish(CX, 2, Z0 + 1, Block.BossAltar);
    p.furnish(CX, 2, Z0, Block.Chest);
    for (const dx of [-3, 3]) for (let ly = 2; ly <= 6; ly++) p.furnish(CX + dx, ly, Z0, ly === 3 ? FV : ly === 6 ? ER : CB);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 3; ly <= 9; ly++) p.set(CX + dx, ly, Z0 - 1, Math.abs(dx) === 2 || ly === 9 ? ER : dx === 0 && ly >= 5 && ly <= 7 ? FV : CB);
    // Doors: south gate with a pointed arch, steps and a glowing lintel.
    p.fill(CX - 1, 2, Z1 + 1, CX + 1, 5, Z1 + 3, Block.Air);
    p.set(CX, 6, Z1 + 1, Block.Air);
    for (let x = CX - 2; x <= CX + 2; x++) p.set(x, 6, Z1 + 3, x % 2 === 0 ? ER : SL);
    for (const sx of [-2, 2]) for (let ly = 2; ly <= 5; ly++) p.set(CX + sx, ly, Z1 + 3, ly === 4 ? FV : SL);
    for (let z = Z1 + 3; z <= CANAL0 - 2; z++) for (let x = CX - 1; x <= CX + 1; x++) p.set(x, 1, z, x === CX ? ER : SL);
    p.set(CX - 2, 2, Z1 + 5, Block.Lantern);
    p.set(CX + 2, 2, Z1 + 5, Block.Lantern);

    // ---- roof: a giant anvil and four smelter stacks ---------------------------------------------
    for (let z = Z0 - 3; z <= Z1 + 3; z++) for (let x = H0 - 3; x <= H1 + 3; x++) if (Math.max(Math.abs(x - CX) - 12, Math.abs(z - CZ) - 12) === 0) p.set(x, 13, z, x % 2 === 0 || z % 2 === 0 ? CB : SL);
    p.fill(CX - 5, 13, CZ - 2, CX + 5, 13, CZ + 2, BB);
    p.fill(CX - 4, 14, CZ - 2, CX + 4, 14, CZ + 2, Block.PolishedStone);
    p.fill(CX - 2, 15, CZ - 1, CX + 2, 16, CZ + 1, Block.PolishedStone);
    p.fill(CX - 7, 15, CZ - 1, CX - 5, 15, CZ + 1, Block.PolishedStone);
    p.set(CX - 8, 15, CZ, Block.PolishedStone);
    p.fill(CX - 1, 17, CZ - 1, CX + 1, 17, CZ + 1, FV);
    p.fill(CX, 18, CZ, CX, 20, CZ, FV);
    p.set(CX, 21, CZ, Block.Lamp);
    for (const [x, z] of [[8, 5], [36, 5], [8, 33], [36, 33]]) {
      p.fill(x - 1, 2, z - 1, x + 1, 19, z + 1, CB);
      p.fill(x, 3, z, x, 19, z, Block.Air);
      for (let ly = 4; ly <= 18; ly += 4) for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) p.set(x + dx, ly, z + dz, ER);
      p.fill(x - 1, 19, z - 1, x + 1, 19, z + 1, SL);
      p.set(x, 19, z, FV);
      p.fill(x, 20, z, x, 21, z, FV);
      // Stack base steps and a lantern.
      p.set(x - 2, 2, z + 2, Block.Lantern);
    }
    // Roof access: a ladder against the east wall.
    p.fill(CX + 12, 2, CZ - 2, CX + 12, 13, CZ - 2, SL);
    for (let ly = 2; ly <= 13; ly++) p.set(CX + 13, ly, CZ - 2, Block.LadderNX);
    p.set(CX + 13, 3, CZ - 3, Block.Lantern);
    p.set(CX + 9, 13, CZ - 2, Block.Chest);
    p.set(CX + 9, 13, CZ - 3, Block.Lantern);
    for (let ly = 2; ly <= 13; ly++) p.set(CX + 12, ly, CZ - 2, SL);

    // ---- workshops -----------------------------------------------------------------------------------
    for (const west of [true, false]) {
      const x0 = west ? 1 : 35;
      p.room(x0, 1, 10, x0 + 8, 8, 20, west ? SL : SL, BB, CB);
      p.fill(x0 + 1, 2, 11, x0 + 7, 7, 19, Block.Air);
      // Door on the south side, window slits of vents, furnaces, workbench and loot.
      p.fill(x0 + 3, 2, 20, x0 + 5, 4, 20, Block.Air);
      for (const dx of [2, 6]) p.set(x0 + dx, 5, 10, FV);
      for (let z = 11; z <= 19; z += 2) p.set(west ? x0 : x0 + 8, 5, z, FV);
      p.set(x0 + 2, 2, 12, Block.Furnace);
      p.set(x0 + 3, 2, 12, Block.Furnace);
      p.set(x0 + 6, 2, 12, Block.Workbench);
      p.set(x0 + 4, 2, 12, BB);
      p.set(x0 + 4, 3, 12, Block.PolishedStone);
      p.set(west ? x0 + 2 : x0 + 6, 2, 15, Block.Chest);
      p.set(x0 + 4, 7, 15, Block.Lamp);
      p.set(x0 + 1, 2, 19, Block.Lantern);
      p.set(x0 + 7, 2, 19, Block.Lantern);
      // Workshop chimney.
      const cx = west ? x0 + 1 : x0 + 7;
      p.fill(cx, 8, 11, cx, 14, 11, CB);
      p.set(cx, 15, 11, FV);
    }
    // Slag spill and cinder scatter outside.
    p.weather(rng, 0, 1, 0, S - 1, 1, S - 1, [BB], CB, 0.1);
    for (let i = 0; i < 24; i++) {
      const x = Math.floor(rng() * S);
      const z = 32 + Math.floor(rng() * 2);
      if (p.get(x, 2, z) === Block.Air && p.get(x, 1, z) !== Block.Lava) p.set(x, 2, z, rng() < 0.5 ? Block.DeadBush : CB);
    }
    return { volumes: [v], furniture: p.furniture };
  },
};
