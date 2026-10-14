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
} satisfies Record<string, SfxDef>;

export type SfxName = keyof typeof defs;
export const SFX: Record<SfxName, SfxDef> = defs;
