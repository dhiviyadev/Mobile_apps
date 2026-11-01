/**
 * Boss health bar (design-voxel-mobs §13.1): top centre, under no corner
 * buttons; name, phase pips, a damage chip that trails the fill, the player
 * scaling ("×2") and a Stunned tag.
 */
import { h } from '../../../core/ui/dom';

export class BossBar {
  readonly el: HTMLElement;
  private readonly name: HTMLElement;
  private readonly scale: HTMLElement;
  private readonly tag: HTMLElement;
  private readonly pips: HTMLElement[];
  private readonly fill: HTMLElement;
  private readonly chip: HTMLElement;
  private chipFrac = 1;
  private chipHold = 0;
  private lastFrac = 1;
  private phase = 0;
  private flashT = 0;
  visible = false;

  constructor(parent: HTMLElement) {
    this.name = h('div', { class: 'bb-name' });
    this.scale = h('div', { class: 'bb-scale' });
    this.tag = h('div', { class: 'bb-tag' });
    this.pips = [0, 1, 2].map(() => h('div', { class: 'bb-pip' }));
    this.fill = h('div', { class: 'bb-fill' });
    this.chip = h('div', { class: 'bb-chip' });
    this.el = h('div', { class: 'boss-bar', 'data-testid': 'boss-bar', role: 'status', hidden: true },
      h('div', { class: 'bb-head' }, h('div', { class: 'bb-pips' }, ...this.pips), this.name, this.scale, this.tag),
      h('div', { class: 'bb-track' }, this.chip, this.fill),
    );
    parent.appendChild(this.el);
  }

  show(o: { name: string; color: number; frac: number; phase: number; scale: number; invulnerable: boolean; stunned: boolean }, dt: number): void {
    if (!this.visible) {
      this.visible = true;
      this.el.hidden = false;
      requestAnimationFrame(() => this.el.classList.add('on'));
      this.chipFrac = o.frac;
    }
    this.name.textContent = `The ${o.name}`;
    this.el.style.setProperty('--bb-color', `#${o.color.toString(16).padStart(6, '0')}`);
    this.scale.textContent = o.scale > 1.01 ? `×${Math.round(o.scale * 2) / 2}` : '';
    this.tag.textContent = o.stunned ? 'Stunned!' : '';
    if (o.phase !== this.phase) {
      if (this.phase) this.flashT = 0.3;
      this.phase = o.phase;
      this.pips.forEach((p, i) => p.classList.toggle('on', i < o.phase));
    }
    this.flashT -= dt;
    this.el.classList.toggle('flash', this.flashT > 0);
    this.el.classList.toggle('invulnerable', o.invulnerable);
    if (o.frac < this.lastFrac) this.chipHold = 0.6;
    this.lastFrac = o.frac;
    this.chipHold -= dt;
    if (this.chipHold <= 0) this.chipFrac = Math.max(o.frac, this.chipFrac - dt * 0.6);
    if (this.chipFrac < o.frac) this.chipFrac = o.frac;
    this.fill.style.width = `${(o.frac * 100).toFixed(1)}%`;
    this.chip.style.width = `${(this.chipFrac * 100).toFixed(1)}%`;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.phase = 0;
    this.el.classList.remove('on');
    this.el.hidden = true;
  }

  dispose(): void {
    this.el.remove();
  }
}
