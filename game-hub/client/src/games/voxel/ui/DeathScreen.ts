/** "You were defeated" overlay (design-voxel-survival §16.3): cause, satchel location, Respawn after 1.5 s. */
import { h } from '../../../core/ui/dom';

export class DeathScreen {
  private el: HTMLElement | null = null;
  private timer = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly onRespawn: () => void,
    private readonly onLeave: () => void,
  ) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(cause: string, satchel: { x: number; y: number; z: number } | null, online: boolean): void {
    this.close();
    const respawn = h('button', { class: 'btn btn-primary btn-lg', 'data-testid': 'respawn', disabled: true, onclick: () => this.onRespawn() }, 'Respawn');
    this.el = h('div', { class: 'death-screen', 'data-testid': 'death-screen', role: 'dialog', 'aria-label': 'You were defeated' },
      h('div', { class: 'death-card' },
        h('h2', null, 'You were defeated'),
        h('p', { class: 'death-cause' }, cause),
        h('p', { class: 'death-satchel' }, satchel
          ? `Your satchel is at ${satchel.x}, ${satchel.y}, ${satchel.z}${online ? ' (lasts 30 minutes)' : ''}`
          : 'You kept your items'),
        h('div', { class: 'death-actions' }, respawn, h('button', { class: 'btn btn-lg btn-ghost', onclick: () => this.onLeave() }, 'Leave')),
      ),
    );
    this.parent.appendChild(this.el);
    this.timer = window.setTimeout(() => (respawn.disabled = false), 1500);
  }

  close(): void {
    window.clearTimeout(this.timer);
    this.el?.remove();
    this.el = null;
  }
}
