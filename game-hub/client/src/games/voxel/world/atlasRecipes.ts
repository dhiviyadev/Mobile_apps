/**
 * Procedural painters for every block tile of the atlas (pure: no DOM, so they
 * are unit-tested in Node). Each tile is 16x16 RGBA, painted with its own
 * seeded RNG (mulberry32(tile * 7919 + 17)), so the art is identical on every
 * device. The original tiles 0..22 keep their exact pixels. Item sprites
 * (160..239) are painted by world/itemSprites.ts.
 */
import { mulberry32, Tile } from '@hub/shared';

export const TILE_PX = 16;

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
type Rnd = () => number;
/** Per-pixel painter (row by row, x fastest), as the original atlas used. */
type Painter = (x: number, y: number, rnd: Rnd) => RGB | RGBA;

/** A 16x16 RGBA tile being drawn. */
class Px {
  constructor(readonly data: Uint8ClampedArray) {}
  set(x: number, y: number, c: RGB | RGBA): void {
    if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
    const i = (y * TILE_PX + x) * 4;
    this.data[i] = Math.max(0, Math.min(255, c[0]));
    this.data[i + 1] = Math.max(0, Math.min(255, c[1]));
    this.data[i + 2] = Math.max(0, Math.min(255, c[2]));
    this.data[i + 3] = c.length === 4 ? c[3] : 255;
  }
  get(x: number, y: number): RGB {
    const i = (y * TILE_PX + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }
  alpha(x: number, y: number): number {
    return this.data[(y * TILE_PX + x) * 4 + 3];
  }
  fill(p: Painter, r: Rnd): void {
    for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) this.set(x, y, p(x, y, r));
  }
}
/** Draws a whole tile (sprites, overlays): starts fully transparent. */
type Drawer = (px: Px, rnd: Rnd) => void;

const hex = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const jitter = (c: RGB, rnd: Rnd, amount: number): RGB => {
  const k = 1 + (rnd() - 0.5) * amount;
  return [c[0] * k, c[1] * k, c[2] * k];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const CLEAR: RGBA = [0, 0, 0, 0];

const GRASS = hex(0x6abf4b);
const DIRT = hex(0x8a5a3b);
const STONE = hex(0x8c8f99);
const SAND = hex(0xe8d39a);

function grassEdge(x: number, rnd: Rnd): number {
  return 3 + Math.floor(Math.abs(Math.sin(x * 1.7)) * 2 + rnd() * 1.5);
}

// ---- the original tiles (pixels unchanged) ---------------------------------------------------

const stone: Painter = (x, y, r) => jitter(Math.sin(x * 0.9 + y * 0.4) + Math.cos(y * 1.3) > 1.2 ? hex(0x777a84) : STONE, r, 0.15);
const cobble: Painter = (x, y, r) => {
  const cell = Math.sin(x * 1.1 + Math.floor(y / 4) * 2.3) * Math.cos(y * 1.4 + Math.floor(x / 5));
  return jitter(Math.abs(cell) < 0.18 ? hex(0x55575e) : hex(0x868991), r, 0.18);
};
const planksPainter = (base: number, seam: number): Painter => (x, y, r) => {
  const s = y % 4 === 3 || (x === (y < 4 ? 5 : y < 8 ? 12 : y < 12 ? 2 : 9) && true);
  return jitter(s ? hex(seam) : hex(base), r, 0.1);
};
const bricksPainter = (brick: number, mortar: number, w = 8, h = 4): Painter => (x, y, r) => {
  const row = Math.floor(y / h);
  const m = y % h === h - 1 || (x + (row % 2) * (w / 2)) % w === w - 1;
  return jitter(m ? hex(mortar) : hex(brick), r, 0.12);
};

const PAINTERS: Partial<Record<number, Painter>> = {
  [Tile.GrassTop]: (_x, _y, r) => jitter(r() < 0.12 ? hex(0x7fd35c) : GRASS, r, 0.22),
  [Tile.GrassSide]: (x, y, r) => (y < grassEdge(x, r) ? jitter(GRASS, r, 0.2) : jitter(DIRT, r, 0.25)),
  [Tile.SnowyGrassSide]: (x, y, r) => (y < grassEdge(x, r) ? jitter(hex(0xf2f6ff), r, 0.06) : jitter(DIRT, r, 0.25)),
  [Tile.Dirt]: (_x, _y, r) => jitter(r() < 0.1 ? hex(0x6e4529) : DIRT, r, 0.25),
  [Tile.Stone]: stone,
  [Tile.Sand]: (_x, _y, r) => jitter(r() < 0.08 ? hex(0xd4bd7e) : SAND, r, 0.1),
  [Tile.Water]: (x, y, r) => jitter(Math.sin((x + y * 0.5) * 0.8) > 0.85 ? hex(0x7cc4f2) : hex(0x3f8fd8), r, 0.06),
  [Tile.LogSide]: (x, _y, r) => jitter(x % 4 === 0 ? hex(0x6b4a2e) : hex(0x8b6340), r, 0.15),
  [Tile.LogTop]: (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    return jitter(d > 7 ? hex(0x6b4a2e) : Math.floor(d) % 3 === 0 ? hex(0xa07a4c) : hex(0xc49a5c), r, 0.08);
  },
  [Tile.Leaves]: (_x, _y, r) => (r() < 0.08 ? [0, 0, 0, 0] : jitter(r() < 0.3 ? hex(0x3f7f2e) : hex(0x4f9a3a), r, 0.25)),
  [Tile.Planks]: planksPainter(0xc49a5c, 0x8f6a3c),
  [Tile.Cobble]: cobble,
  [Tile.Glass]: (x, y, r) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    if (edge) return [220, 240, 255, 255];
    if ((x - y === 3 || x - y === 4) && x > 3 && x < 12) return [255, 255, 255, 255];
    return r() < 0.02 ? [210, 235, 255, 255] : [0, 0, 0, 0];
  },
  [Tile.Brick]: (x, y, r) => {
    const row = Math.floor(y / 4);
    const mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
    return jitter(mortar ? hex(0xd8cfc4) : hex(0xb5523b), r, 0.12);
  },
  [Tile.Snow]: (_x, _y, r) => jitter(r() < 0.06 ? hex(0xdfe9fa) : hex(0xf4f8ff), r, 0.04),
  [Tile.Lamp]: (x, y, r) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    return jitter(d > 6.5 ? hex(0x9a6b2a) : d < 3 ? hex(0xfff3c4) : hex(0xffd166), r, 0.06);
  },
  [Tile.Bedrock]: (_x, _y, r) => jitter(r() < 0.4 ? hex(0x24252a) : hex(0x46474f), r, 0.2),
  [Tile.Gravel]: (_x, _y, r) => jitter(r() < 0.3 ? hex(0x6f6863) : r() < 0.5 ? hex(0xa59d96) : hex(0x8e8680), r, 0.15),
  [Tile.Clay]: (x, y, r) => jitter(mix(hex(0x5fa8c8), hex(0x4f93b3), (Math.sin(x * 0.5) + Math.cos(y * 0.7) + 2) / 4), r, 0.05),
  [Tile.Checkpoint]: (x, y, r) => {
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    return jitter(d < 5 ? hex(0xe9ffe9) : d < 7 ? hex(0x9df0a8) : hex(0x3aa856), r, 0.05);
  },
  [Tile.Finish]: (x, y, r) => jitter(((x >> 2) + (y >> 2)) % 2 === 0 ? hex(0xffd166) : hex(0xfff7e0), r, 0.05),
  [Tile.Cloud]: (_x, _y, r) => jitter(hex(0xffffff), r, 0.03),
  [Tile.Ice]: (x, y, r) => jitter((x * 3 + y) % 11 === 0 ? hex(0xe6f6ff) : hex(0x9fd8ff), r, 0.05),
};

