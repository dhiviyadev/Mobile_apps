/**
 * DOM HUD for Arcfire Arena. Everything is plain DOM (cheap to update, crisp
 * at any resolution) layered over the canvas, respecting safe-area insets.
 */
import { type WeaponId, weaponDef } from '@hub/shared';
import { h } from '../../../core/ui/dom';
import { weaponIcon } from '../render/weaponIcons';

export type CrosshairStyle = 'cross' | 'ring' | 'dot' | 'chevron';
/** Fire-mode tag next to the ammo counter ('' = none). */
export type FireModeTag = 'AUTO' | 'SEMI' | 'BURST' | 'BOLT' | 'PUMP' | '';

export interface KillFeedEntry {
  killer: string;
  killerColor: string;
  victim: string;
  victimColor: string;
  /** Short weapon name. */
  weapon: string;
  weaponId: WeaponId;
  headshot: boolean;
  mine: boolean;
}

export class ArenaHud {
  readonly el: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly damageRing: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly weaponName: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly scoreLeft: HTMLElement;
  private readonly scoreRight: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly spectate: HTMLElement;
  private readonly modeTag: HTMLElement;
  private readonly weaponImg: HTMLImageElement;
  private readonly autoChip: HTMLElement;
  private bannerTimer = 0;
  private hitTimer = 0;
  private last = { hp: -1, mag: -1, reserve: -1, weapon: '', timer: '', reload: -1, spread: -1, mode: '', style: '', scope: '', auto: '', icon: -1, chevron: '' };

  constructor(parent: HTMLElement) {
    this.crosshair = h('div', { class: 'xhair', 'data-testid': 'crosshair' },
      h('i', { class: 't' }), h('i', { class: 'b' }), h('i', { class: 'l' }), h('i', { class: 'r' }), h('i', { class: 'dot' }),
      h('i', { class: 'ring' }), h('i', { class: 'chev c30' }), h('i', { class: 'chev c60' }),
    );
    this.modeTag = h('span', { class: 'fire-mode hidden', 'data-testid': 'fire-mode' });
    this.weaponImg = h('img', { class: 'weapon-icon', alt: '' }) as HTMLImageElement;
    this.autoChip = h('div', { class: 'auto-chip hidden', 'data-testid': 'auto-chip' }, 'AUTO');
    this.hitmarker = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.damageRing = h('div', { class: 'damage-ring' });
    this.hpFill = h('div', { class: 'hp-fill' });
    this.hpText = h('div', { class: 'hp-text', 'data-testid': 'hp' }, '100');
    this.ammoMag = h('span', { class: 'ammo-mag', 'data-testid': 'ammo' }, '30');
    this.ammoReserve = h('span', { class: 'ammo-reserve' }, '/ 90');
    this.weaponName = h('div', { class: 'weapon-name' }, 'Rifle');
    this.reloadBar = h('div', { class: 'reload-bar' }, h('div', { class: 'reload-fill' }));
    this.scoreLeft = h('div', { class: 'score-chip left' }, '0');
    this.scoreRight = h('div', { class: 'score-chip right' }, '0');
    this.roundLabel = h('div', { class: 'round-label' }, 'Round 1');
    this.timer = h('div', { class: 'round-timer', 'data-testid': 'round-timer' }, '1:30');
    this.feed = h('div', { class: 'killfeed' });
    this.bannerTitle = h('div', { class: 'banner-title' });
    this.bannerSub = h('div', { class: 'banner-sub' });
    this.banner = h('div', { class: 'arena-banner', 'data-testid': 'arena-banner' }, this.bannerTitle, this.bannerSub);
    this.scope = h('div', { class: 'scope-overlay', 'data-testid': 'scope' }, h('div', { class: 'scope-lens' }), h('div', { class: 'optic-ring' }));
    this.vignette = h('div', { class: 'hurt-vignette' });
    this.spectate = h('div', { class: 'spectate-label hidden' });

    this.el = h('div', { class: 'arena-hud' },
      this.vignette,
      this.scope,
      this.damageRing,
      this.crosshair,
      this.autoChip,
      this.hitmarker,
      h('div', { class: 'scorebar' }, this.scoreLeft, h('div', { class: 'score-mid' }, this.timer, this.roundLabel), this.scoreRight),
      this.feed,
      this.banner,
      this.spectate,
      h('div', { class: 'hp-panel' }, h('div', { class: 'hp-bar' }, this.hpFill), this.hpText),
      h('div', { class: 'ammo-panel' },
        h('div', { class: 'weapon-line' }, this.weaponImg, this.weaponName, this.modeTag),
        h('div', { class: 'ammo-row' }, this.ammoMag, this.ammoReserve),
        this.reloadBar,
      ),
    );
    parent.appendChild(this.el);
  }

