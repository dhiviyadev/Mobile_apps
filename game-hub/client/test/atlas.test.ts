import { describe, expect, it, vi } from 'vitest';
import { BLOCKS, Tile } from '@hub/shared';
import { paintTile, SPRITE_TILES } from '../src/games/voxel/world/atlasRecipes';

vi.mock('../src/games/voxel/world/itemSprites', () => ({
  paintItemTile: vi.fn((tile: number, out: Uint8ClampedArray) => {
    if (tile !== 160) return false;
    out.fill(200);
    return true;
  }),
}));

/** Measured with the pre-upgrade atlas.ts (commit 0183d45). */
const ORIGINAL_TILES_FNV = '39eaebb2';
const tile = () => new Uint8ClampedArray(16 * 16 * 4);

describe('block atlas', () => {
  it('paints every tile a block references, and the crack stages', () => {
    const used = new Set<number>();
    for (const d of BLOCKS) if (d) for (const t of d.tiles) used.add(t);
    for (let s = 0; s < 8; s++) used.add(Tile.Crack0 + s);
    const missing = [...used].filter((t) => !paintTile(t, tile()));
    expect(missing).toEqual([]);
    for (const t of used) expect(t).toBeLessThan(512);
    expect(used.has(Tile.BedrollTop) && used.has(Tile.BedrollSide)).toBe(true);
    expect(paintTile(Tile.ItemSprites, tile())).toBe(false);
  });

  it('paints sprites with transparent and opaque pixels, deterministically', () => {
    for (const t of SPRITE_TILES) {
      const a = tile();
      paintTile(t, a);
      let clear = 0;
      let solid = 0;
      for (let i = 3; i < a.length; i += 4) a[i] === 0 ? clear++ : solid++;
      expect(clear, `tile ${t}`).toBeGreaterThan(0);
      expect(solid, `tile ${t}`).toBeGreaterThan(0);
      const b = tile();
      paintTile(t, b);
      expect(b).toEqual(a);
    }
  });

  it('keeps the original tiles byte for byte and asks the item sprites for the rest', async () => {
    // FNV-1a of tiles 0..22 as the 8x8 atlas painted them before the world upgrade.
    let h = 0x811c9dc5;
    for (let t = 0; t <= 22; t++) {
      const a = tile();
      paintTile(t, a);
      for (const v of a) h = Math.imul(h ^ v, 0x01000193);
    }
    expect((h >>> 0).toString(16)).toBe(ORIGINAL_TILES_FNV);
    const { paintAtlasPixels } = await import('../src/games/voxel/world/atlas');
    const { paintItemTile } = await import('../src/games/voxel/world/itemSprites');
    const atlas = paintAtlasPixels();
    expect(paintItemTile).toHaveBeenCalledWith(160, expect.any(Uint8ClampedArray));
    // Tile 160 sits at column 0, row 10 of the 256-px-wide atlas.
    expect(atlas[(10 * 16 * 256) * 4]).toBe(200);
  });
});
