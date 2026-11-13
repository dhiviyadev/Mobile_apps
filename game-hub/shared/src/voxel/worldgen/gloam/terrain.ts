/**
 * The Gloamreach's terrain (generator 4, package D): a violet twilight realm of
 * floating shelves over a mist-covered murk floor, with needle spires climbing
 * out of the floor, crystal groves, giant glowing mushrooms and fallen-star
 * barrens. A pure function of (seed, x, z): every feature is rooted by a
 * jittered-cell hash and decided from the column function alone, so chunks
 * agree with each other whatever order they are generated in.
 *
 * Layout in y (the generator fills layers 0..63):
 *   0          bedrock
 *   1..~9      Murkstone floor (the "murk"); valleys of it fill with Gloam Mist
 *   ~24..~48   two layers of floating shelves (islands tapering to a keel)
 *   up to ~60  Spirestone needles rooted in the floor
 */
import { SimplexNoise } from '../../../util/noise';
import { hash4, hashFloat } from '../../../util/rng';
import { Block } from '../../blocks';
import { blockIndex } from '../../chunk';
import { CHUNK_SIZE, TERRAIN_HEIGHT, TERRAIN_VOLUME } from '../../constants';
import { Biome } from '../biomes';

export const GLOAM_MIST_TOP = 11;
const FEATURE_CELL = 7;
const FEATURE_REACH = 6;
const SPIRE_CELL = 36;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Everything the terrain function knows about a column. */
export interface GloamColumn {
  biome: Biome;
  /** Top solid y of the murk floor. */
  floor: number;
  /** Top of the mist that fills floor valleys (== floor when there is none). */
  mist: number;
  /** Shelf layers: bottom and top y (inclusive), top -1 when absent. */
  aBot: number;
  aTop: number;
  bBot: number;
  bTop: number;
  /** Top y of the needle rooted here (0 = none). */
  spire: number;
  /** Highest solid y of any kind. */
  top: number;
}

/** What a feature (tree, crystal cluster, mushroom, crater) writes: a cell setter that ignores cells outside the chunk. */
export type GloamSet = (x: number, y: number, z: number, id: number, onlyAir?: boolean) => void;

type Layer = 'floor' | 'a' | 'b';

export class GloamTerrain {
  private readonly nBiomeA: SimplexNoise;
  private readonly nBiomeB: SimplexNoise;
  private readonly nIsleA: SimplexNoise;
  private readonly nIsleB: SimplexNoise;
  private readonly nDome: SimplexNoise;
  private readonly nKeel: SimplexNoise;
  private readonly nFloor: SimplexNoise;
  private readonly nRough: SimplexNoise;
  private readonly cache = new Map<number, GloamColumn>();

  constructor(readonly seed: number) {
    const s = seed >>> 0;
    this.nBiomeA = new SimplexNoise(s ^ 0x1a2b3c4d);
    this.nBiomeB = new SimplexNoise(s ^ 0x5e6f7081);
    this.nIsleA = new SimplexNoise(s ^ 0x92a3b4c5);
    this.nIsleB = new SimplexNoise(s ^ 0xd6e7f809);
    this.nDome = new SimplexNoise(s ^ 0x1b2c3d4e);
    this.nKeel = new SimplexNoise(s ^ 0x5f607182);
    this.nFloor = new SimplexNoise(s ^ 0x93a4b5c6);
    this.nRough = new SimplexNoise(s ^ 0xd7e8f90a);
  }

  /** Climate fields of a column: f1 splits the tame biomes, f2 the extremes (needles one way, mist the other). */
  private fields(x: number, z: number): { f1: number; f2: number } {
    return { f1: this.nBiomeA.fbm2(x / 460, z / 460, 3), f2: this.nBiomeB.fbm2(x / 560 + 40, z / 560 - 15, 3) };
  }

  static biomeOf(f1: number, f2: number): Biome {
    if (f2 > 0.22) return Biome.SpireFields;
    if (f2 < -0.26) return Biome.MirrorFen;
    if (f1 < -0.2) return Biome.HushHollows;
    if (f1 < 0.2) return Biome.LumenShelves;
    return Biome.PrismThicket;
  }

  biomeAt(x: number, z: number): Biome {
    const { f1, f2 } = this.fields(x, z);
    return GloamTerrain.biomeOf(f1, f2);
  }

  column(x: number, z: number): GloamColumn {
    const key = (x + 40000) * 131072 + (z + 40000);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = this.compute(x, z);
    if (this.cache.size > 60000) this.cache.clear();
    this.cache.set(key, c);
    return c;
  }

