/**
 * Survival HUD (design-voxel-survival §16.1): lifegems and rations above the
 * hotbar, air bubbles, the weapon cooldown arc and draw/load ring at the
 * crosshair, hit markers, hurt vignette with a direction wedge, the day badge,
 * a chip pointing at your Lost Satchel, a pickup feed, rest status, status
 * effects and one-time hints. DOM only; writes happen on change.
 */
import { h } from '../../../core/ui/dom';
import { isNight } from '@hub/shared';

const HINTS_KEY = 'cobalt-hub.voxel.hints.v1';
const RING_R = 15;
const RING_LEN = 2 * Math.PI * RING_R;

export type HintId = 'start' | 'log' | 'workbench' | 'dusk' | 'bow' | 'hungry' | 'shield';
const HINT_TEXT: Record<HintId, string> = {
  start: 'Hold Mine on a tree to collect wood',
  log: 'Open your bag (E or the Bag button) to make planks and a workbench',
  workbench: 'Place the workbench, then craft tools next to it',
  dusk: 'Night falls: build a shelter, craft a sword, or rest on a bedroll',
  bow: 'Hold Draw, aim high for distance, release to shoot',
  hungry: 'Hungry? Hold Use with food selected to eat',
  shield: 'Hold Guard (Z) to block attacks from the front',
};

