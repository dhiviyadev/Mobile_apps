import { describe, expect, it } from 'vitest';
import { ARENA_MAPS } from '@hub/shared';
import { drawMapThumbnail, mapThumbnail, thumbnailLayout } from '../src/games/arena/render/mapThumbnail';

/** A 2D context that records fillRect calls and ignores everything else. */
function stubContext() {
  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(ctx.fillStyle) });
    },
    strokeRect() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe('map thumbnails', () => {
  it('fit every map into the canvas, as large as the space allows', () => {
    for (const map of ARENA_MAPS) {
      const W = 320;
      const H = 200;
      const L = thumbnailLayout(map, W, H, 6);
      const b = map.bounds;
      // Walls (1 m outside the bounds) and the tallest box stay inside the padded area.
      const left = L.ox + (b.minX - 1) * L.s;
      const right = L.ox + (b.maxX + 1) * L.s;
      const top = L.oz + (b.minZ - 1) * L.s - L.hMax * 0.55 * L.s;
      const bottom = L.oz + (b.maxZ + 1) * L.s;
      expect(left, map.id).toBeGreaterThanOrEqual(6 - 1e-6);
      expect(right, map.id).toBeLessThanOrEqual(W - 6 + 1e-6);
      expect(top, map.id).toBeGreaterThanOrEqual(6 - 1e-6);
      expect(bottom, map.id).toBeLessThanOrEqual(H - 6 + 1e-6);
      // One axis is tight: the map fills the card.
      expect(Math.min(left - 6, W - 6 - right, top - 6, H - 6 - bottom), map.id).toBeLessThan(1e-6 + Math.max(right - left, bottom - top));
      expect(Math.abs(left - 6 - (W - 6 - right)) < 1e-6 || Math.abs(top - 6 - (H - 6 - bottom)) < 1e-6, `${map.id} centred`).toBe(true);
      expect(L.s, map.id).toBeGreaterThan(2);
    }
  });

  it('draws every box (top and front) plus overlays inside the canvas', () => {
    for (const map of ARENA_MAPS) {
      const { ctx, rects } = stubContext();
      drawMapThumbnail(ctx, map, 640, 400, 12);
      // Background + each box twice (front, top; the floor and the cut-away south cap less) + grid lines + pickups + spawn ticks.
      expect(rects.length, map.id).toBeGreaterThanOrEqual(1 + (map.boxes.length - 2) * 2 + 1 + map.pickups.length + 12);
      expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 640, h: 400 });
      for (const r of rects) {
        expect(r.x, map.id).toBeGreaterThanOrEqual(-1e-6);
        expect(r.y, map.id).toBeGreaterThanOrEqual(-1e-6);
        expect(r.x + r.w, map.id).toBeLessThanOrEqual(640 + 1e-6);
        expect(r.y + r.h, map.id).toBeLessThanOrEqual(400 + 1e-6);
        expect(r.w).toBeGreaterThanOrEqual(0);
        expect(r.h).toBeGreaterThanOrEqual(0);
      }
      // Map colours are used (theme floor and cover).
      expect(new Set(rects.map((r) => r.fill)).size, map.id).toBeGreaterThan(6);
    }
  });

  it('caches one canvas per map and size', () => {
    let made = 0;
    const create = () => {
      made++;
      return { width: 0, height: 0, getContext: () => stubContext().ctx } as unknown as HTMLCanvasElement;
    };
    const a = mapThumbnail(ARENA_MAPS[0], 320, 200, create);
    expect(a.width).toBe(320);
    expect(a.height).toBe(200);
    expect(mapThumbnail(ARENA_MAPS[0], 320, 200, create)).toBe(a);
    expect(made).toBe(1);
    expect(mapThumbnail(ARENA_MAPS[1], 320, 200, create)).not.toBe(a);
    expect(mapThumbnail(ARENA_MAPS[0], 160, 100, create)).not.toBe(a);
    expect(made).toBe(3);
  });
});
