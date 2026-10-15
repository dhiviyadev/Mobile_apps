/**
 * The server's view of a Voxelvale world: the seed's generated terrain plus
 * the authoritative edit list. Generated chunks are cached in a small LRU,
 * so validating edits anywhere in the world stays cheap in memory.
 * A dirty flag tracks edits made since the last save (see WorldStore).
 */
import {
  type BlockEdit,
  blockIndex,
  blockInWorld,
  CHUNK_HEIGHT,
  chunkKey,
  createWorldGenerator,
  packPos,
  toChunkCoord,
  toLocal,
  unpackPos,
  type VoxelMode,
  type WorldGenerator,
} from '@hub/shared';

const MAX_CACHED_CHUNKS = 256;

export class ServerVoxelWorld {
  readonly generator: WorldGenerator;
  /** packPos -> block id; the full history needed by late joiners. */
  private readonly edits = new Map<number, number>();
  private readonly cache = new Map<string, Uint8Array>();
  private _dirty = false;

  constructor(
    readonly seed: number,
    readonly mode: VoxelMode,
    readonly maxEdits = 200_000,
  ) {
    this.generator = createWorldGenerator(seed, mode);
  }

  get editCount(): number {
    return this.edits.size;
  }

  /** True when the edit list changed since the last markClean(). */
  get dirty(): boolean {
    return this._dirty;
  }

  markClean(): void {
    this._dirty = false;
  }

  /** Flags unsaved changes again, e.g. after a failed save. */
  markDirty(): void {
    this._dirty = true;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return 14;
    if (y >= CHUNK_HEIGHT) return 0;
    const edited = this.edits.get(packPos(x, y, z));
    if (edited !== undefined) return edited;
    return this.chunk(toChunkCoord(x), toChunkCoord(z))[blockIndex(toLocal(x), y, toLocal(z))];
  }

  /** Records an edit. Returns false if the edit budget for this room is exhausted. */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    const key = packPos(x, y, z);
    if (!this.edits.has(key) && this.edits.size >= this.maxEdits) return false;
    // An edit that restores the generated block can be forgotten entirely.
    const generated = this.chunk(toChunkCoord(x), toChunkCoord(z))[blockIndex(toLocal(x), y, toLocal(z))];
    if (generated === id) {
      if (this.edits.delete(key)) this._dirty = true;
    } else if (this.edits.get(key) !== id) {
      this.edits.set(key, id);
      this._dirty = true;
    }
    return true;
  }

  /**
   * Bulk-restores saved edits without marking the world dirty. Edits outside
   * the world are skipped and loading stops at the edit budget.
   * Returns the number of edits applied.
   */
  loadEdits(edits: Iterable<BlockEdit>): number {
    let applied = 0;
    for (const e of edits) {
      if (!blockInWorld(e.x, e.y, e.z)) continue;
      const key = packPos(e.x, e.y, e.z);
      if (!this.edits.has(key) && this.edits.size >= this.maxEdits) break;
      this.edits.set(key, e.id);
      applied++;
    }
    return applied;
  }

  allEdits(): BlockEdit[] {
    const out: BlockEdit[] = [];
    for (const [key, id] of this.edits) {
      const [x, y, z] = unpackPos(key);
      out.push({ x, y, z, id });
    }
    return out;
  }

  private chunk(cx: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cz);
    let c = this.cache.get(key);
    if (c) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, c);
      return c;
    }
    c = this.generator.generateChunk(cx, cz);
    this.cache.set(key, c);
    if (this.cache.size > MAX_CACHED_CHUNKS) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return c;
  }
}
