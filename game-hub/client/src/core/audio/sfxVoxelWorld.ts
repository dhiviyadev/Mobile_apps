/**
 * Voxelvale world sounds (WP-A): footsteps per material, glass and plant
 * breaking, and bubbling lava. Import only types from ./sfx; helpers arrive as `k`.
 */
import type { SfxDef, SynthKit } from './sfx';

export const voxelWorldSfx = (k: SynthKit) => {
  const { tone, noise, notes } = k;
  return {
    stepStone: { play: (v) => noise(v, { dur: 0.05, vol: 0.13, type: 'bandpass', freq: 1500, q: 1.1 }), length: 0.08, minGap: 0.08 },
    stepWood: {
      play: (v) => {
        tone(v, { type: 'triangle', freq: 190, freqEnd: 120, dur: 0.06, vol: 0.1 });
        noise(v, { dur: 0.04, vol: 0.06, type: 'bandpass', freq: 900, q: 1.5 });
      },
      length: 0.1,
      minGap: 0.08,
    },
    stepSand: { play: (v) => noise(v, { dur: 0.08, vol: 0.1, type: 'highpass', freq: 2500, attack: 0.01 }), length: 0.1, minGap: 0.08 },
    stepSnow: { play: (v) => noise(v, { dur: 0.09, vol: 0.11, type: 'bandpass', freq: 3200, freqEnd: 1800, q: 0.7, attack: 0.015 }), length: 0.12, minGap: 0.08 },
    breakGlass: {
      play: (v) => {
        notes(v, [2400, 3100, 2700, 3600], 0.025, 'triangle', 0.12, 0.12);
        noise(v, { dur: 0.15, vol: 0.25, type: 'highpass', freq: 3000 });
      },
      length: 0.3,
    },
    breakPlant: { play: (v) => noise(v, { dur: 0.12, vol: 0.18, type: 'bandpass', freq: 1800, freqEnd: 700, q: 0.9, attack: 0.01 }), length: 0.15 },
    lavaBubble: {
      play: (v) => {
        tone(v, { type: 'sine', freq: 110, freqEnd: 240, dur: 0.12, vol: 0.12 });
        noise(v, { dur: 0.2, vol: 0.08, freq: 300, freqEnd: 120, delay: 0.05 });
      },
      length: 0.3,
      minGap: 0.6,
    },
  } satisfies Record<string, SfxDef>;
};
