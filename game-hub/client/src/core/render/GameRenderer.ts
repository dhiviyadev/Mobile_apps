/**
 * Thin wrapper around THREE.WebGLRenderer shared by both games: quality
 * presets, resize handling, dynamic resolution and frame timing.
 *
 * Colour management is turned off on purpose: everything (vertex colours,
 * procedural textures, materials) is authored in display space, which keeps
 * colours predictable and skips per-pixel sRGB conversion on mobile GPUs.
 */
import * as THREE from 'three';
import { settings } from '../settings';
import { DynamicResolution } from './DynamicResolution';
import { QUALITY_PROFILES, type QualityProfile } from './quality';

THREE.ColorManagement.enabled = false;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly dynres: DynamicResolution;
  profile: QualityProfile;
  private lastFrame = performance.now();
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;
  private resizeListeners = new Set<(w: number, h: number) => void>();
  /** Smoothed frames per second for the stats overlay. */
  fps = 60;

  constructor(private readonly container: HTMLElement) {
    this.profile = QUALITY_PROFILES[settings.effectiveQuality()];
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.profile.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('tabindex', '0');
    container.prepend(this.canvas);

    this.dynres = new DynamicResolution(this.profile.targetFps, this.profile.minRenderScale, () => this.applyPixelRatio());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribe = settings.subscribe((_s, changed) => {
      if (changed.includes('quality') || changed.includes('detectedQuality')) {
        this.profile = QUALITY_PROFILES[settings.effectiveQuality()];
        this.dynres.configure(this.profile.targetFps, this.profile.minRenderScale);
        this.applyPixelRatio();
      }
      if (changed.includes('dynamicResolution')) this.dynres.reset();
    });
    this.resize();
  }

  get width(): number {
    return this.container.clientWidth || window.innerWidth;
  }

  get height(): number {
    return this.container.clientHeight || window.innerHeight;
  }

  onResize(fn: (w: number, h: number) => void): () => void {
    this.resizeListeners.add(fn);
    fn(this.width, this.height);
    return () => this.resizeListeners.delete(fn);
  }

  /** Call once per animation frame before rendering; returns dt in seconds. */
  beginFrame(): number {
    const now = performance.now();
    const ms = now - this.lastFrame;
    this.lastFrame = now;
    if (ms > 0 && ms < 1000) this.fps += (1000 / ms - this.fps) * 0.05;
    this.dynres.update(ms, settings.get().dynamicResolution);
    return Math.min(0.1, ms / 1000);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  /** Effective pixel ratio currently in use. */
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.unsubscribe();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private applyPixelRatio(): void {
    const base = Math.min(window.devicePixelRatio || 1, this.profile.maxPixelRatio);
    this.renderer.setPixelRatio(Math.max(0.5, base * this.dynres.scale));
  }

  private resize(): void {
    this.applyPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    for (const fn of this.resizeListeners) fn(this.width, this.height);
  }
}
