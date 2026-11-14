/**
 * Gloamreach structures (package D): the Fallen Lattice (a ruined Lattice Ring
 * in the overworld), the Twilit Lattice (a lit ring in the Gloamreach: the way
 * home) and the Eclipse Orrery (the realm's boss structure). Placement is in
 * worldgen/gloam/sites.ts; these are the layouts and the blocks.
 */
import { hash4 } from '../../util/rng';
import { Block } from '../blocks';
import { LootTableId } from '../loot';
import { gateInterior, gateRing, type GateAxis, type GateFrame, RING_UV } from '../portal';
import { box, type Built, type ChestSpec, type Layout, type Template } from './template';
import type { Vec3i } from './types';
import { StructureVolume } from './volume';

// ---- shared helpers ----------------------------------------------------------------------------

/** Deterministic variant of a Fallen Lattice from its anchor: axis, whole or broken, which stones are gone. */
export function fallenVariant(ax: number, az: number): { axis: GateAxis; whole: boolean; gone: number[] } {
  const h = hash4(ax, az, 0x1a77, 9);
  const whole = (h >>> 1) % 100 < 35;
  const gone: number[] = [];
  if (!whole) {
    const n = 1 + ((h >>> 8) % 3);
    let k = hash4(ax, az, 0x1a78, 9);
    while (gone.length < n) {
      const i = k % 12;
      k = hash4(k, i, 0x1a79, 9);
      if (!gone.includes(i)) gone.push(i);
    }
  }
  return { axis: (h & 1) as GateAxis, whole, gone };
}

/** The gate a lattice template builds around (ax, az) standing on floor F: bottom ring row sits at F + 1. */
export const latticeFrame = (ax: number, az: number, F: number, axis: GateAxis): GateFrame =>
  axis === 0 ? { axis, x: ax - 2, y: F + 1, z: az } : { axis, x: ax, y: F + 1, z: az - 2 };

const R = (n: number) => Math.round(n);

// ---- Fallen Lattice ----------------------------------------------------------------------------

const FS = 17;
const FH = 12;
const fOrigin = (ax: number, az: number, F: number) => ({ ox: ax - 8, oy: F - 2, oz: az - 8 });

export const fallenLattice: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = fOrigin(ax, az, F);
    const v = fallenVariant(ax, az);
    const chest: ChestSpec = { x: ox + 12, y: F + 1, z: oz + 12, index: 0, loot: v.whole ? LootTableId.FallenLatticeLens : LootTableId.FallenLatticeRepair, sealed: false };
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, FS - 1, FH - 1, FS - 1),
      entrance: { x: ax, y: F + 1, z: az + 8 },
      arena: { x0: ax, y0: F + 1, z0: az, x1: ax + 1, y1: F + 2, z1: az + 1 },
      bossSpawn: { x: ax + 0.5, y: F + 1, z: az + 0.5 },
      // No boss: the "altar" is a paving cell that is never an altar block.
      altar: { x: ax + 4, y: F, z: az + 4 },
      doorways: [],
      chests: [chest],
      guardSpawns: [],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = fOrigin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, FS, FH, FS, Block.StoneBricks);
    const furniture: Vec3i[] = [];
    const variant = fallenVariant(ax, az);
    const paving = () => (rng() < 0.35 ? Block.MossyStoneBricks : rng() < 0.3 ? Block.Cobble : Block.StoneBricks);
    // Cracked paving circle; the air above is cleared so the ring stands free.
    for (let z = 0; z < FS; z++) {
      for (let x = 0; x < FS; x++) {
        const d = Math.hypot(x - 8, z - 8);
        if (d > 6.6) continue;
        for (let y = 3; y <= 9; y++) v.set(x, y, z, Block.Air);
        if (rng() > 0.12 || d < 4) v.set(x, 2, z, paving());
      }
    }
    const frame = latticeFrame(8, 8, 2, variant.axis);
    // Local frame: floor row ly = 2, so the ring's bottom row is ly 3.
    const ring = gateRing({ ...frame, y: 3 });
    ring.forEach((c, i) => {
      if (!variant.gone.includes(i)) v.set(c[0], c[1], c[2], Block.LatticeStone);
      else if (rng() < 0.7) v.set(c[0] + (variant.axis === 0 ? 0 : 1), 3, c[2] + (variant.axis === 0 ? 1 : 0), Block.Cobble);
    });
    for (const c of gateInterior({ ...frame, y: 3 })) v.set(c[0], c[1], c[2], Block.Air);
    void RING_UV;
    // Broken pillars along the plane and stubs beside it.
    const along = (u: number, w: number) => (variant.axis === 0 ? [8 + u, 8 + w] : [8 + w, 8 + u]);
    for (const [u, w, h] of [[-5, 0, 3], [5, 0, 2], [-4, 3, 1], [4, -3, 2], [0, -4, 1]] as [number, number, number][]) {
      const [x, z] = along(u, w);
      for (let k = 0; k < h + Math.floor(rng() * 2); k++) v.set(x, 3 + k, z, rng() < 0.4 ? Block.MossyStoneBricks : Block.StoneBricks);
    }
    // Overgrowth.
    for (let z = 1; z < FS - 1; z++) {
      for (let x = 1; x < FS - 1; x++) {
        if (v.get(x, 3, z) === Block.Air && v.get(x, 2, z) !== 255 && rng() < 0.1) v.set(x, 3, z, rng() < 0.5 ? Block.Fern : Block.TallGrass);
      }
    }
    // A collapsed cache with the chest, behind the gate's corner.
    v.fill(11, 3, 11, 13, 4, 13, Block.MossyCobble);
    v.fill(12, 3, 12, 12, 4, 12, Block.Air);
    v.set(12, 3, 12, Block.Chest);
    v.set(12, 5, 12, Block.MossyCobble);
    v.set(11, 3, 12, Block.Air);
    furniture.push({ x: ox + 12, y: oy + 3, z: oz + 12 });
    return { volumes: [v], furniture };
  },
};

