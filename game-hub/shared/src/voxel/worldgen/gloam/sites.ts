/**
 * Where the Gloamreach's structures go (generator 4, package D).
 *
 * - Fallen Lattices in the overworld: about one per 640 x 640 block region,
 *   always one within FALLEN_GUARANTEE blocks of spawn.
 * - Twilit Lattices in the Gloamreach: about one per 420 x 420, on flat shelves.
 * - Eclipse Orreries in the Gloamreach: about one per 1400 x 1400, one near where
 *   the spawn point maps to.
 * Each region rolls on its own (hash of region, kind and seed), so placement is the
 * same whatever order chunks are generated in. Results are cached per region.
 */
import { hash4, mulberry32 } from '../../../util/rng';
import { SEA_LEVEL } from '../../constants';
import { DIM_X0, DIM_X1, OVERWORLD_MAX_X, overworldToGloam } from '../../realm';
import { describe, type PlacedStructure } from '../../structures/place';
import { StructureType } from '../../structures/types';
import { ORRERY_DECK } from '../../structures/gloam';
import { Biome } from '../biomes';
import { type GloamColumn } from './terrain';

export const FALLEN_REGION = 640;
export const TWILIT_REGION = 330;
export const ORRERY_REGION = 1400;
/** A Fallen Lattice lies within this many blocks of spawn. */
export const FALLEN_GUARANTEE = 450;
/** An Eclipse Orrery lies within this many blocks of where the spawn point maps to. */
export const ORRERY_GUARANTEE = 700;

export interface SiteHost {
  seed: number;
  spawn(): { x: number; z: number };
  /** Overworld column (height and biome). */
  over(x: number, z: number): { height: number; biome: Biome };
  /** Gloamreach column. */
  gloam(x: number, z: number): GloamColumn;
  /** True when another overworld structure lies within `margin` of (x, z). */
  overworldBusy(x: number, z: number, margin: number): boolean;
}

const NO_FALLEN = new Set<Biome>([Biome.Ocean, Biome.IcySea, Biome.Beach, Biome.FrozenShore, Biome.Marshland]);
/** Largest x any overworld structure may reach (the coast fades into sea before the Veil Wall). */
const OVER_X_MAX = OVERWORLD_MAX_X - 260;
const LIMIT = 31000;

interface Cached {
  p: PlacedStructure | null;
}

export class GloamSites {
  private readonly cache = new Map<number, Cached>();
  private fallenExtra: PlacedStructure | null | undefined;
  private orreryExtra: PlacedStructure | null | undefined;

  constructor(private readonly h: SiteHost) {}

  private static key(kind: number, rx: number, rz: number): number {
    return kind * 1e9 + (rx + 4096) * 8192 + (rz + 4096);
  }

  private id(kind: number, rx: number, rz: number): number {
    return hash4(rx, rz, kind, this.h.seed ^ 0x51d3) & 0xffff;
  }

  // ---- fit tests -----------------------------------------------------------------------------

  /** Overworld floor for a Fallen Lattice at (ax, az), or null. */
  private overFloor(ax: number, az: number): number | null {
    if (ax < -LIMIT || ax > OVER_X_MAX || Math.abs(az) > LIMIT) return null;
    const b = this.h.over(ax, az).biome;
    if (NO_FALLEN.has(b)) return null;
    const hs: number[] = [];
    for (const dz of [-8, 0, 8]) for (const dx of [-8, 0, 8]) hs.push(this.h.over(ax + dx, az + dz).height);
    hs.sort((a, c) => a - c);
    if (hs[8] - hs[0] > 4 || hs[0] < SEA_LEVEL + 2 || hs[4] > 48) return null;
    if (this.h.overworldBusy(ax, az, 36)) return null;
    return hs[4];
  }

