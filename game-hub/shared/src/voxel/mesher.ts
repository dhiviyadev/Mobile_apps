/**
 * Greedy mesher with per-vertex ambient occlusion and smooth lighting.
 *
 * Input is a "region": the 16xHx16 chunk plus its 8 neighbours (48xHx48),
 * where H is the tallest of the 9 chunk arrays (see chunk.ts: chunk arrays
 * hold whole 16-high sections up to what is built, at most 256). Light (see
 * light.ts) is computed over the whole region, which makes it exact for the
 * centre chunk; faces and AO only look one block past the chunk edge.
 * Work follows what is built: light stops MAX_LIGHT layers above the highest
 * block of the region (all air and full sky light above), and faces and
 * shapes are only built in the centre chunk's sections that hold blocks.
 * Runs inside Web Workers on the client.
 *
 * Output: two vertex buffers per chunk:
 *   - opaque: solid + alpha-tested blocks (leaves, glass), lava, and every
 *     non-cube shape (plants, slabs, torches, ladders...: a second, non-greedy pass)
 *   - liquid: water (alpha-blended pass)
 * plus the centre chunk's light levels (for lighting things that are not
 * terrain, such as the held block).
 *
 * Vertex layout (non-interleaved):
 *   position Float32x3 (chunk-local), uv Float32x2 (in blocks, tiled in the
 *   shader with fract()), tile Uint8x2 (atlas col,row), light Uint8x4
 *   (face shade * AO, sky light, block light, emissive flag).
 *
 * Vertex light is the average over the open cells among the 4 in front of the
 * face that touch the vertex (the AO cells). Faces are only merged when AO and
 * light are uniform across them, which keeps lighting exact while still
 * collapsing large flat areas (fields, cliffs, sea, dark caves) into few quads.
 */
import {
  ATLAS_COLS,
  Block,
  BlockShape,
  IS_DECOR,
  IS_EMISSIVE,
  IS_LIQUID,
  IS_TRANSPARENT,
  isWater,
  LIQUID_HEIGHT,
  SHAPE,
  SHAPE_BOUNDS,
  TILE_BOTTOM,
  TILE_SIDE,
  TILE_TOP,
  USE_NEIGHBOUR_LIGHT,
} from './blocks';
import { chunkLayers, topOfContent } from './chunk';
import { CHUNK_HEIGHT, CHUNK_LAYER, CHUNK_SIZE, SECTION_HEIGHT } from './constants';
import { changesLight, computeLight, lightAboveTop, MAX_LIGHT } from './light';

export const REGION_SIZE = CHUNK_SIZE * 3; // 48
/** Cells in one layer of a region. */
export const REGION_LAYER = REGION_SIZE * REGION_SIZE;
/** Cells in a full-height region; most regions are shorter (regionLayers). */
export const REGION_VOLUME = REGION_LAYER * CHUNK_HEIGHT;
export { ATLAS_COLS };

/** Layers a region array holds (above: air). */
export const regionLayers = (region: Uint8Array): number => (region.length / REGION_LAYER) | 0;

/** Offset of the centre chunk inside the region on x and z. */
const BORDER = CHUNK_SIZE;

/** Index into a region; x,z chunk-local in [-16, 31] (centre chunk 0..15), y in [0, regionLayers). */
export const regionIndex = (x: number, y: number, z: number): number => (y * REGION_SIZE + (z + BORDER)) * REGION_SIZE + (x + BORDER);

/** 32-bit view of a byte array, or null when it is not 4-byte aligned. */
const asWords = (a: Uint8Array): Uint32Array | null =>
  (a.byteOffset & 3) === 0 && (a.length & 3) === 0 ? new Uint32Array(a.buffer, a.byteOffset, a.length >> 2) : null;

/**
 * Copies a chunk and its 8 neighbours into one region, as tall as the tallest
 * of them (at least one section). `chunks` holds 9 block arrays row by row,
 * index (dz + 1) * 3 + (dx + 1); missing ones and the layers above a shorter
 * one read as air. `out` is a buffer to reuse when it is large enough: the
 * result is then a view of its start. Runs on the main thread for every mesh
 * job, so rows are copied 4 bytes at a time.
 */
export function buildRegion(chunks: readonly (Uint8Array | null)[], out?: Uint8Array): Uint8Array {
  const S = CHUNK_SIZE;
  let layers = SECTION_HEIGHT;
  for (const c of chunks) if (c && chunkLayers(c) > layers) layers = chunkLayers(c);
  const size = layers * REGION_LAYER;
  const region = out && out.length >= size ? out.subarray(0, size) : new Uint8Array(size);
  const out32 = asWords(region);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const src = chunks[j * 3 + i];
      const src32 = src && out32 ? asWords(src) : null;
      const srcLayers = src ? chunkLayers(src) : 0;
      for (let y = 0; y < layers; y++) {
        for (let z = 0; z < S; z++) {
          let d = (y * REGION_SIZE + j * S + z) * REGION_SIZE + i * S;
          let s = (y * S + z) * S;
          if (y >= srcLayers) {
            region.fill(0, d, d + S);
          } else if (src32 && out32) {
            d >>= 2;
            s >>= 2;
            for (let k = 0; k < S >> 2; k++) out32[d + k] = src32[s + k];
          } else {
            for (let k = 0; k < S; k++) region[d++] = src![s++];
          }
        }
      }
    }
  }
  return region;
}

