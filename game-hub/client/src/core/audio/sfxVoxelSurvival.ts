/**
 * Voxelvale sound recipes (WP-B: swing, swingHeavy, hitFlesh, hitCrit, shieldBlock, shieldBreak, bowDraw, bowRelease, xbowLoad, xbowFire, arrowStick, arrowFlesh, eat, eatDone, pickup, toolBreak, death, respawn, drown, craft, invOpen, nightFall, satchel).
 * Import only types from ./sfx; helpers arrive as `k`.
 */
import type { SfxDef, SynthKit } from './sfx';

export const voxelSurvivalSfx = (k: SynthKit) => {
  void k;
  return {} satisfies Record<string, SfxDef>;
};