function loadHints(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HINTS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export class SurvivalHud {
  readonly el: HTMLElement;
  private readonly gems: HTMLElement[] = [];
  private readonly rations: HTMLElement[] = [];
  private readonly bubbles: HTMLElement[] = [];
  private readonly hpRow: HTMLElement;
  private readonly foodRow: HTMLElement;
  private readonly airRow: HTMLElement;
  private readonly effects: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly ringWrap: HTMLElement;
  private readonly cooldown: SVGCircleElement;
  private readonly cooldownWrap: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly hurtDir: HTMLElement;
  private readonly day: HTMLElement;
  private readonly satchel: HTMLElement;
  private readonly satchelArrow: HTMLElement;
  private readonly satchelDist: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly rest: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly shieldOff: HTMLElement;
  private readonly targetInfo: HTMLElement;
  private readonly targetBar: HTMLElement;
  private readonly targetName: HTMLElement;
  private hintTimer = 0;
  private targetTimer = 0;
  private hitTimer = 0;
  private readonly seenHints = loadHints();
  private last = '';
  private lastDay = '';
  private readonly feedLines: { el: HTMLElement; item: number; count: number; at: number }[] = [];

  constructor(parent: HTMLElement, private readonly survival: boolean, private readonly iconFor: (item: number, size: number) => HTMLCanvasElement) {
    for (let i = 0; i < 10; i++) {
      this.gems.push(h('i', { class: 'gem full' }));
      this.rations.push(h('i', { class: 'ration full' }));
      this.bubbles.push(h('i', { class: 'bubble' }));
    }
    this.hpRow = h('div', { class: 'vital-row hp', 'data-testid': 'hp-row' }, this.gems);
    this.foodRow = h('div', { class: 'vital-row food', 'data-testid': 'food-row' }, this.rations);
    this.airRow = h('div', { class: 'vital-row air hidden' }, this.bubbles);
    this.effects = h('div', { class: 'vital-effects' });
    const svg = (cls: string) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 36 36');
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const c of [bg, fg]) {
        c.setAttribute('cx', '18');
        c.setAttribute('cy', '18');
        c.setAttribute('r', String(RING_R));
      }
      bg.setAttribute('class', 'ring-bg');
      fg.setAttribute('class', 'ring-fg');
      fg.setAttribute('stroke-dasharray', String(RING_LEN));
      s.append(bg, fg);
      const wrap = h('div', { class: `${cls} hidden` });
      wrap.appendChild(s);
      return { wrap, fg };
    };
    const r = svg('charge-ring');
    this.ringWrap = r.wrap;
    this.ring = r.fg;
    const cd = svg('cooldown');
    this.cooldownWrap = cd.wrap;
    this.cooldown = cd.fg;
    this.hitmarker = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.vignette = h('div', { class: 'hurt-vignette' });
    this.hurtDir = h('div', { class: 'hurt-dir' });
    this.day = h('div', { class: 'day-badge', 'data-testid': 'day-badge' });
    this.satchelArrow = h('span', { class: 'sc-arrow' }, '▲');
    this.satchelDist = h('span', { class: 'sc-dist' });
    this.satchel = h('button', { class: 'satchel-chip hidden', 'data-testid': 'satchel-chip' }, iconFor(320, 24), this.satchelArrow, this.satchelDist);
    this.feed = h('div', { class: 'pickup-feed' });
    this.rest = h('div', { class: 'rest-status hidden' });
    this.hint = h('div', { class: 'hint-toast' });
    this.shieldOff = h('div', { class: 'shield-off hidden', title: 'Shield disabled' });
    this.targetName = h('span', { class: 'ti-name' });
    this.targetBar = h('i');
    this.targetInfo = h('div', { class: 'target-info' }, this.targetName, h('div', { class: 'ti-bar' }, this.targetBar));
    this.el = h('div', { class: `survival-hud ${survival ? '' : 'creative'}` },
      this.vignette, this.hurtDir, this.ringWrap, this.cooldownWrap, this.hitmarker, this.targetInfo,
      survival ? h('div', { class: 'vitals', 'data-testid': 'vitals' }, h('div', { class: 'vitals-left' }, this.airRow, this.hpRow), this.effects, this.foodRow) : null,
      survival ? this.day : null, this.satchel, this.feed, this.rest, this.hint, this.shieldOff,
    );
    parent.appendChild(this.el);
  }

  /** hp, food: 0..20 in halves; air 0..10. */
  setVitals(hp: number, food: number, air: number, starving: boolean, slow: boolean, burning: boolean): void {
    const key = `${hp},${food},${air},${starving},${slow},${burning}`;
    if (key === this.last) return;
    const prevHp = Number(this.last.split(',')[0] || 20);
    this.last = key;
    this.gems.forEach((g, i) => (g.className = `gem ${hp >= (i + 1) * 2 ? 'full' : hp >= i * 2 + 1 ? 'half' : 'empty'}`));
    this.rations.forEach((g, i) => (g.className = `ration ${food >= (i + 1) * 2 ? 'full' : food >= i * 2 + 1 ? 'half' : 'empty'}`));
    this.bubbles.forEach((g, i) => g.classList.toggle('gone', air <= i));
    this.airRow.classList.toggle('hidden', air >= 10);
    this.hpRow.classList.toggle('low', hp <= 8 && hp > 0);
    this.foodRow.classList.toggle('starving', starving);
    if (hp > prevHp) {
      this.hpRow.classList.remove('regen');
      void this.hpRow.offsetWidth;
      this.hpRow.classList.add('regen');
    }
    this.effects.replaceChildren(...(slow ? [h('span', { class: 'fx slow', title: 'Slowed' }, '❄')] : []), ...(burning ? [h('span', { class: 'fx burn', title: 'Burning' }, '🔥')] : []));
  }

  setDay(day: number, time: number): void {
    const night = isNight(time);
    const key = `${day}${night}`;
    if (key === this.lastDay) return;
    this.lastDay = key;
    this.day.textContent = `${night ? '☾' : '☀'} Day ${day}`;
    this.day.classList.toggle('night', night);
  }

  /** Bow draw / crossbow load progress (null hides); `full` turns gold. */
  setCharge(f: number | null, loaded = false): void {
    this.ringWrap.classList.toggle('hidden', f === null && !loaded);
    if (f === null && !loaded) return;
    const v = loaded ? 1 : Math.max(0, Math.min(1, f ?? 0));
    this.ring.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - v)));
    this.ringWrap.classList.toggle('full', v >= 1);
    this.ringWrap.classList.toggle('loaded', loaded);
  }

  /** Melee cooldown left 0..1 (0 hides). */
  setCooldown(f: number): void {
    this.cooldownWrap.classList.toggle('hidden', f <= 0.02);
    if (f > 0.02) this.cooldown.setAttribute('stroke-dashoffset', String(RING_LEN * f));
  }

  setShieldDisabled(on: boolean): void {
    this.shieldOff.classList.toggle('hidden', !on);
  }

  hitMarker(kind: 'hit' | 'crit' | 'blocked' | 'kill'): void {
    this.hitmarker.className = `hitmarker show ${kind}`;
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => (this.hitmarker.className = 'hitmarker'), kind === 'kill' ? 300 : 140);
  }

  /** Red vignette and an edge wedge toward the source (angle relative to view: 0 = ahead). */
  hurt(angle: number | null, strength: number): void {
    this.vignette.style.setProperty('--k', String(Math.min(1, 0.45 + strength * 0.08)));
    this.vignette.classList.remove('on');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('on');
    if (angle === null) return;
    this.hurtDir.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    this.hurtDir.classList.remove('on');
    void this.hurtDir.offsetWidth;
    this.hurtDir.classList.add('on');
  }

  /** Name and HP bar under the crosshair after hitting a player. */
  showTarget(name: string, hp: number, max: number): void {
    this.targetName.textContent = name;
    this.targetBar.style.width = `${Math.max(0, Math.min(1, hp / max)) * 100}%`;
    this.targetInfo.classList.add('show');
    window.clearTimeout(this.targetTimer);
    this.targetTimer = window.setTimeout(() => this.targetInfo.classList.remove('show'), 2500);
  }

  /** Points at your newest satchel: bearing relative to the view yaw, distance in metres. Null hides it. */
  setSatchel(info: { bearing: number; dist: number } | null, onTap: () => void): void {
    this.satchel.classList.toggle('hidden', !info);
    if (!info) return;
    this.satchel.onclick = onTap;
    this.satchelArrow.style.transform = `rotate(${info.bearing}rad)`;
    this.satchelDist.textContent = `${Math.round(info.dist)} m`;
  }

  /** "+3 Cobblestone" lines (same item within 1.5 s merges). */
  pickup(item: number, count: number, name: string): void {
    const now = performance.now();
    const same = this.feedLines.find((l) => l.item === item && now - l.at < 1500);
    if (same) {
      same.count += count;
      same.at = now;
      same.el.lastChild!.textContent = `+${same.count} ${name}`;
      same.el.classList.remove('fade');
      void same.el.offsetWidth;
      same.el.classList.add('fade');
      return;
    }
    const el = h('div', { class: 'pf-line fade' }, this.iconFor(item, 24), h('span', null, `+${count} ${name}`));
    this.feed.prepend(el);
    this.feedLines.unshift({ el, item, count, at: now });
    while (this.feedLines.length > 4) this.feedLines.pop()!.el.remove();
    window.setTimeout(() => {
      el.remove();
      const i = this.feedLines.findIndex((l) => l.el === el);
      if (i >= 0) this.feedLines.splice(i, 1);
    }, 2600);
  }

  setRest(text: string | null): void {
    this.rest.classList.toggle('hidden', !text);
    if (text) this.rest.textContent = text;
  }

  /** Shows a hint once per browser. */
  showHint(id: HintId): void {
    if (this.seenHints.has(id) || !this.survival) return;
    this.seenHints.add(id);
    try {
      localStorage.setItem(HINTS_KEY, JSON.stringify([...this.seenHints]));
    } catch {
      /* private mode */
    }
    this.hint.textContent = HINT_TEXT[id];
    this.hint.classList.add('show');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.remove('show'), 5000);
  }

  dispose(): void {
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.targetTimer);
    window.clearTimeout(this.hitTimer);
    this.el.remove();
  }
}