/** Crack overlay stages (Tile.Crack0 + 0..7). */
function crackPainter(stage: number): Painter {
  return (x, y, r) => {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const v = n - Math.floor(n);
    const lines = Math.abs(Math.sin(x * 0.9 + y * 0.6)) < 0.08 * (stage + 1) || Math.abs(Math.cos(x * 0.5 - y * 0.9)) < 0.05 * (stage + 1);
    return lines || v < stage * 0.02 ? [20, 16, 12, 160 + r() * 60] : [0, 0, 0, 0];
  };
}
for (let s = 0; s < 8; s++) PAINTERS[Tile.Crack0 + s] = crackPainter(s);

// ---- recipe families ------------------------------------------------------------------------

const speckle = (base: number, alt: number, chance: number, j: number, extra?: [number, number]): Painter => (_x, _y, r) => {
  if (extra && r() < extra[1]) return jitter(hex(extra[0]), r, j);
  return jitter(r() < chance ? hex(alt) : hex(base), r, j);
};
const layered = (base: number, line: number, period: number, j: number, topRows?: number): Painter => (_x, y, r) => {
  if (topRows !== undefined && y < 2) return jitter(hex(topRows), r, j);
  return jitter(y % period === period - 1 ? hex(line) : hex(base), r, j);
};
const smoothTop = (base: number): Painter => (x, y, r) => {
  const border = x === 0 || y === 0 || x === 15 || y === 15;
  return jitter(border ? scale(hex(base), 0.88) : hex(base), r, 0.08);
};
const bands = (base: number): Painter => (_x, y, r) => {
  if (r() < 0.06) return jitter(scale(hex(base), 1.1), r, 0.05);
  return jitter(y % 5 === 4 ? scale(hex(base), 0.92) : hex(base), r, 0.06);
};
const topStrip = (top: number): Painter => (x, y, r) => (y < grassEdge(x, r) ? jitter(hex(top), r, 0.18) : jitter(DIRT, r, 0.25));
const polished = (base: number): Painter => (x, y, r) => {
  const k = x === 0 || y === 0 ? 1.08 : x === 15 || y === 15 ? 0.88 : 1;
  return jitter(scale(hex(base), k), r, 0.06);
};
const moss = (x: number, y: number, r: Rnd) => Math.sin(x * 0.7) + Math.cos(y * 0.9) + r() * 0.8 > 1.2;
const mossy = (base: Painter): Painter => (x, y, r) => {
  const c = base(x, y, r);
  return moss(x, y, r) ? jitter(hex(0x5a8a3a), r, 0.2) : c;
};
const logSide = (base: number, dark: number, marks?: 'aspen' | 'knots'): Drawer => (px, r) => {
  px.fill((x, _y, rr) => jitter(x % 4 === 0 ? hex(dark) : hex(base), rr, 0.15), r);
  if (marks === 'aspen') {
    for (let i = 0; i < 7; i++) {
      const x = Math.floor(r() * 14);
      const y = Math.floor(r() * 16);
      const len = 2 + Math.floor(r() * 2);
      for (let k = 0; k < len; k++) px.set(x + k, y, jitter(hex(0x3a3a3a), r, 0.2));
    }
  } else if (marks === 'knots') {
    for (let i = 0; i < 3; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 2 + Math.floor(r() * 12);
      px.set(x, y, hex(0x4a3a2a));
      px.set(x + 1, y, hex(0x5a4a3a));
      px.set(x, y + 1, hex(0x5a4a3a));
    }
  }
};
const logTop = (bark: number, a: number, b: number): Painter => (x, y, r) => {
  const d = Math.hypot(x - 7.5, y - 7.5);
  return jitter(d > 7 ? hex(bark) : Math.floor(d) % 3 === 0 ? hex(b) : hex(a), r, 0.08);
};
const leaves = (base: number, dark: number, hole: number, extra?: [number, number]): Painter => (_x, _y, r) => {
  if (r() < hole) return CLEAR;
  if (extra && r() < extra[1]) return jitter(hex(extra[0]), r, 0.2);
  return jitter(r() < 0.3 ? hex(dark) : hex(base), r, 0.25);
};
const needleLeaves: Drawer = (px, r) => {
  px.fill((_x, _y, rr) => (rr() < 0.06 ? CLEAR : jitter(hex(0x24482c), rr, 0.2)), r);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(r() * 16);
    const y = Math.floor(r() * 16);
    const dir = r() < 0.5 ? 1 : -1;
    for (let k = 0; k < 3; k++) px.set(x + k * dir, y + k, jitter(hex(r() < 0.5 ? 0x2f5d3a : 0x3c7048), r, 0.15));
  }
};
const blobLeaves: Drawer = (px, r) => {
  px.fill((_x, _y, rr) => (rr() < 0.05 ? CLEAR : jitter(hex(0x2f8a2a), rr, 0.2)), r);
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(r() * 15);
    const y = Math.floor(r() * 15);
    const c = jitter(hex(r() < 0.5 ? 0x3fa83a : 0x4fbc44), r, 0.12);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) px.set(x + dx, y + dy, c);
  }
};
const cloth = (c: number): Painter => (x, y, r) => {
  const base = mix(scale(hex(c), 0.94), scale(hex(c), 1.06), (x + (y >> 1)) & 1);
  return jitter(y % 4 === 3 ? scale(base, 0.9) : base, r, 0.06);
};
const stainedGlass = (c: number): Painter => (x, y, r) => {
  if (x === 0 || y === 0 || x === 15 || y === 15 || x === 7 || y === 7) return hex(0x2a2a30);
  if (((x + y) & 1) === 0 || r() < 0.15) return r() < 0.08 ? [...scale(hex(c), 1.25), 255] as RGBA : [...hex(c), 255] as RGBA;
  return CLEAR;
};

