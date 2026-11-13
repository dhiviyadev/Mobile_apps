/**
 * Sounds of the generator-4 ruin bosses (package S): roars and signature
 * attacks (all procedural). Names are prefixed `ruin`. Import only types from
 * ./sfx; helpers arrive as `k`.
 */
import type { NoiseOpts, SfxDef, SynthKit, ToneOpts } from './sfx';

type Step = { n: NoiseOpts } | { t: ToneOpts } | { notes: [number[], number, OscillatorType, number, number] };

export const voxelRuinSfx = (k: SynthKit) => {
  const r = (steps: Step[], length: number, minGap?: number): SfxDef => ({
    play: (v) => {
      for (const s of steps) {
        if ('n' in s) k.noise(v, s.n);
        else if ('t' in s) k.tone(v, s.t);
        else k.notes(v, s.notes[0], s.notes[1], s.notes[2], s.notes[3], s.notes[4]);
      }
    },
    length,
    minGap,
  });
  return {
    // Brineclaw Matriarch: clacking claws, a wet roar, riptide whoosh, surge crash.
    ruinClack: r([{ t: { type: 'square', freq: 900, freqEnd: 500, dur: 0.05, vol: 0.12 } }, { t: { type: 'square', freq: 1100, freqEnd: 600, dur: 0.05, vol: 0.12, delay: 0.09 } }, { n: { dur: 0.06, type: 'bandpass', freq: 2200, q: 4, vol: 0.12 } }], 0.25, 0.6),
    ruinBrineRoar: r([{ t: { type: 'sawtooth', freq: 90, freqEnd: 55, dur: 1.5, vol: 0.3 } }, { n: { dur: 1.4, type: 'bandpass', freq: 500, freqEnd: 250, q: 1.5, vol: 0.35 } }, { t: { type: 'sine', freq: 300, freqEnd: 150, dur: 0.9, vol: 0.12, delay: 0.2 } }], 1.7, 1.0),
    ruinRiptide: r([{ n: { dur: 1.2, type: 'bandpass', freq: 400, freqEnd: 1800, q: 1, vol: 0.4, attack: 0.5 } }, { t: { type: 'sine', freq: 120, freqEnd: 60, dur: 1.0, vol: 0.3 } }], 1.3, 0.5),
    ruinSurge: r([{ n: { dur: 0.9, type: 'lowpass', freq: 900, freqEnd: 200, vol: 0.6, attack: 0.15 } }, { t: { freq: 70, freqEnd: 35, dur: 0.6, vol: 0.5 } }], 1.0, 0.3),
    // Stormtalon: shrieks, gusts, thunder.
    ruinGust: r([{ n: { dur: 0.5, type: 'bandpass', freq: 700, freqEnd: 1600, q: 0.8, vol: 0.2, attack: 0.15 } }], 0.6, 0.6),
    ruinStormRoar: r([{ t: { type: 'sawtooth', freq: 1400, freqEnd: 700, dur: 0.9, vol: 0.18 } }, { t: { type: 'square', freq: 2100, freqEnd: 900, dur: 0.7, vol: 0.08, delay: 0.1 } }, { n: { dur: 1.0, type: 'highpass', freq: 2500, vol: 0.2 } }], 1.3, 1.0),
    ruinDive: r([{ n: { dur: 0.7, type: 'bandpass', freq: 2400, freqEnd: 500, q: 1.2, vol: 0.4 } }, { t: { type: 'sawtooth', freq: 900, freqEnd: 200, dur: 0.7, vol: 0.15 } }], 0.8, 0.4),
    ruinThunder: r([{ n: { dur: 0.15, type: 'highpass', freq: 5000, vol: 0.5 } }, { n: { dur: 1.1, type: 'lowpass', freq: 600, freqEnd: 80, vol: 0.6, delay: 0.05 } }, { t: { freq: 55, freqEnd: 30, dur: 0.9, vol: 0.4, delay: 0.05 } }], 1.3, 0.2),
    ruinUpdraft: r([{ n: { dur: 0.8, type: 'bandpass', freq: 300, freqEnd: 1400, q: 1.4, vol: 0.4, attack: 0.3 } }, { notes: [[440, 587, 784], 0.08, 'sine', 0.1, 0.25] }], 1.0, 0.3),
    // Bramblehorn Elder: creaking wood, roots, stomps.
    ruinElderRoar: r([{ t: { type: 'sawtooth', freq: 75, freqEnd: 50, dur: 1.5, vol: 0.32 } }, { n: { dur: 1.3, type: 'bandpass', freq: 250, freqEnd: 500, q: 3, vol: 0.3 } }, { t: { type: 'square', freq: 160, freqEnd: 100, dur: 1.0, vol: 0.08, delay: 0.2 } }], 1.7, 1.0),
    ruinRoot: r([{ n: { dur: 0.5, type: 'bandpass', freq: 200, freqEnd: 900, q: 2.5, vol: 0.4, attack: 0.2 } }, { t: { type: 'triangle', freq: 90, freqEnd: 45, dur: 0.35, vol: 0.4, delay: 0.3 } }], 0.8, 0.3),
    ruinStomp: r([{ t: { freq: 55, freqEnd: 28, dur: 0.6, vol: 0.7 } }, { n: { dur: 0.5, type: 'lowpass', freq: 700, freqEnd: 100, vol: 0.5 } }, { n: { dur: 0.2, type: 'bandpass', freq: 3000, q: 3, vol: 0.2, delay: 0.1 } }], 0.8, 0.3),
    // Anvilheart Colossus: iron, fire, hammer rings.
    ruinAnvilRoar: r([{ t: { type: 'square', freq: 60, freqEnd: 45, dur: 1.5, vol: 0.3 } }, { n: { dur: 1.3, type: 'bandpass', freq: 800, freqEnd: 400, q: 2, vol: 0.3 } }, { notes: [[220, 165], 0.25, 'triangle', 0.15, 0.8] }], 1.7, 1.0),
    ruinHammer: r([{ t: { freq: 50, freqEnd: 25, dur: 0.6, vol: 0.8 } }, { n: { dur: 0.15, type: 'highpass', freq: 4000, vol: 0.5 } }, { notes: [[880, 1175], 0.01, 'triangle', 0.25, 0.9] }], 1.0, 0.3),
    ruinSlag: r([{ n: { dur: 0.5, type: 'bandpass', freq: 500, freqEnd: 1800, q: 1.2, vol: 0.3 } }, { t: { type: 'sawtooth', freq: 200, freqEnd: 90, dur: 0.4, vol: 0.12 } }], 0.6, 0.15),
    ruinFlame: r([{ n: { dur: 1.1, type: 'bandpass', freq: 700, freqEnd: 400, q: 0.6, vol: 0.45, attack: 0.25 } }, { n: { dur: 1.0, type: 'highpass', freq: 3000, vol: 0.12 } }], 1.2, 0.3),
  } satisfies Record<string, SfxDef>;
};
