/**
 * Voxel light propagation. Every cell gets two levels in 0..MAX_LIGHT:
 *   - sky light: falls straight down each column at full strength until the
 *     first opaque block (leaves, liquids and ice dim it on the way), then
 *     spreads sideways into caves, overhangs and interiors;
 *   - block light: spreads from emissive blocks (lamps).
 * Spreading loses one level per step, plus LIGHT_COST when entering dimming
 * blocks. Opaque blocks (the same ones that hide neighbouring faces in the
 * mesher) stop light.
 *
 * The client runs this in mesh workers over a 3x3 chunk region, so light that
 * reaches the centre chunk from up to MAX_LIGHT blocks away is exact. The day
 * cycle is applied in the shader: sky light stores "how open to the sky", not
 * the current brightness, so time of day never needs a remesh.
 */
import { Block, IS_LIQUID, IS_TRANSPARENT } from './blocks';

export const MAX_LIGHT = 15;

/** Light emitted by each block id. */
export const LIGHT_EMISSION = new Uint8Array(256);
LIGHT_EMISSION[Block.Lamp] = 15;
LIGHT_EMISSION[Block.Checkpoint] = 10;
LIGHT_EMISSION[Block.Finish] = 10;

/** 1 for blocks that stop light. */
export const LIGHT_OPAQUE = new Uint8Array(256);
/** Extra levels lost when light enters a block, on top of 1 per step. */
export const LIGHT_COST = new Uint8Array(256);
/** Levels lost stepping into a block (opaque blocks lose everything). */
const STEP_LOSS = new Uint8Array(256);
/** Packed for the full-volume pass: sky light lost falling into a block (low 4 bits), emission << 4. */
const FALL = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  LIGHT_OPAQUE[id] = IS_TRANSPARENT[id] ? 0 : 1;
  LIGHT_COST[id] = IS_LIQUID[id] || id === Block.Leaves || id === Block.Ice ? 1 : 0;
  STEP_LOSS[id] = LIGHT_OPAQUE[id] ? MAX_LIGHT + 1 : 1 + LIGHT_COST[id];
  FALL[id] = (LIGHT_OPAQUE[id] ? MAX_LIGHT : LIGHT_COST[id]) | (LIGHT_EMISSION[id] << 4);
}

/** True when replacing block `a` with `b` can change light in other cells. */
export function changesLight(a: number, b: number): boolean {
  return LIGHT_OPAQUE[a] !== LIGHT_OPAQUE[b] || LIGHT_EMISSION[a] !== LIGHT_EMISSION[b] || LIGHT_COST[a] !== LIGHT_COST[b];
}

// Scratch buffers reused between calls (each worker lights one region at a time).
let queue = new Int32Array(0);
let queued = new Uint8Array(0);
let columnLevel = new Uint8Array(0);
let shadeTop = new Int16Array(0);

/**
 * Computes sky and block light for a box of blocks laid out like chunks
 * (x fastest, then z, then y). Above the box is open sky; light does not
 * enter from the sides or below.
 */
export function computeLight(
  blocks: Uint8Array,
  sizeX: number,
  height: number,
  sizeZ: number,
  outSky: Uint8Array,
  outBlock: Uint8Array,
): void {
  const layer = sizeX * sizeZ;
  const volume = layer * height;
  if (queue.length < volume + 1) {
    queue = new Int32Array(volume + 1);
    queued = new Uint8Array(volume);
  }
  if (shadeTop.length < layer) {
    columnLevel = new Uint8Array(layer);
    shadeTop = new Int16Array(layer);
  }

  // ---- one pass over all cells, top layer first (sequential memory) -------------
  // Sky light falls straight down each column; shadeTop = highest y below full
  // sky in the column (-1 when fully open). Emitters seed the block light queue.
  columnLevel.fill(MAX_LIGHT, 0, layer);
  shadeTop.fill(-1, 0, layer);
  outBlock.fill(0, 0, volume);
  let tail = 0;
  for (let y = height - 1; y >= 0; y--) {
    for (let col = 0, i = y * layer; col < layer; col++, i++) {
      const f = FALL[blocks[i]];
      let level = columnLevel[col];
      const drop = f & 15;
      if (drop !== 0 && level !== 0) {
        level = level > drop ? level - drop : 0;
        columnLevel[col] = level;
        if (shadeTop[col] < 0) shadeTop[col] = y;
      }
      outSky[i] = level;
      if (f > 15) {
        outBlock[i] = f >> 4;
        queued[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  spread(blocks, outBlock, sizeX, sizeZ, layer, volume, tail);

  // ---- sky: spread into shadow -----------------------------------------------------
  // Seed the spread with lit cells next to a darker cell they can brighten. Only
  // horizontal neighbours matter: the falling pass already lit everything below a
  // cell as brightly as spreading could. Above every neighbour's shadeTop all
  // cells are at full light, so the scan starts there.
  tail = 0;
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const col = z * sizeX + x;
      let hi = shadeTop[col];
      if (x > 0 && shadeTop[col - 1] > hi) hi = shadeTop[col - 1];
      if (x < sizeX - 1 && shadeTop[col + 1] > hi) hi = shadeTop[col + 1];
      if (z > 0 && shadeTop[col - sizeX] > hi) hi = shadeTop[col - sizeX];
      if (z < sizeZ - 1 && shadeTop[col + sizeX] > hi) hi = shadeTop[col + sizeX];
      for (let y = hi, i = y * layer + col; y >= 0; y--, i -= layer) {
        const level = outSky[i];
        if (level === 0) break; // the rest of the column is shadowed
        if (level < 2) continue;
        if (
          (x > 0 && level - STEP_LOSS[blocks[i - 1]] > outSky[i - 1]) ||
          (x < sizeX - 1 && level - STEP_LOSS[blocks[i + 1]] > outSky[i + 1]) ||
          (z > 0 && level - STEP_LOSS[blocks[i - sizeX]] > outSky[i - sizeX]) ||
          (z < sizeZ - 1 && level - STEP_LOSS[blocks[i + sizeX]] > outSky[i + sizeX])
        ) {
          queued[i] = 1;
          queue[tail++] = i;
        }
      }
    }
  }
  spread(blocks, outSky, sizeX, sizeZ, layer, volume, tail);
}

/**
 * Flood fill from the cells in queue[0..tail). A FIFO ring buffer; a cell is
 * re-queued only when its level rises and it is not already waiting, so the
 * queue never holds more than `volume` entries.
 */
function spread(blocks: Uint8Array, light: Uint8Array, sizeX: number, sizeZ: number, layer: number, volume: number, tail: number): void {
  const cap = volume + 1;
  const q = queue;
  const inQueue = queued;
  let head = 0;
  const visit = (n: number, level: number): void => {
    const v = level - STEP_LOSS[blocks[n]];
    if (v > light[n]) {
      light[n] = v;
      if (!inQueue[n]) {
        inQueue[n] = 1;
        q[tail] = n;
        if (++tail === cap) tail = 0;
      }
    }
  };
  while (head !== tail) {
    const i = q[head];
    if (++head === cap) head = 0;
    inQueue[i] = 0;
    const level = light[i];
    if (level < 2) continue;
    const x = i % sizeX;
    const z = ((i - x) / sizeX) % sizeZ;
    if (x > 0) visit(i - 1, level);
    if (x < sizeX - 1) visit(i + 1, level);
    if (z > 0) visit(i - sizeX, level);
    if (z < sizeZ - 1) visit(i + sizeX, level);
    if (i >= layer) visit(i - layer, level);
    if (i + layer < volume) visit(i + layer, level);
  }
}
