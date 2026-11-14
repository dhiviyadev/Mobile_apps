/**
 * Terrain generator version 3: generator 2's biomes, blocks, trees and
 * structures, but
 * - biomes, oceans and mountain ranges about 3x larger in each direction
 *   (climate, continent and mountain noise scaled; a wider biome-blend grid);
 * - endless: x, z in [-ENDLESS_LIMIT, ENDLESS_LIMIT) (what i16 edits can
 *   address); the land sinks into a deep sea over the last 96 blocks and a
 *   bedrock rim closes the world;
 * - structures placed lazily per 256-block region (LazyStructures);
 * - real cave systems: winding walkable tunnels (two networks), caverns at
 *   mid and low depth, ravines and shafts that open on dry land, and tunnel
 *   mouths on hillsides. Cave noise is sampled on a 4-block lattice per chunk
 *   and interpolated, so caves cost little generation time.
 * Deterministic per seed and independent of chunk order, like v1 and v2.
 */
import { SimplexNoise } from '../../util/noise';
import { hash4, hashFloat } from '../../util/rng';
import { Block } from '../blocks';
import { blockIndex } from '../chunk';
import { CHUNK_SIZE, ENDLESS_LIMIT, SEA_LEVEL, TERRAIN_HEIGHT, TERRAIN_VOLUME } from '../constants';
import { LazyStructures, type LazyOptions, type PlacedStructure } from '../structures/place';
import type { StructureInfo } from '../structures/types';
import { Biome, CLIMATE_TABLE, hClass, tClass } from './biomes';
import { type ColumnV2, LAVA_LEVEL, TerrainGeneratorV2, type TreeV2 } from './v2';

const SEA = SEA_LEVEL;
const MAX_TERRAIN = 54;
/** Biome-blend grid spacing (v2: 4). */
const GRID3 = 12;
/** The land sinks to a deep sea over this many blocks before the edge. */
const EDGE_FADE = 96;
/** Columns this close to the edge are a bedrock wall. */
const RIM = 2;

/** Cave lattice: one sample every LAT blocks, a chunk needs (16/4+1)^2 x (64/4+1). */
const LAT = 4;
const LN = CHUNK_SIZE / LAT + 1;
const LY = TERRAIN_HEIGHT / LAT + 1;
const LATTICE = LN * LN * LY;
/** Height cache around a chunk for the coast and opening checks. */
const PAD = 6;
const HSIDE = CHUNK_SIZE + PAD * 2;

/** Tunnel tube size in noise space (squared radius), widened by the width field. */
const TUNNEL_R = 0.022;
/** Tunnel network noise scales (horizontal, vertical). */
const TUN1_XZ = 64;
const TUN1_Y = 40;
const TUN2_XZ = 48;
const TUN2_Y = 32;
/** Shaft cells: one shaft per cell at most. */
const SHAFT_CELL = 64;
const SHAFT_CHANCE = 0.28;
/** No cave openings this close (blocks) to the spawn point. */
const SPAWN_CLEAR = 24;
/** Mouth-zone threshold: where tunnels may break the surface. */
const MOUTH = 0.7;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Distance in blocks from (x, z) to the world edge (negative outside). */
export function edgeDistance(x: number, z: number): number {
  return Math.min(x + ENDLESS_LIMIT, ENDLESS_LIMIT - 1 - x, z + ENDLESS_LIMIT, ENDLESS_LIMIT - 1 - z);
}

export class TerrainGeneratorV3 extends TerrainGeneratorV2 {
  protected override readonly grid: number = GRID3;
  private readonly lazy: LazyStructures;
  // Caves.
  private readonly nTunA: SimplexNoise;
  private readonly nTunB: SimplexNoise;
  private readonly nTunC: SimplexNoise;
  private readonly nTunD: SimplexNoise;
  private readonly nWidth: SimplexNoise;
  private readonly nRoom: SimplexNoise;
  private readonly nRoomDetail: SimplexNoise;
  private readonly nRavine: SimplexNoise;
  private readonly nMouth: SimplexNoise;
  /** Per-chunk cave fields on the lattice: two sheet pairs per tunnel network, tube width, caverns. */
  private readonly fA = new Float32Array(LATTICE);
  private readonly fB = new Float32Array(LATTICE);
  private readonly fC = new Float32Array(LATTICE);
  private readonly fD = new Float32Array(LATTICE);
  private readonly fW = new Float32Array(LATTICE);
  private readonly fRoom = new Float32Array(LATTICE);
  /** Terrain heights around the chunk being generated (-1 = not yet known). */
  private readonly heights = new Int16Array(HSIDE * HSIDE);
  private chunkX0 = 0;
  private chunkZ0 = 0;
  private chunkStructs: PlacedStructure[] = [];
  private chunkStructsKey = '';
  private readonly boxScratch: PlacedStructure[] = [];