// ---- region dependencies (used by the client World for remeshing and streaming) ----

/**
 * True when the mesh of the neighbouring chunk at offset (dx, dz) can change after
 * the block at chunk-local (lx, lz) changes from `old` (null when unknown) to `id`.
 * A mesh reads blocks one past its chunk edge (face culling, AO), and an edit that
 * changes light moves it at most MAX_LIGHT - 1 blocks sideways (sky light only
 * falls without loss inside its own column). Keep in step with meshChunk: a test
 * meshes the neighbours before and after random edits.
 */
export function neighbourNeedsRemesh(dx: number, dz: number, lx: number, lz: number, old: number | null, id: number): boolean {
  // Blocks between the edit and the row of ours that the neighbour reads.
  const ex = dx > 0 ? CHUNK_SIZE - 1 - lx : dx < 0 ? lx : 0;
  const ez = dz > 0 ? CHUNK_SIZE - 1 - lz : dz < 0 ? lz : 0;
  if (ex === 0 && ez === 0) return true;
  return (old === null || changesLight(old, id)) && ex + ez < MAX_LIGHT;
}

/** True when an edit at chunk-local (lx, lz) is in the row the neighbour at (dx, dz) reads (faces, AO). */
export function editTouchesBorder(dx: number, dz: number, lx: number, lz: number): boolean {
  const ex = dx > 0 ? CHUNK_SIZE - 1 - lx : dx < 0 ? lx : 0;
  const ez = dz > 0 ? CHUNK_SIZE - 1 - lz : dz < 0 ? lz : 0;
  return ex === 0 && ez === 0;
}

/** Air, flowing or falling water: the cells the water simulation writes (never a source). */
const isFlowCell = (id: number): boolean => id === Block.Air || (isWater(id) && id !== Block.Water);

/**
 * True for a change only flowing water can make (both ids air or non-source
 * water). The client remeshes those at a lower priority and rate, so a flood
 * never holds up player edits or chunk streaming.
 */
export const isFluidOnlyChange = (old: number | null, id: number): boolean => old !== null && isFlowCell(old) && isFlowCell(id);

/**
 * Squared distance (in chunks) from the origin chunk to the nearest chunk of the
 * 3x3 region centred on (dx, dz). A chunk's blocks are needed while any chunk
 * whose region contains it is meshed.
 */
export const regionDistance = (dx: number, dz: number): number => {
  const a = Math.max(0, Math.abs(dx) - 1);
  const b = Math.max(0, Math.abs(dz) - 1);
  return a * a + b * b;
};

/**
 * Streaming rings for a render distance of r chunks, as squared chunk distances
 * from the player's chunk: chunks with dx² + dz² <= streamMeshRange(r) are meshed,
 * block data is loaded while regionDistance <= streamMeshRange(r) (so edge chunks
 * have their whole region) and unloaded once regionDistance > streamUnloadRange(r)
 * (the slack avoids reloading when walking back and forth).
 */
export const streamMeshRange = (r: number): number => (r + 0.5) * (r + 0.5);
export const streamUnloadRange = (r: number): number => (r + 2) * (r + 2);

export interface MeshBuffers {
  positions: Float32Array;
  uvs: Float32Array;
  tiles: Uint8Array;
  lights: Uint8Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
}

export interface ChunkMesh {
  opaque: MeshBuffers;
  liquid: MeshBuffers;
  /**
   * Light of the centre chunk's cells (blockIndex order): sky << 4 | block, for
   * its lower layers only; every cell above them is open sky (sky 15, block 0).
   */
  light: Uint8Array;
}

const AO_CURVE = [0.5, 0.68, 0.84, 1];
/** Directional shading per face: +x, -x, +y, -y, +z, -z. */
const FACE_SHADE = [0.82, 0.82, 1, 0.55, 0.68, 0.68];
/** Approximate brightness of a vertex light byte (matches the shader curve); picks quad diagonals. */
const BRIGHTNESS = new Float32Array(256);
for (let v = 0; v < 256; v++) BRIGHTNESS[v] = Math.pow(0.8, ((255 - v) / 255) * MAX_LIGHT);

class Builder {
  positions: Float32Array;
  uvs: Float32Array;
  tiles: Uint8Array;
  lights: Uint8Array;
  indices: Uint32Array;
  v = 0;
  i = 0;

  constructor(initialQuads: number) {
    this.positions = new Float32Array(initialQuads * 12);
    this.uvs = new Float32Array(initialQuads * 8);
    this.tiles = new Uint8Array(initialQuads * 8);
    this.lights = new Uint8Array(initialQuads * 16);
    this.indices = new Uint32Array(initialQuads * 6);
  }

  reset(): void {
    this.v = 0;
    this.i = 0;
  }

