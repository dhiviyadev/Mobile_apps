/**
 * Procedural brand art, rendered at build time: app icons (any, maskable,
 * Apple), shortcut icons and the 1200×630 social preview image. The cube is
 * the same geometry as public/icon.svg; colours come from styles/base.css.
 */
import { drawText } from './pixelFont';
import { bboxOf, polygon, Raster, rect, type Rgb, ring, roundRect, type Shape } from './raster';

export const hex = (c: string): Rgb => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

const BG = hex('#10162a');
const BG_2 = hex('#161e38');
const GREEN = hex('#5fd17a');
const TEAL = hex('#2fb3a6');
const ORANGE = hex('#ff7a45');
const GOLD = hex('#ffd166');
const TEXT = hex('#eef2ff');
const MUTED = hex('#9aa6c8');

/** The logo's faces in 128-unit icon space, relative to its centre (64, 66). Farthest point: 40 units. */
const FACES: readonly { pts: readonly [number, number][]; color: Rgb }[] = [
  { pts: [[0, -40], [34, -20], [0, 0], [-34, -20]], color: GREEN },
  { pts: [[-34, -20], [0, 0], [0, 40], [-34, 20]], color: TEAL },
  { pts: [[34, -20], [0, 0], [0, 40], [34, 20]], color: ORANGE },
];
const LOGO_RADIUS = 40;

/** The cube logo as a shape group centred at (cx, cy), `scale` pixels per icon unit. */
export function logoShapes(cx: number, cy: number, scale: number): Shape[] {
  return FACES.map(({ pts, color }) => {
    const p = pts.map(([x, y]) => [cx + x * scale, cy + y * scale] as [number, number]);
    return { inside: polygon(p), color, bbox: bboxOf(p) };
  });
}

export type IconKind = 'any' | 'maskable' | 'apple';

export function renderIcon(kind: IconKind, size: number): Uint8Array {
  const r = new Raster(size, size);
  const k = size / 128;
  if (kind === 'any') {
    // Rounded square with transparent corners, exactly like icon.svg.
    r.fill({ inside: roundRect(0, 0, size, size, 28 * k), color: BG, bbox: [0, 0, size, size] });
    r.fillGroup(logoShapes(64 * k, 66 * k, k));
  } else {
    // Full bleed and opaque. Maskable: the logo stays inside the 40 % safe circle.
    r.shade(() => BG);
    const radius = (kind === 'maskable' ? 0.32 : 0.36) * size;
    r.fillGroup(logoShapes(size / 2, size / 2, radius / LOGO_RADIUS));
  }
  return r.png();
}

export function renderShortcutIcon(game: 'voxel' | 'arena'): Uint8Array {
  const s = 96;
  const r = new Raster(s, s);
  r.shade(() => BG);
  const c = s / 2;
  if (game === 'voxel') {
    r.fillGroup(logoShapes(c, c, (0.34 * s) / LOGO_RADIUS));
  } else {
    // An original crosshair: ring, four ticks and a centre dot.
    r.fill({ inside: ring(c, c, 0.22 * s, 0.3 * s), color: ORANGE, bbox: [0, 0, s, s] });
    const t = 0.06 * s;
    const from = 0.12 * s;
    const to = 0.38 * s;
    for (const [x, y, w, h] of [
      [c - t / 2, c - to, t, to - from],
      [c - t / 2, c + from, t, to - from],
      [c - to, c - t / 2, to - from, t],
      [c + from, c - t / 2, to - from, t],
    ]) {
      r.fill({ inside: rect(x, y, w, h), color: ORANGE, bbox: [x, y, x + w, y + h] });
    }
    r.fill({ inside: ring(c, c, 0, 0.045 * s), color: GOLD, bbox: [0, 0, s, s] });
  }
  return r.png();
}

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Strings drawn on the social preview (all covered by FONT_5X7; unit-tested). */
export const OG_TEXT = {
  line1: 'COBALT',
  line2: 'GAME HUB',
  voxel: 'VOXELVALE',
  arena: 'ARCFIRE ARENA',
  tagline: 'FREE 3D GAMES - PLAY OFFLINE',
} as const;

export function renderOgImage(): Uint8Array {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const r = new Raster(W, H);
  const glows: { c: Rgb; x: number; y: number; rad: number; a: number }[] = [
    { c: GREEN, x: 180, y: 0, rad: 620, a: 0.18 },
    { c: ORANGE, x: 1020, y: 60, rad: 620, a: 0.18 },
  ];
  r.shade((x, y) => {
    const t = y / (H - 1);
    let col: [number, number, number] = [0, 1, 2].map((i) => BG[i] + (BG_2[i] - BG[i]) * t) as [number, number, number];
    for (const g of glows) {
      const d = Math.hypot(x - g.x, y - g.y);
      if (d >= g.rad) continue;
      const k = g.a * (1 - d / g.rad) ** 2;
      col = col.map((v, i) => v + (g.c[i] - v) * k) as [number, number, number];
    }
    return col;
  });
  r.fillGroup(logoShapes(300, 315, 5.2));
  drawText(r, OG_TEXT.line1, 560, 150, 11, TEXT);
  drawText(r, OG_TEXT.line2, 560, 249, 11, GOLD);
  drawText(r, OG_TEXT.voxel, 560, 372, 4, GREEN);
  drawText(r, OG_TEXT.arena, 560 + (OG_TEXT.voxel.length + 1) * 6 * 4, 372, 4, ORANGE);
  drawText(r, OG_TEXT.tagline, 560, 430, 3, MUTED);
  r.fill({ inside: rect(0, 614, 600, 16), color: GREEN, bbox: [0, 614, 600, 630] });
  r.fill({ inside: rect(600, 614, 600, 16), color: ORANGE, bbox: [600, 614, 1200, 630] });
  return r.png();
}