/** 3x3 rune glyphs, one per brick. */
const GLYPHS = [
  [1, 0, 1, 0, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 1, 1, 0, 1, 0],
  [1, 1, 1, 0, 0, 1, 0, 1, 0],
  [1, 0, 0, 1, 1, 0, 0, 1, 1],
];
const runeBricks = (glyph: number): Drawer => (px, r) => {
  px.fill(bricksPainter(0x3a3648, 0x24222e), r);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const g = GLYPHS[(row * 2 + col + row) % 4];
      const ox = col * 8 + (row % 2) * 4 + 2;
      const oy = row * 4;
      for (let i = 0; i < 9; i++) if (g[i] && i < 6) px.set((ox + (i % 3)) % 16, oy + Math.floor(i / 3), jitter(hex(glyph), r, 0.1));
    }
  }
};

const ore = (oreColor: number, hi: number, n: number, slateBase = false): Drawer => (px, r) => {
  px.fill(slateBase ? layered(0x4a4f5c, 0x5a6070, 3, 0.12) : stone, r);
  for (let i = 0; i < n; i++) {
    const cx = 2 + Math.floor(r() * 12);
    const cy = 2 + Math.floor(r() * 12);
    const cells: [number, number][] = [[cx, cy]];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (r() < 0.7) cells.push([cx + dx, cy + dy]);
    for (const [x, y] of cells) px.set(x, y, jitter(hex(oreColor), r, 0.12));
    px.set(cx - 1, cy - 1, jitter(hex(hi), r, 0.06));
    px.set(cx + 1, cy + 1, scale(hex(oreColor), 0.7));
  }
};

// ---- sprites ---------------------------------------------------------------------------------

const line = (px: Px, x0: number, y0: number, x1: number, y1: number, c: RGB): void => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) px.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
};
const disc = (px: Px, cx: number, cy: number, rad: number, c: (x: number, y: number) => RGB | null): void => {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) {
        const col = c(x, y);
        if (col) px.set(x, y, col);
      }
    }
  }
};

const tallGrass: Drawer = (px, r) => {
  for (let i = 0; i < 7; i++) {
    let x = 1 + 2 * i;
    const h = 7 + Math.floor(r() * 6);
    const lean = r() < 0.5 ? -1 : 1;
    const c = mix(hex(0x5aa83c), hex(0x7fd35c), r());
    for (let k = 0; k < h; k++) {
      if (k > 0 && k % 4 === 0 && r() < 0.6) x += lean;
      px.set(x, 15 - k, jitter(c, r, 0.12));
    }
  }
};
const fern: Drawer = (px, r) => {
  for (let y = 3; y <= 15; y++) px.set(8, y, hex(0x2f6f2f));
  for (let y = 4; y <= 14; y += 2) {
    const len = Math.max(1, Math.round(1 + ((y - 4) / 10) * 5));
    for (let k = 1; k <= len; k++) {
      const c = jitter(hex(k % 2 ? 0x3f8a3a : 0x4f9a46), r, 0.1);
      px.set(8 - k, y + Math.floor(k / 3), c);
      px.set(8 + k, y + Math.floor(k / 3), c);
    }
  }
};
const dryGrass: Drawer = (px, r) => {
  for (let i = 0; i < 5; i++) {
    let x = 2 + i * 3;
    const h = 6 + Math.floor(r() * 6);
    const bend = r() < 0.5 ? -1 : 1;
    for (let k = 0; k < h; k++) {
      if (k > h * 0.6) x += bend * (r() < 0.6 ? 1 : 0);
      px.set(x, 15 - k, jitter(hex(k % 3 === 0 ? 0xa8944a : 0xc8b45a), r, 0.1));
    }
  }
};
const deadBush: Drawer = (px) => {
  const c = hex(0x7a5a3a);
  line(px, 8, 15, 8, 10, c);
  line(px, 8, 10, 4, 5, c);
  line(px, 8, 10, 12, 4, c);
  line(px, 8, 12, 6, 8, c);
  line(px, 8, 11, 11, 8, scale(c, 0.85));
};
const flower = (petal: (px: Px, r: Rnd) => void, stem = 0x4a9a3a, top = 8): Drawer => (px, r) => {
  for (let y = top; y <= 15; y++) px.set(8, y, hex(stem));
  px.set(7, 12, hex(stem));
  px.set(6, 11, hex(stem));
  px.set(9, 13, hex(stem));
  px.set(10, 12, hex(stem));
  petal(px, r);
};
const sunpetal = flower((px) => disc(px, 8, 6, 2.5, (x, y) => (Math.hypot(x - 8, y - 6) < 1.1 ? hex(0xc87a1a) : hex(0xf2d22a))));
const rosette = flower((px, r) => {
  for (let y = 4; y <= 7; y++) for (let x = 6; x <= 10; x++) if (!((x === 6 || x === 10) && (y === 4 || y === 7))) px.set(x, y, jitter(hex(0xd23a3a), r, 0.15));
  px.set(8, 5, hex(0x7a1a1a));
  px.set(8, 6, hex(0x9a2a2a));
});
const bluebell: Drawer = (px, r) => {
  const stem = hex(0x4a8a3a);
  line(px, 8, 15, 8, 9, stem);
  line(px, 8, 9, 6, 6, stem);
  line(px, 8, 11, 10, 8, stem);
  line(px, 8, 10, 11, 5, stem);
  for (const [bx, by] of [[6, 7], [9, 9], [11, 6]]) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px.set(bx + dx - 1, by + dy, jitter(hex(0x5a7ae0), r, 0.15));
  }
};
const frostbloom = flower((px) => {
  const c = hex(0xe8f8ff);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
    line(px, 8, 6, Math.round(8 + Math.cos(a) * 3), Math.round(6 + Math.sin(a) * 3), c);
  }
  px.set(8, 6, hex(0x8ad8ff));
}, 0x8ab8a8);
const mushroom = (cap: number, spots: number | null, flat: boolean, stem = 0xe8dcc8): Drawer => (px, r) => {
  for (let y = 11; y <= 15; y++) {
    px.set(7, y, hex(stem));
    px.set(8, y, scale(hex(stem), 0.9));
  }
  if (flat) {
    for (let y = 9; y <= 11; y++) for (let x = 3; x <= 12; x++) if (!(y === 9 && (x === 3 || x === 12))) px.set(x, y, jitter(hex(cap), r, 0.1));
  } else {
    for (let y = 6; y <= 10; y++) {
      const half = y === 6 ? 2 : y === 7 ? 3 : 4;
      for (let x = 8 - half; x < 8 + half; x++) px.set(x, y, jitter(hex(cap), r, 0.1));
    }
  }
  if (spots !== null) for (const [x, y] of flat ? [[5, 10], [9, 9], [11, 10]] : [[6, 7], [9, 8], [7, 9], [10, 9]]) px.set(x, y, hex(spots));
};
const reeds: Drawer = (px, r) => {
  for (const x of [4, 8, 12]) {
    const top = 1 + Math.floor(r() * 3);
    for (let y = top; y <= 15; y++) px.set(x, y, (15 - y) % 4 === 3 ? hex(0x6a9a3a) : jitter(hex(0x8ac84a), r, 0.1));
    px.set(x - 1, top + 1, hex(0x7ab84a));
    px.set(x + 1, top + 2, hex(0x7ab84a));
  }
};
const hangingMoss: Drawer = (px, r) => {
  for (let i = 0; i < 6; i++) {
    const x = 2 + i * 2 + (r() < 0.5 ? 0 : 1);
    const len = 6 + Math.floor(r() * 11);
    for (let y = 0; y < len; y++) px.set(x, y, jitter(hex(r() < 0.5 ? 0x4a7a3a : 0x5a8a4a), r, 0.12));
  }
};
const lilyPad: Drawer = (px, r) => {
  disc(px, 7.5, 7.5, 7, (x, y) => {
    const a = Math.atan2(y - 7.5, x - 7.5);
    if (a > -0.2 && a < 0.5) return null; // the notch
    const vein = Math.abs(x - 7.5) < 0.6 || Math.abs(y - 7.5) < 0.6 || Math.abs(x - y) < 0.6;
    return jitter(vein ? hex(0x2f6f2f) : hex(0x3a8a3a), r, 0.1);
  });
};
const torch: Drawer = (px) => {
  for (let y = 8; y <= 15; y++) {
    px.set(7, y, hex(0x8a6a3a));
    px.set(8, y, hex(0x6e5230));
  }
  for (let y = 5; y <= 7; y++) {
    px.set(7, y, hex(0xffd84a));
    px.set(8, y, hex(0xff8a2a));
  }
  px.set(7, 5, hex(0xfff4c0));
  px.set(8, 5, hex(0xffd84a));
};
const lantern: Drawer = (px) => {
  const frame = hex(0x3a3a40);
  for (let x = 5; x <= 10; x++) {
    px.set(x, 6, frame);
    px.set(x, 15, frame);
  }
  for (let y = 7; y <= 14; y++) {
    px.set(5, y, frame);
    px.set(10, y, frame);
    for (let x = 6; x <= 9; x++) px.set(x, y, Math.abs(x - 7.5) < 1 && y > 9 && y < 13 ? hex(0xfff4d0) : hex(0xffd88a));
  }
  px.set(7, 5, frame);
  px.set(8, 5, frame);
};
const ladder: Drawer = (px, r) => {
  for (let y = 0; y < 16; y++) for (const x of [2, 3, 12, 13]) px.set(x, y, jitter(hex(0x8a6a3a), r, 0.1));
  for (const y of [1, 2, 5, 6, 9, 10, 13, 14]) for (let x = 4; x <= 11; x++) px.set(x, y, jitter(hex(y % 4 === 1 ? 0x9a7a4a : 0x80623a), r, 0.1));
};