  private grow(): void {
    const g = <T extends Float32Array | Uint8Array | Uint32Array>(a: T): T => {
      const n = new (a.constructor as new (len: number) => T)(a.length * 2);
      n.set(a);
      return n;
    };
    this.positions = g(this.positions);
    this.uvs = g(this.uvs);
    this.tiles = g(this.tiles);
    this.lights = g(this.lights);
    this.indices = g(this.indices);
  }

  /**
   * corners: 4 xyz points CCW as seen from the front; uvCorners: 4 uv pairs;
   * shade: 4 face shade * AO values (0..1); sky, block: 4 light bytes (0..255).
   */
  quad(corners: number[], uvCorners: number[], tile: number, shade: number[], sky: number[], block: number[], emissive: boolean, flip: boolean): void {
    if ((this.v + 4) * 3 > this.positions.length) this.grow();
    const base = this.v;
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    for (let k = 0; k < 4; k++) {
      const vi = this.v++;
      this.positions[vi * 3] = corners[k * 3];
      this.positions[vi * 3 + 1] = corners[k * 3 + 1];
      this.positions[vi * 3 + 2] = corners[k * 3 + 2];
      this.uvs[vi * 2] = uvCorners[k * 2];
      this.uvs[vi * 2 + 1] = uvCorners[k * 2 + 1];
      this.tiles[vi * 2] = col;
      this.tiles[vi * 2 + 1] = row;
      this.lights[vi * 4] = Math.round(shade[k] * 255);
      this.lights[vi * 4 + 1] = sky[k];
      this.lights[vi * 4 + 2] = block[k];
      this.lights[vi * 4 + 3] = emissive ? 255 : 0;
    }
    const idx = this.indices;
    let n = this.i;
    if (!flip) {
      idx[n++] = base; idx[n++] = base + 1; idx[n++] = base + 2;
      idx[n++] = base; idx[n++] = base + 2; idx[n++] = base + 3;
    } else {
      idx[n++] = base + 1; idx[n++] = base + 2; idx[n++] = base + 3;
      idx[n++] = base + 1; idx[n++] = base + 3; idx[n++] = base;
    }
    this.i = n;
  }

  finish(): MeshBuffers {
    const vc = this.v;
    const indices = vc > 65535 ? this.indices.slice(0, this.i) : Uint16Array.from(this.indices.subarray(0, this.i));
    return {
      positions: this.positions.slice(0, vc * 3),
      uvs: this.uvs.slice(0, vc * 2),
      tiles: this.tiles.slice(0, vc * 2),
      lights: this.lights.slice(0, vc * 4),
      indices,
      vertexCount: vc,
    };
  }
}

// Reused between calls (meshing runs single-threaded inside each worker).
let opaqueBuilder: Builder | null = null;
let liquidBuilder: Builder | null = null;
const mask = new Int32Array(CHUNK_HEIGHT * CHUNK_SIZE);
/** Per-face vertex light, one byte per corner: sky and block. */
const skyMask = new Int32Array(CHUNK_HEIGHT * CHUNK_SIZE);
const blockMask = new Int32Array(CHUNK_HEIGHT * CHUNK_SIZE);
/** Region light plus one extra layer above the world (open sky; block light from lightAboveTop). */
let skyLight = new Uint8Array(0);
let blockLight = new Uint8Array(0);
/** Sections (bit per SECTION_HEIGHT layers) of the centre chunk that hold any block. */
let centreSections = 0;
/** Per layer of the centre chunk: bit z set when its row of 16 cells (all x) holds any block. */
const centreRows = new Uint16Array(CHUNK_HEIGHT);

/** Mesh extent per axis; y is the centre chunk's highest block + 1 (set per mesh). */
const DIMS = [CHUNK_SIZE, 0, CHUNK_SIZE];
/**
 * Light is computed this many layers above the highest block of a region: no
 * light reaches further up (MAX_LIGHT levels), so the cells above are exactly
 * open sky without any propagation.
 */
const LIGHT_HEADROOM = MAX_LIGHT;

/** True when all 4 bytes of a packed per-corner value are equal. */
const uniformBytes = (bits: number): boolean => bits === Math.imul(bits & 0xff, 0x01010101);

/** Average of `n` light levels summing to `sum`, as a 0..255 byte. */
const lightByte = (sum: number, n: number): number => Math.round((sum * 17) / n);

export interface MeshOptions {
  /** Draw dense ground cover (tall grass, ferns, dry grass). False on the 'low' quality preset. Default true. */
  decor?: boolean;
}

/** Scratch list for the light fix-up: index, sky, block per entry. */
let fixups = new Int32Array(0);

/**
 * Light-opaque blocks that are not full cubes (slabs, chests, cactus) are dark
 * inside: they take the brightest light of their 6 neighbours instead (not
 * propagated further). Covers the cells one past the chunk edge that faces read.
 */