  constructor(seed: number) {
    super(seed);
    const s = this.seed;
    this.nTunA = new SimplexNoise(s ^ 0x3c6ef372);
    this.nTunB = new SimplexNoise(s ^ 0xa54ff53a);
    this.nTunC = new SimplexNoise(s ^ 0x510e527f);
    this.nTunD = new SimplexNoise(s ^ 0x9b05688c);
    this.nWidth = new SimplexNoise(s ^ 0x1f83d9ab);
    this.nRoom = new SimplexNoise(s ^ 0x5be0cd19);
    this.nRoomDetail = new SimplexNoise(s ^ 0xcbbb9d5d);
    this.nRavine = new SimplexNoise(s ^ 0x629a292a);
    this.nMouth = new SimplexNoise(s ^ 0x9159015a);
    this.lazy = new LazyStructures(this, this.seed, ENDLESS_LIMIT, 128, this.structureOptions());
  }

  /** Which structures this generator places (v3: set 1, the whole world). Generator 4 limits them to the overworld. */
  protected structureOptions(): LazyOptions {
    return {};
  }

  /** Distance in blocks to the world edge (negative outside): the sea fade and the bedrock rim follow it. Generator 4 moves the east edge. */
  protected edge(x: number, z: number): number {
    return edgeDistance(x, z);
  }

  // ---- climate and terrain (3x larger) -------------------------------------------------------

  protected override relief(x: number, z: number): { c: number; mask: number; ridge: number } {
    const c = this.nCont.fbm2(x / 720, z / 720, 4);
    const mask = smoothstep(0.15, 0.45, this.nMount.fbm2(x / 780, z / 780, 4));
    const r = 1 - Math.abs(this.nRidge.noise2(x / 220, z / 220));
    return { c, mask, ridge: r * r * r };
  }

  protected override climate(x: number, z: number, c: number, mask: number, ridge: number): { land: Biome; tc: number } {
    // Wide wobble plus a little fine wobble so borders are not too smooth.
    const jT = this.nJit.noise2(x / 72, z / 72) * 0.05 + this.nJit.noise2(x / 20 + 300, z / 20 - 170) * 0.02;
    const jH = this.nJit.noise2(x / 72 + 100, z / 72 - 50) * 0.05 + this.nJit.noise2(x / 20 - 230, z / 20 + 90) * 0.02;
    const T = this.nTemp.fbm2(x / 660, z / 660, 3) + jT;
    const H = this.nHum.fbm2(x / 560, z / 560, 3) + jH;
    const W = this.nVar.fbm2(x / 500, z / 500, 2);
    const h0 = SEA + 4 + c * 16 + mask * (ridge * 28 + 6);
    const tc = tClass(T - Math.max(0, h0 - SEA - 16) / 40);
    const hc = hClass(H);
    const alt = W > (tc === 4 && hc <= 1 ? 0 : 0.2);
    return { land: CLIMATE_TABLE[tc][hc][alt ? 1 : 0], tc };
  }

  override column(x: number, z: number): ColumnV2 {
    const { c, mask, ridge } = this.relief(x, z);
    const { land, tc } = this.climate(x, z, c, mask, ridge);
    const P = this.shapeAt(x, z);
    const hills = this.nHills.fbm2(x / 112, z / 112, 5);
    let h = SEA + 4 + c * 16 + P[0] + hills * P[1] + mask * (ridge * 28 + 6);
    if (P[4] > 0) h += P[4] * Math.abs(this.nDetail.noise2(x / 22, z / 36)) * 3;
    if (P[2] > 0) h = lerp(h, SEA + 0.6 + hills * 1.5, P[2]);
    if (P[3] > 0 && h > SEA + 3) {
      const s = (h - SEA - 3) / 4;
      const f = Math.floor(s);
      h = lerp(h, SEA + 3 + (f + smoothstep(0.75, 1, s - f)) * 4, P[3]);
    }
    const edge = this.edge(x, z);
    if (edge < EDGE_FADE) h = lerp(SEA - 14, h, smoothstep(8, EDGE_FADE, edge));
    const height = Math.max(4, Math.min(MAX_TERRAIN, Math.floor(h)));
    let biome: Biome;
    if (height < SEA && (land !== Biome.Marshland || height < SEA - 2)) biome = tc === 0 ? Biome.IcySea : Biome.Ocean;
    else if (height <= SEA + 1 && land !== Biome.Marshland && land !== Biome.Redrock) biome = tc === 0 ? Biome.FrozenShore : Biome.Beach;
    else if (height >= SEA + 27) biome = Biome.GlacierPeaks;
    else if (height >= SEA + 19 && mask > 0.3) biome = tc === 0 ? Biome.GlacierPeaks : Biome.Mountains;
    else biome = land;
    return { height, biome, land, tClass: tc, mask };
  }

