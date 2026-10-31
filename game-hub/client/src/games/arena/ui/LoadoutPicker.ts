/**
 * Between-rounds loadout picker: eight primary weapons and three sidearms, each a tappable card with a
 * drawn side view, its fire mode, a one-line blurb, four stat bars and its time to kill. The Combat Knife
 * is always the third slot. Picks apply at once in the loadout phase, otherwise at the next spawn.
 */
import { PRIMARY_WEAPONS, SECONDARY_WEAPONS, ttkBody, type WeaponDef, type WeaponId, weaponDef } from '@hub/shared';
import { h } from '../../../core/ui/dom';
import { weaponIcon } from '../render/weaponIcons';
import { WEAPON_VISUALS } from '../render/weaponVisuals';

function stat(label: string, value: number, cls: string): HTMLElement {
  return h('div', { class: `lo-stat ${cls}` }, h('span', null, label), h('div', { class: 'lo-bar' }, h('i', { style: `width:${Math.round(Math.max(0.04, Math.min(1, value)) * 100)}%` })));
}

/** Shots per second when held at the maximum rate (reloads not counted, except the one-bolt crossbow). */
function fireRate(d: WeaponDef): number {
  if (d.burstCount > 1) return d.burstCount / ((d.burstCount - 1) * d.burstInterval + d.interval);
  return 1 / (d.magazine === 1 ? d.interval + d.reloadTime : d.interval);
}

/** "AUTO · 30 rds", "PUMP · 6", "CROSSBOW · 1"… */
function classTag(d: WeaponDef): string {
  const mode = d.kind === 'projectile' ? 'CROSSBOW' : WEAPON_VISUALS[d.id].mode;
  return `${mode} · ${d.magazine}${d.fireMode === 'auto' && d.kind === 'hitscan' && d.pellets === 1 ? ' rds' : ''}`;
}

function card(d: WeaponDef, small: boolean, onClick: () => void): HTMLElement {
  const damage = Math.min(1, (d.damage * d.pellets) / 110);
  const ttk = ttkBody(d, 10);
  return h('button', { class: `lo-card${small ? ' small' : ''}`, 'data-testid': `loadout-${d.key}`, onclick: onClick },
    h('img', { class: 'lo-icon', src: weaponIcon(d.id, small ? 84 : 96, small ? 30 : 36), alt: '' }),
    h('div', { class: 'lo-title' }, h('span', { class: 'lo-name' }, d.name), h('span', { class: 'lo-tag' }, classTag(d))),
    h('p', { class: 'lo-blurb' }, d.blurb),
    stat('Damage', damage, 'key'),
    stat('Fire rate', fireRate(d) / 15, 'key'),
    stat('Range', d.falloffStart / 60, ''),
    stat('Mobility', (d.moveMul - 0.8) / 0.35, ''),
    h('div', { class: 'lo-dps' }, `TTK ${ttk.toFixed(2)} s · ${d.magazine} ${d.magazine === 1 ? 'bolt' : 'rds'}`),
  );
}

export class LoadoutPicker {
  readonly el: HTMLElement;
  private readonly cards = new Map<WeaponId, HTMLElement>();
  private readonly countdown: HTMLElement;
  private open = false;
  private primary: WeaponId = PRIMARY_WEAPONS[0];
  private secondary: WeaponId = SECONDARY_WEAPONS[0];
  private pickedAt = -1e9;

  constructor(parent: HTMLElement, private readonly onPick: (primary: WeaponId, secondary: WeaponId) => void) {
    this.countdown = h('span', { class: 'lo-count' });
    const section = (title: string, testId: string, ids: readonly WeaponId[], small: boolean, pick: (id: WeaponId) => void) => {
      const grid = h('div', { class: `lo-grid ${small ? 'cols-3' : 'cols-4'}`, 'data-testid': testId });
      for (const id of ids) {
        const c = card(weaponDef(id), small, () => pick(id));
        this.cards.set(id, c);
        grid.appendChild(c);
      }
      return h('section', { class: 'lo-section' }, h('h3', null, title), grid);
    };
    this.el = h('div', { class: 'loadout hidden', 'data-testid': 'loadout' },
      h('div', { class: 'lo-head' }, h('h2', null, 'Choose your loadout'), this.countdown),
      section('Primary', 'loadout-primary', PRIMARY_WEAPONS, false, (id) => this.pick(id, this.secondary)),
      section('Sidearm', 'loadout-secondary', SECONDARY_WEAPONS, true, (id) => this.pick(this.primary, id)),
      h('p', { class: 'lo-note' }, 'Combat Knife is always equipped.'),
    );
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(primary: WeaponId, secondary: WeaponId, secondsLeft: number | null): void {
    if (!this.open) {
      this.open = true;
      this.el.classList.remove('hidden');
    }
    // Online the authority echoes a pick a round trip later: keep showing our own pick meanwhile.
    const settling = performance.now() - this.pickedAt < 1500;
    if (!settling && (primary !== this.primary || secondary !== this.secondary || !this.el.querySelector('.lo-card.active'))) {
      this.primary = primary;
      this.secondary = secondary;
      this.highlight();
    }
    const text = secondsLeft === null ? '' : `Round starts in ${Math.ceil(secondsLeft)}`;
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
  }

  hide(): void {
    this.open = false;
    this.el.classList.add('hidden');
  }

  private pick(primary: WeaponId, secondary: WeaponId): void {
    this.pickedAt = performance.now();
    this.primary = primary;
    this.secondary = secondary;
    this.highlight();
    this.onPick(primary, secondary);
  }

  private highlight(): void {
    for (const [w, c] of this.cards) c.classList.toggle('active', w === this.primary || w === this.secondary);
  }
}
