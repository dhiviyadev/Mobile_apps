/**
 * Procedural pixel-art texture atlas: 8x8 tiles of 16x16 px, painted with a
 * seeded RNG at startup. One small texture for the whole voxel world means
 * one material, no image downloads, and fully original art.
 *
 * Tile indices match `Tile` in @hub/shared/voxel/blocks.
 */
import * as THREE from 'three';
import { Block, blockDef, mulberry32, Tile } from '@hub/shared';

export const TILE_PX = 16;
export const ATLAS_TILES = 8;
const SIZE = TILE_PX * ATLAS_TILES;

type RGB = [number, number, number];
type Painter = (x: number, y: number, rnd: () => number) => RGB | [number, number, number, number];

const hex = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const jitter = (c: RGB, rnd: () => number, amount: number): RGB => {
  const k = 1 + (rnd() - 0.5) * amount;
  return [c[0] * k, c[1] * k, c[2] * k];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const GRASS = hex(0x6abf4b);
const DIRT = hex(0x8a5a3b);
const STONE = hex(0x8c8f99);
const SAND = hex(0xe8d39a);

function grassEdge(x: number, rnd: () => number): number {
  return 3 + Math.floor(Math.abs(Math.sin(x * 1.7)) * 2 + rnd() * 1.5);
}

const PAINTERS: Partial<Record<number, Painter>> = {
  [Tile.GrassTop]: (_x, _y, r) => jitter(r() < 0.12 ? hex(0x7fd35c) : GRASS, r, 0.22),
  [Tile.GrassSide]: (x, y, r) => (y < grassEdge(x, r) ? jitter(GRASS, r, 0.2) : jitter(DIRT, r, 0.25)),
  [Tile.SnowyGrassSide]: (x, y, r) => (y < grassEdge(x, r) ? jitter(hex(0xf2f6ff), r, 0.06) : jitter(DIRT, r, 0.25)),
  [Tile.Dirt]: (_x, _y, r) => jitter(r() < 0.1 ? hex(0x6e4529) : DIRT, r, 0.25),
  [Tile.Stone]: (x, y, r) => jitter(Math.sin(x * 0.9 + y * 0.4) + Math.cos(y * 1.3) > 1.2 ? hex(0x777a84) : STONE, r, 0.15),
  [Tile.Sand]: (_x, _y, r) => jitter(r() < 0.08 ? hex(0xd4bd7e) : SAND, r, 0.1),
  [Tile.Water]: (x, y, r) => jitter(Math.sin((x + y * 0.5) * 0.8) > 0.85 ? hex(0x7cc4f2) : hex(0x3f8fd8), r, 0.06),
  [Tile.LogSide]: (x, _y, r) => jitter(x % 4 === 0 ? hex(0x6b4a2e) : hex(0x8b6340), r, 0.15),
  [Tile.LogTop]: (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    return jitter(d > 7 ? hex(0x6b4a2e) : Math.floor(d) % 3 === 0 ? hex(0xa07a4c) : hex(0xc49a5c), r, 0.08);
  },
  [Tile.Leaves]: (_x, _y, r) => (r() < 0.08 ? [0, 0, 0, 0] : jitter(r() < 0.3 ? hex(0x3f7f2e) : hex(0x4f9a3a), r, 0.25)),
  [Tile.Planks]: (x, y, r) => {
    const seam = y % 4 === 3 || (x === (y < 4 ? 5 : y < 8 ? 12 : y < 12 ? 2 : 9) && true);
    return jitter(seam ? hex(0x8f6a3c) : hex(0xc49a5c), r, 0.1);
  },
  [Tile.Cobble]: (x, y, r) => {
    const cell = Math.sin(x * 1.1 + Math.floor(y / 4) * 2.3) * Math.cos(y * 1.4 + Math.floor(x / 5));
    return jitter(Math.abs(cell) < 0.18 ? hex(0x55575e) : hex(0x868991), r, 0.18);
  },
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

/** Crack overlay stages occupy the last atlas row. */
function crackPainter(stage: number): Painter {
  return (x, y, r) => {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const v = n - Math.floor(n);
    const lines = Math.abs(Math.sin(x * 0.9 + y * 0.6)) < 0.08 * (stage + 1) || Math.abs(Math.cos(x * 0.5 - y * 0.9)) < 0.05 * (stage + 1);
    return lines || v < stage * 0.02 ? [20, 16, 12, 160 + r() * 60] : [0, 0, 0, 0];
  };
}

export function createAtlasCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const paint = (tile: number, painter: Painter) => {
    const rnd = mulberry32(tile * 7919 + 17);
    const ox = (tile % ATLAS_TILES) * TILE_PX;
    const oy = Math.floor(tile / ATLAS_TILES) * TILE_PX;
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const c = painter(x, y, rnd);
        const i = ((oy + y) * SIZE + ox + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, c[0]));
        img.data[i + 1] = Math.max(0, Math.min(255, c[1]));
        img.data[i + 2] = Math.max(0, Math.min(255, c[2]));
        img.data[i + 3] = c.length === 4 ? c[3] : 255;
      }
    }
  };
  for (const [tile, painter] of Object.entries(PAINTERS)) paint(Number(tile), painter!);
  for (let s = 0; s < 8; s++) paint(Tile.Crack0 + s, crackPainter(s));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function createAtlasTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Draws an isometric icon of a block (for the hotbar) onto a new canvas. */
export function drawBlockIcon(atlas: HTMLCanvasElement, block: Block, size = 48): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const def = blockDef(block);
  const w = (size / 2) * 0.94; // half width of the cube outline
  const ox = size / 2 - w;
  const oy = size / 2 - w;
  const k = w / TILE_PX;
  const tileXY = (t: number) => [(t % ATLAS_TILES) * TILE_PX, Math.floor(t / ATLAS_TILES) * TILE_PX];
  const face = (t: number, a: number, b: number, cc: number, d: number, e: number, f: number, shade: number) => {
    const [tx, ty] = tileXY(t);
    ctx.save();
    ctx.setTransform(a, b, cc, d, e + ox, f + oy);
    ctx.drawImage(atlas, tx, ty, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX);
    if (shade < 1) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
      ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    }
    ctx.restore();
  };
  // Map the tile square onto the three visible faces of an isometric cube.
  face(def.tiles[0], k, k / 2, -k, k / 2, w, 0, 1); // top
  face(def.tiles[2], k, k / 2, 0, k, 0, w / 2, 0.8); // left
  face(def.tiles[2], k, -k / 2, 0, k, w, w, 0.62); // right
  return c;
}
