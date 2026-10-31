/**
 * Procedural pixel-art texture atlas: 16x16 tiles of 16x16 px (256x256 RGBA),
 * painted with seeded RNGs at startup (painters in atlasRecipes.ts; item
 * sprites in itemSprites.ts). One small texture for the whole voxel world means
 * one material, no image downloads, and fully original art.
 *
 * Tile indices match `Tile` in @hub/shared/voxel/blocks.
 */
import * as THREE from 'three';
import { ATLAS_COLS, Block, blockDef, BlockShape, SHAPE, SHAPE_BOUNDS } from '@hub/shared';
import { paintTile, TILE_PX } from './atlasRecipes';
import { paintItemTile } from './itemSprites';

export { TILE_PX };
export const ATLAS_TILES = ATLAS_COLS;
const SIZE = TILE_PX * ATLAS_TILES;

/**
 * Every tile of the atlas as RGBA pixels (SIZE x SIZE): block painters first,
 * item sprites for the tiles they do not paint. Pure, so tests run it in Node.
 */
export function paintAtlasPixels(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const tile = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  for (let t = 0; t < ATLAS_TILES * ATLAS_TILES; t++) {
    if (!paintTile(t, tile)) {
      tile.fill(0);
      if (!paintItemTile(t, tile)) continue;
    }
    const ox = (t % ATLAS_TILES) * TILE_PX;
    const oy = Math.floor(t / ATLAS_TILES) * TILE_PX;
    for (let y = 0; y < TILE_PX; y++) out.set(tile.subarray(y * TILE_PX * 4, (y + 1) * TILE_PX * 4), ((oy + y) * SIZE + ox) * 4);
  }
  return out;
}

export function createAtlasCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  img.data.set(paintAtlasPixels());
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

const tileXY = (t: number) => [(t % ATLAS_TILES) * TILE_PX, Math.floor(t / ATLAS_TILES) * TILE_PX];

/**
 * Draws an icon of a block (hotbar, picker) onto a new canvas: an isometric
 * cube, a shorter box for slabs/chests/cactus, or the flat sprite for plants,
 * ladders, torches and lanterns.
 */
export function drawBlockIcon(atlas: HTMLCanvasElement, block: Block, size = 48): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const def = blockDef(block);
  const shape = SHAPE[block];
  if (shape === BlockShape.Cross || shape === BlockShape.Pad || shape === BlockShape.Ladder || block === Block.Torch || block === Block.Lantern) {
    const [tx, ty] = tileXY(shape === BlockShape.Pad ? def.tiles[0] : def.tiles[2]);
    const s = size * 0.8;
    ctx.drawImage(atlas, tx, ty, TILE_PX, TILE_PX, (size - s) / 2, (size - s) / 2, s, s);
    return c;
  }
  const w = (size / 2) * 0.94; // half width of the cube outline
  const k = w / TILE_PX;
  // Boxes: vertical faces as tall as the box, sitting on the icon floor.
  const hk = shape === BlockShape.Box ? Math.max(0.15, SHAPE_BOUNDS[block * 6 + 4] - SHAPE_BOUNDS[block * 6 + 1]) : 1;
  const ox = size / 2 - w;
  const oy = size / 2 - w + w * (1 - hk);
  const face = (t: number, a: number, b: number, cc: number, d: number, e: number, f: number, shade: number, srcH = TILE_PX) => {
    const [tx, ty] = tileXY(t);
    ctx.save();
    ctx.setTransform(a, b, cc, d, e + ox, f + oy);
    ctx.drawImage(atlas, tx, ty + TILE_PX - srcH, TILE_PX, srcH, 0, 0, TILE_PX, srcH);
    if (shade < 1) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
      ctx.fillRect(0, 0, TILE_PX, srcH);
    }
    ctx.restore();
  };
  const srcH = Math.max(1, Math.round(TILE_PX * hk));
  // Map the tile square onto the three visible faces of an isometric cube.
  face(def.tiles[0], k, k / 2, -k, k / 2, w, 0, 1); // top
  face(def.tiles[2], k, k / 2, 0, k, 0, w / 2, 0.8, srcH); // left
  face(def.tiles[2], k, -k / 2, 0, k, w, w, 0.62, srcH); // right
  return c;
}