// ---- Twilit Lattice ----------------------------------------------------------------------------

const TS = 15;
const TH = 13;
const tOrigin = (ax: number, az: number, F: number) => ({ ox: ax - 7, oy: F - 2, oz: az - 7 });

export const twilitLattice: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = tOrigin(ax, az, F);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, TS - 1, TH - 1, TS - 1),
      entrance: { x: ax, y: F + 1, z: az + 7 },
      arena: { x0: ax, y0: F + 1, z0: az, x1: ax + 1, y1: F + 2, z1: az + 1 },
      bossSpawn: { x: ax + 0.5, y: F + 1, z: az + 0.5 },
      altar: { x: ax + 3, y: F, z: az + 3 },
      doorways: [],
      chests: [{ x: ox + 11, y: F + 1, z: oz + 11, index: 0, loot: LootTableId.TwilitLatticeCommon, sealed: false }],
      guardSpawns: [],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = tOrigin(ax, az, F);
    const v = new StructureVolume(ox, oy, oz, TS, TH, TS, Block.GloamBricks);
    const furniture: Vec3i[] = [];
    const axis = (hash4(ax, az, 0x7117, 10) & 1) as GateAxis;
    for (let z = 0; z < TS; z++) {
      for (let x = 0; x < TS; x++) {
        const d = Math.hypot(x - 7, z - 7);
        if (d > 6.6) continue;
        for (let y = 3; y <= 11; y++) v.set(x, y, z, Block.Air);
        v.set(x, 2, z, d > 5.2 ? Block.PolishedGloamstone : (x + z) % 2 === 0 || d < 2.5 ? Block.GloamBricks : Block.Gloamstone);
        v.set(x, 1, z, Block.GloamBricks);
      }
    }
    const frame = latticeFrame(7, 7, 2, axis);
    for (const c of gateRing({ ...frame, y: 3 })) v.set(c[0], c[1], c[2], Block.LatticeStoneLit);
    for (const c of gateInterior({ ...frame, y: 3 })) v.set(c[0], c[1], c[2], Block.Veil);
    // Four lamp posts at the diagonals.
    for (const [x, z] of [[2, 2], [12, 2], [2, 12], [12, 12]]) {
      for (let k = 3; k <= 5; k++) v.set(x, k, z, Block.PolishedGloamstone);
      v.set(x, 6, z, Block.Moonlamp);
    }
    // A flower bed and a small cache.
    for (const [x, z] of [[5, 11], [9, 11], [3, 7], [11, 7]]) if (rng() < 0.8) v.set(x, 3, z, rng() < 0.5 ? Block.LumenBell : Block.GlimmerCluster);
    v.set(11, 3, 11, Block.Chest);
    furniture.push({ x: ox + 11, y: oy + 3, z: oz + 11 });
    return { volumes: [v], furniture };
  },
};

// ---- Eclipse Orrery ----------------------------------------------------------------------------

/** Deck level of every Orrery (its walking surface is F + 1). */
export const ORRERY_DECK = 34;
const OX = 22; // deck radius 21, so local x/z 0..44 around the centre
const OSX = 45;
const OSZ = 62;
const OSY = 58;
const oOrigin = (ax: number, az: number) => ({ ox: ax - OX, oy: 1, oz: az - OX });

