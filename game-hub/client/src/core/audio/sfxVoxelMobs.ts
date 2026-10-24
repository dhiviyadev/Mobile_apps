/**
 * Voxelvale sound recipes (WP-C: the voice() helper and the creature/boss recipes (mob bow draw is mobBowDraw)).
 * Import only types from ./sfx; helpers arrive as `k`.
 */
import type { SfxDef, SynthKit } from './sfx';

export const voxelMobSfx = (k: SynthKit) => {
  void k;
  return {} satisfies Record<string, SfxDef>;
};
