/**
 * Saltworn Lighthouse (coasts, generator 4): a striped red-and-white
 * lighthouse standing on the roof of a drowned octagonal keep, on a rocky
 * island with a keeper's cottage, two timber piers and a wrecked ship. The
 * keep's flooded hall (tide pools in the floor, glowing lenses, hanging
 * weed) is the boss arena; a spiral stair inside the tower climbs to a lit
 * lantern room and a gallery chest. 61 x 37 x 49 on the island (ly0 = F - 3),
 * the wreck is a separate piece in the water to the south.
 */
import { Block } from '../../blocks';
import { LootTableId } from '../../loot';
import { box, type Built, type ChestSpec, type Layout, type Template } from '../template';
import { StructureVolume } from '../volume';
import { Pen } from './kit';

const SX = 61;
const SY = 37;
const SZ = 49;
const CX = 30;
const CZ = 22;
const WH = Block.WhitewashBricks;
const RD = Block.Brick;
const BL = Block.BeaconLens;
/** Hall interior: |dx|, |dz| <= 9 and |dx| + |dz| <= 14; floor block at ly 3, feet at ly 4, ceiling ly 12. */
const A = 9;
/** Tide pools in the hall floor (ly 3): [dx0, dz0, w, d]. */
const POOLS: [number, number, number, number][] = [[-8, -6, 3, 4], [5, -6, 3, 4], [-8, 3, 3, 4], [5, 3, 3, 4]];
/** Spiral ring around the tower's centre column, clockwise from the north-west corner. */
const RING: readonly [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const TOWER_BASE = 13;
const TOP_STEP = 18;

const origin = (ax: number, az: number, F: number) => ({ ox: ax - CX, oy: F - 3, oz: az - CZ });

function chests(ox: number, oy: number, oz: number): ChestSpec[] {
  const at = (lx: number, ly: number, lz: number, index: number, loot: LootTableId, sealed = false): ChestSpec => ({ x: ox + lx, y: oy + ly, z: oz + lz, index, loot, sealed });
  return [
    at(CX, 4, CZ - A, 0, LootTableId.LighthouseBoss, true),
    at(CX + 5, 32, CZ, 1, LootTableId.LighthouseCommon),
    at(CX - 19, 4, CZ - 7, 2, LootTableId.LighthouseCommon),
    at(CX + 28, 4, CZ + 1, 3, LootTableId.LighthouseCommon),
  ];
}

/** Tower outer radius at a height (tapers from 5 at the base to 4 at the gallery). */
const towerR = (ly: number) => 5 - ((ly - TOWER_BASE) / (31 - TOWER_BASE)) * 0.9;

export const lighthouse: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = origin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, SX - 1, SY - 1, SZ - 1),
      entrance: { x: ox + CX, y: F + 1, z: oz + CZ + 16 },
      arena: box(ox, oy, oz, CX - A, 4, CZ - A, CX + A, 11, CZ + A),
      bossSpawn: { x: ox + CX + 0.5, y: F + 1, z: oz + CZ + 0.5 },
      altar: { x: ox + CX, y: oy + 4, z: oz + CZ - A + 1 },
      doorways: [box(ox, oy, oz, CX - 1, 4, CZ + 10, CX + 1, 7, CZ + 11)],
      chests: chests(ox, oy, oz),
      guardSpawns: [
        { x: ox + CX + 8.5, y: F + 1, z: oz + CZ + 14.5 },
        { x: ox + CX - 8.5, y: F + 1, z: oz + CZ + 14.5 },
        { x: ox + CX + 20.5, y: F + 1, z: oz + CZ + 1.5 },
        { x: ox + CX - 20.5, y: F + 1, z: oz + CZ + 1.5 },
        { x: ox + CX + 13.5, y: F + 1, z: oz + CZ - 11.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = origin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, SX, SY, SZ, Block.Cobble);
    const p = new Pen(v);
    const rock = () => (rng() < 0.3 ? Block.MossyCobble : rng() < 0.5 ? Block.Cobble : Block.Stone);

    // ---- the island: four rocky terraces ------------------------------------------------------
    const R = [19.5, 18, 16.5, 15.5];
    for (let ly = 0; ly <= 3; ly++) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          const d = Math.hypot(x - CX, (z - CZ) * 1.0);
          const wobble = Math.sin(Math.atan2(z - CZ, x - CX) * 5 + ly) * 0.8;
          if (d <= R[ly] + wobble) p.set(x, ly, z, ly === 3 ? (rng() < 0.25 ? Block.Gravel : (x + z) % 7 === 0 ? Block.StoneBricks : Block.Sand) : rock());
        }
      }
    }
    // Plaza: paved ring around the keep with a compass inlay.
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        if (p.get(x, 3, z) === Block.Air || p.get(x, 3, z) === 255) continue;
        const d = Math.hypot(x - CX, z - CZ);
        if (d >= 12.5 && d <= 14.5) p.set(x, 3, z, (x + z) % 2 === 0 ? WH : Block.StoneBricks);
        else if (d > 14.5 && Math.abs(x - CX) < 2 && z > CZ) p.set(x, 3, z, WH);
      }
    }
    p.fill(0, 4, 0, SX - 1, SY - 1, SZ - 1, Block.Air);

    // ---- the drowned keep -----------------------------------------------------------------
    const inOct = (dx: number, dz: number, r: number, cut: number) => Math.abs(dx) <= r && Math.abs(dz) <= r && Math.abs(dx) + Math.abs(dz) <= cut;
    for (let ly = 3; ly <= 12; ly++) {
      for (let dz = -12; dz <= 12; dz++) {
        for (let dx = -12; dx <= 12; dx++) {
          if (!inOct(dx, dz, 11, 16)) continue;
          const inner = inOct(dx, dz, A, 14);
          let id: number = Block.Air;
          if (!inner) id = ly === 8 && (dx + dz) % 3 === 0 ? Block.GlassBlue : ly === 4 || ly === 12 ? Block.StoneBricks : WH;
          else if (ly === 3) id = Math.abs(Math.hypot(dx, dz) - 5.5) < 0.7 ? Block.GlassBlue : (dx + dz) % 4 === 0 ? Block.StoneBricks : Block.Sand;
          else if (ly === 12) id = Block.StoneBricks;
          if (id !== Block.Air || ly === 3 || ly === 12) {
            if (inner && ly >= 4 && ly <= 11) continue;
            p.set(CX + dx, ly, CZ + dz, id);
          }
          if (inner && ly >= 4 && ly <= 11) {
            p.set(CX + dx, ly, CZ + dz, Block.Air);
            // The chamfered corners of the octagon are walls inside the arena box.
            if (Math.abs(dx) + Math.abs(dz) > 13) p.furnish(CX + dx, ly, CZ + dz, ly === 8 ? Block.BeaconLens : WH);
          }
        }
      }
    }
    // The chamfered corners of the octagon inside the arena box are wall by design.
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) {
      if (Math.abs(dx) + Math.abs(dz) <= 14) continue;
      for (let ly = 4; ly <= 11; ly++) p.furniture.push({ x: ox + CX + dx, y: oy + ly, z: oz + CZ + dz });
    }
    // Red band round the keep's outside at ly 6..7.
    for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
      if (!inOct(dx, dz, 11, 16) || inOct(dx, dz, 10, 15)) continue;
      for (const ly of [6, 7]) if (p.get(CX + dx, ly, CZ + dz) === WH) p.set(CX + dx, ly, CZ + dz, RD);
    }
    // Hall: tide pools, columns, hanging weed, lenses, altar.
    for (const [dx0, dz0, w, d] of POOLS) p.fill(CX + dx0, 3, CZ + dz0, CX + dx0 + w - 1, 3, CZ + dz0 + d - 1, Block.Water);
    const inPool = (dx: number, dz: number) => POOLS.some(([a, b, w, d]) => dx >= a && dx < a + w && dz >= b && dz < b + d);
    for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
      for (let ly = 4; ly <= 11; ly++) p.furnish(CX + dx, ly, CZ + dz, ly === 4 || ly === 11 ? Block.StoneBricks : ly === 9 ? BL : WH);
      p.furnish(CX + dx, 4, CZ + dz + (dz < 0 ? 1 : -1), Block.Lantern);
    }
    for (let dz = -A; dz <= A; dz++) for (let dx = -A; dx <= A; dx++) {
      if (!inOct(dx, dz, A, 14) || inPool(dx, dz)) continue;
      const r = rng();
      if (r < 0.1) {
        p.furnish(CX + dx, 11, CZ + dz, Block.HangingMoss);
        if (rng() < 0.4) p.furnish(CX + dx, 10, CZ + dz, Block.HangingMoss);
      } else if (r > 0.985 && Math.hypot(dx, dz) > 6 && Math.abs(dx) > 2) p.furnish(CX + dx, 4, CZ + dz, Block.Cobble);
    }
    for (let dz = -8; dz <= 8; dz += 4) for (let dx = -8; dx <= 8; dx += 4) if (inOct(dx, dz, A, 14)) p.set(CX + dx, 12, CZ + dz, BL);
    for (const [dx, dz] of [[-8, 0], [8, 0], [0, 8], [-6, -8], [6, -8], [-8, 8], [8, 8]]) if (inOct(dx, dz, A, 14)) p.furnish(CX + dx, 4, CZ + dz, Block.Lantern);
    for (let i = -7; i <= 7; i += 3) {
      p.furnish(CX + i, 4, CZ - A, Block.Lantern);
      if (Math.abs(i) > 1) p.furnish(CX + i, 4, CZ + A, Block.Lantern);
    }
    // Wall course of lenses, and the tide mural behind the altar.
    for (let dx = -A; dx <= A; dx++) for (const dz of [-A - 1, A + 1]) if (inOct(dx, dz, 10, 15)) p.set(CX + dx, 9, CZ + dz, dx % 3 === 0 ? BL : WH);
    p.furnish(CX, 4, CZ - A + 1, Block.BossAltar);
    p.furnish(CX, 4, CZ - A, Block.Chest);
    for (const dx of [-3, 3]) for (let ly = 4; ly <= 8; ly++) p.furnish(CX + dx, ly, CZ - A, ly === 6 ? BL : RD);
    for (let dx = -2; dx <= 2; dx++) for (let ly = 5; ly <= 10; ly++) p.set(CX + dx, ly, CZ - A - 1, Math.abs(dx) === 2 || ly === 10 ? Block.GlassBlue : (dx === 0 && ly >= 6 && ly <= 8 ? BL : WH));
    // Door in the south: arched, with the approach flagged.
    p.fill(CX - 1, 4, CZ + 10, CX + 1, 7, CZ + 11, Block.Air);
    p.fill(CX, 8, CZ + 10, CX, 8, CZ + 11, Block.Air);
    for (let z = CZ + 12; z <= CZ + 18; z++) for (let x = CX - 1; x <= CX + 1; x++) p.set(x, 3, z, x === CX ? WH : Block.StoneBricks);
    for (const sx of [-2, 2]) {
      p.fill(CX + sx, 4, CZ + 12, CX + sx, 5, CZ + 12, Block.StoneBricks);
      p.set(CX + sx, 6, CZ + 12, Block.Lantern);
    }

    // ---- the tower on the keep's roof ----------------------------------------------------------
    const tw = (x: number, z: number, ly: number, id: number) => p.set(x, ly, z, id);
    for (let ly = TOWER_BASE; ly <= 31; ly++) {
      const r = towerR(ly);
      const stripe = Math.floor((ly - TOWER_BASE) / 3) % 2 === 0 ? WH : RD;
      const o = r * r + 0.25;
      const i = (r - 1.7) * (r - 1.7) + 0.25;
      for (let dz = -6; dz <= 6; dz++) {
        for (let dx = -6; dx <= 6; dx++) {
          const d = dx * dx + dz * dz;
          if (d <= o && d > i) tw(CX + dx, CZ + dz, ly, stripe);
          else if (d <= i) tw(CX + dx, CZ + dz, ly, Block.Air);
        }
      }
      // Slit windows on four sides and a lamp in the centre column every five layers.
      if (ly % 5 === 0) for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) tw(CX + dx * Math.round(r - 0.5), CZ + dz * Math.round(r - 0.5), ly, Block.Glass);
    }
    // Roof terrace parapet of the keep, and the stair up to it from the plaza.
    for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
      if (inOct(dx, dz, 11, 16) && !inOct(dx, dz, 10, 15)) p.set(CX + dx, 13, CZ + dz, (dx + dz) % 2 === 0 ? Block.StoneBricks : Block.StoneBrickSlab);
    }
    // Outer stair on the east face: from the plaza up to the roof, 3 wide, rising 1 per block.
    for (let i = 0; i < 9; i++) {
      for (let k = -1; k <= 1; k++) {
        const x = CX + 20 - i;
        const z = CZ + k;
        for (let ly = 3; ly <= 4 + i; ly++) p.set(x, ly, z, ly === 4 + i ? Block.StoneBricks : rock());
        for (let ly = 5 + i; ly <= 8 + i; ly++) p.set(x, ly, z, Block.Air);
      }
    }
    // The stair meets the roof at ly 12 (x = CX+12); clear the parapet there.
    for (let k = -1; k <= 1; k++) p.set(CX + 11, 13, CZ + k, Block.Air);
    for (let k = -1; k <= 1; k++) p.set(CX + 12, 13, CZ + k, Block.Air);
    for (const sz of [-2, 2]) for (let i = 0; i < 9; i++) p.set(CX + 20 - i, 5 + i, CZ + sz, i % 3 === 0 ? Block.Lantern : Block.StoneBrickSlab);
    // Tower door on the east side of the base, into the stair.
    p.fill(CX + 3, 13, CZ - 1, CX + 5, 14, CZ, Block.Air);
    for (let x = CX + 2; x <= CX + 5; x++) p.set(x, 12, CZ - 1, Block.StoneBricks);
    for (let x = CX + 2; x <= CX + 6; x++) p.set(x, 12, CZ, Block.StoneBricks);
    // Spiral stair: step k (top block y = 13 + k) on ring cell k % 8; the centre column carries lamps.
    for (let ly = TOWER_BASE; ly <= 31; ly++) tw(CX, CZ, ly, ly % 4 === 0 ? Block.Lamp : WH);
    for (let k = 0; k <= TOP_STEP; k++) {
      const [rx, rz] = RING[k % 8];
      tw(CX + rx, CZ + rz, TOWER_BASE + k - 1 + 0, Block.StoneBricks);
    }
    // Landing floor at ly 31 except over the last two steps, then the lantern room.
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dz * dz > 11) continue;
      const hole = (dx === RING[0][0] && dz === RING[0][1]) || (dx === RING[1][0] && dz === RING[1][1]);
      if (!(dx === 0 && dz === 0)) tw(CX + dx, CZ + dz, 31, hole ? Block.Air : Block.StoneBricks);
    }
    p.disc(CX, CZ, 31, 6, Block.StoneBricks);
    p.fill(CX + RING[0][0], 31, CZ + RING[0][1], CX + RING[0][0], 31, CZ + RING[0][1], Block.Air);
    p.fill(CX + RING[1][0], 31, CZ + RING[1][1], CX + RING[1][0], 31, CZ + RING[1][1], Block.Air);
    p.ringWall(CX, CZ, 32, 32, 6, Block.StoneBrickSlab, 1);
    p.disc(CX, CZ, 31, 6, Block.StoneBricks);
    p.fill(CX + RING[0][0], 31, CZ + RING[0][1], CX + RING[0][0], 31, CZ + RING[0][1], Block.Air);
    p.fill(CX + RING[1][0], 31, CZ + RING[1][1], CX + RING[1][0], 31, CZ + RING[1][1], Block.Air);
    // Lantern room: glass walls ringed with mullions, a great lens in the middle, a conical roof.
    for (let ly = 32; ly <= 34; ly++) {
      p.ringWall(CX, CZ, ly, ly, 3.6, Block.Glass, 1);
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        p.set(CX + Math.round(Math.cos(ang) * 3), ly, CZ + Math.round(Math.sin(ang) * 3), ly === 33 ? BL : WH);
      }
      p.set(CX, ly, CZ, BL);
    }
    p.fill(CX - 1, 32, CZ - 1, CX + 1, 32, CZ + 1, Block.Air);
    p.fill(CX, 32, CZ, CX, 34, CZ, BL);
    p.disc(CX, CZ, 35, 4.5, RD);
    p.disc(CX, CZ, 36, 2.5, WH);
    p.set(CX, 36, CZ, BL);
    // Door from the stair to the gallery on the east, and the chest on the ledge.
    p.fill(CX + 3, 32, CZ, CX + 4, 33, CZ, Block.Air);
    p.set(CX + 5, 32, CZ, Block.Chest);
    p.set(CX + 5, 32, CZ + 2, Block.Lantern);
    p.set(CX + 5, 32, CZ - 2, Block.Lantern);
    // Lantern posts on the roof terrace.
    for (const [dx, dz] of [[9, 9], [-9, 9], [9, -9], [-9, -9]]) {
      p.fill(CX + dx, 13, CZ + dz, CX + dx, 14, CZ + dz, WH);
      p.set(CX + dx, 15, CZ + dz, BL);
    }

    // ---- keeper's cottage --------------------------------------------------------------------
    const cx0 = CX - 21;
    const cz0 = CZ - 9;
    p.room(cx0, 3, cz0, cx0 + 8, 8, cz0 + 7, Block.Planks, Block.PinePlanks, Block.PlankSlab);
    for (let x = cx0 - 1; x <= cx0 + 9; x++) for (let z = cz0 - 1; z <= cz0 + 8; z++) if (p.get(x, 9, z) === Block.Air) p.set(x, 9, z, x === cx0 - 1 || x === cx0 + 9 || z === cz0 - 1 || z === cz0 + 8 ? Block.Air : Block.PlankSlab);
    p.fill(cx0 + 1, 4, cz0 + 1, cx0 + 7, 7, cz0 + 6, Block.Air);
    p.fill(cx0 + 8, 4, cz0 + 3, cx0 + 8, 5, cz0 + 4, Block.Air);
    p.set(cx0 + 2, 6, cz0, Block.GlassBlue);
    p.set(cx0 + 6, 6, cz0, Block.GlassBlue);
    p.set(cx0 + 4, 8, cz0 + 3, Block.Lamp);
    p.set(cx0 + 2, 4, cz0 + 2, Block.Chest);
    p.set(cx0 + 6, 4, cz0 + 5, Block.Workbench);
    p.set(cx0 + 2, 4, cz0 + 5, Block.Lantern);
    for (let z = cz0 + 1; z <= cz0 + 6; z++) p.set(cx0, 5, z, z % 2 === 0 ? Block.GlassBlue : Block.Planks);
    p.set(cx0 + 9, 4, cz0 + 3, Block.Lantern);

    // ---- piers ------------------------------------------------------------------------------
    for (const side of [-1, 1]) {
      for (let i = 0; i < 12; i++) {
        const x = CX + side * (17 + i);
        for (let z = CZ - 1; z <= CZ + 1; z++) p.set(x, 3, z, i % 2 === 0 ? Block.Planks : Block.PinePlanks);
        if (i % 4 === 0) for (const z of [CZ - 2, CZ + 2]) {
          p.fill(x, 0, z, x, 2, z, Block.Log);
          p.set(x, 3, z, Block.Log);
          p.set(x, 4, z, Block.Lantern);
        }
        if (i % 4 === 2) for (const z of [CZ - 1, CZ + 1]) p.fill(x, 0, z, x, 2, z, Block.Log);
      }
    }
    // East pier ends in a boathouse with a chest.
    const bx = CX + 24;
    p.room(bx, 3, CZ - 3, bx + 5, 8, CZ + 4, Block.PinePlanks, Block.Planks, Block.PlankSlab);
    p.fill(bx + 1, 4, CZ - 2, bx + 4, 7, CZ + 3, Block.Air);
    p.fill(bx, 4, CZ, bx, 5, CZ + 1, Block.Air);
    p.set(bx + 4, 4, CZ + 1, Block.Chest);
    p.set(bx + 3, 4, CZ - 2, Block.Lantern);
    p.set(bx + 2, 7, CZ, Block.Lamp);

    // Barnacle crust and seaweed on the lower rocks.
    p.weather(rng, 0, 0, 0, SX - 1, 3, SZ - 1, [Block.Cobble, Block.Stone], Block.MossyCobble, 0.2);
    // A few glass-lantern buoys on the plaza edge.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x = Math.round(CX + Math.cos(a) * 15);
      const z = Math.round(CZ + Math.sin(a) * 15);
      if (p.get(x, 3, z) !== Block.Air && p.get(x, 3, z) !== 255 && p.get(x, 4, z) === Block.Air) p.set(x, 4, z, Block.Lantern);
    }

    // ---- the wreck: a half-sunk ship south of the island ---------------------------------------
    const W = new StructureVolume(ox + CX - 22, F - 8, oz + 38, 18, 14, 9, Block.Log);
    const w = new Pen(W);
    for (let x = 0; x < 18; x++) {
      const taper = Math.abs(x - 8) > 6 ? 1 : 0;
      for (let z = 0; z < 9; z++) {
        const dz = Math.abs(z - 4);
        if (dz > 4 - taper - (x < 2 || x > 15 ? 1 : 0)) continue;
        const tilt = Math.floor(x / 6);
        // Hull: keel, planks rising to the gunwale, ribs.
        const y0 = 1 + tilt;
        W.set(x, y0, z, Block.DuskwoodPlanks);
        if (dz >= 3 - taper) for (let y = y0 + 1; y <= y0 + 3 + (x % 3 === 0 ? 1 : 0); y++) if (rng() < 0.85) W.set(x, y, z, x % 4 === 0 ? Block.DuskwoodLog : Block.DuskwoodPlanks);
      }
    }
    for (const x of [6, 10]) w.fill(x, 2, 4, x, 9 + (x === 6 ? 3 : 0), 4, Block.DuskwoodLog);
    w.fill(5, 8, 3, 7, 8, 5, Block.ClothWhite);
    w.set(6, 10, 4, Block.Lantern);
    return { volumes: [v, W], furniture: p.furniture };
  },
};