function fixNeighbourLight(region: Uint8Array, sky: Uint8Array, blk: Uint8Array, top: number): void {
  const S = REGION_SIZE;
  const layer = S * S;
  let n = 0;
  for (let y = 0; y < top; y++) {
    for (let z = -1; z <= CHUNK_SIZE; z++) {
      for (let x = -1; x <= CHUNK_SIZE; x++) {
        const i = regionIndex(x, y, z);
        if (!USE_NEIGHBOUR_LIGHT[region[i]]) continue;
        let s = Math.max(sky[i + 1], sky[i - 1], sky[i + S], sky[i - S], sky[i + layer]);
        let b = Math.max(blk[i + 1], blk[i - 1], blk[i + S], blk[i - S], blk[i + layer]);
        if (y > 0) {
          s = Math.max(s, sky[i - layer]);
          b = Math.max(b, blk[i - layer]);
        }
        if (fixups.length < (n + 1) * 3) {
          const grown = new Int32Array(Math.max(96, fixups.length * 2));
          grown.set(fixups);
          fixups = grown;
        }
        fixups[n * 3] = i;
        fixups[n * 3 + 1] = s;
        fixups[n * 3 + 2] = b;
        n++;
      }
    }
  }
  for (let k = 0; k < n; k++) {
    sky[fixups[k * 3]] = fixups[k * 3 + 1];
    blk[fixups[k * 3]] = fixups[k * 3 + 2];
  }
}

/**
 * Lights the region (see light.ts) and builds the mesh for its centre chunk.
 */
