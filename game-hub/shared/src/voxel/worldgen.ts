/**
 * Deterministic terrain generator. Given the same seed, the server and every
 * client produce identical chunks, so only player edits travel over the network.
 *
 * Features: rolling hills and ridged mountains, oceans and beaches, biomes
 * (plains, forest, desert, snow), trees on a jittered grid, spaghetti caves
 * plus larger caverns, and a bedrock floor.
 */
import { SimplexNoise } from '../util/noise';
import { hash4, hashFloat } from '../util/rng';
import { Block } from './blocks';
import { blockIndex } from './chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL } from './constants';

export enum Biome {
  Plains = 0,
  Forest = 1,
  Desert = 2,
  Snow = 3,
  Beach = 4,
  Mountains = 5,
  Ocean = 6,
}

export interface Column {
  height: number;
  biome: Biome;
}

const TREE_CELL = 5;
const MAX_TERRAIN = CHUNK_HEIGHT - 10;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Tree {
  x: number;
  y: number; // first trunk block
  z: number;
  height: number;
  snowy: boolean;
}

export class TerrainGenerator {
  private readonly n1: SimplexNoise;
  private readonly n2: SimplexNoise;
  private readonly n3: SimplexNoise;
  private readonly caves: SimplexNoise;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.n1 = new SimplexNoise(this.seed);
    this.n2 = new SimplexNoise(this.seed ^ 0x9e3779b9);
    this.n3 = new SimplexNoise(this.seed ^ 0x85ebca6b);
    this.caves = new SimplexNoise(this.seed ^ 0xc2b2ae35);
  }

  /** Surface height (y of the top solid block) and biome for a world column. */
  column(x: number, z: number): Column {
    const cont = this.n1.fbm2(x / 260, z / 260, 3);
    const hills = this.n2.fbm2(x / 70, z / 70, 4);
    const ridgeRaw = 1 - Math.abs(this.n3.noise2(x / 140, z / 140));
    const ridge = ridgeRaw * ridgeRaw * ridgeRaw;
    const mountainMask = smoothstep(0.1, 0.55, cont);
    let h = SEA_LEVEL + 3 + cont * 12 + hills * 5 + mountainMask * ridge * 24;
    h = Math.max(4, Math.min(MAX_TERRAIN, Math.floor(h)));

    const temp = this.n2.fbm2(x / 400 + 500, z / 400 - 200, 2);
    const moist = this.n3.fbm2(x / 260 - 300, z / 260 + 90, 2);
    let biome: Biome;
    if (h < SEA_LEVEL) biome = Biome.Ocean;
    else if (h <= SEA_LEVEL + 1) biome = temp < -0.3 ? Biome.Snow : Biome.Beach;
    else if (h >= SEA_LEVEL + 22) biome = Biome.Mountains;
    else if (temp > 0.3) biome = Biome.Desert;
    else if (temp < -0.3) biome = Biome.Snow;
    else if (moist > 0.12) biome = Biome.Forest;
    else biome = Biome.Plains;
    return { height: h, biome };
  }

  /** The tree rooted in the jittered grid cell containing (x, z), if any. */
  treeInCell(cellX: number, cellZ: number): Tree | null {
    const hsh = hash4(cellX, cellZ, this.seed, 7);
    const tx = cellX * TREE_CELL + (hsh % TREE_CELL);
    const tz = cellZ * TREE_CELL + ((hsh >>> 8) % TREE_CELL);
    const col = this.column(tx, tz);
    const density =
      col.biome === Biome.Forest ? 0.75 : col.biome === Biome.Plains ? 0.16 : col.biome === Biome.Snow ? 0.3 : col.biome === Biome.Mountains ? 0.05 : 0;
    if (hashFloat(cellX, cellZ, this.seed, 11) >= density) return null;
    if (col.height <= SEA_LEVEL + 1 || col.height > MAX_TERRAIN - 9) return null;
    const height = 4 + ((hsh >>> 16) % 3);
    return { x: tx, y: col.height + 1, z: tz, height, snowy: col.biome === Biome.Snow };
  }

  /** True when a tree trunk occupies column (x, z). */
  hasTreeAt(x: number, z: number): boolean {
    const t = this.treeInCell(Math.floor(x / TREE_CELL), Math.floor(z / TREE_CELL));
    return !!t && t.x === x && t.z === z;
  }

  /** Fills a 16x64x16 chunk. Reuses `out` if provided. */
  generateChunk(cx: number, cz: number, out: Uint8Array = new Uint8Array(CHUNK_VOLUME)): Uint8Array {
    out.fill(Block.Air);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = x0 + lx;
        const wz = z0 + lz;
        const { height: h, biome } = this.column(wx, wz);
        const underwater = h < SEA_LEVEL;
        const detail = hashFloat(wx, wz, this.seed, 3);

        let top: Block;
        let filler: Block;
        if (underwater) {
          const floor = this.n1.noise2(wx / 24, wz / 24);
          top = floor > 0.35 ? Block.Clay : floor < -0.35 ? Block.Gravel : Block.Sand;
          filler = top === Block.Clay ? Block.Clay : Block.Sand;
        } else if (biome === Biome.Beach || biome === Biome.Desert) {
          top = Block.Sand;
          filler = Block.Sand;
        } else if (biome === Biome.Snow) {
          top = Block.SnowyGrass;
          filler = Block.Dirt;
        } else if (biome === Biome.Mountains) {
          top = h >= SEA_LEVEL + 28 ? Block.Snow : detail < 0.5 ? Block.Stone : Block.Grass;
          filler = top === Block.Grass ? Block.Dirt : Block.Stone;
        } else {
          top = Block.Grass;
          filler = Block.Dirt;
        }
        const fillerDepth = biome === Biome.Desert ? 4 : 3;

        for (let y = 0; y <= h; y++) {
          let b: Block;
          if (y === 0) b = Block.Bedrock;
          else if (y === 1 && detail < 0.5) b = Block.Bedrock;
          else if (y === h) b = top;
          else if (y >= h - fillerDepth) b = filler;
          else b = Block.Stone;
          out[blockIndex(lx, y, lz)] = b;
        }
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          out[blockIndex(lx, y, lz)] = y === SEA_LEVEL && biome === Biome.Snow && underwater ? Block.Ice : Block.Water;
        }

        // Caves: carve below the surface; keep a roof under oceans and rivers.
        const carveTop = underwater || h <= SEA_LEVEL + 2 ? h - 4 : h - 1;
        for (let y = 2; y <= carveTop; y++) {
          if (this.isCave(wx, y, wz)) out[blockIndex(lx, y, lz)] = Block.Air;
        }
        // A cave that opened the surface should not leave grass hanging on dirt.
        if (out[blockIndex(lx, h, lz)] !== Block.Air && h > 1 && out[blockIndex(lx, h - 1, lz)] === Block.Air && top === Block.Grass) {
          out[blockIndex(lx, h, lz)] = Block.Dirt;
        }
      }
    }

    this.placeTrees(cx, cz, out);
    return out;
  }

  private isCave(x: number, y: number, z: number): boolean {
    // Two thin noise "sheets" intersecting form winding tunnels.
    const a = this.caves.noise3(x / 28, y / 18, z / 28);
    const b = this.caves.noise3(x / 28 + 71.3, y / 18 - 13.1, z / 28 + 37.7);
    if (a * a + b * b < 0.014) return true;
    // Occasional larger caverns deep down.
    if (y < 18) {
      const c = this.n3.noise3(x / 50, y / 22, z / 50);
      if (c > 0.6) return true;
    }
    return false;
  }

  private placeTrees(cx: number, cz: number, out: Uint8Array): void {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const minCell = Math.floor((x0 - 3) / TREE_CELL);
    const maxCell = Math.floor((x0 + CHUNK_SIZE + 3) / TREE_CELL);
    const minCellZ = Math.floor((z0 - 3) / TREE_CELL);
    const maxCellZ = Math.floor((z0 + CHUNK_SIZE + 3) / TREE_CELL);

    const set = (wx: number, y: number, wz: number, b: Block, onlyAir: boolean) => {
      const lx = wx - x0;
      const lz = wz - z0;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return;
      const i = blockIndex(lx, y, lz);
      if (onlyAir && out[i] !== Block.Air) return;
      out[i] = b;
    };

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCell; cellX <= maxCell; cellX++) {
        const t = this.treeInCell(cellX, cellZ);
        if (!t) continue;
        // Trees never root on a carved surface: the top block (y = height) is never carved.
        const lx = t.x - x0;
        const lz = t.z - z0;
        if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
          const gi = blockIndex(lx, t.y - 1, lz);
          if (out[gi] === Block.Grass || out[gi] === Block.SnowyGrass) out[gi] = Block.Dirt;
        }
        const topY = t.y + t.height - 1;
        // Leaves: two wide layers, then a narrow cap.
        for (let dy = -2; dy <= 1; dy++) {
          const y = topY + dy;
          const r = dy <= -1 ? 2 : 1;
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              const corner = Math.abs(dx) === r && Math.abs(dz) === r;
              if (corner && (r === 1 || hashFloat(t.x + dx, y, t.z + dz, this.seed) < 0.6)) continue;
              set(t.x + dx, y, t.z + dz, t.snowy && dy === 1 ? Block.Snow : Block.Leaves, true);
            }
          }
        }
        for (let y = t.y; y <= topY; y++) set(t.x, y, t.z, Block.Log, false);
      }
    }
  }

  /** Finds a dry, open spawn column near the origin. */
  findSpawn(): { x: number; y: number; z: number } {
    for (let r = 0; r < 200; r += 2) {
      for (let i = 0; i < Math.max(1, r * 4); i++) {
        const a = (i / Math.max(1, r * 4)) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r);
        const z = Math.round(Math.sin(a) * r);
        const c = this.column(x, z);
        if (c.height > SEA_LEVEL + 1 && c.height < SEA_LEVEL + 18 && c.biome !== Biome.Mountains && !this.nearTree(x, z)) {
          return { x: x + 0.5, y: c.height + 1, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: CHUNK_HEIGHT - 4, z: 0.5 };
  }

  private nearTree(x: number, z: number): boolean {
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (this.hasTreeAt(x + dx, z + dz)) return true;
    return false;
  }
}
