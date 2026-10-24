/**
 * DOM heads-up display for Voxelvale: crosshair, hotbar (tap or swipe across
 * it on touch, wheel / number keys on desktop), selected-block label, parkour
 * timer and checkpoint counter.
 */
import { h } from '../../../core/ui/dom';

const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const LONG_PRESS_MS = 450;

/** What one hotbar slot shows. Sandbox: 12 block/item ids; survival: 9 inventory stacks. */
export interface SlotView {
  /** Item id (block ids < 256), 0 = empty. */
  item: number;
  /** Name for the selection label. */
  name: string;
  /** Stack size (hidden when <= 1). */
  count?: number;
  /** Remaining durability 0..1 (bar hidden when undefined or 1). */
  wear?: number;
  /** Loaded crossbow dot. */
  loaded?: boolean;
}

/** Draws an item icon (WP0: ui/itemIcons.ts). */
export type IconFor = (item: number, size: number) => HTMLCanvasElement;

export class VoxelHud {
  readonly el: HTMLElement;
  private readonly hotbar: HTMLElement;
  private slots: HTMLElement[] = [];
  private views: SlotView[] = [];
  private readonly offhandSlot: HTMLElement;
  private readonly placeBanner: HTMLElement;
  private placeTimer = 0;
  /** Long-press on a hotbar slot (sandbox: picker for that slot; survival: drop/off-hand popover). */
  onLongPress: ((index: number) => void) | null = null;
  private readonly blockLabel: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly cpEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly roomBestEl: HTMLElement;
  private readonly centerMsg: HTMLElement;
  private readonly underwater: HTMLElement;
  private labelTimer = 0;
  private msgTimer = 0;
  selected = 0;

  constructor(
    parent: HTMLElement,
    private readonly iconFor: IconFor,
    private readonly onSelect: (index: number) => void,
    parkour: boolean,
  ) {
    this.hotbar = h('div', { class: 'hotbar', 'data-testid': 'hotbar' });
    this.offhandSlot = h('div', { class: 'offhand-slot empty', 'data-testid': 'offhand-slot', hidden: true });
    this.hotbar.appendChild(this.offhandSlot);
    this.bindHotbarTouch();
    this.placeBanner = h('div', { class: 'place-banner', 'data-testid': 'place-banner' });

    this.blockLabel = h('div', { class: 'block-label' });
    this.timerEl = h('div', { class: 'pk-timer', 'data-testid': 'parkour-timer' }, '00:00.00');
    this.cpEl = h('div', { class: 'pk-cp' }, '');
    this.bestEl = h('div', { class: 'pk-best' }, '');
    this.roomBestEl = h('div', { class: 'pk-best' }, '');
    this.centerMsg = h('div', { class: 'center-msg' });
    this.underwater = h('div', { class: 'underwater-tint' });

    this.el = h('div', { class: 'voxel-hud' },
      this.underwater,
      h('div', { class: 'crosshair' }),
      parkour ? h('div', { class: 'pk-panel' }, this.timerEl, this.cpEl, this.bestEl, this.roomBestEl) : null,
      this.centerMsg,
      this.placeBanner,
      this.blockLabel,
      parkour ? null : this.hotbar,
    );
    parent.appendChild(this.el);
  }

  /** Mount point for package overlays (vitals, boss bar, target label...). */
  get root(): HTMLElement {
    return this.el;
  }

  /** The current slot contents. */
  get slotViews(): readonly SlotView[] {
    return this.views;
  }

  /** Sets the hotbar contents; rebuilds the DOM when the slot count changes, else patches changed slots. */
  setSlots(views: readonly SlotView[]): void {
    if (views.length !== this.slots.length) {
      for (const el of this.slots) el.remove();
      this.slots = views.map((_, i) => h('div', { class: 'slot', dataset: { index: String(i) } }));
      this.views = [];
      for (const el of this.slots) this.hotbar.appendChild(el);
    }
    views.forEach((v, i) => {
      const old = this.views[i];
      if (old && old.item === v.item && old.count === v.count && old.wear === v.wear && old.loaded === v.loaded) return;
      this.renderSlot(this.slots[i], v, SLOT_KEYS[i] ?? '');
    });
    this.views = views.map((v) => ({ ...v }));
    if (this.selected >= views.length) this.selected = 0;
    this.slots.forEach((s, i) => s.classList.toggle('active', i === this.selected));
  }

