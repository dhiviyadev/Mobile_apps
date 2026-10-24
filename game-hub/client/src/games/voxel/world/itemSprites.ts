/**
 * Item sprite painters for atlas tiles 160..239 (WP-B owns this file after WP0;
 * recipes in design-voxel-survival §17.6 and §19.6). WP-A's atlas builder calls
 * paintItemTile for every tile its own block painters do not cover.
 */

/** Paints one 16x16 RGBA tile into `out` (16*16*4 bytes, row-major). False = no painter for this tile. */
export function paintItemTile(_tile: number, _out: Uint8ClampedArray): boolean {
  return false;
}