// ---- the world upgrade tiles -----------------------------------------------------------------

const DRAWERS: Partial<Record<number, Drawer>> = {
  [Tile.CoalOre]: ore(0x2a2a2e, 0x55555c, 5),
  [Tile.CopperOre]: ore(0xc8743a, 0x6fc8a8, 4),
  [Tile.IronOre]: ore(0xd8b49a, 0xf0dccc, 4),
  [Tile.GoldOre]: ore(0xf2c63a, 0xfff2a8, 4),
  [Tile.CobaltOre]: ore(0x2f6fe0, 0x9cc8ff, 4),
  [Tile.EmberOre]: ore(0xff6a2a, 0xffd08a, 4, true),
  [Tile.ForestFloorTop]: (px, r) => {
    px.fill(speckle(0x6b4a2a, 0x5a3e22, 0.15, 0.15), r);
    for (let i = 0; i < 22; i++) {
      const x = Math.floor(r() * 16);
      const y = Math.floor(r() * 16);
      const c = r() < 0.5 ? hex(0x8f6a32) : hex(0x4a3a20);
      for (let k = 0; k < 3; k++) px.set(x + k, y + k, c);
    }
  },
  [Tile.AspenLogSide]: logSide(0xd9d4c4, 0xc4bfae, 'aspen'),
  [Tile.PineLogSide]: logSide(0x5a3e26, 0x40291a),
  [Tile.MahoganyLogSide]: logSide(0x6a3a26, 0x4e2a1a),
  [Tile.ThornwoodLogSide]: logSide(0x8a7a6a, 0x6a5a4a, 'knots'),
  [Tile.DuskwoodLogSide]: logSide(0x3a2e36, 0x2a2028),
  [Tile.PineLeaves]: needleLeaves,
  [Tile.MahoganyLeaves]: blobLeaves,
  [Tile.TallGrass]: tallGrass,
  [Tile.Fern]: fern,
  [Tile.DryGrass]: dryGrass,
  [Tile.DeadBush]: deadBush,
  [Tile.Sunpetal]: sunpetal,
  [Tile.Rosette]: rosette,
  [Tile.Bluebell]: bluebell,
  [Tile.Frostbloom]: frostbloom,
  [Tile.RedMushroom]: mushroom(0xc83a2a, 0xf4ece0, false),
  [Tile.BrownMushroom]: mushroom(0x8a6a4a, null, true),
  [Tile.Duskcap]: mushroom(0x7a5ad8, 0xb8f0ff, false, 0x6a5a8a),
  [Tile.Reeds]: reeds,
  [Tile.HangingMoss]: hangingMoss,
  [Tile.LilyPad]: lilyPad,
  [Tile.Torch]: torch,
  [Tile.Lantern]: lantern,
  [Tile.Ladder]: ladder,
  [Tile.RuneBricks]: runeBricks(0x24222e),
  [Tile.SealedRune]: runeBricks(0x6ae0ff),
  [Tile.AltarSide]: (px, r) => {
    runeBricks(0x24222e)(px, r);
    for (let y = 0; y < 16; y++) {
      px.set(7, y, hex(0x9a6aff));
      px.set(8, y, hex(0xb88aff));
    }
  },
  [Tile.AltarDormantSide]: (px, r) => {
    px.fill(bricksPainter(0x4a4a52, 0x34343a), r);
    for (let y = 0; y < 16; y++) {
      px.set(7, y, hex(0x6a6a74));
      px.set(8, y, hex(0x8a8a94));
    }
  },
  [Tile.BookshelfSide]: (px, r) => {
    const books = [0x8a2a2a, 0x2a4a8a, 0x3a6a3a, 0x8a6a2a, 0x5a3a6a];
    px.fill(planksPainter(0xc49a5c, 0x8f6a3c), r);
    for (const [y0, y1] of [[2, 6], [9, 13]]) {
      let x = 1;
      while (x < 15) {
        const w = 1 + Math.floor(r() * 2);
        const c = hex(books[Math.floor(r() * books.length)]);
        const top = y0 + Math.floor(r() * 2);
        for (let xx = x; xx < Math.min(15, x + w); xx++) {
          for (let y = top; y <= y1; y++) px.set(xx, y, y === top ? scale(c, 1.3) : jitter(c, r, 0.08));
        }
        x += w;
      }
    }
  },
  [Tile.WorkbenchTop]: (px, r) => {
    px.fill(planksPainter(0xb08850, 0x80602e), r);
    for (let i = 0; i < 16; i++) {
      for (const k of [0, 15]) {
        px.set(i, k, hex(0x6a4a2a));
        px.set(k, i, hex(0x6a4a2a));
      }
      for (const k of [5, 10]) {
        if (i > 0 && i < 15) {
          px.set(i, k, hex(0x7a5a32));
          px.set(k, i, hex(0x7a5a32));
        }
      }
    }
  },
  [Tile.WorkbenchSide]: (px, r) => {
    px.fill(planksPainter(0xb08850, 0x80602e), r);
    for (let y = 5; y <= 10; y++) for (let x = 3; x <= 12; x++) px.set(x, y, y === 5 || y === 10 || x === 3 || x === 12 ? hex(0x5a3a1e) : hex(0x7a5530));
    px.set(7, 7, hex(0xd8d8d8));
    px.set(8, 7, hex(0xd8d8d8));
  },
  [Tile.FurnaceSide]: (px, r) => {
    px.fill(speckle(0x7a7c84, 0x5e6068, 0.25, 0.12), r);
    for (let y = 8; y <= 13; y++) {
      for (let x = 4; x <= 11; x++) px.set(x, y, y >= 12 && r() < 0.4 ? hex(0xff8a2a) : hex(0x1a1a1e));
    }
    for (let x = 3; x <= 12; x++) px.set(x, 7, hex(0x55575e));
  },
  [Tile.FurnaceTop]: (px, r) => {
    px.fill(speckle(0x7a7c84, 0x5e6068, 0.25, 0.12), r);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) if (x % 3 === 0) px.set(x, y, hex(0x3a3a40));
  },
  [Tile.ChestSide]: (px, r) => {
    px.fill((x, y, rr) => {
      if (x === 0 || x === 15 || y === 0 || y === 15) return hex(0x5a3a1a);
      if (y === 4) return hex(0x5a3a1a);
      return jitter(y % 3 === 0 ? hex(0x8f5f2e) : hex(0xa8743a), rr, 0.1);
    }, r);
    for (let y = 4; y <= 6; y++) {
      px.set(7, y, hex(0xd8d8d8));
      px.set(8, y, hex(0xb8b8b8));
    }
  },
  [Tile.ChestTop]: (px, r) => px.fill((x, y, rr) => (x === 0 || x === 15 || y === 0 || y === 15 ? hex(0x5a3a1a) : jitter(x % 5 === 4 ? hex(0x8f5f2e) : hex(0xa8743a), rr, 0.1)), r),
  [Tile.CactusSide]: (px, r) => px.fill((x, _y, rr) => (rr() < 0.03 ? hex(0xe8e0c0) : jitter(x % 4 === 1 ? hex(0x5aa04a) : hex(0x4a8a3a), rr, 0.1)), r),
  [Tile.CactusTop]: (px, r) => {
    px.fill((x, y, rr) => jitter(Math.floor(Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5))) % 3 === 0 ? hex(0x5aa04a) : hex(0x4a8a3a), rr, 0.08), r);
    px.set(7, 7, hex(0xd84a8a));
    px.set(8, 8, hex(0xd84a8a));
  },
  [Tile.PumpkinSide]: (px, r) => {
    px.fill((x, y, rr) => {
      const c = jitter(x % 4 === 0 ? hex(0xc8721a) : hex(0xe08a1f), rr, 0.08);
      return y === 0 || y === 15 ? scale(c, 0.85) : c;
    }, r);
  },
  [Tile.PumpkinTop]: (px, r) => {
    px.fill((x, y, rr) => {
      const a = Math.atan2(y - 7.5, x - 7.5);
      return jitter(Math.abs(Math.sin(a * 4)) < 0.25 ? hex(0xc8721a) : hex(0xe08a1f), rr, 0.08);
    }, r);
    for (let y = 6; y <= 9; y++) for (let x = 7; x <= 8; x++) px.set(x, y, hex(0x6a5a2a));
  },
  [Tile.MelonSide]: (px, r) => px.fill((x, y, rr) => jitter((x + Math.round(Math.sin(y * 0.8) * 1.5) + 10) % 5 === 0 ? hex(0x3a7a2a) : hex(0x5aa03a), rr, 0.08), r),
  [Tile.MelonTop]: (px, r) => {
    px.fill((x, y, rr) => jitter((Math.round(Math.hypot(x - 7.5, y - 7.5) + Math.sin(Math.atan2(y - 7.5, x - 7.5) * 6))) % 4 === 0 ? hex(0x3a7a2a) : hex(0x5aa03a), rr, 0.08), r);
    px.set(7, 7, hex(0x6a5a2a));
    px.set(8, 8, hex(0x6a5a2a));
  },
  [Tile.HaySide]: (px, r) => px.fill((_x, y, rr) => (y === 3 || y === 12 ? hex(0x8a6a2a) : jitter(rr() < 0.3 ? hex(0xc0a03a) : hex(0xd8b84a), rr, 0.1)), r),
  [Tile.HayTop]: (px, r) => px.fill((x, y, rr) => (x === 3 || x === 12 ? hex(0x8a6a2a) : jitter(rr() < 0.25 ? hex(0xb09030) : rr() < 0.2 ? hex(0xf0d870) : hex(0xd8b84a), rr, 0.1)), r),
  [Tile.AltarTop]: (px, r) => {
    px.fill((x, y, rr) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d < 2.2) return hex(0xe85aff);
      if (Math.abs(d - 6) < 0.7) return hex(0x9a6aff);
      return jitter(hex(0x2e2a3a), rr, 0.12);
    }, r);
  },
  [Tile.AltarDormantTop]: (px, r) => {
    px.fill((x, y, rr) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d < 2.2) return hex(0x8a8a94);
      if (Math.abs(d - 6) < 0.7) return hex(0x6a6a74);
      return jitter(hex(0x34343c), rr, 0.12);
    }, r);
  },
  [Tile.BedrollTop]: (px, r) => {
    px.fill((x, y, rr) => {
      if (y < 4) return jitter(y === 0 || x === 0 || x === 15 ? hex(0xc8c4b8) : hex(0xf0ece0), rr, 0.05); // pillow
      if (x === 0 || x === 15 || y === 15) return hex(0x7a201c);
      return jitter((x + y) % 6 === 0 ? hex(0x9a2824) : hex(0xb3312c), rr, 0.06);
    }, r);
  },
  [Tile.BedrollSide]: (px, r) => px.fill((_x, y, rr) => (y < 10 ? CLEAR : y === 15 ? hex(0x5a1814) : jitter(y === 12 ? hex(0xe0d8c8) : hex(0xb3312c), rr, 0.06)), r),
};

