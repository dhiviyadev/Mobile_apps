/**
 * Greedy mesher with per-vertex ambient occlusion and smooth lighting.
 *
 * Input is a "region": the 16x64x16 chunk plus its 8 neighbours (48x64x48).
 * Light (see light.ts) is computed over the whole region, which makes it exact
 * for the centre chunk; faces and AO only look one block past the chunk edge.
 * Runs inside Web Workers on the client.
 *
 * Output: two vertex buffers per chunk:
 *   - opaque: solid + alpha-tested blocks (leaves, glass)
 *   - liquid: water (alpha-blended pass)
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
import { IS_EMISSIVE, IS_LIQUID, IS_TRANSPARENT, TILE_BOTTOM, TILE_SIDE, TILE_TOP } from './blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE } from './constants';
import { changesLight, computeLight, lightAboveTop, MAX_LIGHT } from './light';

export const REGION_SIZE = CHUNK_SIZE * 3; // 48
export const REGION_VOLUME = REGION_SIZE * REGION_SIZE * CHUNK_HEIGHT;
export const ATLAS_COLS = 8;

/** Offset of the centre chunk inside the region on x and z. */
const BORDER = CHUNK_SIZE;

/** Index into a region; x,z chunk-local in [-16, 31] (centre chunk 0..15), y in [0, 63]. */
export const regionIndex = (x: number, y: number, z: number): number => (y * REGION_SIZE + (z + BORDER)) * REGION_SIZE + (x + BORDER);

/** 32-bit view of a byte array, or null when it is not 4-byte aligned. */
const asWords = (a: Uint8Array): Uint32Array | null =>
  (a.byteOffset & 3) === 0 && (a.length & 3) === 0 ? new Uint32Array(a.buffer, a.byteOffset, a.length >> 2) : null;

/**
 * Copies a chunk and its 8 neighbours into one region. `chunks` holds 9 block
 * arrays row by row, index (dz + 1) * 3 + (dx + 1); missing ones read as air.
 * Runs on the main thread for every mesh job, so rows are copied 4 bytes at a time.
 */
export function buildRegion(chunks: readonly (Uint8Array | null)[], out: Uint8Array = new Uint8Array(REGION_VOLUME)): Uint8Array {
  const S = CHUNK_SIZE;
  const out32 = asWords(out);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const src = chunks[j * 3 + i];
      const src32 = src && out32 ? asWords(src) : null;
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        for (let z = 0; z < S; z++) {
          let d = (y * REGION_SIZE + j * S + z) * REGION_SIZE + i * S;
          let s = (y * S + z) * S;
          if (!src) {
            out.fill(0, d, d + S);
          } else if (src32 && out32) {
            d >>= 2;
            s >>= 2;
            for (let k = 0; k < S >> 2; k++) out32[d + k] = src32[s + k];
          } else {
            for (let k = 0; k < S; k++) out[d++] = src[s++];
          }
        }
      }
    }
  }
  return out;
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
}

const AO_CURVE = [0.5, 0.68, 0.84, 1];
/** Directional shading per face: +x, -x, +y, -y, +z, -z. */
const FACE_SHADE = [0.82, 0.82, 1, 0.55, 0.68, 0.68];
const WATER_DROP = 0.125;
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
let skyLight: Uint8Array | null = null;
let blockLight: Uint8Array | null = null;

const DIMS = [CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE];

/** True when all 4 bytes of a packed per-corner value are equal. */
const uniformBytes = (bits: number): boolean => bits === Math.imul(bits & 0xff, 0x01010101);

/** Average of `n` light levels summing to `sum`, as a 0..255 byte. */
const lightByte = (sum: number, n: number): number => Math.round((sum * 17) / n);

/**
 * Lights the region (see light.ts) and builds the mesh for its centre chunk.
 */
export function meshChunk(region: Uint8Array): ChunkMesh {
  opaqueBuilder ??= new Builder(4096);
  liquidBuilder ??= new Builder(1024);
  opaqueBuilder.reset();
  liquidBuilder.reset();
  if (!skyLight || !blockLight) {
    skyLight = new Uint8Array(REGION_VOLUME + REGION_SIZE * REGION_SIZE).fill(MAX_LIGHT);
    blockLight = new Uint8Array(REGION_VOLUME + REGION_SIZE * REGION_SIZE);
  }
  computeLight(region, REGION_SIZE, CHUNK_HEIGHT, REGION_SIZE, skyLight, blockLight);
  lightAboveTop(blockLight, REGION_SIZE, CHUNK_HEIGHT, REGION_SIZE);
  const sky = skyLight;
  const blk = blockLight;

  const get = (x: number, y: number, z: number): number => {
    if (y < 0) return 14; // bedrock below the world: never show bottom faces
    if (y >= CHUNK_HEIGHT) return 0;
    return region[regionIndex(x, y, z)];
  };
  const opaqueAt = (x: number, y: number, z: number): number => (IS_TRANSPARENT[get(x, y, z)] ? 0 : 1);

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
        // ---- build the mask for this slice --------------------------------------
        for (let v = 0; v < dv; v++) {
          for (let u = 0; u < du; u++) {
            pos[axis] = slice;
            pos[uAxis] = u;
            pos[vAxis] = v;
            const b = get(pos[0], pos[1], pos[2]);
            let key = 0;
            let skyBits = 0;
            let blockBits = 0;
            if (b !== 0) {
              q[0] = pos[0];
              q[1] = pos[1];
              q[2] = pos[2];
              q[axis] += sign;
              const n = get(q[0], q[1], q[2]);
              let visible: boolean;
              if (IS_LIQUID[b]) visible = !IS_LIQUID[n] && (IS_TRANSPARENT[n] === 1 || (axis === 1 && sign > 0 && n === 0));
              else if (IS_TRANSPARENT[b]) visible = n !== b && IS_TRANSPARENT[n] === 1;
              else visible = IS_TRANSPARENT[n] === 1;
              if (visible) {
                const emissive = IS_EMISSIVE[b] === 1;
                // The cell in front of a visible face is never opaque (y may be 64: open sky).
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
                // Liquids: skip AO; flag surface blocks so their quads drop slightly.
                if (IS_LIQUID[b]) {
                  const above = get(pos[0], pos[1] + 1, pos[2]);
                  ao = 0xff | (IS_LIQUID[above] ? 0 : 1 << 8);
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

  return { opaque: opaqueBuilder.finish(), liquid: liquidBuilder.finish() };
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
  const ao = (key >> 8) & 0xff;
  const plane = slice + (sign > 0 ? 1 : 0);
  // Corner order (u,v): (0,0) (1,0) (1,1) (0,1) is CCW for the +axis face.
  cu[0] = u; cu[1] = u + w; cu[2] = u + w; cu[3] = u;
  cv[0] = v; cv[1] = v; cv[2] = v + h; cv[3] = v + h;
  // For side faces of surface water, the top edge is wherever Y is largest.
  const topY = uAxis === 1 ? u + w : vAxis === 1 ? v + h : -1;
  const order = sign > 0 ? ORDER_POS : ORDER_NEG;
  for (let k = 0; k < 4; k++) {
    const c = order[k];
    p[axis] = plane;
    p[uAxis] = cu[c];
    p[vAxis] = cv[c];
    if (surface) {
      if (axis === 1) {
        if (sign > 0) p[1] -= WATER_DROP;
      } else if (p[1] === topY) p[1] -= WATER_DROP;
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
  (liquid ? liquidBuilder! : opaqueBuilder!).quad(corners, uvc, tile, shade, skyV, blockV, IS_EMISSIVE[b] === 1, flip);
}
