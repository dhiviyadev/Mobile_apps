/**
 * Voxelvale sound recipes (WP-A: stepStone, stepWood, stepSand, stepSnow, breakGlass, breakPlant, lavaBubble).
 * Import only types from ./sfx; helpers arrive as `k`.
 */
import type { SfxDef, SynthKit } from './sfx';

export const voxelWorldSfx = (k: SynthKit) => {
  void k;
  return {} satisfies Record<string, SfxDef>;
};
