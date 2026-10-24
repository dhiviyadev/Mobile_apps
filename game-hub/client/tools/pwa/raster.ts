/**
 * Tiny dependency-free rasterizer for the build-time art (app icons, the
 * social preview image): an RGBA canvas, anti-aliased shape fills by 4×4
 * supersampling, and a PNG encoder on top of node:zlib.
 */
import { deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];
/** True when the sample point (pixel space) is inside the shape. */
export type Inside = (x: number, y: number) => boolean;
export interface Shape {
  inside: Inside;
  color: Rgb;
  /** [x0, y0, x1, y1] in pixels; only this box is sampled. */
  bbox: readonly [number, number, number, number];
}

/** Samples per axis. */
const S = 4;
const OFFSETS = Array.from({ length: S }, (_, i) => (i + 0.5) / S);

export class Raster {
  /** RGBA, straight (not premultiplied) alpha; starts fully transparent. */
  readonly px: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Uint8Array(w * h * 4);
  }

  /** Per-pixel callback (gradients, glows), called at pixel centres; writes opaque colours. */
  shade(fn: (x: number, y: number) => Rgb): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const [r, g, b] = fn(x + 0.5, y + 0.5);
        const i = (y * this.w + x) * 4;
        this.px[i] = clamp8(r);
        this.px[i + 1] = clamp8(g);
        this.px[i + 2] = clamp8(b);
        this.px[i + 3] = 255;
      }
    }
  }

  /** One shape, anti-aliased by supersampling over its bbox, composited source-over. */
  fill(shape: Shape, alpha = 1): void {
    this.forPixels(shape.bbox, (x, y) => {
      let covered = 0;
      for (const oy of OFFSETS) for (const ox of OFFSETS) if (shape.inside(x + ox, y + oy)) covered++;
      if (covered > 0) this.blend(x, y, shape.color, (covered / (S * S)) * alpha);
    });
  }

  /**
   * Shapes that share edges (the cube logo): each sample takes the colour of
   * the LAST shape containing it, and the pixel gets the average of its
   * covered samples. Faces then meet without the dark seams that
   * anti-aliasing each face separately leaves.
   */
  fillGroup(shapes: readonly Shape[]): void {
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of shapes) {
      box[0] = Math.min(box[0], s.bbox[0]);
      box[1] = Math.min(box[1], s.bbox[1]);
      box[2] = Math.max(box[2], s.bbox[2]);
      box[3] = Math.max(box[3], s.bbox[3]);
    }
    this.forPixels(box, (x, y) => {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const oy of OFFSETS) {
        for (const ox of OFFSETS) {
          for (let k = shapes.length - 1; k >= 0; k--) {
            if (!shapes[k].inside(x + ox, y + oy)) continue;
            const c = shapes[k].color;
            r += c[0];
            g += c[1];
            b += c[2];
            covered++;
            break;
          }
        }
      }
      if (covered > 0) this.blend(x, y, [r / covered, g / covered, b / covered], covered / (S * S));
    });
  }

  png(): Uint8Array {
    return encodePng(this.w, this.h, this.px);
  }

  private forPixels(bbox: readonly [number, number, number, number], fn: (x: number, y: number) => void): void {
    const x0 = Math.max(0, Math.floor(bbox[0]));
    const y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(this.w, Math.ceil(bbox[2]));
    const y1 = Math.min(this.h, Math.ceil(bbox[3]));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) fn(x, y);
  }

  private blend(x: number, y: number, c: Rgb, a: number): void {
    const i = (y * this.w + x) * 4;
    const da = this.px[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) this.px[i + k] = clamp8((c[k] * a + this.px[i + k] * da * (1 - a)) / oa);
    this.px[i + 3] = clamp8(oa * 255);
  }
}

const clamp8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

// ---- shape predicates ------------------------------------------------------------

/** Even-odd point-in-polygon. */
export const polygon = (pts: readonly (readonly [number, number])[]): Inside => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export const rect = (x: number, y: number, w: number, h: number): Inside => (px, py) =>
  px >= x && px <= x + w && py >= y && py <= y + h;

export const roundRect = (x: number, y: number, w: number, h: number, r: number): Inside => (px, py) => {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  // Distance into the nearest corner square, if the point is in one.
  const dx = px < x + r ? x + r - px : px > x + w - r ? px - (x + w - r) : 0;
  const dy = py < y + r ? y + r - py : py > y + h - r ? py - (y + h - r) : 0;
  return dx * dx + dy * dy <= r * r;
};

/** Annulus r0 ≤ distance ≤ r1 (a disc when r0 = 0). */
export const ring = (cx: number, cy: number, r0: number, r1: number): Inside => (px, py) => {
  const d2 = (px - cx) ** 2 + (py - cy) ** 2;
  return d2 >= r0 * r0 && d2 <= r1 * r1;
};

export const bboxOf = (pts: readonly (readonly [number, number])[]): [number, number, number, number] => [
  Math.min(...pts.map((p) => p[0])),
  Math.min(...pts.map((p) => p[1])),
  Math.max(...pts.map((p) => p[0])),
  Math.max(...pts.map((p) => p[1])),
];

// ---- PNG encoding ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * 8-bit RGBA PNG. Each row gets the filter (None, Sub, Up, Average, Paeth)
 * with the smallest sum of absolute residuals, the usual heuristic, so
 * gradients like the social preview compress well.
 */
export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== w * h * 4) throw new Error(`encodePng: expected ${w * h * 4} bytes, got ${rgba.length}`);
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= 4 ? prev[i - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best], y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // bit depth 8, colour type 6 (RGBA), deflate, adaptive filtering, no interlace
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
