/**
 * Terrain generator version 4: generator 3's overworld for x < OVERWORLD_MAX_X
 * (its coast fades into sea before the edge), an impassable bedrock Veil Wall
 * over [VEIL_X0, DIM_X0), and the Gloamreach (gloam/terrain.ts) over
 * [DIM_X0, DIM_X1). Structures: v3's ruins stay in the overworld; Fallen
 * Lattices join them there, Twilit Lattices and Eclipse Orreries live in the
 * Gloamreach (gloam/sites.ts). Deterministic per seed, independent of chunk order.
 */
import { Block } from '../blocks';
import { blockIndex } from '../chunk';
import { CHUNK_SIZE, ENDLESS_LIMIT, TERRAIN_HEIGHT, TERRAIN_VOLUME } from '../constants';
import { DIM_X0, OVERWORLD_MAX_X, VEIL_X0 } from '../realm';
import type { PlacedStructure } from '../structures/place';
import type { LazyOptions } from '../structures/place';
import type { StructureInfo } from '../structures/types';
import { Biome } from './biomes';
import { GloamSites } from './gloam/sites';
import { GloamTerrain } from './gloam/terrain';
import type { ColumnV2 } from './v2';
import { TerrainGeneratorV3 } from './v3';

export class TerrainGeneratorV4 extends TerrainGeneratorV3 {
  readonly gloam: GloamTerrain;
  readonly sites: GloamSites;
  private readonly scratch: PlacedStructure[] = [];

  constructor(seed: number) {
    super(seed);
    this.gloam = new GloamTerrain(this.seed);
    this.sites = new GloamSites({
      seed: this.seed,
      spawn: () => this.findSpawn(),
      over: (x, z) => super.column(x, z),
      gloam: (x, z) => this.gloam.column(x, z),
      overworldBusy: (x, z, m) => TerrainGeneratorV3.prototype.nearStructure.call(this, x, z, m),
    });
  }

  /** Generator 4's overworld uses the reworked and new boss ruins (set 2), clear of the Veil Wall. */
  protected override structureOptions(): LazyOptions {
    return { structureSet: 2, maxX: OVERWORLD_MAX_X };
  }

  /** The overworld's east edge is OVERWORLD_MAX_X, not the endless limit. */
  protected override edge(x: number, z: number): number {
    return Math.min(x + ENDLESS_LIMIT, OVERWORLD_MAX_X - 1 - x, z + ENDLESS_LIMIT, ENDLESS_LIMIT - 1 - z);
  }

  override column(x: number, z: number): ColumnV2 {
    if (x >= DIM_X0) {
      const g = this.gloam.column(x, z);
      return { height: g.top, biome: g.biome, land: g.biome, tClass: 2, mask: 0 };
    }
    if (x >= VEIL_X0) return { height: TERRAIN_HEIGHT - 2, biome: Biome.VeilWall, land: Biome.VeilWall, tClass: 2, mask: 0 };
    return super.column(x, z);
  }

  // ---- structures ------------------------------------------------------------------------------

  override structures(): StructureInfo[] {
    return [...super.structures(), ...this.sites.overworldInBox(-512, -512, 512, 512, []).map((p) => p.info)];
  }

  override structuresNear(x: number, z: number, radius: number): StructureInfo[] {
    const infos = x >= VEIL_X0 ? [] : super.structuresNear(x, z, radius);
    const sites = x >= VEIL_X0 ? this.sites.gloamInBox(x - radius, z - radius, x + radius + 1, z + radius + 1, this.scratch) : this.sites.overworldInBox(x - radius, z - radius, x + radius + 1, z + radius + 1, this.scratch);
    for (const p of sites) {
      const b = p.info.bounds;
      const dx = Math.max(b.x0 - x, 0, x - b.x1);
      const dz = Math.max(b.z0 - z, 0, z - b.z1);
      if (dx * dx + dz * dz <= radius * radius) infos.push(p.info);
    }
    return infos;
  }

  override structureAt(x: number, y: number, z: number): StructureInfo | null {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const sites = fx >= VEIL_X0 ? this.sites.gloamInBox(fx, fz, fx + 1, fz + 1, this.scratch) : this.sites.overworldInBox(fx, fz, fx + 1, fz + 1, this.scratch);
    for (const p of sites) {
      const b = p.info.bounds;
      if (fx >= b.x0 && fx < b.x1 && fy >= b.y0 && fy < b.y1 && fz >= b.z0 && fz < b.z1) return p.info;
    }
    return fx >= VEIL_X0 ? null : super.structureAt(x, y, z);
  }

  override nearStructure(x: number, z: number, margin: number): boolean {
    if (x >= VEIL_X0) return false;
    return super.nearStructure(x, z, margin) || this.sites.overworldInBox(x - margin, z - margin, x + margin + 1, z + margin + 1, this.scratch).length > 0;
  }

  protected override chunkStructures(x0: number, z0: number): PlacedStructure[] {
    const base = super.chunkStructures(x0, z0);
    const extra = this.sites.overworldInBox(x0 - 4, z0 - 4, x0 + CHUNK_SIZE + 4, z0 + CHUNK_SIZE + 4, []);
    return extra.length ? [...base, ...extra] : base;
  }

  // ---- chunks ---------------------------------------------------------------------------------

  override generateChunk(cx: number, cz: number, out: Uint8Array = new Uint8Array(TERRAIN_VOLUME)): Uint8Array {
    const x0 = cx * CHUNK_SIZE;
    if (x0 >= DIM_X0) {
      this.gloam.generateChunk(cx, cz, out);
      const placed = this.sites.gloamInBox(x0 - 2, cz * CHUNK_SIZE - 2, x0 + CHUNK_SIZE + 2, cz * CHUNK_SIZE + CHUNK_SIZE + 2, []);
      for (const p of placed) for (const v of this.volumesFor(p)) v.copyIntoChunk(cx, cz, out);
      // The world's far rim.
      if (x0 + CHUNK_SIZE > DIM_X1_SOLID || Math.abs(cz * CHUNK_SIZE) >= ENDLESS_LIMIT) this.rim(cx, cz, out);
      return out;
    }
    if (x0 >= VEIL_X0) {
      out.fill(Block.Bedrock);
      return out;
    }
    return super.generateChunk(cx, cz, out);
  }

  /** The Gloamreach's outer wall: bedrock where x or z leave the world. */
  private rim(cx: number, cz: number, out: Uint8Array): void {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const z = cz * CHUNK_SIZE + lz;
        if (x < ENDLESS_LIMIT - 2 && Math.abs(z + 0.5) < ENDLESS_LIMIT - 2) continue;
        for (let y = 0; y < TERRAIN_HEIGHT; y++) out[blockIndex(lx, y, lz)] = Block.Bedrock;
      }
    }
  }
}

const DIM_X1_SOLID = ENDLESS_LIMIT - 2 - CHUNK_SIZE;
