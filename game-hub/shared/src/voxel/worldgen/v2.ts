/**
 * Terrain generator version 2: 18 biomes chosen from temperature, humidity and
 * variant noise plus continent and mountain masks, terrain shape blended across
 * biome borders, rock layers, ores, lava caves, 6 tree species, plants, snow,
 * and rare boss structures (structures/*.ts). Deterministic per seed and
 * independent of chunk order, like v1 (design-voxel-world §6).
 */
import { SimplexNoise } from '../../util/noise';
import { hash4, hashFloat, mulberry32 } from '../../util/rng';
import { Block } from '../blocks';
import { blockIndex } from '../chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL } from '../constants';
import { buildStructure, computeStructures, type PlacedStructure } from '../structures/place';
import type { StructureInfo } from '../structures/types';
import type { StructureVolume } from '../structures/volume';
import { Biome, CLIMATE_TABLE, hClass, PLANT_TABLE, SHAPE_PARAM_COUNT, SHAPE_PARAMS, tClass, TREE_TABLE, TreeSpecies } from './biomes';
import { placeOres, placeRockPockets } from './ores';
import { placeTree, TREE_REACH, treeHeight } from './trees';

const SEA = SEA_LEVEL;
const MAX_TERRAIN = 54;
/** Carved cells at or below this become lava. */
export const LAVA_LEVEL = 5;
const TREE_CELL = 4;
const GRID = 4;
const CACHE_LIMIT = 65536;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const gridKey = (gx: number, gz: number) => (gx + 32768) * 65536 + (gz + 32768);

export interface ColumnV2 {
  /** Top solid y of the generated terrain (before caves, trees and structures). */
  height: number;
  biome: Biome;
  /** Biome from climate alone (before the ocean / shore / peak overrides). */
  land: Biome;
  tClass: number;
  mask: number;
}

/** Red-rock clay bands, by (y + shift) & 15. */
const BANDS: readonly Block[] = [
  Block.RustClay, Block.RustClay, Block.CreamClay, Block.OchreClay, Block.OchreClay, Block.UmberClay, Block.RedSandstone, Block.OchreClay,
  Block.CreamClay, Block.RustClay, Block.UmberClay, Block.UmberClay, Block.OchreClay, Block.CreamClay, Block.RedSandstone, Block.RustClay,
];

const GRASSY = new Set<number>([Block.Grass, Block.Dirt, Block.ForestFloor, Block.ParchedGrass, Block.Mud, Block.SnowyGrass]);
const TREE_SOIL = GRASSY;
const SPAWN_BIOMES = new Set<Biome>([Biome.Plains, Biome.Forest, Biome.AspenGrove, Biome.Savanna, Biome.Pinewood]);
const NO_SPAWN = new Set<Biome>([Biome.Ocean, Biome.IcySea, Biome.Beach, Biome.FrozenShore, Biome.GlacierPeaks, Biome.Marshland]);

export interface TreeV2 {
  x: number;
  /** First trunk block (ground + 1). */
  y: number;
  z: number;
  species: TreeSpecies;
  hsh: number;
}

/** What a column's top looks like: top block, then filler layers. */
interface Surface {
  top: Block;
  filler: Block;
  fillerDepth: number;
  filler2: Block;
  filler2Depth: number;
  /** Red-rock bands instead of filler, down to height - 12. */
  bands: boolean;
}