export const eclipseOrrery: Template = {
  layout(ax, az, F): Layout {
    const { ox, oy, oz } = oOrigin(ax, az);
    return {
      bounds: box(ox, oy, oz, 0, 0, 0, OSX - 1, OSY - 1, OSZ - 1),
      entrance: { x: ax, y: F + 1, z: az + 33 },
      arena: { x0: ax - 17, y0: F + 1, z0: az - 17, x1: ax + 18, y1: F + 13, z1: az + 18 },
      bossSpawn: { x: ax + 0.5, y: F + 1, z: az - 4.5 },
      altar: { x: ax, y: F + 1, z: az },
      doorways: [{ x0: ax - 2, y0: F + 1, z0: az + 18, x1: ax + 3, y1: F + 5, z1: az + 21 }],
      chests: [
        { x: ax, y: F + 1, z: az - 1, index: 0, loot: LootTableId.OrreryBoss, sealed: true },
        { x: ax - 17, y: F + 1, z: az, index: 1, loot: LootTableId.OrreryCommon, sealed: false },
        { x: ax + 17, y: F + 1, z: az, index: 2, loot: LootTableId.OrreryCommon, sealed: false },
      ],
      guardSpawns: [
        { x: ax - 11.5, y: F + 1, z: az - 11.5 },
        { x: ax + 12.5, y: F + 1, z: az - 11.5 },
        { x: ax - 11.5, y: F + 1, z: az + 12.5 },
        { x: ax + 12.5, y: F + 1, z: az + 12.5 },
      ],
    };
  },

  build(ax, az, F, rng): Built {
    const { ox, oy, oz } = oOrigin(ax, az);
    const v = new StructureVolume(ox, oy, oz, OSX, OSY, OSZ, null);
    const furniture: Vec3i[] = [];
    const furnish = (x: number, y: number, z: number, id: number) => {
      v.set(x - ox, y - oy, z - oz, id);
      furniture.push({ x, y, z });
    };
    const put = (x: number, y: number, z: number, id: number) => v.set(x - ox, y - oy, z - oz, id);
    const C = 0; // centre offsets are relative to (ax, az)
    void C;
    // The hall's air: everything above the deck within the rim, so spires and the upper shelf never cut into it.
    for (let dz = -21; dz <= 21; dz++) {
      for (let dx = -21; dx <= 21; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > 21.4) continue;
        const x = ax + dx;
        const z = az + dz;
        for (let y = F + 1; y <= F + 22; y++) put(x, y, z, Block.Air);
        // Deck: two layers; the keel under it narrows to a point.
        const ring = (r0: number, r1: number) => d >= r0 && d < r1;
        let top: number = Block.EclipseBrick;
        if (d < 3.2) top = Block.OrreryBrass;
        else if (ring(8, 9) || ring(14, 15) || ring(20, 21.4)) top = Block.OrreryBrass;
        else {
          const ang = Math.atan2(dz, dx);
          const spoke = Math.abs(((ang / (Math.PI / 4)) % 1 + 1) % 1 - 0.5) > 0.46 && d > 3 && d < 20;
          top = spoke ? Block.PolishedGloamstone : (dx + dz) % 2 === 0 ? Block.EclipseBrick : Block.PolishedGloamstone;
        }
        if (rng() < 0.04 && top !== Block.OrreryBrass) top = Block.Gloamstone;
        put(x, F, z, top);
        put(x, F - 1, z, Block.EclipseBrick);
        const keel = Math.floor((21.4 - d) * 0.34);
        for (let k = 1; k <= keel; k++) put(x, F - 1 - k, z, k % 2 ? Block.EclipseBrick : Block.Gloamstone);
      }
    }
    // Rim wall with four arches (south is the main door) and crenels.
    for (let dz = -21; dz <= 21; dz++) {
      for (let dx = -21; dx <= 21; dx++) {
        const d = Math.hypot(dx, dz);
        if (d < 19.2 || d >= 21) continue;
        const cardinal = (Math.abs(dx) <= 2 && Math.abs(dz) > 15) || (Math.abs(dz) <= 2 && Math.abs(dx) > 15);
        if (cardinal) {
          if (Math.abs(dx) === 3 || Math.abs(dz) === 3) for (let h = 1; h <= 5; h++) put(ax + dx, F + h, az + dz, Block.PolishedGloamstone);
          if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) continue;
          if (Math.abs(dx) <= 2 ? Math.abs(dx) === 2 : Math.abs(dz) === 2) put(ax + dx, F + 5, az + dz, Block.PolishedGloamstone);
          continue;
        }
        const crenel = (dx + dz) % 2 === 0;
        for (let h = 1; h <= (crenel ? 3 : 2); h++) put(ax + dx, F + h, az + dz, h === 3 ? Block.OrreryBrass : Block.EclipseBrick);
      }
    }
    // Moon pylons: six slender towers carrying glass moons and a brass orbit ring.
    const pylons: [number, number][] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 6;
      pylons.push([ax + R(Math.cos(a) * 13), az + R(Math.sin(a) * 13)]);
    }
    for (const [px, pz] of pylons) {
      for (let h = 1; h <= 9; h++) furnish(px, F + h, pz, h > 7 ? Block.OrreryBrass : Block.EclipseBrick);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy) <= 1 && !(dx === 0 && dz === 0 && dy < 0)) put(px + dx, F + 11 + dy, pz + dz, Block.EclipseGlass);
          }
        }
      }
      put(px, F + 11, pz, Block.Moonlamp);
    }
    // The orbit ring (radius 13, y F + 9) and the cross-arms to the hanging sun.
    for (let k = 0; k < 360; k += 2) {
      const a = (k * Math.PI) / 180;
      put(ax + R(Math.cos(a) * 13), F + 9, az + R(Math.sin(a) * 13), Block.OrreryBrass);
    }
    for (let i = -12; i <= 12; i++) {
      if (Math.abs(i) < 2) continue;
      put(ax + i, F + 9, az, Block.OrreryBrass);
      put(ax, F + 9, az + i, Block.OrreryBrass);
    }
    // The dark sun: a glass shell with a starfall heart, ringed in light.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dy, dz);
          if (d <= 2.2) put(ax + dx, F + 9 + dy, az + dz, d <= 1.1 ? Block.StarfallBlock : Block.EclipseGlass);
        }
      }
    }
    for (let k = 0; k < 24; k++) {
      const a = (k * Math.PI * 2) / 24;
      put(ax + R(Math.cos(a) * 4), F + 9, az + R(Math.sin(a) * 4), k % 3 === 0 ? Block.StarfallBlock : Block.EclipseGlass);
    }
    // Dais, altar and chests.
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (Math.hypot(dx, dz) <= 3.3) put(ax + dx, F, az + dz, Block.OrreryBrass);
    furnish(ax, F + 1, az, Block.BossAltar);
    furnish(ax, F + 1, az - 1, Block.Chest);
    furnish(ax - 17, F + 1, az, Block.Chest);
    furnish(ax + 17, F + 1, az, Block.Chest);
    put(ax - 18, F + 1, az, Block.EclipseBrick);
    put(ax + 18, F + 1, az, Block.EclipseBrick);
    // Lamps along the rim.
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI * 2) / 16 + Math.PI / 16;
      const x = ax + R(Math.cos(a) * 18);
      const z = az + R(Math.sin(a) * 18);
      if (Math.hypot(x - ax, z - az) > 17.2 && v.get(x - ox, F + 1 - oy, z - oz) === Block.Air) furnish(x, F + 1, z, Block.Lantern);
    }
    // The south causeway: a 3-wide bridge from the main door to the lift tower.
    for (let z = az + 21; z <= az + 33; z++) {
      for (let x = ax - 1; x <= ax + 1; x++) {
        put(x, F, z, (z - az) % 4 === 0 ? Block.OrreryBrass : Block.PolishedGloamstone);
        put(x, F - 1, z, Block.EclipseBrick);
        for (let y = F + 1; y <= F + 6; y++) put(x, y, z, Block.Air);
      }
      if ((z - az) % 3 === 0) {
        put(ax - 2, F + 1, z, Block.Lantern);
        put(ax + 2, F + 1, z, Block.Lantern);
      }
      put(ax - 2, F, z, Block.EclipseBrick);
      put(ax + 2, F, z, Block.EclipseBrick);
    }
    // The lift tower: a column from the murk to the causeway's end with a ladder up its south face.
    for (let z = az + 34; z <= az + 36; z++) {
      for (let x = ax - 1; x <= ax + 1; x++) {
        for (let y = 1; y <= F; y++) put(x, y, z, y === F ? Block.OrreryBrass : Block.EclipseBrick);
        for (let y = F + 1; y <= F + 6; y++) put(x, y, z, Block.Air);
      }
    }
    for (let y = 1; y <= F; y++) {
      put(ax, y, az + 37, Block.LadderNZ);
      // Clear the cell for the ladder (terrain, mist, vines).
    }
    put(ax - 1, F + 1, az + 37, Block.Lantern);
    put(ax + 1, F + 1, az + 37, Block.Lantern);
    // Underlighting so the keel reads from below.
    for (const [dx, dz] of [[0, 12], [0, -12], [12, 0], [-12, 0]]) put(ax + dx, F - 3, az + dz, Block.Moonlamp);
    return { volumes: [v], furniture };
  },
};
