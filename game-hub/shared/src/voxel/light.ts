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
import { BLOCKS } from './blocks';
import { CHUNK_HEIGHT, TERRAIN_HEIGHT } from './constants';
import type { BlockQuery } from './physics';

export const MAX_LIGHT = 15;

/** Light emitted by each block id (BlockDef.light). */
export const LIGHT_EMISSION = new Uint8Array(256);
/** 1 for blocks that stop light (BlockDef.lightOpaque). */
export const LIGHT_OPAQUE = new Uint8Array(256);
/** Extra levels lost when light enters a block, on top of 1 per step (BlockDef.lightCost). */
export const LIGHT_COST = new Uint8Array(256);
/** Levels lost stepping into a block (opaque blocks lose everything). */
const STEP_LOSS = new Uint8Array(256);
/** Packed for the full-volume pass: sky light lost falling into a block (low 4 bits), emission << 4. */
const FALL = new Uint8Array(256);
for (const d of BLOCKS) {
  if (!d) continue;
  LIGHT_EMISSION[d.id] = d.light;
  LIGHT_OPAQUE[d.id] = d.lightOpaque ? 1 : 0;
  LIGHT_COST[d.id] = d.lightCost;
}
for (let id = 0; id < 256; id++) {
  STEP_LOSS[id] = LIGHT_OPAQUE[id] ? MAX_LIGHT + 1 : 1 + LIGHT_COST[id];
  FALL[id] = (LIGHT_OPAQUE[id] ? MAX_LIGHT : LIGHT_COST[id]) | (LIGHT_EMISSION[id] << 4);
}

/**
 * Approximate light at a cell without a region pass (server spawn checks; the
 * server has no mesher light): `sky` if no light-opaque block is above the cell
 * in its column, else 0; maxed with the best emitter estimate within Chebyshev
 * radius 7 (emission - Manhattan distance). About 2.2k block reads.
 */
export function approxLight(get: BlockQuery, x: number, y: number, z: number, sky = MAX_LIGHT): number {
  let best = 0;
  let open = true;
  for (let yy = y + 1; yy < CHUNK_HEIGHT; yy++) {
    if (LIGHT_OPAQUE[get(x, yy, z)]) {
      open = false;
      break;
    }
  }
  if (open) best = sky;
  if (best >= MAX_LIGHT) return best;
  for (let dy = -7; dy <= 7; dy++) {
    for (let dz = -7; dz <= 7; dz++) {
      for (let dx = -7; dx <= 7; dx++) {
        const e = LIGHT_EMISSION[get(x + dx, y + dy, z + dz)];
        if (!e) continue;
        const l = e - Math.abs(dx) - Math.abs(dy) - Math.abs(dz);
        if (l > best) best = l;
      }
    }
  }
  return best;
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
  const levels = columnLevel.subarray(0, layer);
  const words = height > TERRAIN_HEIGHT && (blocks.byteOffset & 3) === 0 && (layer & 3) === 0 ? new Uint32Array(blocks.buffer, blocks.byteOffset, volume >> 2) : null;
  let tail = 0;
  for (let y = height - 1; y >= 0; y--) {
    if (words && y >= TERRAIN_HEIGHT) {
      // Above the generated terrain only builds are solid, so most cells are air, which passes
      // the light through unchanged: copy the column levels, then visit only the 4-cell groups
      // holding blocks (the open space around a tall build costs next to nothing).
      outSky.set(levels, y * layer);
      for (let w = (y * layer) >> 2, end = w + (layer >> 2); w < end; w++) {
        if (words[w] === 0) continue;
        for (let i = w << 2, col = i - y * layer, k = 0; k < 4; k++, i++, col++) {
          const f = FALL[blocks[i]];
          if (f === 0) continue;
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
      continue;
    }
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
 * Fills the layer just above the box (y = height, open air past the build limit)
 * with the block light it would get from the top layer: one level less than the
 * cell below, then spread sideways one level per block. `outBlock` must hold that
 * extra layer. The mesher samples it for faces at the top of the world; light does
 * not flow back down from it.
 */
export function lightAboveTop(outBlock: Uint8Array, sizeX: number, height: number, sizeZ: number): void {
  const layer = sizeX * sizeZ;
  const top = (height - 1) * layer;
  const above = height * layer;
  for (let col = 0; col < layer; col++) {
    const v = outBlock[top + col];
    outBlock[above + col] = v > 0 ? v - 1 : 0;
  }
  // Every cell of the layer is air, so two raster passes give the exact spread:
  // first from the -x / -z sides, then from the +x / +z sides.
  for (let z = 0, i = above; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++, i++) {
      let v = outBlock[i];
      if (x > 0 && outBlock[i - 1] > v + 1) v = outBlock[i - 1] - 1;
      if (z > 0 && outBlock[i - sizeX] > v + 1) v = outBlock[i - sizeX] - 1;
      outBlock[i] = v;
    }
  }
  for (let z = sizeZ - 1, i = above + layer - 1; z >= 0; z--) {
    for (let x = sizeX - 1; x >= 0; x--, i--) {
      let v = outBlock[i];
      if (x < sizeX - 1 && outBlock[i + 1] > v + 1) v = outBlock[i + 1] - 1;
      if (z < sizeZ - 1 && outBlock[i + sizeX] > v + 1) v = outBlock[i + sizeX] - 1;
      outBlock[i] = v;
    }
  }
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
