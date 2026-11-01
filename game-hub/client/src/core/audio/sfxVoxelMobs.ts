/**
 * Voxelvale creature and boss sounds (WP-C, design-voxel-mobs §12): a voice()
 * helper (a formant-filtered oscillator with glide, vibrato, pulse chopping
 * and breath) and the idle / hurt / death / attack recipes. All procedural.
 * Import only types from ./sfx; helpers arrive as `k`.
 */
import type { NoiseOpts, SfxDef, SynthKit, ToneOpts, Voice } from './sfx';

interface VoiceOpts {
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  dur: number;
  vol?: number;
  attack?: number;
  delay?: number;
  /** Bandpass centre and Q. */
  formant?: number;
  q?: number;
  /** Vibrato rate (Hz) and depth (cents). */
  vib?: number;
  vibDepth?: number;
  /** Amplitude chops across the duration (bleats, clucks, chitters). */
  pulses?: number;
  /** 0..1 noise through the same bandpass. */
  breath?: number;
}

function voice(k: SynthKit, v: Voice, o: VoiceOpts): void {
  const { ctx } = v;
  const t = v.t + (o.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sawtooth';
  osc.frequency.setValueAtTime(o.freq * v.pitch, t);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd * v.pitch), t + o.dur);
  if (o.vib) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = o.vib;
    depth.gain.value = o.vibDepth ?? 40;
    lfo.connect(depth).connect(osc.detune);
    lfo.start(t);
    lfo.stop(t + o.dur + 0.05);
  }
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = (o.formant ?? 1200) * v.pitch;
  bp.Q.value = o.q ?? 1.2;
  const g = ctx.createGain();
  const vol = o.vol ?? 0.3;
  const pulses = Math.max(1, o.pulses ?? 1);
  const slice = o.dur / pulses;
  g.gain.setValueAtTime(0.0001, t);
  for (let i = 0; i < pulses; i++) {
    const s = t + i * slice;
    g.gain.exponentialRampToValueAtTime(vol, s + Math.max(0.005, Math.min(o.attack ?? 0.02, slice * 0.3)));
    g.gain.exponentialRampToValueAtTime(pulses > 1 ? vol * 0.08 : 0.0001, s + slice * 0.9);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(bp).connect(g).connect(v.out);
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
  if (o.breath) k.noise(v, { dur: o.dur, vol: vol * o.breath, type: 'bandpass', freq: o.formant ?? 1200, q: o.q ?? 1.2, delay: o.delay });
}

type Step = { v: VoiceOpts } | { n: NoiseOpts } | { t: ToneOpts } | { notes: [number[], number, OscillatorType, number, number] };

function recipe(k: SynthKit, steps: Step[], length: number, minGap?: number): SfxDef {
  return {
    play: (v) => {
      for (const s of steps) {
        if ('v' in s) voice(k, v, s.v);
        else if ('n' in s) k.noise(v, s.n);
        else if ('t' in s) k.tone(v, s.t);
        else k.notes(v, s.notes[0], s.notes[1], s.notes[2], s.notes[3], s.notes[4]);
      }
    },
    length,
    minGap,
  };
}