  /** Gloamreach floor for a Twilit Lattice: a flat shelf top (or flat floor above the mist), no needles. */
  private twilitFloor(ax: number, az: number): number | null {
    if (ax < DIM_X0 + 40 || ax > DIM_X1 - 60 || Math.abs(az) > LIMIT) return null;
    const c0 = this.h.gloam(ax, az);
    if (c0.spire > 0 || c0.top <= c0.mist + 1) return null;
    const hs: number[] = [];
    for (const dz of [-7, 0, 7]) {
      for (const dx of [-7, 0, 7]) {
        const c = this.h.gloam(ax + dx, az + dz);
        if (c.spire > 0) return null;
        hs.push(c.top);
      }
    }
    hs.sort((a, b) => a - b);
    if (hs[8] - hs[0] > 2 || hs[0] <= c0.mist) return null;
    return c0.top;
  }

  private orreryOk(ax: number, az: number): boolean {
    return ax >= DIM_X0 + 60 && ax <= DIM_X1 - 80 && Math.abs(az) <= LIMIT;
  }

  // ---- regions --------------------------------------------------------------------------------

  private roll(kind: number, rx: number, rz: number): PlacedStructure | null {
    const key = GloamSites.key(kind, rx, rz);
    const hit = this.cache.get(key);
    if (hit) return hit.p;
    const p = this.rollUncached(kind, rx, rz);
    if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(key, { p });
    return p;
  }

  private rollUncached(kind: number, rx: number, rz: number): PlacedStructure | null {
    const seed = this.h.seed;
    const R = kind === 9 ? FALLEN_REGION : kind === 10 ? TWILIT_REGION : ORRERY_REGION;
    const margin = kind === 11 ? 80 : 40;
    const rng = mulberry32(hash4(rx, rz, seed, 0x6107 + kind));
    const chance = kind === 9 ? 0.86 : kind === 10 ? 0.9 : 0.72;
    if (rng() >= chance) return null;
    const tries = kind === 11 ? 3 : 8;
    for (let i = 0; i < tries; i++) {
      const ax = rx * R + margin + Math.floor(rng() * (R - margin * 2));
      const az = rz * R + margin + Math.floor(rng() * (R - margin * 2));
      const p = this.tryAt(kind, rx, rz, ax, az);
      if (p) return p;
    }
    return null;
  }

  private tryAt(kind: number, rx: number, rz: number, ax: number, az: number): PlacedStructure | null {
    const id = this.id(kind, rx, rz);
    if (kind === 9) {
      const F = this.overFloor(ax, az);
      if (F === null) return null;
      return describe(this.h.seed, rx, rz, StructureType.FallenLattice, ax, az, F, this.h.over(ax, az).biome, false, 1, id);
    }
    if (kind === 10) {
      const F = this.twilitFloor(ax, az);
      if (F === null) return null;
      return describe(this.h.seed, rx, rz, StructureType.TwilitLattice, ax, az, F, this.h.gloam(ax, az).biome, false, 1, id);
    }
    if (!this.orreryOk(ax, az)) return null;
    return describe(this.h.seed, rx, rz, StructureType.EclipseOrrery, ax, az, ORRERY_DECK, this.h.gloam(ax, az).biome, false, 1, id);
  }

