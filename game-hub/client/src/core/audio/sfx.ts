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

interface SfxDef {
  play(v: Voice): void;
  /** Seconds until the voice is silent (for cleanup). */
  length?: number;
  /** Minimum seconds between two plays of the same sound. */
  minGap?: number;
}

interface ToneOpts {
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

interface NoiseOpts {
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

/** Stand-in for Arcfire Arena weapon sounds whose recipes come with the weapons package. */
const WEAPON_SFX_PLACEHOLDER: SfxDef = { play: (v) => tone(v, { type: 'square', freq: 1500, dur: 0.02, vol: 0.06 }), length: 0.05 };

const defs = {
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
  // Names are final (Voxelvale survival reuses xbow_shot, xbow_cock, bolt_hit, bolt_flesh); recipes follow.
  ar_shot: WEAPON_SFX_PLACEHOLDER,
  smg_shot: WEAPON_SFX_PLACEHOLDER,
  lmg_shot: WEAPON_SFX_PLACEHOLDER,
  burst_shot: WEAPON_SFX_PLACEHOLDER,
  dmr_shot: WEAPON_SFX_PLACEHOLDER,
  hc_shot: WEAPON_SFX_PLACEHOLDER,
  mp_shot: WEAPON_SFX_PLACEHOLDER,
  xbow_shot: WEAPON_SFX_PLACEHOLDER,
  bolt_hit: WEAPON_SFX_PLACEHOLDER,
  bolt_flesh: WEAPON_SFX_PLACEHOLDER,
  bolt_fly: WEAPON_SFX_PLACEHOLDER,
  knife_hit: WEAPON_SFX_PLACEHOLDER,
  clank: WEAPON_SFX_PLACEHOLDER,
  mag_out: WEAPON_SFX_PLACEHOLDER,
  mag_in: WEAPON_SFX_PLACEHOLDER,
  charge: WEAPON_SFX_PLACEHOLDER,
  pump: WEAPON_SFX_PLACEHOLDER,
  bolt_cycle: WEAPON_SFX_PLACEHOLDER,
  shell_in: WEAPON_SFX_PLACEHOLDER,
  cylinder: WEAPON_SFX_PLACEHOLDER,
  xbow_cock: WEAPON_SFX_PLACEHOLDER,
  casing: WEAPON_SFX_PLACEHOLDER,
  equip: WEAPON_SFX_PLACEHOLDER,
  autoshoot_on: WEAPON_SFX_PLACEHOLDER,
  autoshoot_off: WEAPON_SFX_PLACEHOLDER,
} satisfies Record<string, SfxDef>;

export type SfxName = keyof typeof defs;
export const SFX: Record<SfxName, SfxDef> = defs;
