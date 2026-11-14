import { voxelMobSfx } from './sfxVoxelMobs';
import { voxelRuinSfx } from './sfxRuins';
import { voxelSurvivalSfx } from './sfxVoxelSurvival';
import { voxelWorldSfx } from './sfxVoxelWorld';
import { gloamSfx } from './sfxGloam';

/**
 * Synthesised sound effects. Each recipe builds a short-lived WebAudio graph
 * from oscillators and a shared noise buffer.
 */

export interface Voice {
  ctx: AudioContext;
  out: AudioNode;
  t: number;
  noise: AudioBuffer;
  pitch: number;
}

export interface SfxDef {
  play(v: Voice): void;
  /** Seconds until the voice is silent (for cleanup). */
  length?: number;
  /** Minimum seconds between two plays of the same sound. */
  minGap?: number;
}

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  freqEnd?: number;
  dur: number;
  vol?: number;
  attack?: number;
  delay?: number;
}

function tone(v: Voice, o: ToneOpts): void {
  const { ctx } = v;
  const t = v.t + (o.delay ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq * v.pitch, t);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd * v.pitch), t + o.dur);
  const vol = o.vol ?? 0.5;
  const attack = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g).connect(v.out);
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

export interface NoiseOpts {
  dur: number;
  vol?: number;
  type?: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  delay?: number;
}

function noise(v: Voice, o: NoiseOpts): void {
  const { ctx } = v;
  const t = v.t + (o.delay ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = v.noise;
  src.playbackRate.value = v.pitch;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'lowpass';
  f.frequency.setValueAtTime(o.freq * v.pitch, t);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.freqEnd * v.pitch), t + o.dur);
  f.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  const vol = o.vol ?? 0.5;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f).connect(g).connect(v.out);
  // Random offset so consecutive bursts don't sound identical.
  src.start(t, Math.random() * 0.5);
  src.stop(t + o.dur + 0.02);
}

const notes = (v: Voice, freqs: number[], step: number, type: OscillatorType, vol = 0.25, dur = 0.18) =>
  freqs.forEach((f, i) => tone(v, { type, freq: f, dur, vol, delay: i * step }));

/** A gunshot in layers: a filtered noise crack, a falling tone for the body, an optional echo tail and mechanical tick. */
interface GunVoice {
  crack: [freq: number, freqEnd: number, dur: number, vol: number, type?: BiquadFilterType];
  body: [f0: number, f1: number, dur: number, vol: number, type?: OscillatorType];
  tail?: [freq: number, dur: number, vol: number, delay: number];
  tick?: [freq: number, dur: number, vol: number];
}

function gun(v: Voice, g: GunVoice): void {
  const [cf, cfe, cd, cv, ct] = g.crack;
  noise(v, { dur: cd, vol: cv, type: ct ?? 'lowpass', freq: cf, freqEnd: cfe });
  const [b0, b1, bd, bv, bt] = g.body;
  tone(v, { type: bt ?? 'sine', freq: b0, freqEnd: b1, dur: bd, vol: bv });
  if (g.tail) {
    const [tf, td, tv, delay] = g.tail;
    noise(v, { dur: td, vol: tv, freq: tf, freqEnd: tf * 0.3, attack: 0.02, delay });
  }
  if (g.tick) tone(v, { type: 'square', freq: g.tick[0], dur: g.tick[1], vol: g.tick[2] });
}

/** Helpers handed to recipe files (they import only types from here, so there is no import cycle). */
export interface SynthKit {
  tone(v: Voice, o: ToneOpts): void;
  noise(v: Voice, o: NoiseOpts): void;
  notes(v: Voice, freqs: number[], step: number, type: OscillatorType, vol?: number, dur?: number): void;
}
const KIT: SynthKit = { tone, noise, notes };