  /** A Fallen Lattice within FALLEN_GUARANTEE of spawn (the nearest region roll, else a ring search). */
  private fallenNearSpawn(): PlacedStructure | null {
    if (this.fallenExtra !== undefined) return this.fallenExtra;
    const s = this.h.spawn();
    let best: PlacedStructure | null = null;
    let bestD = Infinity;
    for (const p of this.regionsAround(9, s.x, s.z, FALLEN_GUARANTEE)) {
      const d = Math.hypot(p.info.anchor.x - s.x, p.info.anchor.z - s.z);
      if (d <= FALLEN_GUARANTEE && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) {
      // Ring search: first fitting spot, 150..440 blocks out.
      search: for (let r = 150; r <= 440; r += 12) {
        const n = Math.ceil(r / 6);
        const off = (hash4(this.h.seed, r, 0x6108) % 360) * (Math.PI / 180);
        for (let i = 0; i < n; i++) {
          const a = off + (i / n) * Math.PI * 2;
          const ax = Math.round(s.x + Math.cos(a) * r);
          const az = Math.round(s.z + Math.sin(a) * r);
          const F = this.overFloor(ax, az);
          if (F === null) continue;
          best = describe(this.h.seed, 0, 0, StructureType.FallenLattice, ax, az, F, this.h.over(ax, az).biome, false, 1, this.id(9, 4090, 4090));
          break search;
        }
      }
    }
    return (this.fallenExtra = best);
  }

  /** An Orrery within ORRERY_GUARANTEE of where the spawn point maps to. */
  private orreryNearSpawn(): PlacedStructure | null {
    if (this.orreryExtra !== undefined) return this.orreryExtra;
    const s = this.h.spawn();
    const m = overworldToGloam(s.x, s.z);
    let best: PlacedStructure | null = null;
    let bestD = Infinity;
    for (const p of this.regionsAround(11, m.x, m.z, ORRERY_GUARANTEE)) {
      const d = Math.hypot(p.info.anchor.x - m.x, p.info.anchor.z - m.z);
      if (d <= ORRERY_GUARANTEE && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) {
      const off = (hash4(this.h.seed, 0x6109) % 360) * (Math.PI / 180);
      for (let r = 260; r <= 650 && !best; r += 40) {
        for (let i = 0; i < 12 && !best; i++) {
          const a = off + (i / 12) * Math.PI * 2;
          const ax = Math.round(m.x + Math.cos(a) * r);
          const az = Math.round(m.z + Math.sin(a) * r);
          if (this.orreryOk(ax, az)) best = describe(this.h.seed, 0, 0, StructureType.EclipseOrrery, ax, az, ORRERY_DECK, this.h.gloam(ax, az).biome, false, 1, this.id(11, 4090, 4090));
        }
      }
    }
    return (this.orreryExtra = best);
  }

  private regionsAround(kind: number, x: number, z: number, radius: number): PlacedStructure[] {
    const R = kind === 9 ? FALLEN_REGION : kind === 10 ? TWILIT_REGION : ORRERY_REGION;
    const out: PlacedStructure[] = [];
    for (let rx = Math.floor((x - radius) / R); rx <= Math.floor((x + radius) / R); rx++) {
      for (let rz = Math.floor((z - radius) / R); rz <= Math.floor((z + radius) / R); rz++) {
        const p = this.roll(kind, rx, rz);
        if (p) out.push(p);
      }
    }
    return out;
  }

  /** Overworld structures (Fallen Lattices) whose bounds overlap [x0, x1) x [z0, z1). */
  overworldInBox(x0: number, z0: number, x1: number, z1: number, out: PlacedStructure[] = []): PlacedStructure[] {
    return this.inBoxKinds([9], x0, z0, x1, z1, out);
  }

  /** Gloamreach structures overlapping the box. */
  gloamInBox(x0: number, z0: number, x1: number, z1: number, out: PlacedStructure[] = []): PlacedStructure[] {
    return this.inBoxKinds([10, 11], x0, z0, x1, z1, out);
  }

  private inBoxKinds(kinds: number[], x0: number, z0: number, x1: number, z1: number, out: PlacedStructure[]): PlacedStructure[] {
    out.length = 0;
    const hit = (p: PlacedStructure | null) => {
      if (!p) return;
      const b = p.info.bounds;
      if (b.x0 < x1 && b.x1 > x0 && b.z0 < z1 && b.z1 > z0 && !out.some((o) => o.info.id === p.info.id && o.info.type === p.info.type)) out.push(p);
    };
    for (const kind of kinds) {
      const R = kind === 9 ? FALLEN_REGION : kind === 10 ? TWILIT_REGION : ORRERY_REGION;
      // Structures stay in their region (margin 40, reach <= 40 for lattices; the Orrery reaches 40 from its anchor).
      const reach = 64;
      for (let rx = Math.floor((x0 - reach) / R); rx <= Math.floor((x1 + reach) / R); rx++) {
        for (let rz = Math.floor((z0 - reach) / R); rz <= Math.floor((z1 + reach) / R); rz++) hit(this.roll(kind, rx, rz));
      }
      if (kind === 9) hit(this.fallenNearSpawn());
      if (kind === 11) hit(this.orreryNearSpawn());
    }
    return out;
  }
}
