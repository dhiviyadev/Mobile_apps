/**
 * A structure piece as a box of template cells, copied into every chunk it
 * touches. KEEP cells leave the generated terrain alone; a foundation fills the
 * gap under the piece's solid bottom layer down to the ground.
 */
import { Block, IS_LIQUID, IS_SOLID, SHAPE, BlockShape } from '../blocks';
import { blockIndex } from '../chunk';
import { CHUNK_SIZE } from '../constants';

/** Template cell that leaves the generated block alone. */
export const KEEP = 255;
const LEAVES = new Set<number>([Block.Leaves, Block.AspenLeaves, Block.PineLeaves, Block.MahoganyLeaves, Block.ThornwoodLeaves, Block.DuskwoodLeaves]);
/** Most cells a foundation reaches down. */
const FOUNDATION_DEPTH = 24;

export class StructureVolume {
  /** sx*sy*sz cells, index (ly*sz + lz)*sx + lx, filled with KEEP. */
  readonly data: Uint8Array;

  constructor(
    readonly ox: number,
    readonly oy: number,
    readonly oz: number,
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
    readonly foundation: Block | null,
  ) {
    this.data = new Uint8Array(sx * sy * sz).fill(KEEP);
  }

  private index(lx: number, ly: number, lz: number): number {
    return (ly * this.sz + lz) * this.sx + lx;
  }

  inside(lx: number, ly: number, lz: number): boolean {
    return lx >= 0 && ly >= 0 && lz >= 0 && lx < this.sx && ly < this.sy && lz < this.sz;
  }

  set(lx: number, ly: number, lz: number, id: number): void {
    if (this.inside(lx, ly, lz)) this.data[this.index(lx, ly, lz)] = id;
  }

  get(lx: number, ly: number, lz: number): number {
    return this.inside(lx, ly, lz) ? this.data[this.index(lx, ly, lz)] : KEEP;
  }

  /** Fills an inclusive box. */
  fill(lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number, id: number): void {
    for (let y = ly0; y <= ly1; y++) for (let z = lz0; z <= lz1; z++) for (let x = lx0; x <= lx1; x++) this.set(x, y, z, id);
  }

  /** Writes the template into chunk (cx, cz) where it is not KEEP, then the foundation fill-down. */
  copyIntoChunk(cx: number, cz: number, out: Uint8Array): void {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const ax = Math.max(this.ox, x0);
    const bx = Math.min(this.ox + this.sx, x0 + CHUNK_SIZE);
    const az = Math.max(this.oz, z0);
    const bz = Math.min(this.oz + this.sz, z0 + CHUNK_SIZE);
    if (ax >= bx || az >= bz) return;
    for (let wz = az; wz < bz; wz++) {
      for (let wx = ax; wx < bx; wx++) {
        const lx = wx - this.ox;
        const lz = wz - this.oz;
        for (let ly = 0; ly < this.sy; ly++) {
          const y = this.oy + ly;
          if (y < 1 || y > 63) continue;
          const id = this.data[this.index(lx, ly, lz)];
          if (id !== KEEP) out[blockIndex(wx - x0, y, wz - z0)] = id;
        }
        if (this.foundation === null) continue;
        const bottom = this.data[this.index(lx, 0, lz)];
        if (bottom === KEEP || !IS_SOLID[bottom]) continue;
        for (let y = this.oy - 1, n = 0; y >= 1 && n < FOUNDATION_DEPTH; y--, n++) {
          const i = blockIndex(wx - x0, y, wz - z0);
          const c = out[i];
          if (IS_SOLID[c] && !LEAVES.has(c) && SHAPE[c] === BlockShape.Cube && !IS_LIQUID[c]) break;
          out[i] = this.foundation;
        }
      }
    }
  }
}