Object.assign(PAINTERS, {
  [Tile.RedSand]: speckle(0xc8743a, 0xb0602e, 0.12, 0.1),
  [Tile.SandstoneTop]: smoothTop(0xe0cc94),
  [Tile.SandstoneSide]: layered(0xdcc58a, 0xc8b078, 4, 0.08, 0xe8d4a0),
  [Tile.RedSandstoneTop]: smoothTop(0xc06c40),
  [Tile.RedSandstoneSide]: layered(0xb8643a, 0xa05430, 4, 0.08),
  [Tile.Granite]: speckle(0xa8786a, 0xd8a898, 0.18, 0.12, [0x5a4a4a, 0.08]),
  [Tile.BasaltTop]: ((x, y, r) => jitter(x % 5 === 0 || (y + (Math.floor(x / 5) % 2) * 2) % 5 === 0 ? hex(0x3a3c42) : hex(0x50535a), r, 0.1)) as Painter,
  [Tile.BasaltSide]: ((x, _y, r) => jitter(x % 4 === 0 ? hex(0x3a3c42) : r() < 0.1 ? hex(0x5e6168) : hex(0x50535a), r, 0.1)) as Painter,
  [Tile.Slate]: layered(0x4a4f5c, 0x5a6070, 3, 0.12),
  [Tile.Marble]: ((x, y, r) => jitter(Math.abs(Math.sin(x * 0.35 + Math.sin(y * 0.5) * 2)) < 0.12 ? hex(0xa8a8b0) : hex(0xece8e0), r, 0.04)) as Painter,
  [Tile.Obsidian]: speckle(0x1e1726, 0x3c2f52, 0.08, 0.1, [0x8a7ab8, 0.01]),
  [Tile.Mud]: speckle(0x4f3b2c, 0x6a5444, 0.1, 0.12),
  [Tile.ForestFloorSide]: topStrip(0x6b4a2a),
  [Tile.MossyCobble]: mossy(cobble),
  [Tile.OchreClay]: bands(0xc98a3a),
  [Tile.RustClay]: bands(0xa04a2a),
  [Tile.CreamClay]: bands(0xe0c9a0),
  [Tile.UmberClay]: bands(0x6e4a32),
  [Tile.PackedIce]: ((x, y, r) => jitter((((x - (y >> 1)) % 7) + 7) % 7 === 0 ? hex(0xd4ecff) : hex(0x8fc4ee), r, 0.04)) as Painter,
  [Tile.Lava]: ((x, y, r) => {
    if (r() < 0.12) return jitter(hex(0x8a2010), r, 0.2);
    return jitter(Math.abs(Math.sin(x * 0.6 + y * 0.25) + Math.cos(y * 0.5 - x * 0.2)) < 0.35 ? hex(0xffc040) : hex(0xd8461a), r, 0.08);
  }) as Painter,
  [Tile.ParchedGrassTop]: speckle(0xb6b04a, 0x9a9440, 0.15, 0.12),
  [Tile.ParchedGrassSide]: topStrip(0xb6b04a),
  [Tile.AspenLogTop]: logTop(0xbfb8a8, 0xe8dcc0, 0xd0c4a4),
  [Tile.AspenLeaves]: leaves(0x9cc84a, 0x7aa83a, 0.08),
  [Tile.AspenPlanks]: planksPainter(0xe2d3a8, 0xb8a678),
  [Tile.PineLogTop]: logTop(0x40291a, 0xb08a5a, 0x96703e),
  [Tile.PinePlanks]: planksPainter(0x9a6b3c, 0x6e4a28),
  [Tile.MahoganyLogTop]: logTop(0x4e2a1a, 0xb86a4a, 0x9a5038),
  [Tile.MahoganyPlanks]: planksPainter(0xa4553a, 0x7a3a26),
  [Tile.ThornwoodLogTop]: logTop(0x6a5a4a, 0xd89a5a, 0xb87a40),
  [Tile.ThornwoodLeaves]: leaves(0x7a9a3a, 0x5e7a2a, 0.14),
  [Tile.ThornwoodPlanks]: planksPainter(0xc2783e, 0x8f5428),
  [Tile.DuskwoodLogTop]: logTop(0x2a2028, 0x7a6a7e, 0x5e4e62),
  [Tile.DuskwoodLeaves]: leaves(0x3b4a3f, 0x2a362e, 0.07, [0x5b4a6b, 0.04]),
  [Tile.DuskwoodPlanks]: planksPainter(0x5a4a5e, 0x3d3142),
  [Tile.StoneBricks]: bricksPainter(0x8c8f99, 0x6a6c74),
  [Tile.MossyStoneBricks]: mossy(bricksPainter(0x8c8f99, 0x6a6c74)),
  [Tile.PolishedStone]: polished(0x9a9da6),
  [Tile.MarblePillarSide]: ((x, y, r) => {
    const base = x % 3 === 0 ? hex(0xd8d4cc) : hex(0xf0ece4);
    return jitter(y < 2 || y > 13 ? scale(base, 0.92) : base, r, 0.03);
  }) as Painter,
  [Tile.MarblePillarTop]: ((x, y, r) => jitter(Math.abs(Math.hypot(x - 7.5, y - 7.5) - 5) < 0.8 ? hex(0xd8d4cc) : hex(0xf0ece4), r, 0.03)) as Painter,
  [Tile.SandstoneBricks]: bricksPainter(0xdcc58a, 0xb8a06a),
  [Tile.MudBricks]: bricksPainter(0x7a5a42, 0x5a4232, 6, 3),
  [Tile.BasaltBricks]: bricksPainter(0x45474e, 0x2c2d32),
  [Tile.IceBricks]: bricksPainter(0xa8d8f8, 0xe0f4ff, 8, 8),
} satisfies Partial<Record<number, Painter>>);
[0xe9ecec, 0xb3312c, 0xe07a1f, 0xe8c52a, 0x4f8f2f, 0x2f5fb3, 0x7b3fb0, 0x26262b].forEach((c, i) => (PAINTERS[Tile.ClothWhite + i] = cloth(c)));
[0xd2423c, 0x3c6ed2, 0x4caf50, 0xe0a030].forEach((c, i) => (PAINTERS[Tile.GlassRed + i] = stainedGlass(c)));