export function meshChunk(region: Uint8Array, opts: MeshOptions = {}): ChunkMesh {
  opaqueBuilder ??= new Builder(4096);
  liquidBuilder ??= new Builder(1024);
  opaqueBuilder.reset();
  liquidBuilder.reset();
  const height = regionLayers(region);
  // Highest block of the whole region; the centre chunk's highest block and the sections holding blocks.
  const top = topOfContent(region, REGION_LAYER, height);
  const meshTop = scanCentre(region, top);
  // Light box: up to LIGHT_HEADROOM layers above the highest block (exact, see there), plus one
  // layer above the box for faces at its top (open sky; block light from lightAboveTop).
  const lightTop = Math.min(height, top + LIGHT_HEADROOM);
  const lightSize = (lightTop + 1) * REGION_LAYER;
  if (skyLight.length < lightSize) {
    skyLight = new Uint8Array(lightSize);
    blockLight = new Uint8Array(lightSize);
  }
  computeLight(region, REGION_SIZE, lightTop, REGION_SIZE, skyLight, blockLight);
  skyLight.fill(MAX_LIGHT, lightTop * REGION_LAYER, lightSize);
  lightAboveTop(blockLight, REGION_SIZE, lightTop, REGION_SIZE);
  fixNeighbourLight(region, skyLight, blockLight, top);
  const sky = skyLight;
  const blk = blockLight;
  DIMS[1] = meshTop;

  const get = (x: number, y: number, z: number): number => {
    if (y < 0) return 14; // bedrock below the world: never show bottom faces
    if (y >= height) return 0;
    return region[regionIndex(x, y, z)];
  };
  const opaqueAt = (x: number, y: number, z: number): number => (IS_TRANSPARENT[get(x, y, z)] ? 0 : 1);
  /** Top of a liquid cell: full when more liquid sits on it, else its surface height. */
  const liquidTop = (x: number, y: number, z: number, id: number): number => (IS_LIQUID[get(x, y + 1, z)] ? 1 : LIQUID_HEIGHT[id]);

  const pos = [0, 0, 0];
  const q = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const uAxis = (axis + 1) % 3;
    const vAxis = (axis + 2) % 3;
    const du = DIMS[uAxis];
    const dv = DIMS[vAxis];
    const eu = [uAxis === 0 ? 1 : 0, uAxis === 1 ? 1 : 0, uAxis === 2 ? 1 : 0];
    const ev = [vAxis === 0 ? 1 : 0, vAxis === 1 ? 1 : 0, vAxis === 2 ? 1 : 0];
    for (let sign = 1; sign >= -1; sign -= 2) {
      const face = axis * 2 + (sign > 0 ? 0 : 1);
      for (let slice = 0; slice < DIMS[axis]; slice++) {
        // Empty layers and rows have no faces: skipped (the mask is all zero between slices).
        if (axis === 1 && centreRows[slice] === 0) continue;
        // ---- build the mask for this slice --------------------------------------
        for (let v = 0; v < dv; v++) {
          for (let u = 0; u < du; u++) {
            pos[axis] = slice;
            pos[uAxis] = u;
            pos[vAxis] = v;
            if (!(centreRows[pos[1]] & (1 << pos[2]))) continue;
            const b = get(pos[0], pos[1], pos[2]);
            let key = 0;
            let skyBits = 0;
            let blockBits = 0;
            if (b !== 0 && SHAPE[b] === BlockShape.Cube) {
              q[0] = pos[0];
              q[1] = pos[1];
              q[2] = pos[2];
              q[axis] += sign;
              const n = get(q[0], q[1], q[2]);
              let visible: boolean;
              // Liquid beside a lower liquid surface: only the strip above that surface shows.
              let lower = 0;
              if (IS_LIQUID[b] && IS_LIQUID[n] && isWater(b) === isWater(n)) {
                visible = axis !== 1 && liquidTop(pos[0], pos[1], pos[2], b) > liquidTop(q[0], q[1], q[2], n);
                lower = n;
              } else if (IS_LIQUID[b]) {
                // A surface below the block above still shows: it sits lower than that block.
                visible = IS_TRANSPARENT[n] === 1 || (axis === 1 && sign > 0 && (n === 0 || LIQUID_HEIGHT[b] < 1));
              } else if (IS_TRANSPARENT[b]) visible = n !== b && IS_TRANSPARENT[n] === 1;
              else visible = IS_TRANSPARENT[n] === 1;
              if (visible) {
                const emissive = IS_EMISSIVE[b] === 1;
                // The cell in front of a visible face is never opaque (y may be the light box's top: open sky).
                const qi = regionIndex(q[0], q[1], q[2]);
                // AO and smooth light for the 4 corners: (u-,v-), (u+,v-), (u+,v+), (u-,v+)
                let ao = 0;
                for (let c = 0; c < 4; c++) {
                  const ou = c === 1 || c === 2 ? 1 : -1;
                  const ov = c >= 2 ? 1 : -1;
                  const ux = eu[0] * ou, uy = eu[1] * ou, uz = eu[2] * ou;
                  const vx = ev[0] * ov, vy = ev[1] * ov, vz = ev[2] * ov;
                  const side1 = opaqueAt(q[0] + ux, q[1] + uy, q[2] + uz);
                  const side2 = opaqueAt(q[0] + vx, q[1] + vy, q[2] + vz);
                  const corner = opaqueAt(q[0] + ux + vx, q[1] + uy + vy, q[2] + uz + vz);
                  const level = side1 && side2 ? 0 : 3 - (side1 + side2 + corner);
                  ao |= level << (c * 2);
                  if (emissive) continue; // full-bright: world light is ignored
                  // Average the open cells; the corner is hidden when both sides are walls.
                  let cells = 1;
                  let s = sky[qi];
                  let l = blk[qi];
                  if (!side1) {
                    const i = qi + ux + (uy * REGION_SIZE + uz) * REGION_SIZE;
                    s += sky[i];
                    l += blk[i];
                    cells++;
                  }
                  if (!side2) {
                    const i = qi + vx + (vy * REGION_SIZE + vz) * REGION_SIZE;
                    s += sky[i];
                    l += blk[i];
                    cells++;
                  }
                  if (!corner && !(side1 && side2)) {
                    const i = qi + ux + vx + ((uy + vy) * REGION_SIZE + uz + vz) * REGION_SIZE;
                    s += sky[i];
                    l += blk[i];
                    cells++;
                  }
                  skyBits |= lightByte(s, cells) << (c * 8);
                  blockBits |= lightByte(l, cells) << (c * 8);
                }
                // Liquids: skip AO; flag surface blocks so their quads drop to the
                // surface height, and keep the lower neighbour for strips above it.
                if (IS_LIQUID[b]) {
                  const above = get(pos[0], pos[1] + 1, pos[2]);
                  ao = 0xff | (IS_LIQUID[above] ? 0 : 1 << 8) | (lower << 9);
                  if (!IS_TRANSPARENT[n]) {
                    // Under a solid block the cell in front is dark: light the surface from the water itself.
                    const pi = regionIndex(pos[0], pos[1], pos[2]);
                    skyBits = Math.imul(lightByte(sky[pi], 1), 0x01010101);
                    blockBits = Math.imul(lightByte(blk[pi], 1), 0x01010101);
                  }
                }
                key = b | (ao << 8) | (1 << 30);
              }
            }
            const mi = v * du + u;
            mask[mi] = key;
            skyMask[mi] = skyBits;
            blockMask[mi] = blockBits;
          }
        }

        // ---- greedy merge ----------------------------------------------------------
        for (let v = 0; v < dv; v++) {
          for (let u = 0; u < du; ) {
            const mi = v * du + u;
            const key = mask[mi];
            if (key === 0) {
              u++;
              continue;
            }
            const skyBits = skyMask[mi];
            const blockBits = blockMask[mi];
            const aoBits = (key >> 8) & 0xff;
            const uniform =
              (aoBits === 0 || aoBits === 0x55 || aoBits === 0xaa || aoBits === 0xff) && uniformBytes(skyBits) && uniformBytes(blockBits);
            let w = 1;
            let h = 1;
            if (uniform) {
              for (let j = mi + 1; u + w < du && mask[j] === key && skyMask[j] === skyBits && blockMask[j] === blockBits; j++) w++;
              outer: while (v + h < dv) {
                for (let k = 0, j = (v + h) * du + u; k < w; k++, j++) {
                  if (mask[j] !== key || skyMask[j] !== skyBits || blockMask[j] !== blockBits) break outer;
                }
                h++;
              }
            }
            for (let hv = 0; hv < h; hv++) for (let k = 0; k < w; k++) mask[(v + hv) * du + u + k] = 0;
            emitQuad(key, skyBits, blockBits, axis, uAxis, vAxis, sign, face, slice, u, v, w, h);
            u += w;
          }
        }
      }
    }
  }

  emitShapes(get, sky, blk, opts.decor !== false, meshTop);

  // Centre chunk light for the layers of the light box (above it: open sky, see ChunkMesh.light).
  const light = new Uint8Array(lightTop * CHUNK_LAYER);
  for (let y = 0, o = 0; y < lightTop; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0, ri = regionIndex(0, y, z); x < CHUNK_SIZE; x++, ri++, o++) light[o] = (sky[ri] << 4) | blk[ri];
    }
  }
  return { opaque: opaqueBuilder.finish(), liquid: liquidBuilder.finish(), light };
}

