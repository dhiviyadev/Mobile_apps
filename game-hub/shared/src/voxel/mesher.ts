/**
 * Greedy mesher with per-vertex ambient occlusion.
 *
 * Input is a "padded" chunk: the 16x64x16 chunk plus a 1-block border taken
 * from neighbouring chunks (18x64x18), so faces and AO at chunk edges are
 * correct without access to other chunks. Runs inside Web Workers on the client.
 *
 * Output: two vertex buffers per chunk:
 *   - opaque: solid + alpha-tested blocks (leaves, glass)
 *   - liquid: water (alpha-blended pass)
 *
 * Vertex layout (non-interleaved):
 *   position Float32x3 (chunk-local), uv Float32x2 (in blocks, tiled in the
 *   shader with fract()), tile Uint8x2 (atlas col,row), light Uint8x2
 *   (face shade * AO, emissive flag).
 *
 * Faces are only merged when their AO is uniform, which keeps lighting exact
 * while still collapsing large flat areas (fields, cliffs, sea) into few quads.
 */
import { IS_EMISSIVE, IS_LIQUID, IS_TRANSPARENT, TILE_BOTTOM, TILE_SIDE, TILE_TOP } from './blocks';
import { CHUNK_HEIGHT, CHUNK_SIZE } from './constants';

export const PAD = CHUNK_SIZE + 2; // 18
export const PADDED_VOLUME = PAD * PAD * CHUNK_HEIGHT;
export const ATLAS_COLS = 8;

/** Index into a padded volume; x,z in [-1, 16], y in [0, 63]. */
export const paddedIndex = (x: number, y: number, z: number): number => (y * PAD + (z + 1)) * PAD + (x + 1);

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
    this.lights = new Uint8Array(initialQuads * 8);
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

  /** corners: 4 xyz points CCW as seen from the front; uvCorners: 4 uv pairs. */
  quad(corners: number[], uvCorners: number[], tile: number, light: number[], emissive: boolean, flip: boolean): void {
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
      this.lights[vi * 2] = Math.round(light[k] * 255);
      this.lights[vi * 2 + 1] = emissive ? 255 : 0;
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
      lights: this.lights.slice(0, vc * 2),
      indices,
      vertexCount: vc,
    };
  }
}

// Reused between calls (meshing runs single-threaded inside each worker).
let opaqueBuilder: Builder | null = null;
let liquidBuilder: Builder | null = null;
const mask = new Int32Array(CHUNK_HEIGHT * CHUNK_SIZE);

const DIMS = [CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE];

/**
 * Builds the mesh for one chunk from its padded volume.
 */
export function meshChunk(vol: Uint8Array): ChunkMesh {
  opaqueBuilder ??= new Builder(4096);
  liquidBuilder ??= new Builder(1024);
  opaqueBuilder.reset();
  liquidBuilder.reset();

  const get = (x: number, y: number, z: number): number => {
    if (y < 0) return 14; // bedrock below the world: never show bottom faces
    if (y >= CHUNK_HEIGHT) return 0;
    return vol[paddedIndex(x, y, z)];
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
                // AO for the 4 corners: (u-,v-), (u+,v-), (u+,v+), (u-,v+)
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
                }
                // Liquids: skip AO; flag surface blocks so their quads drop slightly.
                if (IS_LIQUID[b]) {
                  const above = get(pos[0], pos[1] + 1, pos[2]);
                  ao = 0xff | (IS_LIQUID[above] ? 0 : 1 << 8);
                }
                key = b | (ao << 8) | (1 << 30);
              }
            }
            mask[v * du + u] = key;
          }
        }

        // ---- greedy merge ----------------------------------------------------------
        for (let v = 0; v < dv; v++) {
          for (let u = 0; u < du; ) {
            const key = mask[v * du + u];
            if (key === 0) {
              u++;
              continue;
            }
            const aoBits = (key >> 8) & 0xff;
            const uniform = aoBits === 0 || aoBits === 0x55 || aoBits === 0xaa || aoBits === 0xff;
            let w = 1;
            let h = 1;
            if (uniform) {
              while (u + w < du && mask[v * du + u + w] === key) w++;
              outer: while (v + h < dv) {
                for (let k = 0; k < w; k++) if (mask[(v + h) * du + u + k] !== key) break outer;
                h++;
              }
            }
            for (let hv = 0; hv < h; hv++) for (let k = 0; k < w; k++) mask[(v + hv) * du + u + k] = 0;
            emitQuad(key, axis, uAxis, vAxis, sign, face, slice, u, v, w, h);
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
const light = [0, 0, 0, 0];
const cu = [0, 0, 0, 0];
const cv = [0, 0, 0, 0];
const p = [0, 0, 0];
const ORDER_POS = [0, 1, 2, 3];
const ORDER_NEG = [0, 3, 2, 1];

function emitQuad(
  key: number,
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
    light[k] = FACE_SHADE[face] * AO_CURVE[level];
  }
  const tile = axis === 1 ? (sign > 0 ? TILE_TOP[b] : TILE_BOTTOM[b]) : TILE_SIDE[b];
  // Split the quad along the diagonal that keeps AO gradients symmetric.
  const flip = light[0] + light[2] < light[1] + light[3];
  (liquid ? liquidBuilder! : opaqueBuilder!).quad(corners, uvc, tile, light, IS_EMISSIVE[b] === 1, flip);
}