// ---- Gloamreach tiles (package D, 256..295) -----------------------------------------------------

/** A faint lattice of lines across a stone, used by the Lattice Stones (unlit dim, lit bright). */
const latticeStone = (lit: boolean): Drawer => (px, r) => {
  px.fill(bricksPainter(lit ? 0x4a3a78 : 0x2c2640, lit ? 0x2a2048 : 0x1c1830, 8, 8), r);
  const line1 = hex(lit ? 0xd8c8ff : 0x5a4a88);
  const line2 = hex(lit ? 0x8ae8ff : 0x42386a);
  for (let i = 1; i < 15; i++) {
    px.set(i, i, jitter(line1, r, 0.08));
    px.set(15 - i, i, jitter(line1, r, 0.08));
  }
  for (let y = 4; y <= 11; y++) for (let x = 4; x <= 11; x++) if (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 3.2) px.set(x, y, jitter(line2, r, 0.1));
  px.set(7, 7, hex(lit ? 0xffffff : 0x6a5aa8));
  px.set(8, 8, hex(lit ? 0xffffff : 0x6a5aa8));
  for (let i = 0; i < 16; i++) {
    for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i]]) px.set(x, y, jitter(scale(hex(lit ? 0x6a58b8 : 0x1a1628), 1), r, 0.1));
  }
};

