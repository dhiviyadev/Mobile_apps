/**
 * Voxelvale survival sounds (WP-B; design-voxel-survival §18): procedural
 * swings, hits, shields, bows, crossbows, eating, pickups and life events.
 * Import only types from ./sfx; helpers arrive as `k`.
 */
import type { SfxDef, SynthKit } from './sfx';

export const voxelSurvivalSfx = (k: SynthKit) => {
  const { tone, noise, notes } = k;
  return {
    swing: { play: (v) => noise(v, { dur: 0.18, vol: 0.22, type: 'bandpass', freq: 1300, freqEnd: 420, q: 1.2, attack: 0.03 }), length: 0.22, minGap: 0.08 },
    swingHeavy: { play: (v) => noise(v, { dur: 0.26, vol: 0.26, type: 'bandpass', freq: 800, freqEnd: 240, q: 1.0, attack: 0.05 }), length: 0.3, minGap: 0.1 },
    hitFlesh: {
      play: (v) => {
        noise(v, { dur: 0.08, vol: 0.32, freq: 600, freqEnd: 150 });
        tone(v, { freq: 150, freqEnd: 70, dur: 0.08, vol: 0.25 });
      },
      length: 0.12,
      minGap: 0.03,
    },
    hitCrit: {
      play: (v) => {
        noise(v, { dur: 0.08, vol: 0.34, freq: 700, freqEnd: 160 });
        notes(v, [1800, 2400], 0.03, 'triangle', 0.14, 0.06);
      },
      length: 0.15,
      minGap: 0.03,
    },
    shieldBlock: {
      play: (v) => {
        tone(v, { type: 'square', freq: 1900, dur: 0.04, vol: 0.1 });
        noise(v, { dur: 0.1, vol: 0.22, type: 'bandpass', freq: 3200, q: 4 });
        tone(v, { type: 'triangle', freq: 620, freqEnd: 540, dur: 0.15, vol: 0.16 });
      },
      length: 0.2,
      minGap: 0.04,
    },
    shieldBreak: {
      play: (v) => {
        noise(v, { dur: 0.16, vol: 0.3, type: 'highpass', freq: 2500 });
        tone(v, { type: 'sawtooth', freq: 400, freqEnd: 120, dur: 0.25, vol: 0.12 });
      },
      length: 0.3,
      minGap: 0.2,
    },
    bowDraw: {
      play: (v) => {
        tone(v, { type: 'sawtooth', freq: 70, freqEnd: 110, dur: 0.6, vol: 0.04, attack: 0.2 });
        noise(v, { dur: 0.6, vol: 0.05, type: 'bandpass', freq: 500, q: 8, attack: 0.2 });
      },
      length: 0.65,
      minGap: 0.3,
    },
    bowRelease: {
      play: (v) => {
        tone(v, { type: 'triangle', freq: 220, freqEnd: 140, dur: 0.16, vol: 0.22 });
        noise(v, { dur: 0.06, vol: 0.18, type: 'bandpass', freq: 2400, freqEnd: 900, q: 3 });
      },
      length: 0.2,
      minGap: 0.05,
    },
    xbowLoad: {
      play: (v) => {
        noise(v, { dur: 0.05, vol: 0.2, type: 'bandpass', freq: 1800, q: 5 });
        tone(v, { type: 'square', freq: 520, freqEnd: 900, dur: 0.05, vol: 0.06, delay: 0.04 });
        noise(v, { dur: 0.04, vol: 0.24, type: 'highpass', freq: 3000, delay: 0.1 });
      },
      length: 0.2,
      minGap: 0.1,
    },
    xbowFire: {
      play: (v) => {
        noise(v, { dur: 0.05, vol: 0.32, type: 'highpass', freq: 2200 });
        tone(v, { type: 'triangle', freq: 330, freqEnd: 90, dur: 0.14, vol: 0.26 });
        noise(v, { dur: 0.12, vol: 0.12, type: 'bandpass', freq: 900, freqEnd: 400, q: 2, delay: 0.02 });
      },
      length: 0.2,
      minGap: 0.05,
    },
    arrowStick: {
      play: (v) => {
        noise(v, { dur: 0.04, vol: 0.25, type: 'bandpass', freq: 1500, q: 3 });
        tone(v, { type: 'triangle', freq: 180, freqEnd: 140, dur: 0.12, vol: 0.1, delay: 0.01 });
      },
      length: 0.15,
      minGap: 0.03,
    },
    arrowFlesh: { play: (v) => noise(v, { dur: 0.07, vol: 0.28, freq: 500, freqEnd: 140 }), length: 0.1, minGap: 0.03 },
    eat: { play: (v) => noise(v, { dur: 0.06, vol: 0.2, type: 'bandpass', freq: 1100 + Math.random() * 400, q: 2 }), length: 0.08, minGap: 0.2 },
    eatDone: { play: (v) => notes(v, [660, 880], 0.05, 'sine', 0.1, 0.08), length: 0.15 },
    pickup: { play: (v) => tone(v, { freq: 600, freqEnd: 1200, dur: 0.06, vol: 0.12 }), length: 0.08, minGap: 0.04 },
    toolBreak: {
      play: (v) => {
        noise(v, { dur: 0.08, vol: 0.3, type: 'highpass', freq: 2500 });
        tone(v, { type: 'square', freq: 900, freqEnd: 300, dur: 0.12, vol: 0.1 });
      },
      length: 0.15,
    },
    death: { play: (v) => notes(v, [523, 392, 262], 0.12, 'triangle', 0.2, 0.2), length: 0.6 },
    respawn: { play: (v) => notes(v, [392, 523, 659], 0.08, 'sine', 0.16, 0.18), length: 0.4 },
    drown: {
      play: (v) => {
        for (let i = 0; i < 3; i++) tone(v, { freq: 300, freqEnd: 600, dur: 0.05, vol: 0.08, delay: i * 0.07 });
      },
      length: 0.25,
      minGap: 0.5,
    },
    craft: {
      play: (v) => {
        noise(v, { dur: 0.04, vol: 0.2, type: 'bandpass', freq: 700, q: 3 });
        noise(v, { dur: 0.04, vol: 0.2, type: 'bandpass', freq: 760, q: 3, delay: 0.07 });
        tone(v, { freq: 1200, dur: 0.03, vol: 0.08, delay: 0.12 });
      },
      length: 0.2,
      minGap: 0.06,
    },
    invOpen: { play: (v) => noise(v, { dur: 0.08, vol: 0.12, freq: 1500, freqEnd: 600 }), length: 0.1 },
    nightFall: { play: (v) => notes(v, [196, 147], 0.4, 'sine', 0.08, 0.8), length: 1.2 },
    satchel: { play: (v) => notes(v, [1320, 1760, 2093], 0.04, 'triangle', 0.12, 0.08), length: 0.25 },
  } satisfies Record<string, SfxDef>;
};