  private compute(x: number, z: number): GloamColumn {
    const { f1, f2 } = this.fields(x, z);
    const biome = GloamTerrain.biomeOf(f1, f2);
    // The murk floor: gentle noise, lower (and misty) in the MirrorFen.
    const fn = this.nFloor.fbm2(x / 70, z / 70, 3);
    const mere = smooth(-0.1, -0.35, f2);
    const floor = Math.max(3, Math.round(8.5 + fn * 3.5 - mere * 3));
    const mist = Math.max(floor, mere > 0.5 ? GLOAM_MIST_TOP + 1 : GLOAM_MIST_TOP - 1);
    // Island coverage: needle reach has wide bold shelves, the mere few.
    const thr = biome === Biome.SpireFields ? 0.02 : biome === Biome.MirrorFen ? 0.3 : biome === Biome.HushHollows ? 0.1 : 0.06;
    const shelf = (n: SimplexNoise, level: number, ox: number): [number, number] => {
      const s = n.fbm2(x / 120 + ox, z / 120 - ox, 3);
      const u = s - thr;
      if (u <= 0.015) return [0, -1];
      const dome = this.nDome.fbm2(x / 40 + ox, z / 40, 2);
      const top = Math.round(level + dome * 2.2 + smooth(0, 0.3, u) * 3);
      const keel = this.nKeel.noise2(x / 7 + ox, z / 7) * 0.5 + 0.5;
      const thick = 2 + smooth(0.0, 0.5, u) * 13 + keel * smooth(0.04, 0.3, u) * 4;
      return [Math.round(top - thick), top];
    };
    const [aBot, aTop] = shelf(this.nIsleA, 25, 0);
    const [bBot, bTop] = shelf(this.nIsleB, 43, 71);
    // Needles: one per 36-block cell at most, rooted in the floor.
    let spire = 0;
    const cx = Math.floor(x / SPIRE_CELL);
    const cz = Math.floor(z / SPIRE_CELL);
    const h = hash4(cx, cz, this.seed, 0x5917);
    const dens = biome === Biome.SpireFields ? 0.85 : biome === Biome.MirrorFen ? 0.05 : 0.14;
    if ((h & 1023) / 1024 < dens) {
      const px = cx * SPIRE_CELL + 8 + ((h >>> 10) % 20);
      const pz = cz * SPIRE_CELL + 8 + ((h >>> 15) % 20);
      const r = 3 + ((h >>> 20) % 45) / 10;
      const height = 34 + ((h >>> 25) % 26);
      const d = Math.hypot(x - px, z - pz) + this.nRough.noise2(x / 3, z / 3) * 0.6;
      if (d < r) spire = Math.round(floor + (height - floor) * Math.pow(1 - d / r, 1.3));
      if (spire < floor + 3) spire = 0;
    }
    let top = floor;
    if (aTop >= 0) top = Math.max(top, aTop);
    if (bTop >= 0) top = Math.max(top, bTop);
    if (spire > 0) top = Math.max(top, spire);
    return { biome, floor, mist, aBot, aTop, bBot, bTop, spire, top: Math.min(TERRAIN_HEIGHT - 2, top) };
  }

  /** Top block, filler and filler depth of a surface in a biome. */
  private surface(biome: Biome, x: number, z: number, floorSurface: boolean): [number, number, number] {
    const patch = this.nRough.noise2(x / 18 + 9, z / 18) > 0.1;
    switch (biome) {
      case Biome.LumenShelves:
        return floorSurface ? [patch ? Block.Gloamsoil : Block.Murkstone, Block.Murkstone, 1] : [Block.Duskmoss, Block.Gloamsoil, 3];
      case Biome.PrismThicket:
        return floorSurface ? [Block.Gloamsoil, Block.Murkstone, 2] : [patch ? Block.Gloamsoil : Block.Duskmoss, Block.Gloamsoil, 3];
      case Biome.HushHollows:
        return floorSurface ? [patch ? Block.Shardsand : Block.Murkstone, Block.Murkstone, 1] : [Block.Shardsand, Block.Shardsand, 3];
      case Biome.MirrorFen:
        return floorSurface ? [Block.Gloamsoil, Block.Murkstone, 2] : [patch ? Block.Duskmoss : Block.Gloamsoil, Block.Gloamsoil, 3];
      default:
        return floorSurface ? [Block.Murkstone, Block.Murkstone, 0] : [patch ? Block.Duskmoss : Block.Gloamstone, Block.Gloamstone, 0];
    }
  }

