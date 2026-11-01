/**
 * Name and health of the creature under the crosshair (design-voxel-mobs
 * §13.2), with a hint when it can be fed or named.
 */
import { h } from '../../../core/ui/dom';

export class TargetLabel {
  readonly el: HTMLElement;
  private readonly name: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly hint: HTMLElement;
  private hideIn = 0;
  current = '';

  constructor(parent: HTMLElement) {
    this.name = h('div', { class: 'mt-name' });
    this.fill = h('div', { class: 'mt-fill' });
    this.hint = h('div', { class: 'mt-hint' });
    this.el = h('div', { class: 'mob-target', 'data-testid': 'mob-target' }, this.name, h('div', { class: 'mt-bar' }, this.fill), this.hint);
    parent.appendChild(this.el);
  }

  show(name: string, health: number, hostile: boolean, hint: string): void {
    this.hideIn = 0.5;
    this.current = name;
    if (this.name.textContent !== name) this.name.textContent = name;
    if (this.hint.textContent !== hint) this.hint.textContent = hint;
    this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, health)) * 100)}%`;
    this.el.classList.add('on');
    this.el.classList.toggle('hostile', hostile);
  }

  update(dt: number): void {
    if (this.hideIn <= 0) return;
    this.hideIn -= dt;
    if (this.hideIn <= 0) {
      this.el.classList.remove('on');
      this.current = '';
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
