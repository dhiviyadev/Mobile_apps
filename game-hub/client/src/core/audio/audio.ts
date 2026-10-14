/**
 * Procedural audio engine (WebAudio). Every sound effect and music track is
 * synthesised at runtime, so there are no audio files to download and all
 * audio is original.
 *
 * iOS Safari only allows audio after a user gesture: `unlock()` is called from
 * the first tap (and again from every "play" button) to create/resume the context.
 */
import { settings } from '../settings';
import { MusicPlayer, type MusicMood } from './music';
import { SFX, type SfxName } from './sfx';

export interface PlayOptions {
  volume?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** Playback-rate style pitch multiplier. */
  pitch?: number;
}

class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise: AudioBuffer | null = null;
  private music: MusicPlayer | null = null;
  private pendingMood: MusicMood | null = null;
  /** Per-sound throttle so rapid fire doesn't stack hundreds of voices. */
  private lastPlayed = new Map<SfxName, number>();

  constructor() {
    settings.subscribe(() => this.applyVolumes());
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  /** Creates / resumes the AudioContext. Safe to call repeatedly; must run in a user gesture the first time. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.sfxBus = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.ratio.value = 4;
        this.sfxBus.connect(this.master);
        this.musicBus.connect(this.master);
        this.master.connect(comp).connect(this.ctx.destination);
        this.noise = this.makeNoise();
        this.applyVolumes();
        // iOS needs an actual (silent) sound started inside the gesture.
        const src = this.ctx.createBufferSource();
        src.buffer = this.ctx.createBuffer(1, 1, 22050);
        src.connect(this.ctx.destination);
        src.start(0);
      }
      if (this.ctx.state !== 'running') void this.ctx.resume();
      if (this.pendingMood) {
        const mood = this.pendingMood;
        this.pendingMood = null;
        this.playMusic(mood);
      }
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    }
  }

  play(name: SfxName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.noise) return;
    const now = ctx.currentTime;
    const minGap = SFX[name].minGap ?? 0.03;
    if (now - (this.lastPlayed.get(name) ?? -1) < minGap) return;
    this.lastPlayed.set(name, now);

    const out = ctx.createGain();
    out.gain.value = opts.volume ?? 1;
    let node: AudioNode = out;
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      out.connect(p);
      node = p;
    }
    node.connect(this.sfxBus);
    SFX[name].play({ ctx, out, t: now, noise: this.noise, pitch: opts.pitch ?? 1 });
    // Disconnect after the voice has surely finished.
    window.setTimeout(() => node.disconnect(), ((SFX[name].length ?? 1) + 0.2) * 1000);
  }

  /**
   * Plays a positional sound: volume by distance, pan by direction relative
   * to the listener's yaw.
   */
  playAt(name: SfxName, dx: number, dz: number, listenerYaw: number, maxDist = 40, volume = 1): void {
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return;
    const falloff = 1 / (1 + d * 0.12);
    // Right vector of a camera with yaw y is (cos y, 0, -sin y).
    const right = dx * Math.cos(listenerYaw) - dz * Math.sin(listenerYaw);
    const pan = d > 0.001 ? (right / d) * 0.8 : 0;
    this.play(name, { volume: volume * falloff, pan });
  }

  playMusic(mood: MusicMood): void {
    if (!this.ctx || this.ctx.state !== 'running') {
      this.pendingMood = mood;
      return;
    }
    if (this.music?.mood === mood) return;
    this.music?.stop();
    this.music = new MusicPlayer(this.ctx, this.musicBus, mood);
    this.music.start();
  }

  stopMusic(): void {
    this.pendingMood = null;
    this.music?.stop();
    this.music = null;
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const s = settings.get();
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.masterVolume, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfxVolume, t, 0.05);
    this.musicBus.gain.setTargetAtTime(s.musicVolume * 0.45, t, 0.05);
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff) - 1;
    }
    return buf;
  }
}

export const audio = new AudioEngine();
export type { SfxName, MusicMood };