  private ore(x: number, y: number, z: number, biome: Biome): boolean {
    const p = biome === Biome.HushHollows ? 0.012 : 0.003;
    return hashFloat(x, y, z, this.seed ^ 0x57a7) < p;
  }

  // ---- chunks -------------------------------------------------------------------------------

  /** Fills terrain (no structures) into a chunk array. `out` is cleared first. */
  generateChunk(cx: number, cz: number, out: Uint8Array = new Uint8Array(TERRAIN_VOLUME)): Uint8Array {
    out.fill(Block.Air);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) this.fillColumn(out, lx, lz, x0 + lx, z0 + lz);
    }
    this.features(cx, cz, out);
    return out;
  }

  private fillColumn(out: Uint8Array, lx: number, lz: number, wx: number, wz: number): void {
    const c = this.column(wx, wz);
    const put = (y: number, id: number) => {
      if (y >= 0 && y < TERRAIN_HEIGHT) out[blockIndex(lx, y, lz)] = id;
    };
    // Floor.
    out[blockIndex(lx, 0, lz)] = Block.Bedrock;
    const [ft, ff, fd] = this.surface(c.biome, wx, wz, true);
    for (let y = 1; y <= c.floor; y++) {
      const depth = c.floor - y;
      put(y, depth === 0 ? ft : depth <= fd ? ff : this.ore(wx, y, wz, c.biome) ? Block.StarfallOre : Block.Murkstone);
    }
    for (let y = c.floor + 1; y <= c.mist; y++) put(y, Block.GloamMist);
    // Shelves.
    const layer = (bot: number, top: number) => {
      if (top < 0) return;
      const [st, sf, sd] = this.surface(c.biome, wx, wz, false);
      const solid = c.biome === Biome.SpireFields ? Block.Gloamstone : Block.Gloamstone;
      for (let y = Math.max(1, bot); y <= top; y++) {
        const depth = top - y;
        put(y, depth === 0 ? st : depth <= sd ? sf : this.ore(wx, y, wz, c.biome) ? Block.StarfallOre : solid);
      }
      // Hanging vines under the keel.
      const vine = c.biome === Biome.PrismThicket ? 0.2 : c.biome === Biome.LumenShelves ? 0.08 : 0.025;
      if (bot > c.mist + 2 && hashFloat(wx, wz, this.seed, 0x71e) < vine) {
        const n = 1 + (hash4(wx, wz, this.seed, 0x71f) % 5);
        for (let k = 1; k <= n; k++) if (out[blockIndex(lx, bot - k, lz)] === Block.Air) put(bot - k, Block.Lumenvine);
      }
    };
    layer(c.aBot, c.aTop);
    layer(c.bBot, c.bTop);
    // Needle.
    if (c.spire > 0) {
      for (let y = c.floor + 1; y <= c.spire; y++) put(y, y > c.spire - 1 && y > 40 ? Block.Spirestone : Block.Spirestone);
    }
    // Ground cover on every open top (floor, shelf tops).
    this.plants(out, lx, lz, wx, wz, c);
  }

  /** Ground cover: tufts, bells, glimmer clusters; per column hashes. */
  private plants(out: Uint8Array, lx: number, lz: number, wx: number, wz: number, c: GloamColumn): void {
    if (c.spire > 0) return;
    const r = hashFloat(wx, wz, this.seed, 0x91a);
    const tops: [number, boolean][] = [];
    if (c.floor >= c.mist) tops.push([c.floor, true]);
    if (c.aTop >= 0 && out[blockIndex(lx, Math.min(c.aTop + 1, TERRAIN_HEIGHT - 1), lz)] === Block.Air) tops.push([c.aTop, false]);
    if (c.bTop >= 0 && out[blockIndex(lx, Math.min(c.bTop + 1, TERRAIN_HEIGHT - 1), lz)] === Block.Air) tops.push([c.bTop, false]);
    for (const [y, isFloor] of tops) {
      if (y + 1 >= TERRAIN_HEIGHT) continue;
      const below = out[blockIndex(lx, y, lz)];
      const grassy = below === Block.Duskmoss || below === Block.Gloamsoil;
      let id = 0;
      switch (c.biome) {
        case Biome.LumenShelves:
          if (!grassy) break;
          id = r < 0.24 ? Block.WispTuft : r < 0.27 ? Block.LumenBell : r < 0.277 ? Block.GlimmerCluster : 0;
          break;
        case Biome.PrismThicket:
          if (!grassy) break;
          id = r < 0.14 ? Block.WispTuft : r < 0.18 ? Block.GlimmerCluster : r < 0.2 ? Block.LumenBell : 0;
          break;
        case Biome.HushHollows:
          id = r < 0.006 ? Block.GlimmerCluster : 0;
          break;
        case Biome.MirrorFen:
          if (!grassy) break;
          id = r < 0.1 ? Block.WispTuft : r < 0.12 ? Block.LumenBell : 0;
          break;
        default:
          if (!grassy) break;
          id = r < 0.05 ? Block.WispTuft : r < 0.057 ? Block.LumenBell : 0;
      }
      if (id && !isFloor) out[blockIndex(lx, y + 1, lz)] = id;
      else if (id && out[blockIndex(lx, y + 1, lz)] === Block.Air) out[blockIndex(lx, y + 1, lz)] = id;
    }
  }

  // ---- features: gloamwood trees, crystal clusters, mistcaps, craters -----------------------------

  /** The surface a feature rooted at (x, z) stands on: layer and y, or null when there is nothing solid and open. */
  private root(x: number, z: number, c: GloamColumn, pick: number): { y: number; layer: Layer } | null {
    if (c.spire > 0) return null;
    const opts: { y: number; layer: Layer }[] = [];
    if (c.floor >= c.mist) opts.push({ y: c.floor, layer: 'floor' });
    if (c.aTop >= 0 && c.aTop > c.bBot - 1) opts.push({ y: c.aTop, layer: 'a' });
    if (c.bTop >= 0) opts.push({ y: c.bTop, layer: 'b' });
    // A shelf top is only open when no higher shelf sits right above it.
    const open = opts.filter((o) => (o.layer === 'a' ? !(c.bTop >= 0 && c.bBot <= o.y + 8) : true));
    if (!open.length) return null;
    return open[pick % open.length];
  }

  private features(cx: number, cz: number, out: Uint8Array): void {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const set: GloamSet = (x, y, z, id, onlyAir = true) => {
      const lx = x - x0;
      const lz = z - z0;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= TERRAIN_HEIGHT) return;
      const i = blockIndex(lx, y, lz);
      if (onlyAir && out[i] !== Block.Air && out[i] !== Block.GloamMist && out[i] !== Block.WispTuft && out[i] !== Block.LumenBell && out[i] !== Block.GlimmerCluster) return;
      out[i] = id;
    };
    for (let gz = Math.floor((z0 - FEATURE_REACH) / FEATURE_CELL); gz <= Math.floor((z0 + CHUNK_SIZE + FEATURE_REACH) / FEATURE_CELL); gz++) {
      for (let gx = Math.floor((x0 - FEATURE_REACH) / FEATURE_CELL); gx <= Math.floor((x0 + CHUNK_SIZE + FEATURE_REACH) / FEATURE_CELL); gx++) {
        const h = hash4(gx, gz, this.seed, 0xfea7);
        const x = gx * FEATURE_CELL + (h % FEATURE_CELL);
        const z = gz * FEATURE_CELL + ((h >>> 8) % FEATURE_CELL);
        const c = this.column(x, z);
        const kind = this.featureKind(c.biome, (h >>> 16) / 65536);
        if (kind === 0) continue;
        const root = this.root(x, z, c, h >>> 24);
        if (!root) continue;
        this.placeFeature(kind, x, root.y, z, h, c.biome, set);
      }
    }
  }

  /** 0 none, 1 gloamwood tree, 2 crystal cluster, 3 giant mistcap, 4 crater, 5 starfall monolith. */
  private featureKind(biome: Biome, r: number): number {
    switch (biome) {
      case Biome.LumenShelves:
        return r < 0.3 ? 1 : r < 0.34 ? 2 : 0;
      case Biome.PrismThicket:
        return r < 0.3 ? 2 : r < 0.46 ? 1 : 0;
      case Biome.HushHollows:
        return r < 0.1 ? 4 : r < 0.15 ? 5 : r < 0.19 ? 2 : 0;
      case Biome.MirrorFen:
        return r < 0.5 ? 3 : r < 0.56 ? 1 : 0;
      case Biome.SpireFields:
        return r < 0.06 ? 1 : r < 0.12 ? 2 : r < 0.15 ? 5 : 0;
      default:
        return 0;
    }
  }

  private placeFeature(kind: number, x: number, y: number, z: number, h: number, biome: Biome, set: GloamSet): void {
    const rnd = (n: number) => hashFloat(h, n, x, z);
    switch (kind) {
      case 1: {
        // Gloamwood: a slim bending trunk and a flat luminous crown with hanging vines.
        const height = 5 + Math.floor(rnd(1) * 5);
        const lean = rnd(2) < 0.5 ? 0 : rnd(3) < 0.5 ? 1 : -1;
        let tx = x;
        let tz = z;
        for (let k = 1; k <= height; k++) {
          if (k > 3 && lean !== 0 && k % 2 === 0) (rnd(4) < 0.5 ? (tx += lean) : (tz += lean));
          set(tx, y + k, tz, Block.GloamwoodLog);
        }
        const top = y + height;
        const R = 2.4 + rnd(5) * 1.2;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dx = -3; dx <= 3; dx++) {
              const d = Math.hypot(dx, dz) + Math.abs(dy) * 1.1;
              if (d > R || (dy === 1 && d > R - 1.1) || (dy === -1 && d > R - 0.7)) continue;
              set(tx + dx, top + dy, tz + dz, Block.GloamwoodLeaves);
            }
          }
        }
        for (let i = 0; i < 4; i++) {
          const vx = tx + Math.round((rnd(10 + i) - 0.5) * R * 1.5);
          const vz = tz + Math.round((rnd(20 + i) - 0.5) * R * 1.5);
          const n = 1 + Math.floor(rnd(30 + i) * 3);
          for (let k = 0; k < n; k++) set(vx, top - 2 - k, vz, Block.Lumenvine);
        }
        return;
      }
      case 2: {
        // A crystal cluster: one tall prism flanked by shorter ones.
        const n = 2 + Math.floor(rnd(1) * 3);
        for (let i = 0; i < n; i++) {
          const ox = i === 0 ? 0 : Math.round((rnd(10 + i) - 0.5) * 4);
          const oz = i === 0 ? 0 : Math.round((rnd(20 + i) - 0.5) * 4);
          const height = i === 0 ? 4 + Math.floor(rnd(2) * 5) : 2 + Math.floor(rnd(30 + i) * 3);
          for (let k = 1; k <= height; k++) set(x + ox, y + k, z + oz, Block.PrismCrystal);
          set(x + ox + 1, y + 1, z + oz, Block.GlimmerCluster);
        }
        return;
      }
      case 3: {
        // Giant mistcap: stem and a rounded cap.
        const height = 3 + Math.floor(rnd(1) * 6);
        const R = 2.5 + rnd(2) * 1.8;
        for (let k = 1; k <= height; k++) set(x, y + k, z, Block.MistcapStem);
        for (let dy = 0; dy <= 2; dy++) {
          for (let dz = -4; dz <= 4; dz++) {
            for (let dx = -4; dx <= 4; dx++) {
              const d = Math.hypot(dx, dz);
              const rr = dy === 0 ? R : dy === 1 ? R * 0.8 : R * 0.45;
              if (d > rr || (dx === 0 && dz === 0 && dy === 0)) continue;
              set(x + dx, y + height + dy, z + dz, Block.Mistcap);
            }
          }
        }
        return;
      }
      case 4: {
        // Fallen-star crater: a shallow pit, a rim and ore at its heart.
        const R = 3 + Math.floor(rnd(1) * 2);
        for (let dz = -R - 1; dz <= R + 1; dz++) {
          for (let dx = -R - 1; dx <= R + 1; dx++) {
            const d = Math.hypot(dx, dz);
            if (d <= R) {
              const depth = Math.round((1 - d / R) * 2.5);
              for (let k = 0; k < depth; k++) set(x + dx, y - k, z + dz, Block.Air, false);
              if (depth >= 2) set(x + dx, y - depth + 1, z + dz, d < 1.2 ? Block.StarfallOre : Block.Shardsand, false);
            } else if (d <= R + 1.3 && rnd(5 + dx * 7 + dz * 13) < 0.5) set(x + dx, y + 1, z + dz, Block.Gloamstone);
          }
        }
        return;
      }
      case 5: {
        // Starfall monolith: a leaning needle of ore-streaked stone.
        const height = 3 + Math.floor(rnd(1) * 4);
        for (let k = 1; k <= height; k++) {
          set(x, y + k, z, rnd(k) < 0.35 ? Block.StarfallOre : Block.Gloamstone);
          if (k <= 2) set(x + 1, y + k, z, Block.Gloamstone);
        }
        set(x, y + height + 1, z, Block.StarfallBlock);
        return;
      }
    }
    void biome;
  }
}