  /** Off-hand slot left of the hotbar (survival); undefined hides it. */
  setOffhand(view: SlotView | null | undefined): void {
    this.offhandSlot.hidden = view === undefined;
    if (view !== undefined) this.renderSlot(this.offhandSlot, view ?? { item: 0, name: '' }, '');
  }

  /** Banner at the top centre: biome and ruin names, boss awakening. */
  showPlace(title: string, subtitle?: string, ms = 2800): void {
    this.placeBanner.replaceChildren(h('div', { class: 'pb-title' }, title), ...(subtitle ? [h('div', { class: 'pb-sub' }, subtitle)] : []));
    this.placeBanner.classList.add('show');
    window.clearTimeout(this.placeTimer);
    this.placeTimer = window.setTimeout(() => this.placeBanner.classList.remove('show'), ms);
  }

  private renderSlot(el: HTMLElement, v: SlotView, key: string): void {
    const icon = v.item ? this.iconFor(v.item, 64) : h('div');
    icon.classList.add('slot-icon');
    const dur = v.wear !== undefined && v.wear < 1
      ? h('div', { class: 'slot-dur' }, h('i', { style: `width:${Math.round(v.wear * 100)}%;background:hsl(${Math.round(120 * v.wear)},70%,50%)` }))
      : null;
    const parts: Node[] = [icon];
    if (key) parts.push(h('span', { class: 'slot-key' }, key));
    if (v.count && v.count > 1) parts.push(h('span', { class: 'slot-count' }, String(v.count)));
    if (dur) parts.push(dur);
    if (v.loaded) parts.push(h('span', { class: 'slot-loaded' }));
    el.replaceChildren(...parts);
    el.classList.toggle('empty', !v.item);
  }

  select(index: number, announce = true): void {
    const n = Math.max(1, this.slots.length);
    this.selected = ((index % n) + n) % n;
    this.slots.forEach((s, i) => s.classList.toggle('active', i === this.selected));
    if (announce) {
      this.blockLabel.textContent = this.views[this.selected]?.name ?? '';
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

  setRoomBest(text: string): void {
    if (this.roomBestEl.textContent !== text) this.roomBestEl.textContent = text;
  }

  /** Nothing to toggle yet in Voxelvale (Tab is the arena scoreboard). */
  toggleHelp(): void {}

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
    window.clearTimeout(this.placeTimer);
    this.el.remove();
  }

  /** Tap a slot, or keep the finger down and slide across the bar to scrub. */
  private bindHotbarTouch(): void {
    let activePointer: number | null = null;
    let pressIndex = -1;
    let pressTimer = 0;
    const slotAt = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.slot');
      return el?.dataset.index !== undefined ? Number(el.dataset.index) : -1;
    };
    const pick = (e: PointerEvent) => {
      const idx = slotAt(e);
      if (idx !== pressIndex) window.clearTimeout(pressTimer); // scrubbing cancels a long-press
      if (idx >= 0 && idx !== this.selected) this.onSelect(idx);
    };
    this.hotbar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activePointer = e.pointerId;
      pressIndex = slotAt(e);
      window.clearTimeout(pressTimer);
      if (pressIndex >= 0) pressTimer = window.setTimeout(() => this.onLongPress?.(pressIndex), LONG_PRESS_MS);
      pick(e);
    });
    this.hotbar.addEventListener('pointermove', (e) => {
      if (e.pointerId === activePointer) pick(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === activePointer) activePointer = null;
      window.clearTimeout(pressTimer);
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