/**
 * Sets centreRows and centreSections from the centre chunk's cells below `top`
 * (the region's highest block + 1) and returns the centre chunk's highest block + 1.
 */
function scanCentre(region: Uint8Array, top: number): number {
  centreSections = 0;
  centreRows.fill(0);
  let meshTop = 0;
  // Each row of the centre chunk is 4 aligned words (it starts 16 cells into a 48-cell row).
  const words = (region.byteOffset & 3) === 0 ? new Uint32Array(region.buffer, region.byteOffset, (top * REGION_LAYER) >> 2) : null;
  for (let y = 0; y < top; y++) {
    let rows = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const i = regionIndex(0, y, z);
      let any = false;
      if (words) {
        const w = i >> 2;
        any = (words[w] | words[w + 1] | words[w + 2] | words[w + 3]) !== 0;
      } else {
        for (let x = 0; x < CHUNK_SIZE && !any; x++) any = region[i + x] !== 0;
      }
      if (any) rows |= 1 << z;
    }
    centreRows[y] = rows;
    if (rows) {
      centreSections |= 1 << (y >> 4);
      meshTop = y + 1;
    }
  }
  return meshTop;
}

const corners = new Array<number>(12);
const uvc = new Array<number>(8);
const shade = [0, 0, 0, 0];
const skyV = [0, 0, 0, 0];
const blockV = [0, 0, 0, 0];
const bright = [0, 0, 0, 0];
const cu = [0, 0, 0, 0];
const cv = [0, 0, 0, 0];
const p = [0, 0, 0];
const ORDER_POS = [0, 1, 2, 3];
const ORDER_NEG = [0, 3, 2, 1];

function emitQuad(
  key: number,
  skyBits: number,
  blockBits: number,
  axis: number,
  uAxis: number,
  vAxis: number,
  sign: number,
  face: number,
  slice: number,
  u: number,
  v: number,
  w: number,
  h: number,
): void {
  const b = key & 0xff;
  const liquid = IS_LIQUID[b] === 1;
  const surface = liquid && ((key >> 16) & 1) === 1;
  const lower = liquid ? (key >> 17) & 0xff : 0;
  const drop = surface ? 1 - LIQUID_HEIGHT[b] : 0;
  const ao = (key >> 8) & 0xff;
  const plane = slice + (sign > 0 ? 1 : 0);
  // Corner order (u,v): (0,0) (1,0) (1,1) (0,1) is CCW for the +axis face.
  cu[0] = u; cu[1] = u + w; cu[2] = u + w; cu[3] = u;
  cv[0] = v; cv[1] = v; cv[2] = v + h; cv[3] = v + h;
  // Side faces of liquids: the top edge is wherever Y is largest, the bottom edge where it is smallest.
  const topY = uAxis === 1 ? u + w : vAxis === 1 ? v + h : -1;
  const bottomY = uAxis === 1 ? u : vAxis === 1 ? v : -1;
  const order = sign > 0 ? ORDER_POS : ORDER_NEG;
  for (let k = 0; k < 4; k++) {
    const c = order[k];
    p[axis] = plane;
    p[uAxis] = cu[c];
    p[vAxis] = cv[c];
    if (liquid) {
      if (axis === 1) {
        if (sign > 0) p[1] -= drop;
      } else if (p[1] === topY) p[1] -= drop;
      else if (lower !== 0 && p[1] === bottomY) p[1] += LIQUID_HEIGHT[lower];
    }
    corners[k * 3] = p[0];
    corners[k * 3 + 1] = p[1];
    corners[k * 3 + 2] = p[2];
    // Texture coordinates: side faces keep "up" = +Y and are not mirrored.
    const lu = cu[c] - u;
    const lv = cv[c] - v;
    if (axis === 0) {
      uvc[k * 2] = sign > 0 ? h - lv : lv; // horizontal = z
      uvc[k * 2 + 1] = lu; // vertical = y
    } else if (axis === 2) {
      uvc[k * 2] = sign > 0 ? lu : w - lu; // horizontal = x
      uvc[k * 2 + 1] = lv; // vertical = y
    } else {
      uvc[k * 2] = lv;
      uvc[k * 2 + 1] = lu;
    }
    const level = liquid ? 3 : (ao >> (c * 2)) & 3;
    shade[k] = FACE_SHADE[face] * AO_CURVE[level];
    skyV[k] = (skyBits >>> (c * 8)) & 0xff;
    blockV[k] = (blockBits >>> (c * 8)) & 0xff;
    bright[k] = shade[k] * BRIGHTNESS[Math.max(skyV[k], blockV[k])];
  }
  const tile = axis === 1 ? (sign > 0 ? TILE_TOP[b] : TILE_BOTTOM[b]) : TILE_SIDE[b];
  // Split the quad along the diagonal that keeps light gradients symmetric.
  const flip = bright[0] + bright[2] < bright[1] + bright[3];
  (liquid && b !== Block.Lava ? liquidBuilder! : opaqueBuilder!).quad(corners, uvc, tile, shade, skyV, blockV, IS_EMISSIVE[b] === 1, flip);
}