export const voxelMobSfx = (k: SynthKit) => {
  const r = (steps: Step[], length: number, minGap?: number) => recipe(k, steps, length, minGap);
  const chops = (n: number, gap: number, o: NoiseOpts): Step[] => Array.from({ length: n }, (_, i) => ({ n: { ...o, delay: (o.delay ?? 0) + i * gap } }));
  return {
    woolbackIdle: r([{ v: { freq: 230, freqEnd: 190, dur: 0.55, vol: 0.22, formant: 950, q: 2, vib: 8, vibDepth: 45, pulses: 3, breath: 0.15 } }], 0.7, 0.5),
    woolbackHurt: r([{ v: { freq: 330, freqEnd: 250, dur: 0.22, vol: 0.3, formant: 1200, q: 2, breath: 0.25 } }], 0.35, 0.1),
    woolbackDeath: r([{ v: { freq: 280, freqEnd: 90, dur: 0.7, vol: 0.3, formant: 800, q: 1.5, vib: 5, vibDepth: 70 } }, { n: { dur: 0.2, freq: 300, freqEnd: 100, vol: 0.3, delay: 0.4 } }], 0.9),
    hoplingIdle: r([{ t: { freq: 1800, freqEnd: 2300, dur: 0.05, vol: 0.08 } }, { t: { freq: 1900, freqEnd: 2400, dur: 0.05, vol: 0.08, delay: 0.09 } }], 0.2, 0.5),
    hoplingHurt: r([{ v: { freq: 1400, freqEnd: 900, type: 'triangle', dur: 0.12, vol: 0.2, formant: 2500, q: 3 } }], 0.2, 0.1),
    hoplingDeath: r([{ v: { freq: 1200, freqEnd: 300, type: 'triangle', dur: 0.3, vol: 0.2, formant: 2000, q: 2 } }], 0.4),
    cluckitIdle: r([{ v: { freq: 520, freqEnd: 480, type: 'square', dur: 0.36, vol: 0.15, formant: 1400, q: 4, pulses: 4, breath: 0.1 } }], 0.5, 0.4),
    cluckitHurt: r([{ v: { freq: 900, freqEnd: 600, type: 'square', dur: 0.18, vol: 0.22, formant: 1800, q: 3, pulses: 2 } }, { n: { dur: 0.12, type: 'highpass', freq: 3000, vol: 0.1 } }], 0.3, 0.1),
    cluckitDeath: r([{ v: { freq: 700, freqEnd: 200, type: 'square', dur: 0.4, vol: 0.22, formant: 1300, q: 2 } }], 0.5),
    fernhartIdle: r([{ v: { freq: 420, freqEnd: 620, type: 'triangle', dur: 0.4, vol: 0.14, formant: 1600, q: 1.5, breath: 0.3 } }], 0.5, 0.5),
    fernhartHurt: r([{ v: { freq: 600, freqEnd: 380, type: 'triangle', dur: 0.2, vol: 0.22, formant: 1500, q: 2, breath: 0.3 } }], 0.3, 0.1),
    fernhartDeath: r([{ v: { freq: 520, freqEnd: 160, type: 'triangle', dur: 0.6, vol: 0.22, formant: 1200, vib: 6, vibDepth: 50 } }], 0.7),
    fishIdle: r([{ t: { freq: 1600, dur: 0.04, vol: 0.05 } }, { t: { freq: 2100, dur: 0.04, vol: 0.05, delay: 0.07 } }], 0.15, 0.5),
    fishHurt: r([{ n: { dur: 0.15, type: 'bandpass', freq: 1600, freqEnd: 600, q: 0.7, vol: 0.2 } }], 0.2, 0.1),
    fishDeath: r([{ n: { dur: 0.3, type: 'bandpass', freq: 1600, freqEnd: 600, q: 0.7, vol: 0.2 } }, { t: { freq: 900, freqEnd: 300, dur: 0.2, vol: 0.12 } }], 0.4),
    mudlurchIdle: r([{ v: { freq: 85, freqEnd: 70, dur: 0.9, vol: 0.28, formant: 350, q: 1.2, vib: 3, vibDepth: 60, breath: 0.4 } }, { n: { dur: 0.3, freq: 300, vol: 0.15, delay: 0.3 } }], 1.0, 0.6),
    mudlurchHurt: r([{ v: { freq: 120, freqEnd: 80, dur: 0.25, vol: 0.3, formant: 450, breath: 0.5 } }, { n: { dur: 0.12, freq: 500, vol: 0.2 } }], 0.35, 0.1),
    mudlurchDeath: r([{ v: { freq: 110, freqEnd: 45, dur: 1.0, vol: 0.3, formant: 300, vib: 4, vibDepth: 60, breath: 0.6 } }, { n: { dur: 0.5, freq: 600, freqEnd: 120, vol: 0.3, delay: 0.3 } }], 1.1),
    mudlurchSwing: r([{ n: { dur: 0.2, type: 'bandpass', freq: 400, freqEnd: 1200, q: 1.4, vol: 0.3, attack: 0.05 } }], 0.3, 0.2),
    rattlebowIdle: r([{ t: { type: 'square', freq: 1900, dur: 0.03, vol: 0.06 } }, { t: { type: 'square', freq: 2100, dur: 0.03, vol: 0.06, delay: 0.05 } }, { t: { type: 'square', freq: 1700, dur: 0.03, vol: 0.06, delay: 0.11 } }, { n: { dur: 0.04, type: 'bandpass', freq: 2500, q: 6, vol: 0.1 } }], 0.2, 0.6),
    rattlebowHurt: r(chops(3, 0.03, { dur: 0.04, type: 'bandpass', freq: 2600, q: 5, vol: 0.3 }), 0.2, 0.1),
    rattlebowDeath: r([...Array.from({ length: 8 }, (_, i): Step => ({ n: { dur: 0.03, type: 'bandpass', freq: 2000 + ((i * 397) % 1200), q: 6, vol: 0.25, delay: i * 0.06 } })), { t: { type: 'triangle', freq: 200, freqEnd: 80, dur: 0.3, vol: 0.2 } }], 0.6),
    mobBowDraw: r([{ n: { dur: 0.5, type: 'bandpass', freq: 900, freqEnd: 1400, q: 3, vol: 0.12, attack: 0.2 } }], 0.6, 0.3),
    mobShoot: r([{ t: { type: 'triangle', freq: 180, freqEnd: 120, dur: 0.15, vol: 0.25 } }, { n: { dur: 0.08, type: 'bandpass', freq: 1800, q: 4, vol: 0.2 } }], 0.25, 0.1),
    crawlerIdle: r([{ v: { freq: 2400, type: 'square', dur: 0.3, vol: 0.08, formant: 3000, q: 4, pulses: 6 } }], 0.4, 0.5),
    crawlerHurt: r([{ v: { freq: 2000, freqEnd: 1400, type: 'square', dur: 0.15, vol: 0.15, formant: 2800, q: 3, pulses: 3 } }], 0.25, 0.1),
    crawlerDeath: r([{ v: { freq: 1800, freqEnd: 400, type: 'square', dur: 0.5, vol: 0.15, formant: 2400, q: 2, pulses: 8 } }], 0.6),
    crawlerLunge: r([{ n: { dur: 0.25, type: 'highpass', freq: 4000, vol: 0.2 } }, { v: { freq: 2600, freqEnd: 3200, dur: 0.2, vol: 0.1, formant: 3000, q: 5 } }], 0.35, 0.3),
    puffcapIdle: r([{ n: { dur: 0.2, freq: 600, vol: 0.12 } }, { t: { freq: 200, freqEnd: 160, dur: 0.15, vol: 0.08 } }], 0.3, 0.6),
    puffInflate: r([{ v: { freq: 150, freqEnd: 600, type: 'sine', dur: 1.4, vol: 0.25, formant: 800, q: 1, breath: 0.6 } }], 1.5, 1.0),
    sporeBurst: r([{ n: { dur: 0.6, freq: 1200, freqEnd: 150, vol: 0.6 } }, { t: { freq: 90, freqEnd: 40, dur: 0.4, vol: 0.5 } }], 0.7, 0.2),
    puffcapHurt: r([{ n: { dur: 0.12, freq: 900, vol: 0.25 } }, { t: { freq: 300, freqEnd: 200, dur: 0.1, vol: 0.15 } }], 0.2, 0.1),
    puffcapDeath: r([{ n: { dur: 0.4, freq: 700, freqEnd: 150, vol: 0.3 } }], 0.5),
    duskwingIdle: r(chops(10, 0.05, { dur: 0.04, type: 'bandpass', freq: 300, q: 2, vol: 0.1 }), 0.6, 0.6),
    duskwingAttack: r([{ v: { freq: 2800, freqEnd: 1800, dur: 0.3, vol: 0.15, formant: 3200, q: 5 } }], 0.4, 0.3),
    duskwingHurt: r([{ v: { freq: 2400, freqEnd: 1600, dur: 0.12, vol: 0.15, formant: 3000, q: 4 } }], 0.2, 0.1),
    duskwingDeath: r([{ v: { freq: 2200, freqEnd: 500, dur: 0.5, vol: 0.15, formant: 2600 } }, ...chops(6, 0.06, { dur: 0.04, type: 'bandpass', freq: 300, q: 2, vol: 0.1 })], 0.6),
    sentinelRoar: r([{ v: { freq: 70, freqEnd: 55, dur: 1.6, vol: 0.45, formant: 500, q: 1, vib: 6, vibDepth: 80, breath: 0.5 } }, { n: { dur: 1.2, freq: 400, vol: 0.3 } }], 1.8, 1.0),
    wardenRoar: r([{ notes: [[880, 1320, 1760], 0.05, 'triangle', 0.15, 0.9] }, { n: { dur: 1.2, type: 'highpass', freq: 3000, freqEnd: 1500, vol: 0.2 } }], 1.4, 1.0),
    thornmawRoar: r([{ v: { freq: 95, freqEnd: 70, dur: 1.4, vol: 0.45, formant: 300, q: 1.5, pulses: 8, breath: 0.6 } }], 1.5, 1.0),
    knightRoar: r([{ t: { type: 'square', freq: 110, freqEnd: 80, dur: 1.0, vol: 0.2 } }, { n: { dur: 0.8, type: 'bandpass', freq: 2200, q: 3, vol: 0.25 } }, { v: { freq: 60, dur: 1.2, vol: 0.35, formant: 400, vib: 5, vibDepth: 40 } }], 1.4, 1.0),
    bossHurt: r([{ v: { freq: 90, freqEnd: 70, dur: 0.25, vol: 0.3, formant: 500, breath: 0.4 } }], 0.35, 0.15),
    bossSlam: r([{ t: { freq: 60, freqEnd: 30, dur: 0.5, vol: 0.7 } }, { n: { dur: 0.6, freq: 800, freqEnd: 100, vol: 0.6 } }], 0.7, 0.3),
    bossCharge: r([{ n: { dur: 0.9, type: 'bandpass', freq: 400, freqEnd: 2000, q: 1.2, vol: 0.35, attack: 0.3 } }, { t: { type: 'sawtooth', freq: 80, freqEnd: 140, dur: 0.9, vol: 0.15 } }], 1.0, 0.5),
    bossSummon: r([{ notes: [[220, 277, 330, 440], 0.08, 'sine', 0.15, 0.3] }, { n: { dur: 0.6, type: 'bandpass', freq: 600, vol: 0.15 } }], 0.8, 0.5),
    bossTeleport: r([{ t: { freq: 1200, freqEnd: 300, dur: 0.4, vol: 0.2 } }, { n: { dur: 0.3, type: 'highpass', freq: 2500, vol: 0.15 } }], 0.5, 0.3),
    bossStep: r([{ t: { freq: 50, freqEnd: 35, dur: 0.15, vol: 0.35 } }, { n: { dur: 0.1, freq: 200, vol: 0.2 } }], 0.2, 0.3),
    bossDefeat: r([{ notes: [[784, 659, 523, 392], 0.12, 'triangle', 0.2, 0.5] }, { n: { dur: 1.5, freq: 1200, freqEnd: 100, vol: 0.4 } }], 1.7),
    shardWhoosh: r([{ n: { dur: 0.25, type: 'highpass', freq: 3000, freqEnd: 1500, vol: 0.2 } }, { t: { type: 'triangle', freq: 2400, freqEnd: 1600, dur: 0.15, vol: 0.06 } }], 0.3, 0.08),
    seedPop: r([{ t: { freq: 300, freqEnd: 120, dur: 0.12, vol: 0.3 } }, { n: { dur: 0.1, type: 'bandpass', freq: 900, vol: 0.2 } }], 0.2, 0.08),
    emberWhoosh: r([{ n: { dur: 0.3, type: 'bandpass', freq: 600, freqEnd: 1500, q: 1, vol: 0.2 } }], 0.35, 0.08),
    frostNova: r([{ n: { dur: 0.7, type: 'highpass', freq: 4000, freqEnd: 1500, vol: 0.4 } }, { notes: [[1568, 2093], 0.05, 'triangle', 0.12, 0.3] }], 0.8, 0.3),
    hailCrash: r([{ n: { dur: 0.2, type: 'bandpass', freq: 2600, q: 2, vol: 0.35 } }, { t: { type: 'triangle', freq: 1800, freqEnd: 900, dur: 0.1, vol: 0.1 } }], 0.25, 0.05),
    vineLash: r([{ n: { dur: 0.25, type: 'bandpass', freq: 300, freqEnd: 1800, q: 1.5, vol: 0.4, attack: 0.08 } }], 0.3, 0.2),
    cleave: r([{ n: { dur: 0.3, type: 'bandpass', freq: 500, freqEnd: 2400, q: 1.2, vol: 0.45, attack: 0.06 } }, { t: { type: 'square', freq: 220, freqEnd: 110, dur: 0.2, vol: 0.08 } }], 0.35, 0.2),
    ruptureCrack: r([{ n: { dur: 0.5, freq: 2000, freqEnd: 200, vol: 0.6 } }, { t: { freq: 70, freqEnd: 35, dur: 0.4, vol: 0.5 } }], 0.6, 0.3),
    tameHeart: r([{ notes: [[880, 1175, 1568], 0.06, 'sine', 0.15, 0.15] }], 0.35, 0.3),
    tameFail: r([{ n: { dur: 0.2, freq: 900, freqEnd: 300, vol: 0.15 } }], 0.3, 0.3),
    mobHit: r([{ n: { dur: 0.08, type: 'bandpass', freq: 1300, q: 1.5, vol: 0.35 } }, { t: { freq: 220, freqEnd: 120, dur: 0.08, vol: 0.2 } }], 0.12, 0.04),
  } satisfies Record<string, SfxDef>;
};
