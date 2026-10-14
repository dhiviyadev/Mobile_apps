/** Between-rounds loadout picker: one big tappable card per primary weapon. */
import { PRIMARY_WEAPONS, type WeaponId, weaponDef } from '@hub/shared';
import { h } from '../../../core/ui/dom';

const BLURB: Record<number, string> = {
  0: 'Full-auto all-rounder. Controls mid range.',
  1: 'Nine pellets. Devastating up close.',
  2: 'One-shot headshots. Scope for perfect accuracy.',
};

function stat(label: string, value: number): HTMLElement {
  return h('div', { class: 'lo-stat' }, h('span', null, label), h('div', { class: 'lo-bar' }, h('i', { style: `width:${Math.round(Math.min(1, value) * 100)}%` })));
}

export class LoadoutPicker {
  readonly el: HTMLElement;
  private readonly cards = new Map<WeaponId, HTMLElement>();
  private readonly countdown: HTMLElement;
  private open = false;

  constructor(parent: HTMLElement, private readonly onPick: (w: WeaponId) => void) {
    this.countdown = h('span', { class: 'lo-count' });
    const grid = h('div', { class: 'lo-grid' });
    for (const id of PRIMARY_WEAPONS) {
      const d = weaponDef(id);
      const dps = (d.damage * d.pellets) / d.interval;
      const card = h('button', { class: 'lo-card', 'data-testid': `loadout-${d.short.toLowerCase()}`, onclick: () => this.pick(id) },
        h('div', { class: 'lo-name' }, d.name),
        h('p', { class: 'lo-blurb' }, BLURB[id]),
        stat('Damage', (d.damage * d.pellets) / 130),
        stat('Fire rate', 0.1 / d.interval),
        stat('Range', d.falloffStart / 60),
        stat('Mobility', (d.moveMul - 0.8) / 0.2),
        h('div', { class: 'lo-dps' }, `${Math.round(dps)} dmg/s · ${d.magazine} rounds`),
      );
      this.cards.set(id, card);
      grid.appendChild(card);
    }
    this.el = h('div', { class: 'loadout hidden', 'data-testid': 'loadout' },
      h('div', { class: 'lo-head' }, h('h2', null, 'Choose your loadout'), this.countdown),
      grid,
      h('p', { class: 'lo-note' }, 'Sidearm and Blade are always equipped.'),
    );
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(selected: WeaponId, secondsLeft: number | null): void {
    this.open = true;
    this.el.classList.remove('hidden');
    this.highlight(selected);
    this.countdown.textContent = secondsLeft === null ? '' : `Round starts in ${Math.ceil(secondsLeft)}`;
  }

  hide(): void {
    this.open = false;
    this.el.classList.add('hidden');
  }

  private pick(id: WeaponId): void {
    this.highlight(id);
    this.onPick(id);
  }

  private highlight(id: WeaponId): void {
    for (const [w, card] of this.cards) card.classList.toggle('active', w === id);
  }
}