  setScores(left: string, right: string, leftClass: string, rightClass: string, round: string): void {
    if (this.scoreLeft.textContent !== left) this.scoreLeft.textContent = left;
    if (this.scoreRight.textContent !== right) this.scoreRight.textContent = right;
    this.scoreLeft.className = `score-chip left ${leftClass}`;
    this.scoreRight.className = `score-chip right ${rightClass}`;
    if (this.roundLabel.textContent !== round) this.roundLabel.textContent = round;
  }

  setTimer(seconds: number | null, urgent = false): void {
    const text = seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    if (text !== this.last.timer) {
      this.timer.textContent = text;
      this.last.timer = text;
    }
    this.timer.classList.toggle('urgent', urgent);
  }

  setHp(hp: number): void {
    const v = Math.max(0, Math.round(hp));
    if (v === this.last.hp) return;
    this.last.hp = v;
    this.hpText.textContent = String(v);
    this.hpFill.style.transform = `scaleX(${v / 100})`;
    this.hpFill.classList.toggle('low', v <= 30);
    this.vignette.style.opacity = v > 0 && v <= 30 ? String(0.25 + (30 - v) / 60) : '0';
  }

  /**
   * @param reloadProgress 0..1 bar under the counter (shell reloads pass mag / magazine)
   * @param mode fire-mode tag next to the weapon name ('' hides it)
   */
  setAmmo(mag: number, reserve: number, weapon: string, melee: boolean, reloadProgress: number, mode: FireModeTag = ''): void {
    if (mag !== this.last.mag || reserve !== this.last.reserve || weapon !== this.last.weapon) {
      this.ammoMag.textContent = melee ? '—' : String(mag);
      this.ammoReserve.textContent = melee ? '' : `/ ${reserve}`;
      this.weaponName.textContent = weapon;
      this.ammoMag.classList.toggle('empty', !melee && mag === 0);
      this.last.mag = mag;
      this.last.reserve = reserve;
      this.last.weapon = weapon;
    }
    if (mode !== this.last.mode) {
      this.last.mode = mode;
      this.modeTag.textContent = mode;
      this.modeTag.classList.toggle('hidden', mode === '');
    }
    const r = Math.round(reloadProgress * 100);
    if (r !== this.last.reload) {
      this.last.reload = r;
      this.reloadBar.classList.toggle('active', reloadProgress > 0 && reloadProgress < 1);
      (this.reloadBar.firstChild as HTMLElement).style.transform = `scaleX(${reloadProgress})`;
    }
  }

  /** Side-view icon of the held weapon in the ammo panel. */
  setWeaponIcon(id: WeaponId): void {
    if (id === this.last.icon) return;
    this.last.icon = id;
    this.weaponImg.src = weaponIcon(id, 72, 26);
    this.weaponImg.alt = weaponDef(id).short;
  }

  /**
   * @param gapPx distance of the crosshair lines (or the ring) from the centre
   * @param style cross (rifles), ring (shotgun spread), dot (sniper hip, knife), chevron (crossbow drop marks)
   */
  setCrosshair(gapPx: number, visible: boolean, style: CrosshairStyle = 'cross'): void {
    const g = Math.round(gapPx);
    if (g !== this.last.spread) {
      this.crosshair.style.setProperty('--gap', `${g}px`);
      this.last.spread = g;
    }
    if (style !== this.last.style) {
      this.last.style = style;
      this.crosshair.dataset.style = style;
    }
    this.crosshair.classList.toggle('hidden', !visible);
  }