const GLOAM_PAINTERS: Partial<Record<number, Painter | Drawer>> = {};
const gp = (t: number, p: Painter) => (GLOAM_PAINTERS[t] = p);
const gd = (t: number, d: Drawer) => (GLOAM_DRAWERS[t] = d);
const GLOAM_DRAWERS: Partial<Record<number, Drawer>> = {};

gp(Tile.Gloamstone, (x, y, r) => {
  const vein = Math.sin(x * 0.8 + y * 0.5) + Math.cos(y * 1.1 - x * 0.3) > 1.35;
  return jitter(vein ? hex(0x7a6ca0) : r() < 0.08 ? hex(0x6a5e90) : hex(0x5a4f78), r, 0.12);
});
gp(Tile.Murkstone, (x, y, r) => jitter(r() < 0.04 ? hex(0x4a8aa8) : r() < 0.2 ? hex(0x3a3e5a) : hex(0x2a2d44), r, 0.14 + (Math.sin(x + y * 2) > 0.9 ? 0.05 : 0)));
gp(Tile.DuskmossTop, (_x, _y, r) => (r() < 0.05 ? jitter(hex(0x9af0ff), r, 0.1) : jitter(r() < 0.25 ? hex(0x5a86d0) : hex(0x3f5e9a), r, 0.2)));
gp(Tile.DuskmossSide, (x, y, r) => (y < 3 + Math.floor(Math.abs(Math.sin(x * 1.9)) * 2 + r() * 1.3) ? jitter(r() < 0.2 ? hex(0x5a86d0) : hex(0x3f5e9a), r, 0.18) : jitter(r() < 0.1 ? hex(0x362a48) : hex(0x4a3a5c), r, 0.18)));
gp(Tile.Gloamsoil, (_x, _y, r) => jitter(r() < 0.1 ? hex(0x362a48) : r() < 0.06 ? hex(0x6a5a80) : hex(0x4a3a5c), r, 0.16));
gp(Tile.PrismCrystal, (x, y, r) => {
  const edge = x === 0 || y === 0 || x === 15 || y === 15;
  const facet = ((x + y) % 5 === 0 || (x - y + 16) % 7 === 0) && !edge;
  if (edge) return jitter(hex(0xe8d8ff), r, 0.06);
  return facet ? jitter(hex(0xf0e8ff), r, 0.05) : jitter(mix(hex(0x8a5ce8), hex(0xc8a8ff), (x + y) / 30), r, 0.1);
});
gd(Tile.GlimmerCluster, (px, r) => {
  for (const [cx, h, c] of [[5, 9, 0x6ad8ff], [8, 13, 0x9af0ff], [11, 8, 0x6ad8ff], [3, 5, 0x5ab8e8]] as [number, number, number][]) {
    for (let y = 15 - h; y <= 15; y++) {
      const w = Math.max(0, Math.floor((y - (15 - h)) / 4));
      for (let x = cx - w; x <= cx + w; x++) px.set(x, y, jitter(x === cx ? hex(0xe8ffff) : hex(c), r, 0.1));
    }
  }
});
gd(Tile.StarfallOre, (px, r) => {
  px.fill(speckle(0x2a2d44, 0x3a3e5a, 0.2, 0.12), r);
  for (let i = 0; i < 5; i++) {
    const cx = 2 + Math.floor(r() * 12);
    const cy = 2 + Math.floor(r() * 12);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) if (dx === 0 && dy === 0 || r() < 0.7) px.set(cx + dx, cy + dy, jitter(hex(0x7affd8), r, 0.12));
    px.set(cx, cy, hex(0xe8fff8));
  }
});
gd(Tile.GloamwoodLogSide, (px, r) => {
  px.fill((x, _y, rr) => jitter(x % 4 === 0 ? hex(0x2e2444) : hex(0x4a3a5e), rr, 0.14), r);
  for (let i = 0; i < 3; i++) {
    const x = 2 + Math.floor(r() * 12);
    const y = 2 + Math.floor(r() * 12);
    px.set(x, y, hex(0x7affd8));
    px.set(x, y + 1, hex(0x4fc8a8));
  }
});
gp(Tile.GloamwoodLogTop, logTop(0x2e2444, 0x6a5a8a, 0x8a78b0));
gp(Tile.GloamwoodLeaves, leaves(0x6a5cd8, 0x4a3fa8, 0.1, [0x9af0ff, 0.05]));
gp(Tile.GloamwoodPlanks, planksPainter(0x6a5a88, 0x463a60));
gp(Tile.Voidglass, (x, y, r) => {
  if (x === 0 || y === 0 || x === 15 || y === 15) return [58, 47, 92, 255];
  if ((x - y === 3 || x - y === 4) && x > 3 && x < 12) return [120, 100, 200, 255];
  return r() < 0.03 ? [100, 80, 190, 255] : CLEAR;
});
gd(Tile.LumenBell, (px, r) => {
  line(px, 8, 15, 8, 7, hex(0x3a8a8a));
  line(px, 8, 11, 5, 9, hex(0x3a8a8a));
  disc(px, 8, 5, 3.4, (x, y) => (y > 6 ? null : (x + y) % 4 === 0 ? hex(0xe8e0ff) : jitter(hex(0x9a8cff), r, 0.08)));
  for (const x of [5, 7, 9, 11]) px.set(x, 8, hex(0x6a5cd8));
  px.set(8, 9, hex(0xffffff));
});
gd(Tile.WispTuft, (px, r) => {
  for (let i = 0; i < 7; i++) {
    const x = 2 + i * 2;
    const h = 5 + Math.floor(r() * 7);
    for (let y = 15; y > 15 - h; y--) px.set(x + (y < 15 - h / 2 ? (i % 2 ? 1 : -1) : 0), y, jitter(y < 15 - h + 2 ? hex(0x9ab8ff) : hex(0x4a6ad8), r, 0.12));
  }
});
gp(Tile.MistcapTop, (x, y, r) => {
  const spot = (x * 5 + y * 3) % 11 === 0 && r() < 0.8;
  return jitter(spot ? hex(0xfff0ff) : hex(r() < 0.3 ? 0xc870ff : 0xa850e8), r, 0.1);
});
gp(Tile.MistcapSide, (x, y, r) => jitter(y > 12 ? (x % 2 ? hex(0xe8d0f8) : hex(0xb898d8)) : (x * 3 + y * 5) % 13 === 0 ? hex(0xfff0ff) : hex(0xa850e8), r, 0.1));
gp(Tile.MistcapStem, (x, y, r) => jitter(y % 6 === 5 ? hex(0xb8a8c8) : x % 5 === 0 ? hex(0xc8b8d8) : hex(0xe0d4ec), r, 0.07));
gp(Tile.SpirestoneSide, (x, y, r) => jitter((y + Math.floor(Math.sin(x * 0.7) * 1.4)) % 5 === 4 ? hex(0x8a7ea8) : (x + y * 2) % 9 === 0 ? hex(0xd0c4e8) : hex(0xb4a8d0), r, 0.08));
gp(Tile.SpirestoneTop, smoothTop(0xb4a8d0));
gp(Tile.GloamBricks, bricksPainter(0x5a4f78, 0x3a3252));
gp(Tile.PolishedGloamstone, polished(0x6a5f8a));
gp(Tile.Moonlamp, (x, y, r) => {
  const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
  return jitter(d > 6.5 ? hex(0x6a5a98) : d < 3 ? hex(0xffffff) : hex(0xdcd0ff), r, 0.05);
});
gd(Tile.LatticeStone, latticeStone(false));
gd(Tile.LatticeStoneLit, latticeStone(true));
gp(Tile.Veil, (x, y, r) => {
  const dx = x - 7.5;
  const dy = y - 7.5;
  const ang = Math.atan2(dy, dx);
  const rad = Math.hypot(dx, dy);
  const s = Math.sin(ang * 3 + rad * 0.9) + Math.sin(rad * 0.7 - ang) * 0.6;
  if (s < -0.9 && r() < 0.8) return CLEAR;
  const c = s > 0.9 ? hex(0xf4ecff) : s > 0.1 ? hex(0xb48cff) : hex(0x6a46e8);
  return jitter(c, r, 0.08);
});
gp(Tile.GloamMist, (x, y, r) => ((x + y * 3) % 7 === 0 || r() < 0.18 ? jitter(hex(0xa898e0), r, 0.1) : CLEAR));
gp(Tile.StarfallBlock, (x, y, r) => {
  const edge = x === 0 || y === 0 || x === 15 || y === 15;
  const star = (x * 7 + y * 11) % 17 === 0;
  return jitter(edge ? hex(0x2fb090) : star ? hex(0xffffff) : (x + y) % 6 === 0 ? hex(0x9affe0) : hex(0x4fe8c0), r, 0.06);
});
gp(Tile.EclipseBrick, (x, y, r) => {
  const row = Math.floor(y / 4);
  const mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
  return jitter(mortar ? hex(0x14102a) : r() < 0.03 ? hex(0xd8a848) : hex(0x2a2440), r, 0.1);
});
gp(Tile.OrreryBrass, (x, y, r) => {
  const d = Math.hypot(x - 7.5, y - 7.5);
  const edge = x === 0 || y === 0 || x === 15 || y === 15;
  return jitter(edge ? hex(0x9a6a28) : Math.abs(d - 5) < 0.7 || Math.abs(d - 2) < 0.6 ? hex(0xfff0a8) : hex(0xd8a848), r, 0.07);
});
gp(Tile.EclipseGlass, (x, y, r) => {
  if (x === 0 || y === 0 || x === 15 || y === 15 || x === 7 || y === 7) return hex(0x2a2048);
  return ((x + y) & 1) === 0 || r() < 0.2 ? (r() < 0.1 ? [210, 190, 255, 255] : [106, 79, 216, 255]) : CLEAR;
});
gp(Tile.Shardsand, (_x, _y, r) => (r() < 0.05 ? jitter(hex(0xd8c8ff), r, 0.1) : jitter(r() < 0.3 ? hex(0x7a6aa8) : hex(0x8a7ab8), r, 0.1)));
gd(Tile.Lumenvine, (px, r) => {
  for (const x of [4, 8, 12]) {
    const len = 9 + Math.floor(r() * 7);
    for (let y = 0; y < len; y++) px.set(x + (y % 4 === 2 ? 1 : 0), y, jitter(hex(0x3a8a8a), r, 0.12));
    px.set(x, len, hex(0x9af0ff));
    px.set(x, len - 3, hex(0x9af0ff));
  }
});

