/**
 * DOM heads-up display for Voxelvale: crosshair, hotbar (tap or swipe across
 * it on touch, wheel / number keys on desktop), selected-block label, parkour
 * timer and checkpoint counter.
 */
import { blockDef, HOTBAR_BLOCKS } from '@hub/shared';
import { h } from '../../../core/ui/dom';
import { drawBlockIcon } from '../world/atlas';

const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

export class VoxelHud {
  readonly el: HTMLElement;
  private readonly hotbar: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly blockLabel: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly cpEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly centerMsg: HTMLElement;
  private readonly underwater: HTMLElement;
  private labelTimer = 0;
  private msgTimer = 0;
  selected = 0;

  constructor(
    parent: HTMLElement,
    atlas: HTMLCanvasElement,
    private readonly onSelect: (index: number) => void,
    parkour: boolean,
  ) {
    this.hotbar = h('div', { class: 'hotbar', 'data-testid': 'hotbar' });
    HOTBAR_BLOCKS.forEach((b, i) => {
      const icon = drawBlockIcon(atlas, b, 64);
      icon.className = 'slot-icon';
      const slot = h('div', { class: 'slot', dataset: { index: String(i) } }, icon, h('span', { class: 'slot-key' }, SLOT_KEYS[i] ?? ''));
      this.slots.push(slot);
      this.hotbar.appendChild(slot);
    });
    this.bindHotbarTouch();

    this.blockLabel = h('div', { class: 'block-label' });
    this.timerEl = h('div', { class: 'pk-timer', 'data-testid': 'parkour-timer' }, '00:00.00');
    this.cpEl = h('div', { class: 'pk-cp' }, '');
    this.bestEl = h('div', { class: 'pk-best' }, '');
    this.centerMsg = h('div', { class: 'center-msg' });
    this.underwater = h('div', { class: 'underwater-tint' });

    this.el = h('div', { class: 'voxel-hud' },
      this.underwater,
      h('div', { class: 'crosshair' }),
      parkour ? h('div', { class: 'pk-panel' }, this.timerEl, this.cpEl, this.bestEl) : null,
      this.centerMsg,
      this.blockLabel,
      parkour ? null : this.hotbar,
    );
    parent.appendChild(this.el);
    this.select(0, false);
  }

  select(index: number, announce = true): void {
    const n = HOTBAR_BLOCKS.length;
    this.selected = ((index % n) + n) % n;
    this.slots.forEach((s, i) => s.classList.toggle('active', i === this.selected));
    if (announce) {
      this.blockLabel.textContent = blockDef(HOTBAR_BLOCKS[this.selected]).name;
      this.blockLabel.classList.add('show');
      window.clearTimeout(this.labelTimer);
      this.labelTimer = window.setTimeout(() => this.blockLabel.classList.remove('show'), 1100);
    }
  }

  setUnderwater(on: boolean): void {
    this.underwater.classList.toggle('on', on);
  }

  setParkour(timeMs: number, checkpoint: number, total: number, bestMs: number | null, running: boolean): void {
    this.timerEl.textContent = formatTime(timeMs);
    this.timerEl.classList.toggle('running', running);
    this.cpEl.textContent = `Checkpoint ${checkpoint}/${total}`;
    this.bestEl.textContent = bestMs !== null ? `Best ${formatTime(bestMs)}` : '';
  }

  /** Big centred message (e.g. "Checkpoint!"), fades after `ms`. */
  flash(text: string, ms = 1400, kind: 'good' | 'info' = 'info'): void {
    this.centerMsg.textContent = text;
    this.centerMsg.className = `center-msg show ${kind}`;
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.centerMsg.classList.remove('show'), ms);
  }

  dispose(): void {
    window.clearTimeout(this.labelTimer);
    window.clearTimeout(this.msgTimer);
    this.el.remove();
  }

  /** Tap a slot, or keep the finger down and slide across the bar to scrub. */
  private bindHotbarTouch(): void {
    let activePointer: number | null = null;
    const pick = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.slot');
      const idx = el ? Number(el.dataset.index) : -1;
      if (idx >= 0 && idx !== this.selected) this.onSelect(idx);
    };
    this.hotbar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activePointer = e.pointerId;
      pick(e);
    });
    this.hotbar.addEventListener('pointermove', (e) => {
      if (e.pointerId === activePointer) pick(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === activePointer) activePointer = null;
    };
    this.hotbar.addEventListener('pointerup', end);
    this.hotbar.addEventListener('pointercancel', end);
  }
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