  /** Crossbow chevron: the drop marks for 30 m and 60 m, in pixels below the centre. */
  setChevron(px30: number, px60: number): void {
    const key = `${Math.round(px30)}:${Math.round(px60)}`;
    if (key === this.last.chevron) return;
    this.last.chevron = key;
    this.crosshair.style.setProperty('--c30', `${Math.round(px30)}px`);
    this.crosshair.style.setProperty('--c60', `${Math.round(px60)}px`);
  }

  /** Full-screen sight overlay: 'scope' (sniper, 4×), 'optic' (marksman, 2×: lighter, see-through centre), null = none. */
  setScope(kind: 'scope' | 'optic' | null): void {
    const k = kind ?? '';
    if (k === this.last.scope) return;
    this.last.scope = k;
    this.scope.classList.toggle('on', kind !== null);
    this.scope.classList.toggle('optic', kind === 'optic');
  }

  /** Auto-shoot chip under the crosshair: hidden when off, dim while waiting, lit while it fires. */
  setAutoShoot(state: 'off' | 'idle' | 'firing'): void {
    if (state === this.last.auto) return;
    this.last.auto = state;
    this.autoChip.classList.toggle('hidden', state === 'off');
    this.autoChip.classList.toggle('firing', state === 'firing');
    this.crosshair.classList.toggle('auto', state === 'firing');
  }

  /** Short rising label after a pickup, next to the HP bar (health) or the ammo counter (ammo). */
  pickupFlash(text: string, kind: 'health' | 'ammo'): void {
    const anchor = this.el.querySelector(kind === 'health' ? '.hp-panel' : '.ammo-panel');
    if (!anchor) return;
    // Styled in arena-move.css: mint by the HP bar, amber by the ammo counter, rising for 1.2 s.
    const label = h('div', { class: `pickup-flash ${kind}`, 'data-testid': 'pickup-flash' }, text);
    anchor.appendChild(label);
    window.setTimeout(() => label.remove(), 1200);
  }

  hitMarker(kind: 'hit' | 'head' | 'kill'): void {
    this.hitmarker.className = `hitmarker show ${kind}`;
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hitmarker.classList.remove('show'), kind === 'kill' ? 380 : 180);
  }

  /** @param angle direction of the attacker relative to where we look (radians, 0 = ahead, + = left) */
  damageFrom(angle: number): void {
    const arc = h('div', { class: 'damage-arc', style: `transform: rotate(${-angle}rad)` });
    this.damageRing.appendChild(arc);
    window.setTimeout(() => arc.remove(), 900);
  }

  killFeed(e: KillFeedEntry): void {
    const icon = weaponIcon(e.weaponId, 48, 18);
    const row = h('div', { class: `kf-row ${e.mine ? 'mine' : ''}` },
      h('span', { style: `color:${e.killerColor}` }, e.killer),
      h('span', { class: 'kf-weapon' }, icon ? h('img', { src: icon, alt: e.weapon, title: weaponDef(e.weaponId).name }) : e.weapon, e.headshot ? h('b', { class: 'kf-head', title: 'Headshot' }, '◎') : null),
      h('span', { style: `color:${e.victimColor}` }, e.victim),
    );
    this.feed.prepend(row);
    while (this.feed.children.length > 5) this.feed.lastElementChild?.remove();
    window.setTimeout(() => row.classList.add('fade'), 5000);
    window.setTimeout(() => row.remove(), 5600);
  }

  showBanner(title: string, sub = '', ms = 2000, kind: 'win' | 'lose' | 'info' = 'info'): void {
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.banner.className = `arena-banner show ${kind}`;
    window.clearTimeout(this.bannerTimer);
    if (ms > 0) this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  hideBanner(): void {
    this.banner.classList.remove('show');
  }

  setSpectating(text: string | null): void {
    this.spectate.classList.toggle('hidden', text === null);
    if (text !== null && this.spectate.textContent !== text) this.spectate.textContent = text;
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
  }

  dispose(): void {
    window.clearTimeout(this.bannerTimer);
    window.clearTimeout(this.hitTimer);
    this.el.remove();
  }
}
