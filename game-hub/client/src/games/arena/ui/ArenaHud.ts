/**
 * DOM HUD for Arcfire Arena. Everything is plain DOM (cheap to update, crisp
 * at any resolution) layered over the canvas, respecting safe-area insets.
 */
import { h } from '../../../core/ui/dom';

export interface KillFeedEntry {
  killer: string;
  killerColor: string;
  victim: string;
  victimColor: string;
  weapon: string;
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
  private bannerTimer = 0;
  private hitTimer = 0;
  private last = { hp: -1, mag: -1, reserve: -1, weapon: '', timer: '', reload: -1, spread: -1 };

  constructor(parent: HTMLElement) {
    this.crosshair = h('div', { class: 'xhair' }, h('i', { class: 't' }), h('i', { class: 'b' }), h('i', { class: 'l' }), h('i', { class: 'r' }), h('i', { class: 'dot' }));
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
    this.scope = h('div', { class: 'scope-overlay' }, h('div', { class: 'scope-lens' }));
    this.vignette = h('div', { class: 'hurt-vignette' });
    this.spectate = h('div', { class: 'spectate-label hidden' });

    this.el = h('div', { class: 'arena-hud' },
      this.vignette,
      this.scope,
      this.damageRing,
      this.crosshair,
      this.hitmarker,
      h('div', { class: 'scorebar' }, this.scoreLeft, h('div', { class: 'score-mid' }, this.timer, this.roundLabel), this.scoreRight),
      this.feed,
      this.banner,
      this.spectate,
      h('div', { class: 'hp-panel' }, h('div', { class: 'hp-bar' }, this.hpFill), this.hpText),
      h('div', { class: 'ammo-panel' }, this.weaponName, h('div', { class: 'ammo-row' }, this.ammoMag, this.ammoReserve), this.reloadBar),
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

  setAmmo(mag: number, reserve: number, weapon: string, melee: boolean, reloadProgress: number): void {
    if (mag !== this.last.mag || reserve !== this.last.reserve || weapon !== this.last.weapon) {
      this.ammoMag.textContent = melee ? '—' : String(mag);
      this.ammoReserve.textContent = melee ? '' : `/ ${reserve}`;
      this.weaponName.textContent = weapon;
      this.ammoMag.classList.toggle('empty', !melee && mag === 0);
      this.last.mag = mag;
      this.last.reserve = reserve;
      this.last.weapon = weapon;
    }
    const r = Math.round(reloadProgress * 100);
    if (r !== this.last.reload) {
      this.last.reload = r;
      this.reloadBar.classList.toggle('active', reloadProgress > 0 && reloadProgress < 1);
      (this.reloadBar.firstChild as HTMLElement).style.transform = `scaleX(${reloadProgress})`;
    }
  }

  /** @param gapPx distance of the crosshair lines from the centre */
  setCrosshair(gapPx: number, visible: boolean): void {
    const g = Math.round(gapPx);
    if (g !== this.last.spread) {
      this.crosshair.style.setProperty('--gap', `${g}px`);
      this.last.spread = g;
    }
    this.crosshair.classList.toggle('hidden', !visible);
  }

  setScope(on: boolean): void {
    this.scope.classList.toggle('on', on);
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
    const row = h('div', { class: `kf-row ${e.mine ? 'mine' : ''}` },
      h('span', { style: `color:${e.killerColor}` }, e.killer),
      h('span', { class: 'kf-weapon' }, e.weapon, e.headshot ? ' ◎' : ''),
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