// ---- special shapes (plants, slabs, torches, ladders, lily pads) -------------------------

const sc = new Array<number>(12);
const suv = new Array<number>(8);
const sShade = [0, 0, 0, 0];
const sSky = [0, 0, 0, 0];
const sBlk = [0, 0, 0, 0];

/** Uniform-light quad in the opaque buffer (corners CCW from the front); `both` also emits the back side. */
function shapeQuad(c: number[], uv: number[], tile: number, shadeV: number, skyB: number, blkB: number, emissive: boolean, both: boolean): void {
  sShade.fill(shadeV);
  sSky.fill(skyB);
  sBlk.fill(blkB);
  opaqueBuilder!.quad(c, uv, tile, sShade, sSky, sBlk, emissive, false);
  if (!both) return;
  const rc = [c[9], c[10], c[11], c[6], c[7], c[8], c[3], c[4], c[5], c[0], c[1], c[2]];
  const ruv = [uv[6], uv[7], uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]];
  opaqueBuilder!.quad(rc, ruv, tile, sShade, sSky, sBlk, emissive, false);
}

const setCorner = (k: number, x: number, y: number, z: number, u: number, v: number): void => {
  sc[k * 3] = x;
  sc[k * 3 + 1] = y;
  sc[k * 3 + 2] = z;
  suv[k * 2] = u;
  suv[k * 2 + 1] = v;
};

/**
 * The 6 faces of a box at cell (x, y, z) with cell-relative bounds (block
 * units), in FACE_SHADE order (+x, -x, +y, -y, +z, -z). Corners are CCW seen
 * from outside; UVs are the matching part of the tile (side faces keep "up" =
 * +Y and are not mirrored, like the greedy faces). Shared with the client's
 * held-block geometry. `emit(face)` false skips a face.
 */
export function boxFaces(
  x: number, y: number, z: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  emit: (face: number) => boolean,
  out: (face: number, corners: number[], uvs: number[]) => void,
): void {
  const X0 = x + x0, X1 = x + x1, Y0 = y + y0, Y1 = y + y1, Z0 = z + z0, Z1 = z + z1;
  if (emit(0)) {
    setCorner(0, X1, Y0, Z1, 1 - z1, y0); setCorner(1, X1, Y0, Z0, 1 - z0, y0); setCorner(2, X1, Y1, Z0, 1 - z0, y1); setCorner(3, X1, Y1, Z1, 1 - z1, y1);
    out(0, sc, suv);
  }
  if (emit(1)) {
    setCorner(0, X0, Y0, Z0, z0, y0); setCorner(1, X0, Y0, Z1, z1, y0); setCorner(2, X0, Y1, Z1, z1, y1); setCorner(3, X0, Y1, Z0, z0, y1);
    out(1, sc, suv);
  }
  if (emit(2)) {
    setCorner(0, X0, Y1, Z0, x0, z0); setCorner(1, X0, Y1, Z1, x0, z1); setCorner(2, X1, Y1, Z1, x1, z1); setCorner(3, X1, Y1, Z0, x1, z0);
    out(2, sc, suv);
  }
  if (emit(3)) {
    setCorner(0, X0, Y0, Z0, x0, z0); setCorner(1, X1, Y0, Z0, x1, z0); setCorner(2, X1, Y0, Z1, x1, z1); setCorner(3, X0, Y0, Z1, x0, z1);
    out(3, sc, suv);
  }
  if (emit(4)) {
    setCorner(0, X0, Y0, Z1, x0, y0); setCorner(1, X1, Y0, Z1, x1, y0); setCorner(2, X1, Y1, Z1, x1, y1); setCorner(3, X0, Y1, Z1, x0, y1);
    out(4, sc, suv);
  }
  if (emit(5)) {
    setCorner(0, X1, Y0, Z0, 1 - x1, y0); setCorner(1, X0, Y0, Z0, 1 - x0, y0); setCorner(2, X0, Y1, Z0, 1 - x0, y1); setCorner(3, X1, Y1, Z0, 1 - x1, y1);
    out(5, sc, suv);
  }
}

/**
 * The planes of a sprite-like shape (Cross: 2 diagonal planes; Pad: 1
 * horizontal; Ladder: 1 vertical against its wall) for block `b` at cell
 * (x, y, z). Each is drawn from both sides. `jitter` nudges plants (x, z).
 */
