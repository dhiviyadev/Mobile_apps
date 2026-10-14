/**
 * Generative background music. A lookahead scheduler queues notes ~150 ms ahead
 * on the AudioContext clock (the standard "two clocks" technique), so timing
 * stays tight even when the main thread is busy rendering.
 *
 * Each mood is a chord progression plus pad, arpeggio, bass and (optionally)
 * drums. Melodic choices use a seeded RNG, so a loop is varied but repeatable.
 */
import { mulberry32 } from '@hub/shared';

export type MusicMood = 'menu' | 'voxel' | 'arena';

interface MoodDef {
  bpm: number;
  /** MIDI note of the key's root. */
  root: number;
  /** Chords as semitone offsets from the root, one chord per bar. */
  progression: number[][];
  arpType: OscillatorType;
  arpDensity: number;
  drums: boolean;
  bass: boolean;
}

const MOODS: Record<MusicMood, MoodDef> = {
  menu: { bpm: 84, root: 57, progression: [[0, 3, 7, 10], [-4, 0, 3, 7], [-7, -3, 0, 5], [-2, 2, 5, 9]], arpType: 'triangle', arpDensity: 0.45, drums: false, bass: true },
  voxel: { bpm: 72, root: 60, progression: [[0, 4, 7, 11], [-5, -1, 2, 7], [-3, 0, 4, 9], [-7, -3, 0, 5]], arpType: 'sine', arpDensity: 0.35, drums: false, bass: true },
  arena: { bpm: 116, root: 50, progression: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], arpType: 'square', arpDensity: 0.7, drums: true, bass: true },
};

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class MusicPlayer {
  private timer = 0;
  private step = 0;
  private nextTime = 0;
  private readonly def: MoodDef;
  private readonly rng = mulberry32(42);
  private readonly bus: GainNode;
  private noise: AudioBuffer;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    readonly mood: MusicMood,
  ) {
    this.def = MOODS[mood];
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start(): void {
    this.nextTime = this.ctx.currentTime + 0.1;
    this.bus.gain.setTargetAtTime(1, this.ctx.currentTime, 1.2);
    this.timer = window.setInterval(() => this.schedule(), 40);
  }

  stop(): void {
    window.clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(0, t, 0.3);
    window.setTimeout(() => this.bus.disconnect(), 1500);
  }

  private schedule(): void {
    const sixteenth = 60 / this.def.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step++;
    }
  }

  private playStep(step: number, t: number, sixteenth: number): void {
    const d = this.def;
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const chord = d.progression[bar % d.progression.length];

    if (inBar === 0) this.pad(chord, t, sixteenth * 16);
    if (d.bass && (inBar === 0 || inBar === 8 || (d.drums && inBar % 4 === 2 && this.rng() < 0.4))) {
      this.voice('triangle', midiToFreq(d.root + chord[0] - 24), t, sixteenth * (d.drums ? 1.6 : 6), d.drums ? 0.32 : 0.22, 500);
    }
    if (inBar % 2 === 0 && this.rng() < d.arpDensity) {
      const n = chord[Math.floor(this.rng() * chord.length)] + (this.rng() < 0.35 ? 12 : 0);
      this.voice(d.arpType, midiToFreq(d.root + n + 12), t, sixteenth * 1.8, d.arpType === 'square' ? 0.05 : 0.09, 2600);
    }
    if (d.drums) {
      if (inBar % 4 === 0) this.kick(t);
      if (inBar % 8 === 4) this.snare(t);
      if (inBar % 2 === 1) this.hat(t, inBar % 4 === 3 ? 0.06 : 0.035);
    }
  }

  private voice(type: OscillatorType, freq: number, t: number, dur: number, vol: number, cutoff: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(f).connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private pad(chord: number[], t: number, dur: number): void {
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.05);
    f.connect(g).connect(this.bus);
    for (const n of chord) {
      for (const detune of [-7, 7]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiToFreq(this.def.root + n);
        osc.detune.value = detune;
        osc.connect(f);
        osc.start(t);
        osc.stop(t + dur * 1.1);
      }
    }
  }

  private kick(t: number): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, dur: number, vol: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private snare(t: number): void {
    this.noiseHit(t, 'bandpass', 1800, 0.16, 0.22);
  }

  private hat(t: number, vol: number): void {
    this.noiseHit(t, 'highpass', 7000, 0.05, vol);
  }
}