for (const [t, p] of Object.entries(GLOAM_PAINTERS)) PAINTERS[+t] = p as Painter;
for (const [t, d] of Object.entries(GLOAM_DRAWERS)) DRAWERS[+t] = d as Drawer;

/** Tiles drawn as sprites (transparent background): what the atlas test checks for both alpha kinds. */
export const SPRITE_TILES: readonly number[] = [
  Tile.TallGrass, Tile.Fern, Tile.DryGrass, Tile.DeadBush, Tile.Sunpetal, Tile.Rosette, Tile.Bluebell, Tile.Frostbloom,
  Tile.RedMushroom, Tile.BrownMushroom, Tile.Duskcap, Tile.Reeds, Tile.HangingMoss, Tile.LilyPad, Tile.Torch, Tile.Lantern, Tile.Ladder,
  Tile.GlimmerCluster, Tile.LumenBell, Tile.WispTuft, Tile.Lumenvine,
];

/**
 * Paints one 16x16 RGBA tile into `out` (16*16*4 bytes, row-major).
 * Returns false when no block painter owns the tile (item sprites, free tiles).
 */
export function paintTile(tile: number, out: Uint8ClampedArray): boolean {
  const painter = PAINTERS[tile];
  const drawer = DRAWERS[tile];
  if (!painter && !drawer) return false;
  out.fill(0);
  const px = new Px(out);
  const rnd = mulberry32(tile * 7919 + 17);
  if (drawer) drawer(px, rnd);
  else px.fill(painter!, rnd);
  return true;
}
