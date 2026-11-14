/**
 * Gloamreach sounds (package D): the Lattice Ring (lighting, the rising hum
 * while you cross, arrival), the realm's creatures and the Eclipse Colossus.
 * All procedural, built from the creature voice recipes.
 */
import type { SfxDef, SynthKit } from './sfx';
import { recipe, type Step } from './sfxVoxelMobs';

export const gloamSfx = (k: SynthKit) => {
  const r = (steps: Step[], length: number, minGap?: number) => recipe(k, steps, length, minGap);
  const { tone, noise, notes } = k;
  return {
    // ---- Lattice Ring ----
    gloamLight: {
      play: (v) => {
        notes(v, [523, 659, 784, 1047, 1319], 0.07, 'sine', 0.16, 0.5);
        noise(v, { dur: 0.6, type: 'highpass', freq: 3000, freqEnd: 6000, vol: 0.12 });
        tone(v, { type: 'triangle', freq: 110, freqEnd: 220, dur: 0.7, vol: 0.1 });
      },
      length: 1.0,
      minGap: 0.5,
    },
    // Two seconds of rising hum with a shimmer on top: the length of the charge.
    gloamHum: {
      play: (v) => {
        tone(v, { type: 'sine', freq: 70, freqEnd: 330, dur: 2.0, vol: 0.28, attack: 0.3 });
        tone(v, { type: 'triangle', freq: 140, freqEnd: 660, dur: 2.0, vol: 0.1, attack: 0.5 });
        tone(v, { type: 'sine', freq: 1400, freqEnd: 2600, dur: 2.0, vol: 0.04, attack: 0.8 });
        noise(v, { dur: 2.0, type: 'bandpass', freq: 400, freqEnd: 2400, q: 1.5, vol: 0.12, attack: 0.9 });
      },
      length: 2.2,
      minGap: 1.5,
    },
    gloamArrive: {
      play: (v) => {
        tone(v, { type: 'sine', freq: 660, freqEnd: 110, dur: 0.7, vol: 0.25 });
        notes(v, [880, 1175, 1568, 2093], 0.09, 'sine', 0.14, 0.9);
        noise(v, { dur: 0.9, type: 'bandpass', freq: 3000, freqEnd: 600, q: 0.8, vol: 0.2 });
      },
      length: 1.4,
      minGap: 1,
    },
    // ---- creatures ----
    lanternhornIdle: r([{ v: { freq: 160, freqEnd: 200, type: 'triangle', dur: 0.8, vol: 0.2, formant: 700, q: 1.5, vib: 4, vibDepth: 30, breath: 0.2 } }, { t: { type: 'sine', freq: 880, freqEnd: 1100, dur: 0.5, vol: 0.05, delay: 0.2 } }], 1.0, 0.8),
    lanternhornHurt: r([{ v: { freq: 260, freqEnd: 170, type: 'triangle', dur: 0.25, vol: 0.28, formant: 900, q: 2, breath: 0.25 } }], 0.35, 0.1),
    lanternhornDeath: r([{ v: { freq: 220, freqEnd: 70, type: 'triangle', dur: 0.9, vol: 0.28, formant: 700, vib: 5, vibDepth: 60 } }, { notes: [[784, 659, 523], 0.15, 'sine', 0.08, 0.4] }], 1.1),
    bobblesnoutIdle: r([{ v: { freq: 700, freqEnd: 520, type: 'square', dur: 0.2, vol: 0.12, formant: 1500, q: 3, pulses: 3 } }, { t: { freq: 1500, freqEnd: 1900, dur: 0.05, vol: 0.06, delay: 0.25 } }], 0.4, 0.6),
    bobblesnoutHurt: r([{ v: { freq: 1000, freqEnd: 600, type: 'square', dur: 0.14, vol: 0.2, formant: 1800, q: 2, pulses: 2 } }], 0.2, 0.1),
    bobblesnoutDeath: r([{ v: { freq: 900, freqEnd: 200, type: 'square', dur: 0.35, vol: 0.18, formant: 1400, q: 2, pulses: 3 } }], 0.45),
    glimmerhareIdle: r([{ notes: [[1568, 1976], 0.08, 'sine', 0.07, 0.12] }], 0.25, 0.8),
    glimmerhareHurt: r([{ v: { freq: 1600, freqEnd: 900, type: 'triangle', dur: 0.12, vol: 0.18, formant: 2600, q: 3 } }], 0.2, 0.1),
    glimmerhareDeath: r([{ notes: [[1568, 1175, 784, 523], 0.08, 'triangle', 0.12, 0.2] }], 0.5),
    wisplingIdle: r([{ v: { freq: 1800, freqEnd: 2400, type: 'sine', dur: 0.5, vol: 0.08, formant: 2600, q: 5, vib: 11, vibDepth: 90, breath: 0.2 } }], 0.6, 0.5),
    wisplingAttack: r([{ v: { freq: 2600, freqEnd: 1400, type: 'sine', dur: 0.3, vol: 0.14, formant: 2400, q: 4 } }, { n: { dur: 0.2, type: 'highpass', freq: 4000, vol: 0.1 } }], 0.4, 0.3),
    wisplingHurt: r([{ v: { freq: 2400, freqEnd: 1500, type: 'sine', dur: 0.12, vol: 0.16, formant: 2800, q: 4 } }], 0.2, 0.1),
    wisplingDeath: r([{ v: { freq: 2200, freqEnd: 400, type: 'sine', dur: 0.6, vol: 0.14, formant: 2400, vib: 9, vibDepth: 120 } }, { notes: [[2093, 1568, 1047], 0.1, 'sine', 0.08, 0.3] }], 0.8),
    shardbackIdle: r([{ v: { freq: 2200, type: 'square', dur: 0.3, vol: 0.08, formant: 3200, q: 5, pulses: 5 } }, { t: { type: 'triangle', freq: 1500, dur: 0.04, vol: 0.06, delay: 0.1 } }], 0.4, 0.5),
    shardbackHurt: r([{ n: { dur: 0.14, type: 'bandpass', freq: 3400, q: 4, vol: 0.3 } }, { t: { type: 'triangle', freq: 2200, freqEnd: 1500, dur: 0.1, vol: 0.1 } }], 0.25, 0.1),
    shardbackDeath: r([{ n: { dur: 0.5, type: 'bandpass', freq: 3000, freqEnd: 800, q: 3, vol: 0.3 } }, { notes: [[2093, 1760, 1397, 1047], 0.05, 'triangle', 0.1, 0.2] }], 0.6),
    shardbackLunge: r([{ n: { dur: 0.25, type: 'highpass', freq: 4500, vol: 0.18 } }, { t: { type: 'triangle', freq: 1900, freqEnd: 2600, dur: 0.2, vol: 0.08 } }], 0.3, 0.3),
    hushwalkerIdle: r([{ n: { dur: 1.0, type: 'bandpass', freq: 300, freqEnd: 180, q: 1.2, vol: 0.12, attack: 0.4 } }, { v: { freq: 60, freqEnd: 55, dur: 1.0, vol: 0.1, formant: 260, breath: 0.5 } }], 1.1, 1.2),
    hushwalkerHurt: r([{ v: { freq: 90, freqEnd: 60, dur: 0.3, vol: 0.28, formant: 400, breath: 0.6 } }, { n: { dur: 0.15, freq: 700, vol: 0.2 } }], 0.4, 0.1),
    hushwalkerDeath: r([{ v: { freq: 80, freqEnd: 30, dur: 1.1, vol: 0.3, formant: 300, vib: 4, vibDepth: 50, breath: 0.6 } }, { n: { dur: 0.8, type: 'bandpass', freq: 500, freqEnd: 120, vol: 0.22, delay: 0.2 } }], 1.3),
    hushwalkerSwing: r([{ n: { dur: 0.3, type: 'bandpass', freq: 250, freqEnd: 900, q: 1.2, vol: 0.3, attack: 0.1 } }], 0.4, 0.2),
    glintcasterIdle: r([{ notes: [[1320, 1760, 1568], 0.12, 'triangle', 0.07, 0.25] }], 0.5, 0.9),
    glintcasterHurt: r([{ v: { freq: 1100, freqEnd: 700, type: 'triangle', dur: 0.18, vol: 0.2, formant: 1800, q: 3 } }, { n: { dur: 0.1, type: 'highpass', freq: 3000, vol: 0.12 } }], 0.3, 0.1),
    glintcasterDeath: r([{ notes: [[1568, 1320, 1047, 784, 523], 0.09, 'triangle', 0.14, 0.3] }, { n: { dur: 0.6, type: 'highpass', freq: 2800, freqEnd: 1200, vol: 0.2 } }], 0.9),
    glintcasterCast: r([{ t: { type: 'sine', freq: 600, freqEnd: 1800, dur: 0.35, vol: 0.12, attack: 0.1 } }, { n: { dur: 0.25, type: 'highpass', freq: 3500, vol: 0.1 } }], 0.5, 0.3),
    murkpuffIdle: r([{ n: { dur: 0.3, freq: 400, vol: 0.1 } }, { t: { freq: 140, freqEnd: 110, dur: 0.2, vol: 0.08 } }], 0.4, 0.7),
    murkpuffHurt: r([{ n: { dur: 0.14, freq: 700, vol: 0.22 } }, { t: { freq: 240, freqEnd: 150, dur: 0.1, vol: 0.14 } }], 0.2, 0.1),
    murkpuffDeath: r([{ n: { dur: 0.45, freq: 600, freqEnd: 120, vol: 0.3 } }], 0.5),
    murkpuffSwell: r([{ v: { freq: 120, freqEnd: 480, type: 'sine', dur: 1.4, vol: 0.22, formant: 700, q: 1, breath: 0.7 } }], 1.5, 1.0),
    // ---- the Eclipse Colossus ----
    colossusRoar: r([{ v: { freq: 55, freqEnd: 45, dur: 1.8, vol: 0.45, formant: 380, q: 1, vib: 5, vibDepth: 70, breath: 0.5 } }, { notes: [[220, 330, 440, 660], 0.18, 'sine', 0.12, 1.0] }, { n: { dur: 1.2, type: 'highpass', freq: 2500, freqEnd: 1200, vol: 0.18 } }], 2.0, 1.0),
    colossusHurt: r([{ v: { freq: 80, freqEnd: 60, dur: 0.3, vol: 0.32, formant: 450, breath: 0.4 } }, { t: { type: 'sine', freq: 660, freqEnd: 440, dur: 0.2, vol: 0.08 } }], 0.4, 0.15),
    colossusDefeat: r([{ notes: [[659, 523, 392, 330, 262], 0.2, 'triangle', 0.22, 0.6] }, { n: { dur: 1.8, freq: 1400, freqEnd: 90, vol: 0.4 } }, { v: { freq: 70, freqEnd: 25, dur: 1.8, vol: 0.4, formant: 300 } }], 2.2),
    colossusDrop: r([{ t: { freq: 55, freqEnd: 28, dur: 0.6, vol: 0.7 } }, { n: { dur: 0.7, freq: 900, freqEnd: 90, vol: 0.6 } }], 0.8, 0.3),
    colossusPulse: r([{ t: { type: 'sine', freq: 160, freqEnd: 40, dur: 0.9, vol: 0.5 } }, { n: { dur: 0.7, type: 'bandpass', freq: 600, freqEnd: 3000, q: 1, vol: 0.3 } }], 1.0, 0.3),
    colossusVolley: r([{ n: { dur: 0.25, type: 'highpass', freq: 3500, freqEnd: 6000, vol: 0.25 } }, { notes: [[1760, 2093, 2637], 0.04, 'triangle', 0.1, 0.12] }], 0.4, 0.1),
    colossusOrbit: r([{ n: { dur: 1.2, type: 'bandpass', freq: 300, freqEnd: 2200, q: 1.4, vol: 0.3, attack: 0.5 } }, { t: { type: 'sawtooth', freq: 70, freqEnd: 190, dur: 1.2, vol: 0.12 } }], 1.3, 0.5),
    colossusCall: r([{ notes: [[196, 247, 294, 392], 0.12, 'sine', 0.16, 0.4] }, { v: { freq: 90, freqEnd: 70, dur: 0.8, vol: 0.2, formant: 400, breath: 0.6 } }], 1.0, 0.5),
  } satisfies Record<string, SfxDef>;
};