  // ---- spawn and structures ------------------------------------------------------------------

  /** As v2, but the rings reach further (biomes are 3x larger) and thin out past 200 blocks. */
  override findSpawn(): { x: number; y: number; z: number } {
    if (this.spawn) return { ...this.spawn };
    for (const preferred of [true, false]) {
      for (let r = 0; r < 900; r += r < 200 ? 2 : 8) {
        const n = r < 200 ? Math.max(1, r * 4) : Math.ceil(r * 1.5);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = Math.round(Math.cos(a) * r);
          const z = Math.round(Math.sin(a) * r);
          if (this.spawnOk(x, z, preferred) && !this.nearTree(x, z, 3)) {
            this.spawn = { x: x + 0.5, y: this.column(x, z).height + 1, z: z + 0.5 };
            return { ...this.spawn };
          }
        }
      }
    }
    this.spawn = { x: 0.5, y: 60, z: 0.5 };
    return { ...this.spawn };
  }

  /** The structures around the origin (the area a generator-2 world covers); others: structuresNear. */
  override structures(): StructureInfo[] {
    return this.lazy.inBox(-512, -512, 512, 512).map((p) => p.info);
  }

  /** Structures whose bounds come within `radius` (horizontal) of (x, z). */
  structuresNear(x: number, z: number, radius: number): StructureInfo[] {
    const out: StructureInfo[] = [];
    for (const p of this.lazy.inBox(x - radius, z - radius, x + radius + 1, z + radius + 1, this.boxScratch)) {
      const b = p.info.bounds;
      const dx = Math.max(b.x0 - x, 0, x - b.x1);
      const dz = Math.max(b.z0 - z, 0, z - b.z1);
      if (dx * dx + dz * dz <= radius * radius) out.push(p.info);
    }
    return out;
  }

  /** The structure whose bounds contain the cell, or null. */
  structureAt(x: number, y: number, z: number): StructureInfo | null {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    for (const p of this.lazy.inBox(fx, fz, fx + 1, fz + 1, this.boxScratch)) {
      const b = p.info.bounds;
      if (fx >= b.x0 && fx < b.x1 && fy >= b.y0 && fy < b.y1 && fz >= b.z0 && fz < b.z1) return p.info;
    }
    return null;
  }

  override nearStructure(x: number, z: number, margin: number): boolean {
    return this.lazy.inBox(x - margin, z - margin, x + margin + 1, z + margin + 1, this.boxScratch).length > 0;
  }

  protected override chunkStructures(x0: number, z0: number): PlacedStructure[] {
    const key = `${x0},${z0}`;
    if (key !== this.chunkStructsKey) {
      this.chunkStructsKey = key;
      this.chunkStructs = this.lazy.inBox(x0 - 4, z0 - 4, x0 + CHUNK_SIZE + 4, z0 + CHUNK_SIZE + 4);
    }
    return this.chunkStructs;
  }

  /** No trees rooted over a ravine or shaft (they would float). */
  override treeInCell(cellX: number, cellZ: number, structures = true): TreeV2 | null {
    const t = super.treeInCell(cellX, cellZ, structures);
    if (t && (this.ravineWidth(t.x, t.z) > 0 || this.shaftAt(t.x, t.z))) return null;
    return t;
  }

  // ---- chunks ---------------------------------------------------------------------------------

  override generateChunk(cx: number, cz: number, out: Uint8Array = new Uint8Array(TERRAIN_VOLUME)): Uint8Array {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    // Wholly past the edge: solid bedrock.
    if (this.edge(x0, z0) < 0 && this.edge(x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1) < 0) {
      out.fill(Block.Bedrock);
      return out;
    }
    this.prepareCaves(x0, z0);
    super.generateChunk(cx, cz, out);
    // The rim: bedrock walls along the edge (and past it).
    if (this.edge(x0, z0) < RIM || this.edge(x0 + CHUNK_SIZE - 1, z0 + CHUNK_SIZE - 1) < RIM) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (this.edge(x0 + lx, z0 + lz) >= RIM) continue;
          for (let y = 0; y < TERRAIN_HEIGHT; y++) out[blockIndex(lx, y, lz)] = Block.Bedrock;
        }
      }
    }
    return out;
  }

  // ---- caves -----------------------------------------------------------------------------------

  /** Samples the 3D cave fields on the chunk's lattice and resets the height cache. */
  private prepareCaves(x0: number, z0: number): void {
    this.chunkX0 = x0;
    this.chunkZ0 = z0;
    this.heights.fill(-1);
    let i = 0;
    for (let j = 0; j < LY; j++) {
      const y = j * LAT;
      for (let k = 0; k < LN; k++) {
        const z = z0 + k * LAT;
        for (let l = 0; l < LN; l++, i++) {
          const x = x0 + l * LAT;
          // Two networks of tubes, each where two noise sheets cross near zero.
          this.fA[i] = this.nTunA.noise3(x / TUN1_XZ, y / TUN1_Y, z / TUN1_XZ);
          this.fB[i] = this.nTunB.noise3(x / TUN1_XZ, y / TUN1_Y, z / TUN1_XZ);
          this.fC[i] = this.nTunC.noise3(x / TUN2_XZ + 31.7, y / TUN2_Y, z / TUN2_XZ - 12.9);
          this.fD[i] = this.nTunD.noise3(x / TUN2_XZ - 8.3, y / TUN2_Y, z / TUN2_XZ + 50.1);
          this.fW[i] = 1 + 0.8 * this.nWidth.noise3(x / 90, y / 40, z / 90);
          this.fRoom[i] = this.nRoom.noise3(x / 80, y / 22, z / 80) * 0.75 + this.nRoomDetail.noise3(x / 26, y / 14, z / 26) * 0.25;
        }
      }
    }
  }

  /** Terrain height of a column near the current chunk (cached). */
  private heightNear(x: number, z: number): number {
    const lx = x - this.chunkX0 + PAD;
    const lz = z - this.chunkZ0 + PAD;
    if (lx < 0 || lz < 0 || lx >= HSIDE || lz >= HSIDE) return this.column(x, z).height;
    const i = lz * HSIDE + lx;
    let h = this.heights[i];
    if (h < 0) this.heights[i] = h = this.column(x, z).height;
    return h;
  }

  /** Lowest terrain among the four columns `d` blocks away. */
  private lowestAround(x: number, z: number, d: number): number {
    return Math.min(this.heightNear(x + d, z), this.heightNear(x - d, z), this.heightNear(x, z + d), this.heightNear(x, z - d));
  }

  /** Ravine half-width at a column in noise units (0 = no ravine). */
  private ravineWidth(x: number, z: number): number {
    const gate = this.nRavine.noise2(x / 420 + 77.7, z / 420 - 33.3);
    if (gate < 0.2) return 0;
    const w = 0.03 * smoothstep(0.2, 0.42, gate);
    return Math.abs(this.nRavine.noise2(x / 150, z / 150)) < w ? w : 0;
  }

  /** The shaft over this column: its floor, or null. */
  private shaftAt(x: number, z: number): { floor: number } | null {
    const sx = Math.floor(x / SHAFT_CELL);
    const sz = Math.floor(z / SHAFT_CELL);
    if (hashFloat(sx, sz, this.seed, 41) >= SHAFT_CHANCE) return null;
    const hsh = hash4(sx, sz, this.seed, 42);
    const ax = sx * SHAFT_CELL + 10 + (hsh % (SHAFT_CELL - 20));
    const az = sz * SHAFT_CELL + 10 + ((hsh >>> 8) % (SHAFT_CELL - 20));
    const radius = 1.6 + ((hsh >>> 16) & 15) / 12;
    const dx = x - ax;
    const dz = z - az;
    if (dx * dx + dz * dz > (radius + 1.2) * (radius + 1.2)) return null;
    // Ragged walls.
    const r = radius + this.nMouth.noise2(x / 3 + 11.1, z / 3 - 7.7) * 0.6;
    if (dx * dx + dz * dz > r * r) return null;
    return { floor: 8 + ((hsh >>> 20) % 12) };
  }

  /** True for land a cave may open onto: high enough and no water within 5 blocks. */
  private dryLand(x: number, z: number, h: number): boolean {
    return h >= SEA + 3 && this.lowestAround(x, z, 5) >= SEA + 2 && this.lowestAround(x, z, 2) >= SEA + 2;
  }

  /** Lowest y the structures over this column leave alone (no carving at or above it), or TERRAIN_HEIGHT. */
  private structureFloor(x: number, z: number): number {
    let floor = TERRAIN_HEIGHT;
    for (const p of this.chunkStructs) {
      const b = p.info.bounds;
      if (x >= b.x0 - 3 && x < b.x1 + 3 && z >= b.z0 - 3 && z < b.z1 + 3) floor = Math.min(floor, b.y0 - 3);
    }
    return floor;
  }

  protected override carveColumn(out: Uint8Array, lx: number, lz: number, wx: number, wz: number, col: ColumnV2): void {
    const h = col.height;
    if (this.edge(wx, wz) < EDGE_FADE) return; // the deep edge sea stays sealed
    // Ceiling: a few blocks of rock under the surface, more under or beside water.
    let top = h - 5;
    if (h < SEA + 12) top = Math.min(top, this.lowestAround(wx, wz, 3) - 5, this.lowestAround(wx, wz, 6) - 4);
    const sFloor = this.structureFloor(wx, wz);
    const spawn = this.spawn ?? this.findSpawn();
    const sdx = wx + 0.5 - spawn.x;
    const sdz = wz + 0.5 - spawn.z;
    const nearSpawn = sdx * sdx + sdz * sdz < SPAWN_CLEAR * SPAWN_CLEAR;
    if (nearSpawn && sdx * sdx + sdz * sdz < 16) top = Math.min(top, h - 8);
    // Openings to the surface on dry land: tunnel mouths, ravines, shafts.
    let openTop = top;
    let ravine = 0;
    let ravineFloor = 0;
    let shaftFloor = -1;
    if (!nearSpawn && sFloor === TERRAIN_HEIGHT && h >= SEA + 3) {
      const mouth = this.nMouth.noise2(wx / 70, wz / 70) > MOUTH;
      ravine = this.ravineWidth(wx, wz);
      const shaft = this.shaftAt(wx, wz);
      if ((mouth || ravine || shaft) && this.dryLand(wx, wz, h)) {
        if (mouth) openTop = h;
        if (ravine) ravineFloor = 9 + Math.floor((this.nMouth.noise2(wx / 40 - 50, wz / 40 + 20) + 1) * 4);
        if (shaft) shaftFloor = shaft.floor;
      } else ravine = 0;
    }
    const yMax = Math.min(Math.max(openTop, ravine ? h : 0, shaftFloor >= 0 ? h : 0), sFloor - 1, TERRAIN_HEIGHT - 2);
    if (yMax < 2) return;
    const rv = ravine ? Math.abs(this.nRavine.noise2(wx / 150, wz / 150)) : 0;
    // Lattice cell of the column and its x/z weights.
    const l0 = lx >> 2, k0 = lz >> 2;
    const fx = (lx & 3) / LAT, fz = (lz & 3) / LAT;
    const i00 = k0 * LN + l0;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const plane = LN * LN;
    const { fA, fB, fC, fD, fW, fRoom } = this;
    for (let y = 2; y <= yMax; y++) {
      let carve = false;
      if (shaftFloor >= 0 && y >= shaftFloor) carve = true;
      else if (ravine && y >= ravineFloor && rv < ravine * (0.3 + 0.7 * Math.min(1, (y - ravineFloor) / Math.max(1, h - ravineFloor)))) carve = true;
      else if (y <= openTop) {
        const j = y >> 2;
        const fy = (y & 3) / LAT;
        const p = i00 + j * plane;
        const q = p + plane;
        const at = (f: Float32Array) => {
          const lo = f[p] * w00 + f[p + 1] * w10 + f[p + LN] * w01 + f[p + LN + 1] * w11;
          const hi = f[q] * w00 + f[q + 1] * w10 + f[q + LN] * w01 + f[q + LN + 1] * w11;
          return lo + (hi - lo) * fy;
        };
        const w = at(fW) * TUNNEL_R;
        const a = at(fA), b = at(fB);
        if (a * a + b * b < w) carve = true;
        else {
          const c = at(fC), d = at(fD);
          if (c * c + d * d < w * 0.8) carve = true;
          else if (y >= 3 && y <= 36) {
            // Caverns: most open between y 8 and 24.
            const band = smoothstep(3, 10, y) * (1 - smoothstep(24, 36, y));
            if (at(fRoom) > 0.62 - band * 0.2) carve = true;
          }
        }
      }
      if (carve) out[blockIndex(lx, y, lz)] = y <= LAVA_LEVEL ? Block.Lava : Block.Air;
    }
  }
}
