/**
 * Keeps the frame rate up by scaling the render resolution.
 *
 * Measures the interval between animation frames (which includes GPU time on
 * a vsynced display). If frames run slower than the target for ~1 s, the
 * resolution drops a step; after ~4 s of comfortable headroom it rises again.
 */
export class DynamicResolution {
  scale = 1;
  private avgMs = 16.7;
  private slowFor = 0;
  private fastFor = 0;
  private cooldown = 0;

  constructor(
    private targetFps: number,
    private minScale: number,
    private readonly onChange: (scale: number) => void,
  ) {}

  configure(targetFps: number, minScale: number): void {
    if (targetFps === this.targetFps && minScale === this.minScale) return;
    this.targetFps = targetFps;
    this.minScale = minScale;
    if (this.scale < minScale) this.set(minScale);
  }

  reset(): void {
    this.set(1);
    this.slowFor = this.fastFor = 0;
  }

  /** @param frameMs time since the previous frame */
  update(frameMs: number, enabled: boolean): void {
    if (!enabled) {
      if (this.scale !== 1) this.set(1);
      return;
    }
    // Ignore hitches (tab switches, GC pauses) so one spike doesn't drop quality.
    const ms = Math.min(frameMs, 100);
    this.avgMs += (ms - this.avgMs) * 0.08;
    const dt = ms / 1000;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    const budget = 1000 / this.targetFps;
    if (this.avgMs > budget * 1.12) {
      this.slowFor += dt;
      this.fastFor = 0;
      if (this.slowFor > 1 && this.scale > this.minScale) {
        this.set(Math.max(this.minScale, this.scale - 0.1));
      }
    } else if (this.avgMs < budget * 0.85) {
      this.fastFor += dt;
      this.slowFor = 0;
      if (this.fastFor > 4 && this.scale < 1) this.set(Math.min(1, this.scale + 0.1));
    } else {
      this.slowFor = this.fastFor = 0;
    }
  }

  get averageFrameMs(): number {
    return this.avgMs;
  }

  private set(scale: number): void {
    this.scale = Math.round(scale * 100) / 100;
    this.slowFor = this.fastFor = 0;
    this.cooldown = 1.5;
    this.onChange(this.scale);
  }
}
