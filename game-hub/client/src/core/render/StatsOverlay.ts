/** Small FPS / ping / resolution read-out, toggled in Settings. */
import { settings } from '../settings';
import { h } from '../ui/dom';
import type { GameRenderer } from './GameRenderer';

export class StatsOverlay {
  readonly el: HTMLElement;
  private timer = 0;
  private readonly unsubscribe: () => void;

  constructor(
    parent: HTMLElement,
    private readonly renderer: GameRenderer,
    private readonly ping: () => number | null,
    private readonly extra: () => string = () => '',
  ) {
    this.el = h('div', { class: 'stats-overlay', 'data-testid': 'stats' });
    parent.appendChild(this.el);
    this.unsubscribe = settings.subscribe(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const on = settings.get().showStats;
    this.el.classList.toggle('hidden', !on);
    window.clearInterval(this.timer);
    if (on) {
      this.update();
      this.timer = window.setInterval(() => this.update(), 500);
    }
  }

  private update(): void {
    const p = this.ping();
    const res = Math.round(this.renderer.dynres.scale * 100);
    const parts = [`${Math.round(this.renderer.fps)} fps`];
    if (p !== null) parts.push(`${Math.round(p)} ms`);
    parts.push(`${this.renderer.profile.preset} ${res}%`);
    parts.push(`${this.renderer.drawCalls} dc · ${(this.renderer.triangles / 1000).toFixed(0)}k tri`);
    const extra = this.extra();
    if (extra) parts.push(extra);
    this.el.textContent = parts.join(' · ');
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.unsubscribe();
    this.el.remove();
  }
}