export function spritePlanes(b: number, x: number, y: number, z: number, jx: number, jz: number, out: (corners: number[], uvs: number[]) => void): void {
  const o = b * 6;
  const bx0 = SHAPE_BOUNDS[o], by0 = SHAPE_BOUNDS[o + 1], bz0 = SHAPE_BOUNDS[o + 2];
  const bx1 = SHAPE_BOUNDS[o + 3], by1 = SHAPE_BOUNDS[o + 4], bz1 = SHAPE_BOUNDS[o + 5];
  const shape = SHAPE[b];
  if (shape === BlockShape.Cross) {
    const h = by1;
    const ax = x + CROSS_LO + jx, bx = x + CROSS_HI + jx;
    const az = z + CROSS_LO + jz, bz = z + CROSS_HI + jz;
    setCorner(0, ax, y, az, 0, 0); setCorner(1, bx, y, bz, 1, 0); setCorner(2, bx, y + h, bz, 1, h); setCorner(3, ax, y + h, az, 0, h);
    out(sc, suv);
    setCorner(0, ax, y, bz, 0, 0); setCorner(1, bx, y, az, 1, 0); setCorner(2, bx, y + h, az, 1, h); setCorner(3, ax, y + h, bz, 0, h);
    out(sc, suv);
  } else if (shape === BlockShape.Pad) {
    const py = y + by0;
    setCorner(0, x + bx0, py, z + bz0, bx0, 1 - bz0); setCorner(1, x + bx0, py, z + bz1, bx0, 1 - bz1); setCorner(2, x + bx1, py, z + bz1, bx1, 1 - bz1); setCorner(3, x + bx1, py, z + bz0, bx1, 1 - bz0);
    out(sc, suv);
  } else if (shape === BlockShape.Ladder) {
    const t = 1 / 16;
    if (bz1 - bz0 < 0.5) {
      const pz = z + (bz0 === 0 ? t : 1 - t);
      setCorner(0, x, y, pz, 0, 0); setCorner(1, x + 1, y, pz, 1, 0); setCorner(2, x + 1, y + 1, pz, 1, 1); setCorner(3, x, y + 1, pz, 0, 1);
    } else {
      const px = x + (bx0 === 0 ? t : 1 - t);
      setCorner(0, px, y, z + 1, 0, 0); setCorner(1, px, y, z, 1, 0); setCorner(2, px, y + 1, z, 1, 1); setCorner(3, px, y + 1, z + 1, 0, 1);
    }
    out(sc, suv);
  }
}

/** Face directions in FACE_SHADE order: +x, -x, +y, -y, +z, -z. */
const FACE_DIR = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const CROSS_LO = 0.146;
const CROSS_HI = 0.854;

/** Second pass: every non-cube cell of the centre chunk; not merged, no AO, lit by its own (fixed-up) cell. */
function emitShapes(get: (x: number, y: number, z: number) => number, sky: Uint8Array, blk: Uint8Array, decor: boolean, meshTop: number): void {
  for (let y = 0; y < meshTop; y++) {
    if (!(centreSections & (1 << (y >> 4)))) {
      y |= SECTION_HEIGHT - 1; // skip the rest of an empty section
      continue;
    }
    const rows = centreRows[y];
    for (let z = 0; z < CHUNK_SIZE; z++) {
      if (!(rows & (1 << z))) continue;
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const b = get(x, y, z);
        const shape = SHAPE[b];
        if (shape === BlockShape.Cube) continue;
        if (!decor && IS_DECOR[b]) continue;
        const ri = regionIndex(x, y, z);
        const emissive = IS_EMISSIVE[b] === 1;
        const skyB = lightByte(sky[ri], 1);
        const blkB = lightByte(blk[ri], 1);
        if (shape === BlockShape.Box) {
          const o = b * 6;
          const bx0 = SHAPE_BOUNDS[o], by0 = SHAPE_BOUNDS[o + 1], bz0 = SHAPE_BOUNDS[o + 2];
          const bx1 = SHAPE_BOUNDS[o + 3], by1 = SHAPE_BOUNDS[o + 4], bz1 = SHAPE_BOUNDS[o + 5];
          boxFaces(
            x, y, z, bx0, by0, bz0, bx1, by1, bz1,
            (face) => {
              // Only faces on the cell boundary can be hidden: by an opaque neighbour or the same block.
              const onEdge = face === 0 ? bx1 === 1 : face === 1 ? bx0 === 0 : face === 2 ? by1 === 1 : face === 3 ? by0 === 0 : face === 4 ? bz1 === 1 : bz0 === 0;
              if (!onEdge) return true;
              const d = FACE_DIR[face];
              const n = get(x + d[0], y + d[1], z + d[2]);
              return IS_TRANSPARENT[n] === 1 && n !== b;
            },
            (face, c, uv) => shapeQuad(c, uv, face === 2 ? TILE_TOP[b] : face === 3 ? TILE_BOTTOM[b] : TILE_SIDE[b], FACE_SHADE[face], skyB, blkB, emissive, false),
          );
        } else {
          let jx = 0;
          let jz = 0;
          if (shape === BlockShape.Cross) {
            // Plants are nudged per cell so fields of grass do not line up.
            const hsh = Math.imul((x * 73856093) ^ (y * 19349663) ^ (z * 83492791), 1);
            jx = ((hsh & 3) - 1.5) * 0.06;
            jz = (((hsh >> 2) & 3) - 1.5) * 0.06;
          }
          const tile = shape === BlockShape.Pad ? TILE_TOP[b] : TILE_SIDE[b];
          spritePlanes(b, x, y, z, jx, jz, (c, uv) => shapeQuad(c, uv, tile, 0.9, skyB, blkB, emissive, true));
        }
      }
    }
  }
}