const defs = {
  // Voxelvale recipes live in one file per package (no merge conflicts here).
  ...voxelWorldSfx(KIT),
  ...voxelSurvivalSfx(KIT),
  ...voxelMobSfx(KIT),
  ...voxelRuinSfx(KIT),
  ...gloamSfx(KIT),
  click: { play: (v) => tone(v, { freq: 1300, freqEnd: 900, dur: 0.05, vol: 0.18 }), length: 0.1 },
  chat: { play: (v) => notes(v, [880, 1175], 0.06, 'sine', 0.12, 0.08), length: 0.2 },
  countdown: { play: (v) => tone(v, { type: 'square', freq: 660, dur: 0.12, vol: 0.12 }), length: 0.2 },

  // ---- voxel ----------------------------------------------------------------
  place: {
    play: (v) => {
      noise(v, { dur: 0.08, vol: 0.5, freq: 500, freqEnd: 200 });
      tone(v, { freq: 180, freqEnd: 90, dur: 0.09, vol: 0.4 });
    },
    length: 0.15,
  },
  break: {
    play: (v) => {
      noise(v, { dur: 0.16, vol: 0.55, type: 'bandpass', freq: 1400, freqEnd: 300, q: 1.2 });
      noise(v, { dur: 0.06, vol: 0.3, type: 'highpass', freq: 2500, delay: 0.05 });
    },
    length: 0.25,
  },
  dig: { play: (v) => noise(v, { dur: 0.07, vol: 0.25, type: 'bandpass', freq: 900, q: 1.5 }), length: 0.1, minGap: 0.12 },
  step: { play: (v) => noise(v, { dur: 0.06, vol: 0.12, freq: 650, freqEnd: 250 }), length: 0.1, minGap: 0.08 },
  jump: { play: (v) => tone(v, { freq: 260, freqEnd: 420, dur: 0.09, vol: 0.08 }), length: 0.12 },
  land: { play: (v) => noise(v, { dur: 0.09, vol: 0.22, freq: 380, freqEnd: 120 }), length: 0.12, minGap: 0.1 },
  splash: {
    play: (v) => {
      noise(v, { dur: 0.35, vol: 0.35, type: 'bandpass', freq: 1600, freqEnd: 500, q: 0.7 });
      noise(v, { dur: 0.2, vol: 0.15, type: 'highpass', freq: 3000, delay: 0.05 });
    },
    length: 0.45,
    minGap: 0.25,
  },
  checkpoint: { play: (v) => notes(v, [784, 1046, 1318], 0.07, 'triangle', 0.22, 0.2), length: 0.45 },
  finish: { play: (v) => notes(v, [523, 659, 784, 1046, 1318], 0.09, 'square', 0.12, 0.25), length: 0.8 },

  // ---- arena -----------------------------------------------------------------
  rifle: {
    play: (v) => {
      noise(v, { dur: 0.12, vol: 0.55, freq: 3200, freqEnd: 700 });
      tone(v, { freq: 150, freqEnd: 55, dur: 0.1, vol: 0.45 });
    },
    length: 0.18,
    minGap: 0.04,
  },
  pistol: {
    play: (v) => {
      noise(v, { dur: 0.09, vol: 0.5, freq: 4200, freqEnd: 900 });
      tone(v, { freq: 210, freqEnd: 80, dur: 0.07, vol: 0.35 });
    },
    length: 0.14,
  },
  shotgun: {
    play: (v) => {
      noise(v, { dur: 0.28, vol: 0.75, freq: 2400, freqEnd: 300 });
      tone(v, { freq: 110, freqEnd: 40, dur: 0.18, vol: 0.6 });
      noise(v, { dur: 0.12, vol: 0.2, type: 'bandpass', freq: 1800, q: 2, delay: 0.32 });
      noise(v, { dur: 0.1, vol: 0.18, type: 'bandpass', freq: 2400, q: 2, delay: 0.44 });
    },
    length: 0.6,
  },
  sniper: {
    play: (v) => {
      noise(v, { dur: 0.06, vol: 0.6, type: 'highpass', freq: 2500 });
      noise(v, { dur: 0.5, vol: 0.55, freq: 2000, freqEnd: 200 });
      tone(v, { freq: 95, freqEnd: 35, dur: 0.3, vol: 0.6 });
      noise(v, { dur: 0.4, vol: 0.12, freq: 900, freqEnd: 200, delay: 0.25 });
    },
    length: 0.8,
  },
  melee: {
    play: (v) => noise(v, { dur: 0.16, vol: 0.4, type: 'bandpass', freq: 500, freqEnd: 2600, q: 1.4, attack: 0.04 }),
    length: 0.2,
  },
  reload: {
    play: (v) => {
      tone(v, { type: 'square', freq: 1900, dur: 0.02, vol: 0.12 });
      noise(v, { dur: 0.12, vol: 0.18, type: 'bandpass', freq: 1300, q: 3, delay: 0.08 });
      tone(v, { type: 'square', freq: 2400, dur: 0.025, vol: 0.14, delay: 0.32 });
    },
    length: 0.45,
  },
  empty: { play: (v) => tone(v, { type: 'square', freq: 2600, dur: 0.02, vol: 0.1 }), length: 0.05, minGap: 0.15 },
  hit: {
    play: (v) => {
      tone(v, { freq: 1900, dur: 0.05, vol: 0.2 });
      tone(v, { type: 'triangle', freq: 2600, dur: 0.04, vol: 0.12 });
    },
    length: 0.08,
    minGap: 0.04,
  },
  headshot: { play: (v) => notes(v, [2200, 2900], 0.035, 'sine', 0.2, 0.08), length: 0.15, minGap: 0.04 },
  kill: { play: (v) => notes(v, [880, 1320, 1760], 0.05, 'triangle', 0.25, 0.14), length: 0.3 },
  hurt: {
    play: (v) => {
      tone(v, { freq: 140, freqEnd: 70, dur: 0.12, vol: 0.4 });
      noise(v, { dur: 0.1, vol: 0.25, freq: 900, freqEnd: 200 });
    },
    length: 0.15,
    minGap: 0.06,
  },
  impact: { play: (v) => noise(v, { dur: 0.05, vol: 0.18, type: 'bandpass', freq: 2200, q: 2 }), length: 0.08, minGap: 0.02 },
  round_start: { play: (v) => notes(v, [440, 554, 659, 880], 0.08, 'square', 0.1, 0.16), length: 0.5 },
  round_win: { play: (v) => notes(v, [523, 659, 784, 1046], 0.1, 'triangle', 0.25, 0.3), length: 0.7 },
  round_lose: { play: (v) => notes(v, [466, 392, 311, 233], 0.12, 'triangle', 0.22, 0.32), length: 0.8 },

  // ---- Arcfire Arena: movement (WP1) ----------------------------------------
  footstep: {
    play: (v) => {
      noise(v, { dur: 0.07, vol: 0.16, freq: 520, freqEnd: 170 });
      tone(v, { freq: 95, freqEnd: 60, dur: 0.05, vol: 0.12 });
    },
    length: 0.1,
    minGap: 0.05,
  },
  slide: {
    play: (v) => {
      noise(v, { dur: 0.8, vol: 0.26, type: 'bandpass', freq: 1500, freqEnd: 450, q: 0.9, attack: 0.03 });
      noise(v, { dur: 0.6, vol: 0.18, freq: 320, freqEnd: 110, attack: 0.02 });
    },
    length: 0.9,
    minGap: 0.25,
  },
  pad: {
    play: (v) => {
      noise(v, { dur: 0.08, vol: 0.35, freq: 240, freqEnd: 90 });
      tone(v, { freq: 170, freqEnd: 640, dur: 0.3, vol: 0.28 });
      tone(v, { type: 'triangle', freq: 340, freqEnd: 1280, dur: 0.18, vol: 0.1, delay: 0.02 });
    },
    length: 0.4,
    minGap: 0.08,
  },

  // ---- Arcfire Arena: items (WP1) -------------------------------------------
  pad_launch: {
    play: (v) => {
      noise(v, { dur: 0.45, vol: 0.3, type: 'bandpass', freq: 600, freqEnd: 2400, q: 0.8, attack: 0.02 });
      tone(v, { freq: 140, freqEnd: 420, dur: 0.3, vol: 0.2 });
    },
    length: 0.5,
    minGap: 0.08,
  },
  pad_boost: {
    play: (v) => {
      tone(v, { type: 'sawtooth', freq: 300, freqEnd: 1200, dur: 0.18, vol: 0.1 });
      noise(v, { dur: 0.2, vol: 0.18, type: 'highpass', freq: 2000 });
    },
    length: 0.25,
    minGap: 0.08,
  },
  pickup_health: {
    play: (v) => {
      notes(v, [740, 988, 1318], 0.05, 'sine', 0.2, 0.16);
      noise(v, { dur: 0.25, vol: 0.06, type: 'highpass', freq: 5000, attack: 0.02 });
    },
    length: 0.4,
    minGap: 0.1,
  },
  pickup_ammo: {
    play: (v) => {
      noise(v, { dur: 0.05, vol: 0.25, type: 'bandpass', freq: 1800, q: 3 });
      tone(v, { type: 'square', freq: 420, freqEnd: 300, dur: 0.07, vol: 0.08, delay: 0.05 });
      noise(v, { dur: 0.05, vol: 0.2, type: 'bandpass', freq: 2400, q: 3, delay: 0.11 });
    },
    length: 0.25,
    minGap: 0.1,
  },
  pickup_spawn: { play: (v) => tone(v, { type: 'sine', freq: 520, freqEnd: 1040, dur: 0.25, vol: 0.08 }), length: 0.3, minGap: 0.2 },

  // ---- Arcfire Arena: map vote (WP3) ----------------------------------------
  vote_cast: { play: (v) => notes(v, [660, 880], 0.05, 'triangle', 0.16, 0.1), length: 0.25 },
  vote_tick: { play: (v) => tone(v, { type: 'triangle', freq: 1046, dur: 0.06, vol: 0.12 }), length: 0.1, minGap: 0.5 },
  vote_win: { play: (v) => notes(v, [523, 784, 1046, 1568], 0.08, 'triangle', 0.22, 0.25), length: 0.7 },

  // ---- Arcfire Arena: weapons (WP2) -----------------------------------------
  // Names are final (Voxelvale survival reuses xbow_shot, xbow_cock, bolt_hit, bolt_flesh).
  // Shots: each weapon has its own crack, body and tail, so it can be told apart by ear.
  ar_shot: {
    play: (v) => gun(v, { crack: [3200, 700, 0.1, 0.55], body: [150, 55, 0.1, 0.45], tail: [1200, 0.25, 0.12, 0.04] }),
    length: 0.32,
    minGap: 0.04,
  },
  smg_shot: {
    play: (v) => gun(v, { crack: [4800, 1200, 0.06, 0.45], body: [220, 90, 0.05, 0.3], tail: [1500, 0.12, 0.08, 0.03] }),
    length: 0.18,
    minGap: 0.03,
  },
  lmg_shot: {
    play: (v) => gun(v, { crack: [2600, 500, 0.12, 0.6], body: [120, 45, 0.13, 0.55], tail: [900, 0.3, 0.15, 0.05] }),
    length: 0.38,
    minGap: 0.04,
  },
  burst_shot: {
    play: (v) => gun(v, { tick: [3000, 0.01, 0.08], crack: [3600, 800, 0.08, 0.5], body: [170, 70, 0.08, 0.4], tail: [1400, 0.18, 0.1, 0.04] }),
    length: 0.25,
    minGap: 0.03,
  },
  dmr_shot: {
    play: (v) => {
      noise(v, { dur: 0.05, vol: 0.6, type: 'highpass', freq: 3000 });
      gun(v, { crack: [2200, 300, 0.3, 0.5], body: [110, 40, 0.2, 0.55], tail: [800, 0.35, 0.12, 0.15] });
    },
    length: 0.55,
    minGap: 0.1,
  },
  hc_shot: {
    play: (v) => gun(v, { crack: [3000, 600, 0.08, 0.65], body: [90, 35, 0.22, 0.65, 'triangle'], tail: [700, 0.4, 0.15, 0.08] }),
    length: 0.52,
    minGap: 0.1,
  },
  mp_shot: {
    play: (v) => gun(v, { crack: [5200, 1400, 0.05, 0.4], body: [260, 110, 0.04, 0.25] }),
    length: 0.1,
    minGap: 0.03,
  },
  xbow_shot: {
    play: (v) => {
      tone(v, { type: 'triangle', freq: 180, freqEnd: 120, dur: 0.18, vol: 0.35 });
      tone(v, { freq: 360, freqEnd: 240, dur: 0.12, vol: 0.2 });
      noise(v, { dur: 0.08, vol: 0.3, type: 'bandpass', freq: 2400, freqEnd: 800, q: 3 });
    },
    length: 0.24,
    minGap: 0.1,
  },
  bolt_hit: {
    play: (v) => {
      noise(v, { dur: 0.09, vol: 0.45, freq: 900, freqEnd: 200 });
      tone(v, { freq: 140, freqEnd: 80, dur: 0.06, vol: 0.3 });
    },
    length: 0.14,
    minGap: 0.03,
  },
  bolt_flesh: {
    play: (v) => {
      noise(v, { dur: 0.07, vol: 0.35, type: 'bandpass', freq: 600, q: 1.5 });
      tone(v, { freq: 120, freqEnd: 70, dur: 0.08, vol: 0.3 });
    },
    length: 0.13,
    minGap: 0.03,
  },
  bolt_fly: { play: (v) => noise(v, { dur: 0.25, vol: 0.12, type: 'bandpass', freq: 1800, freqEnd: 600, q: 2, attack: 0.08 }), length: 0.3, minGap: 0.2 },
  knife_hit: {
    play: (v) => {
      noise(v, { dur: 0.06, vol: 0.3, type: 'bandpass', freq: 1800, q: 2 });
      tone(v, { freq: 300, freqEnd: 150, dur: 0.05, vol: 0.25 });
    },
    length: 0.1,
    minGap: 0.05,
  },
  // Mechanical sounds on the viewmodel's keyframes (local only).
  clank: {
    play: (v) => {
      tone(v, { type: 'square', freq: 2400, dur: 0.03, vol: 0.1 });
      noise(v, { dur: 0.05, vol: 0.2, type: 'highpass', freq: 3500 });
    },
    length: 0.08,
    minGap: 0.05,
  },
  mag_out: {
    play: (v) => {
      noise(v, { dur: 0.06, vol: 0.2, type: 'bandpass', freq: 1100, q: 4 });
      tone(v, { type: 'square', freq: 1600, dur: 0.015, vol: 0.1 });
    },
    length: 0.1,
    minGap: 0.05,
  },
  mag_in: {
    play: (v) => {
      tone(v, { type: 'square', freq: 2000, dur: 0.02, vol: 0.14 });
      noise(v, { dur: 0.05, vol: 0.25, type: 'bandpass', freq: 1500, q: 3, delay: 0.02 });
    },
    length: 0.1,
    minGap: 0.05,
  },
  charge: {
    play: (v) => {
      noise(v, { dur: 0.05, vol: 0.22, type: 'bandpass', freq: 1300, q: 3 });
      tone(v, { type: 'square', freq: 2200, dur: 0.02, vol: 0.14, delay: 0.07 });
    },
    length: 0.12,
    minGap: 0.05,
  },
  pump: {
    play: (v) => {
      noise(v, { dur: 0.07, vol: 0.3, type: 'bandpass', freq: 900, q: 2 });
      noise(v, { dur: 0.07, vol: 0.3, type: 'bandpass', freq: 900, q: 2, delay: 0.12 });
      tone(v, { type: 'square', freq: 1400, dur: 0.015, vol: 0.1, delay: 0.12 });
    },
    length: 0.22,
    minGap: 0.1,
  },
  bolt_cycle: {
    play: (v) => {
      tone(v, { type: 'square', freq: 1800, dur: 0.02, vol: 0.12 });
      noise(v, { dur: 0.06, vol: 0.2, type: 'bandpass', freq: 1200, q: 3, delay: 0.05 });
      noise(v, { dur: 0.06, vol: 0.2, type: 'bandpass', freq: 1400, q: 3, delay: 0.22 });
      tone(v, { type: 'square', freq: 2100, dur: 0.02, vol: 0.12, delay: 0.3 });
    },
    length: 0.35,
    minGap: 0.2,
  },
  shell_in: {
    play: (v) => {
      noise(v, { dur: 0.04, vol: 0.22, type: 'bandpass', freq: 1600, q: 4 });
      tone(v, { type: 'square', freq: 2500, dur: 0.015, vol: 0.1 });
    },
    length: 0.07,
    minGap: 0.05,
  },
  cylinder: {
    play: (v) => {
      for (let i = 0; i < 6; i++) tone(v, { type: 'square', freq: 2600, dur: 0.01, vol: 0.08, delay: i * 0.025 });
    },
    length: 0.2,
    minGap: 0.1,
  },
  xbow_cock: {
    play: (v) => {
      tone(v, { type: 'sawtooth', freq: 90, freqEnd: 140, dur: 0.4, vol: 0.06 });
      noise(v, { dur: 0.35, vol: 0.08, type: 'bandpass', freq: 600, q: 6 });
      tone(v, { type: 'square', freq: 1900, dur: 0.02, vol: 0.14, delay: 0.42 });
    },
    length: 0.5,
    minGap: 0.3,
  },
  casing: {
    play: (v) => {
      tone(v, { freq: 4200, freqEnd: 3800, dur: 0.05, vol: 0.05 });
      tone(v, { freq: 3900, dur: 0.04, vol: 0.03, delay: 0.08 });
    },
    length: 0.15,
    minGap: 0.06,
  },
  equip: {
    play: (v) => {
      noise(v, { dur: 0.08, vol: 0.15, freq: 700 });
      tone(v, { type: 'square', freq: 1500, dur: 0.015, vol: 0.08, delay: 0.06 });
    },
    length: 0.12,
    minGap: 0.1,
  },
  autoshoot_on: { play: (v) => notes(v, [1200, 1600], 0.06, 'sine', 0.12, 0.06), length: 0.16, minGap: 0.1 },
  autoshoot_off: { play: (v) => notes(v, [1600, 1200], 0.06, 'sine', 0.12, 0.06), length: 0.16, minGap: 0.1 },
} satisfies Record<string, SfxDef>;

export type SfxName = keyof typeof defs;
export const SFX: Record<SfxName, SfxDef> = defs;