export class TerrainGeneratorV2 {
  readonly seed: number;
  private readonly nCont: SimplexNoise;
  private readonly nMount: SimplexNoise;
  private readonly nRidge: SimplexNoise;
  private readonly nHills: SimplexNoise;
  private readonly nTemp: SimplexNoise;
  private readonly nHum: SimplexNoise;
  private readonly nVar: SimplexNoise;
  private readonly nJit: SimplexNoise;
  private readonly nDetail: SimplexNoise;
  private readonly nSurf: SimplexNoise;
  private readonly caves: SimplexNoise;
  private readonly nCavern: SimplexNoise;
  /** Land biome per 4-block grid point. */
  private readonly rawLand = new Map<number, Biome>();
  /** 5x5-blurred shape parameters per grid point. */
  private readonly blurred = new Map<number, Float32Array>();
  private spawn: { x: number; y: number; z: number } | null = null;
  private placed: PlacedStructure[] | null = null;
  /** Built structure volumes, least recently used first (at most 4). */
  private readonly volumes = new Map<number, StructureVolume[]>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.nCont = new SimplexNoise(s ^ 0x13579bdf);
    this.nMount = new SimplexNoise(s ^ 0x0badf00d);
    this.nRidge = new SimplexNoise(s ^ 0x77777777);
    this.nHills = new SimplexNoise(s ^ 0x31415926);
    this.nTemp = new SimplexNoise(s ^ 0x1a2b3c4d);
    this.nHum = new SimplexNoise(s ^ 0x5e6f7081);
    this.nVar = new SimplexNoise(s ^ 0x2468ace0);
    this.nJit = new SimplexNoise(s ^ 0x27182818);
    this.nDetail = new SimplexNoise(s ^ 0x6a09e667);
    this.nSurf = new SimplexNoise(s ^ 0xbb67ae85);
    this.caves = new SimplexNoise(s ^ 0xc2b2ae35);
    this.nCavern = new SimplexNoise(s ^ 0x85ebca6b);
  }

  // ---- climate and terrain -----------------------------------------------------------------

  /** Continent, mountain and ridge values at a point (shared by the climate lapse and the height). */
  private relief(x: number, z: number): { c: number; mask: number; ridge: number } {
    const c = this.nCont.fbm2(x / 240, z / 240, 3);
    const mask = smoothstep(0.15, 0.45, this.nMount.fbm2(x / 260, z / 260, 3));
    const r = 1 - Math.abs(this.nRidge.noise2(x / 120, z / 120));
    return { c, mask, ridge: r * r * r };
  }

  /** Land biome and temperature class from the climate at a point. */
  private climate(x: number, z: number, c: number, mask: number, ridge: number): { land: Biome; tc: number } {
    const jT = this.nJit.noise2(x / 24, z / 24) * 0.05;
    const jH = this.nJit.noise2(x / 24 + 100, z / 24 - 50) * 0.05;
    const T = this.nTemp.fbm2(x / 200, z / 200, 2) + jT;
    const H = this.nHum.fbm2(x / 170, z / 170, 2) + jH;
    const W = this.nVar.fbm2(x / 150, z / 150, 2);
    const h0 = SEA + 4 + c * 16 + mask * (ridge * 28 + 6);
    const tc = tClass(T - Math.max(0, h0 - SEA - 16) / 40);
    const hc = hClass(H);
    const alt = W > (tc === 4 && hc <= 1 ? 0 : 0.2);
    return { land: CLIMATE_TABLE[tc][hc][alt ? 1 : 0], tc };
  }

  private rawAt(gx: number, gz: number): Biome {
    const key = gridKey(gx, gz);
    let b = this.rawLand.get(key);
    if (b === undefined) {
      const x = gx * GRID;
      const z = gz * GRID;
      const r = this.relief(x, z);
      b = this.climate(x, z, r.c, r.mask, r.ridge).land;
      if (this.rawLand.size >= CACHE_LIMIT) this.rawLand.clear();
      this.rawLand.set(key, b);
    }
    return b;
  }

  private blurredAt(gx: number, gz: number): Float32Array {
    const key = gridKey(gx, gz);
    let p = this.blurred.get(key);
    if (!p) {
      p = new Float32Array(SHAPE_PARAM_COUNT);
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const params = SHAPE_PARAMS[this.rawAt(gx + dx, gz + dz)]!;
          for (let i = 0; i < SHAPE_PARAM_COUNT; i++) p[i] += params[i] / 25;
        }
      }
      if (this.blurred.size >= CACHE_LIMIT) this.blurred.clear();
      this.blurred.set(key, p);
    }
    return p;
  }

  private readonly params = new Float32Array(SHAPE_PARAM_COUNT);
  /** Shape parameters at a column: bilinear between blurred grid points. */
  private shapeAt(x: number, z: number): Float32Array {
    const gx = Math.floor(x / GRID);
    const gz = Math.floor(z / GRID);
    const fx = (x - gx * GRID) / GRID;
    const fz = (z - gz * GRID) / GRID;
    const a = this.blurredAt(gx, gz), b = this.blurredAt(gx + 1, gz), c = this.blurredAt(gx, gz + 1), d = this.blurredAt(gx + 1, gz + 1);
    for (let i = 0; i < SHAPE_PARAM_COUNT; i++) this.params[i] = lerp(lerp(a[i], b[i], fx), lerp(c[i], d[i], fx), fz);
    return this.params;
  }

  /** Surface height and biome of a world column. */
  column(x: number, z: number): ColumnV2 {
    const { c, mask, ridge } = this.relief(x, z);
    const { land, tc } = this.climate(x, z, c, mask, ridge);
    const P = this.shapeAt(x, z);
    const hills = this.nHills.fbm2(x / 64, z / 64, 4);
    let h = SEA + 4 + c * 16 + P[0] + hills * P[1] + mask * (ridge * 28 + 6);
    if (P[4] > 0) h += P[4] * Math.abs(this.nDetail.noise2(x / 22, z / 36)) * 3;
    if (P[2] > 0) h = lerp(h, SEA + 0.6 + hills * 1.5, P[2]);
    if (P[3] > 0 && h > SEA + 3) {
      const s = (h - SEA - 3) / 4;
      const f = Math.floor(s);
      h = lerp(h, SEA + 3 + (f + smoothstep(0.75, 1, s - f)) * 4, P[3]);
    }
    const height = Math.max(4, Math.min(MAX_TERRAIN, Math.floor(h)));
    let biome: Biome;
    if (height < SEA && (land !== Biome.Marshland || height < SEA - 2)) biome = tc === 0 ? Biome.IcySea : Biome.Ocean;
    else if (height <= SEA + 1 && land !== Biome.Marshland && land !== Biome.Redrock) biome = tc === 0 ? Biome.FrozenShore : Biome.Beach;
    else if (height >= SEA + 27) biome = Biome.GlacierPeaks;
    else if (height >= SEA + 19 && mask > 0.3) biome = tc === 0 ? Biome.GlacierPeaks : Biome.Mountains;
    else biome = land;
    return { height, biome, land, tClass: tc, mask };
  }

  private surface(x: number, z: number, col: ColumnV2): Surface {
    const s: Surface = { top: Block.Grass, filler: Block.Dirt, fillerDepth: 3, filler2: Block.Stone, filler2Depth: 0, bands: false };
    const surf = () => this.nSurf.noise2(x / 12, z / 12);
    if (col.height < SEA) {
      if (col.biome === Biome.Marshland) {
        s.top = s.filler = Block.Mud;
        s.fillerDepth = 2;
        return s;
      }
      const floor = this.nDetail.noise2(x / 24, z / 24);
      s.top = floor > 0.35 ? Block.Clay : floor < -0.35 ? Block.Gravel : Block.Sand;
      s.filler = s.top === Block.Clay ? Block.Clay : Block.Sand;
      return s;
    }
    switch (col.biome) {
      case Biome.Duskwood:
        if (surf() > -0.2) s.top = Block.ForestFloor;
        break;
      case Biome.Pinewood:
        if (surf() > 0.1) s.top = Block.ForestFloor;
        break;
      case Biome.Snow:
      case Biome.Frostpine:
        s.top = Block.SnowyGrass;
        break;
      case Biome.Savanna:
        s.top = hashFloat(x, z, this.seed, 4) < 0.1 ? Block.Dirt : Block.ParchedGrass;
        break;
      case Biome.Desert:
        s.top = s.filler = Block.Sand;
        s.fillerDepth = 4;
        s.filler2 = Block.Sandstone;
        s.filler2Depth = 4;
        break;
      case Biome.Redrock:
        s.top = Block.RedSand;
        s.bands = true;
        break;
      case Biome.Marshland:
        if (surf() > 0.25) {
          s.top = s.filler = Block.Mud;
          s.fillerDepth = 2;
        }
        break;
      case Biome.Mountains: {
        const d = hashFloat(x, z, this.seed, 3);
        s.top = d < 0.45 ? Block.Stone : d < 0.55 ? Block.Gravel : Block.Grass;
        if (s.top !== Block.Grass) s.filler = Block.Stone;
        break;
      }
      case Biome.GlacierPeaks:
        s.top = surf() > 0.45 ? Block.PackedIce : Block.Snow;
        s.filler = Block.Stone;
        break;
      case Biome.Beach:
        s.top = s.filler = Block.Sand;
        s.filler2 = Block.Sandstone;
        s.filler2Depth = 2;
        break;
      case Biome.FrozenShore:
        s.top = s.filler = Block.Sand;
        break;
    }
    return s;
  }

  /** Top block of a column as generated (before caves turn grass into dirt). */
  topBlock(x: number, z: number, col = this.column(x, z)): Block {
    return this.surface(x, z, col).top;
  }

  private isCave(x: number, y: number, z: number): boolean {
    const a = this.caves.noise3(x / 28, y / 18, z / 28);
    const b = this.caves.noise3(x / 28 + 71.3, y / 18 - 13.1, z / 28 + 37.7);
    if (a * a + b * b < 0.014) return true;
    if (y < 18) {
      const c = this.nCavern.noise3(x / 50, y / 22, z / 50);
      if (c > 0.6) return true;
    }
    return false;
  }

  // ---- plants and trees -----------------------------------------------------------------------

  /** Ground cover a column gets on top (0 = none), ignoring structures. */
  plantAt(x: number, z: number, col: ColumnV2, top: Block): Block {
    if (col.height < SEA || col.height + 1 > 62) return Block.Air;
    const table = PLANT_TABLE[col.biome];
    if (!table) return Block.Air;
    let r = hashFloat(x, z, this.seed, 13);
    for (const [block, p] of table) {
      if (r < p) return this.plantFits(x, z, block, top) ? block : Block.Air;
      r -= p;
    }
    return Block.Air;
  }

  private plantFits(x: number, z: number, block: Block, top: Block): boolean {
    if (block === Block.DeadBush || block === Block.Cactus) return top === Block.Sand || top === Block.RedSand;
    if (block === Block.Reeds) {
      if (top !== Block.Grass && top !== Block.Dirt && top !== Block.Sand && top !== Block.Mud) return false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.column(x + dx, z + dz).height < SEA) return true;
      return false;
    }
    if (top === Block.Stone || top === Block.Gravel) return false;
    return GRASSY.has(top);
  }

  /** The tree rooted in a jittered 4x4 grid cell, if any. `structures` false skips the footprint check (spawn search). */
  treeInCell(cellX: number, cellZ: number, structures = true): TreeV2 | null {
    const density = hashFloat(cellX, cellZ, this.seed, 11);
    if (density >= 0.85) return null; // above every biome's density: skip the column lookup
    const hsh = hash4(cellX, cellZ, this.seed, 7);
    const tx = cellX * TREE_CELL + (hsh % TREE_CELL);
    const tz = cellZ * TREE_CELL + ((hsh >>> 8) % TREE_CELL);
    const col = this.column(tx, tz);
    const table = TREE_TABLE[col.biome];
    if (!table || density >= table.density) return null;
    const h = col.height;
    if (col.biome === Biome.Marshland ? h < SEA : h <= SEA + 1) return null;
    const species = table.pick(hashFloat(cellX, cellZ, this.seed, 12));
    if (h + treeHeight(species, hsh) + 4 >= 63) return null;
    if (!TREE_SOIL.has(this.topBlock(tx, tz, col))) return null;
    if (structures && this.nearStructure(tx, tz, 3)) return null;
    return { x: tx, y: h + 1, z: tz, species, hsh };
  }

  private nearTree(x: number, z: number, r: number): boolean {
    for (let cz = Math.floor((z - r) / TREE_CELL); cz <= Math.floor((z + r) / TREE_CELL); cz++) {
      for (let cx = Math.floor((x - r) / TREE_CELL); cx <= Math.floor((x + r) / TREE_CELL); cx++) {
        const t = this.treeInCell(cx, cz, false);
        if (t && Math.abs(t.x - x) <= r && Math.abs(t.z - z) <= r) return true;
      }
    }
    return false;
  }

  // ---- spawn and structures --------------------------------------------------------------------

  /** A dry, open spawn near the origin, in a pleasant biome when there is one. Memoized. */
  findSpawn(): { x: number; y: number; z: number } {
    if (this.spawn) return { ...this.spawn };
    const ok = (x: number, z: number, preferred: boolean) => {
      const c = this.column(x, z);
      if (c.height <= SEA + 1 || c.height >= SEA + 18) return false;
      if (preferred ? !SPAWN_BIOMES.has(c.biome) : NO_SPAWN.has(c.biome)) return false;
      if (this.plantAt(x, z, c, this.topBlock(x, z, c)) !== Block.Air) return false;
      // No snow layer at the feet either.
      const snow = c.biome === Biome.Snow ? 0.6 : c.biome === Biome.Frostpine ? 0.75 : 0;
      return !(snow && hashFloat(x, z, this.seed, 21) < snow);
    };
    for (const preferred of [true, false]) {
      for (let r = 0; r < 200; r += 2) {
        const n = Math.max(1, r * 4);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = Math.round(Math.cos(a) * r);
          const z = Math.round(Math.sin(a) * r);
          if (ok(x, z, preferred) && !this.nearTree(x, z, 3)) {
            this.spawn = { x: x + 0.5, y: this.column(x, z).height + 1, z: z + 0.5 };
            return { ...this.spawn };
          }
        }
      }
    }
    this.spawn = { x: 0.5, y: 60, z: 0.5 };
    return { ...this.spawn };
  }

  private placedStructures(): PlacedStructure[] {
    return (this.placed ??= computeStructures(this, this.seed));
  }

  /** Every boss structure of the world (6..16, deterministic). */
  structures(): StructureInfo[] {
    return this.placedStructures().map((p) => p.info);
  }

  /** True when (x, z) is within `margin` of a structure's footprint. */
  nearStructure(x: number, z: number, margin: number): boolean {
    for (const p of this.placedStructures()) {
      const b = p.info.bounds;
      if (x >= b.x0 - margin && x < b.x1 + margin && z >= b.z0 - margin && z < b.z1 + margin) return true;
    }
    return false;
  }

  private volumesFor(p: PlacedStructure): StructureVolume[] {
    let v = this.volumes.get(p.info.id);
    if (v) {
      this.volumes.delete(p.info.id);
    } else {
      v = buildStructure(p, this.seed).volumes;
      if (this.volumes.size >= 4) this.volumes.delete(this.volumes.keys().next().value as number);
    }
    this.volumes.set(p.info.id, v);
    return v;
  }

  // ---- chunks ----------------------------------------------------------------------------------

  /** Fills a 16x64x16 chunk. Reuses `out` if provided. */
  generateChunk(cx: number, cz: number, out: Uint8Array = new Uint8Array(CHUNK_VOLUME)): Uint8Array {
    out.fill(Block.Air);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const cols: ColumnV2[] = [];
    const tops: Block[] = [];
    const structures = this.placedStructures();
    const nearAny = structures.some((p) => {
      const b = p.info.bounds;
      return b.x0 - 3 < x0 + CHUNK_SIZE && b.x1 + 3 > x0 && b.z0 - 3 < z0 + CHUNK_SIZE && b.z1 + 3 > z0;
    });

    // 1-2. Columns: rock, layers, surface, water; caves, lava and the grass fix.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = x0 + lx;
        const wz = z0 + lz;
        const col = this.column(wx, wz);
        cols.push(col);
        const h = col.height;
        const s = this.surface(wx, wz, col);
        tops.push(s.top);
        const bedrock1 = hashFloat(wx, wz, this.seed, 3) < 0.5;
        const slateTop = 8 + (hash4(wx, wz, this.seed, 5) & 1) + (this.nDetail.noise2(wx / 32, wz / 32) > 0 ? 1 : 0);
        const shift = s.bands ? Math.floor(this.nDetail.noise2(wx / 60, wz / 60) * 2.5) : 0;
        for (let y = 0; y <= h; y++) {
          let b: Block;
          if (y === 0 || (y === 1 && bedrock1)) b = Block.Bedrock;
          else if (y === h) b = s.top;
          else if (s.bands && y >= h - 12) b = BANDS[(((y + shift) % 16) + 16) % 16];
          else if (y >= h - s.fillerDepth) b = s.filler;
          else if (y >= h - s.fillerDepth - s.filler2Depth) b = s.filler2;
          else b = y <= slateTop ? Block.Slate : Block.Stone;
          out[blockIndex(lx, y, lz)] = b;
        }
        for (let y = h + 1; y <= SEA; y++) out[blockIndex(lx, y, lz)] = y === SEA && col.biome === Biome.IcySea ? Block.Ice : Block.Water;
        const carveTop = h < SEA || h <= SEA + 2 ? h - 4 : h - 1;
        for (let y = 2; y <= carveTop; y++) {
          if (this.isCave(wx, y, wz)) out[blockIndex(lx, y, lz)] = y <= LAVA_LEVEL ? Block.Lava : Block.Air;
        }
        // A cave that opened under the surface leaves dirt, not grass, on top.
        const ti = blockIndex(lx, h, lz);
        if (h > 1 && out[blockIndex(lx, h - 1, lz)] === Block.Air && (s.top === Block.Grass || s.top === Block.ParchedGrass || s.top === Block.ForestFloor || s.top === Block.SnowyGrass)) {
          out[ti] = Block.Dirt;
        }
      }
    }

    // 3. Rock pockets, then ores (only into stone that survived carving).
    placeRockPockets(cx, cz, this.seed, out);
    placeOres(cx, cz, this.seed, out, (vx, vz) => this.column(vx * CHUNK_SIZE + 8, vz * CHUNK_SIZE + 8).biome === Biome.Redrock);

    // 4. Plants, snow, lily pads.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = cols[lz * CHUNK_SIZE + lx];
        const wx = x0 + lx;
        const wz = z0 + lz;
        const h = col.height;
        if (nearAny && this.nearStructure(wx, wz, 2)) continue;
        if (col.biome === Biome.Marshland && h < SEA) {
          if (hashFloat(wx, wz, this.seed, 15) < 0.1 && out[blockIndex(lx, SEA + 1, lz)] === Block.Air) out[blockIndex(lx, SEA + 1, lz)] = Block.LilyPad;
          continue;
        }
        if (h + 1 > 62 || out[blockIndex(lx, h + 1, lz)] !== Block.Air) continue;
        const top = out[blockIndex(lx, h, lz)];
        const plant = this.plantAt(wx, wz, col, top);
        if (plant !== Block.Air) {
          const stack = plant === Block.Cactus || plant === Block.Reeds ? 1 + (hash4(wx, wz, this.seed, 14) % 3) : 1;
          for (let k = 1; k <= stack && h + k <= 62; k++) out[blockIndex(lx, h + k, lz)] = plant;
          continue;
        }
        const snow = col.biome === Biome.Snow ? 0.6 : col.biome === Biome.Frostpine ? 0.75 : col.biome === Biome.FrozenShore ? 0.5 : 0;
        if (snow && hashFloat(wx, wz, this.seed, 21) < snow && (top === Block.SnowyGrass || top === Block.Sand || top === Block.Dirt)) out[blockIndex(lx, h + 1, lz)] = Block.SnowLayer;
      }
    }

    // Pinewood boulders and Icy Sea icebergs (inside the chunk).
    const mid = cols[8 * CHUNK_SIZE + 8];
    if (mid.biome === Biome.Pinewood && hashFloat(cx, cz, this.seed, 31) < 0.25) {
      const rng = mulberry32(hash4(cx, cz, this.seed, 33));
      const bx = 3 + Math.floor(rng() * 10);
      const bz = 3 + Math.floor(rng() * 10);
      const by = cols[bz * CHUNK_SIZE + bx].height + 0.5;
      if (!(nearAny && this.nearStructure(x0 + bx, z0 + bz, 4))) {
        for (let y = Math.floor(by - 2); y <= Math.ceil(by + 2); y++) {
          for (let z = bz - 2; z <= bz + 2; z++) {
            for (let x = bx - 2; x <= bx + 2; x++) {
              if (y < 1 || y > 62 || (x + 0.5 - bx - 0.5) ** 2 + (y + 0.5 - by) ** 2 + (z + 0.5 - bz - 0.5) ** 2 > 1.6 * 1.6) continue;
              out[blockIndex(x, y, z)] = rng() < 0.6 ? Block.MossyCobble : Block.Cobble;
            }
          }
        }
      }
    }
    if (mid.biome === Biome.IcySea && hashFloat(cx, cz, this.seed, 32) < 0.2) {
      const rng = mulberry32(hash4(cx, cz, this.seed, 34));
      const bx = 3 + Math.floor(rng() * 10);
      const bz = 3 + Math.floor(rng() * 10);
      for (let z = bz - 2; z <= bz + 2; z++) {
        for (let x = bx - 2; x <= bx + 2; x++) {
          const d = Math.hypot(x - bx, z - bz);
          if (d > 2) continue;
          for (let y = SEA - 2; y <= SEA + 1 + Math.round(2 - d); y++) out[blockIndex(x, y, z)] = Block.PackedIce;
        }
      }
    }

    // 5. Trees (cross-border, clipped to this chunk).
    const set = (wx: number, y: number, wz: number, b: Block, onlyAir: boolean): boolean => {
      const lx = wx - x0;
      const lz = wz - z0;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= CHUNK_HEIGHT) return false;
      const i = blockIndex(lx, y, lz);
      if (onlyAir && out[i] !== Block.Air) return false;
      out[i] = b;
      return true;
    };
    for (let cellZ = Math.floor((z0 - TREE_REACH) / TREE_CELL); cellZ <= Math.floor((z0 + CHUNK_SIZE + TREE_REACH) / TREE_CELL); cellZ++) {
      for (let cellX = Math.floor((x0 - TREE_REACH) / TREE_CELL); cellX <= Math.floor((x0 + CHUNK_SIZE + TREE_REACH) / TREE_CELL); cellX++) {
        const t = this.treeInCell(cellX, cellZ);
        if (!t) continue;
        const lx = t.x - x0;
        const lz = t.z - z0;
        if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
          const gi = blockIndex(lx, t.y - 1, lz);
          if (out[gi] === Block.Grass || out[gi] === Block.SnowyGrass || out[gi] === Block.ParchedGrass) out[gi] = Block.Dirt;
        }
        placeTree(t.species, t.x, t.y, t.z, t.hsh, this.seed, set);
      }
    }

    // 6. Structure pieces.
    if (nearAny) {
      for (const p of structures) {
        const b = p.info.bounds;
        if (b.x0 - 1 >= x0 + CHUNK_SIZE || b.x1 + 1 <= x0 || b.z0 - 1 >= z0 + CHUNK_SIZE || b.z1 + 1 <= z0) continue;
        for (const v of this.volumesFor(p)) v.copyIntoChunk(cx, cz, out);
      }
    }
    return out;
  }
}
