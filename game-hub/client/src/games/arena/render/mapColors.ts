/**
 * Map box colours from the map theme, shared by the 3D map mesh and the 2D
 * vote-card thumbnails (no three.js here).
 */
import type { ArenaMap, BoxKind } from '@hub/shared';

/** Base colour (0xRRGGBB) of a box kind on this map. */
export function kindColor(map: ArenaMap, kind: BoxKind): number {
  const t = map.theme;
  switch (kind) {
    case 'floor':
      return t.floor;
    case 'wall':
    case 'pillar':
      return t.wall;
    case 'platform':
    case 'stairs':
      return t.platform;
    case 'accent':
      return t.accent;
    case 'trim':
      return t.trim;
    case 'pad':
      // A dark rim under the glowing pad cap.
      return scaleColor(t.pad, 0.45);
    default:
      return t.cover;
  }
}

/** Colour × k per channel (clamped), as 0xRRGGBB. */
export function scaleColor(c: number, k: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** CSS colour string for 0xRRGGBB × k. */
export function cssColor(c: number, k = 1): string {
  return `#${scaleColor(c, k).toString(16).padStart(6, '0')}`;
}
