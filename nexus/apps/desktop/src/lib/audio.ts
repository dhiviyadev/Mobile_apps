/** Push-to-talk recording with a live level meter, and interruptible playback.
 * The microphone is opened only while recording and released immediately after. */

const SPEECH_LEVEL = 0.12; // above typical room noise after the browser's noise suppression
const END_OF_SPEECH_MS = 1500;
const NO_SPEECH_MS = 8000;

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private raf = 0;
  private cancelled = false;
  private startedAt = 0;
  private lastVoice = 0;
  private fired = false;
  /** True once something louder than room noise was picked up. */
  heardSpeech = false;

  /**
   * @param onLevel live level (0..1) and waveform for the meter
   * @param onSilence hands-free mode: called once when the speaker stops talking (or never starts)
   */
  constructor(
    private onLevel: (level: number, waveform: Uint8Array) => void,
    private onSilence?: () => void,
  ) {}

  get active(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available in this window.");
    this.cancelled = false;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Uint8Array(analyser.fftSize);
    this.startedAt = this.lastVoice = performance.now();
    this.heardSpeech = false;
    this.fired = false;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (const v of data) sum += v;
      const level = Math.min(1, sum / data.length / 90);
      this.onLevel(level, wave);
      if (this.onSilence && !this.fired) {
        const now = performance.now();
        if (level > SPEECH_LEVEL) {
          this.heardSpeech = true;
          this.lastVoice = now;
        }
        const finished = this.heardSpeech && now - this.lastVoice > END_OF_SPEECH_MS;
        const nothing = !this.heardSpeech && now - this.startedAt > NO_SPEECH_MS;
        if (finished || nothing) {
          this.fired = true;
          this.onSilence();
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
  }

  /** Stop and return the recording (null if cancelled or empty). */
  stop(): Promise<{ blob: Blob; filename: string } | null> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.release();
        const silent = Boolean(this.onSilence) && !this.heardSpeech; // hands-free: nothing was said
        resolve(this.cancelled || silent || blob.size < 800 ? null : { blob, filename: type.includes("mp4") ? "speech.m4a" : "speech.webm" });
      };
      rec.stop();
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.recorder?.state === "recording") this.recorder.stop();
    else this.release();
  }

  private release(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.recorder = null;
    this.onLevel(0, new Uint8Array(0));
  }
}

let current: HTMLAudioElement | null = null;

export function play(blob: Blob, onEnd?: () => void): void {
  stopPlayback();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  current = audio;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (current === audio) current = null;
    onEnd?.();
  };
  void audio.play();
}

export function stopPlayback(): void {
  if (current) {
    current.pause();
    current = null;
  }
}

export function isPlaying(): boolean {
  return current !== null && !current.paused;
}
