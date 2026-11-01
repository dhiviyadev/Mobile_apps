/**
 * Day/night helpers shared by the sky renderer (client/src/games/voxel/sky/Sky.ts),
 * mob spawning and survival (resting, night warnings). timeOfDay is 0..1 with
 * 0.25 = sunrise, 0.5 = noon, 0.75 = sunset (VoxelState.timeOfDay).
 */

/** 0 at night .. 1 in full day: smoothstep(-0.18, 0.25) of the sun elevation (exactly Sky.update). */
export function daylightAt(timeOfDay: number): number {
  const e = Math.sin((timeOfDay - 0.25) * Math.PI * 2);
  const t = Math.min(1, Math.max(0, (e + 0.18) / 0.43));
  return t * t * (3 - 2 * t);
}

/** Sky light level the sun gives an open cell: 15 at noon, 4 at night. */
export function skyLevelAt(timeOfDay: number): number {
  return Math.round(4 + 11 * daylightAt(timeOfDay));
}

/** Time a skipped night (resting) jumps to. */
export const DAWN_TIME = 0.23;
/** Time the "Night falls" warning plays. */
export const DUSK_TIME = 0.77;

export function isNight(timeOfDay: number): boolean {
  return daylightAt(timeOfDay) < 0.25;
}
