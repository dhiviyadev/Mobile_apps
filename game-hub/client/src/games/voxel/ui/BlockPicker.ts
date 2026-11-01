/**
 * Creative Block Picker (sandbox): every placeable block in tabs, a search box,
 * a "Pick" eyedropper for the block under the crosshair and a mini hotbar to
 * choose the slot being filled. Tapping a block assigns it and keeps the picker
 * open. Opens with B, the "Blocks" touch button or a long-press on a slot;
 * closes with B, Esc, × or a tap outside the panel.
 */
import { BLOCK_CATEGORY, type BlockCategory, blockDef, CREATIVE_BLOCKS, FIRST_ITEM, itemName } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import { h, svg } from '../../../core/ui/dom';
import { GAME_ICONS } from '../../../core/ui/icons';
import type { IconFor } from './VoxelHud';

/** A tab the picker shows (WP-B registers 'Items'). */
export interface PickerTab {
  id: string;
  label: string;
  items(): readonly number[];
}

const CATEGORY_TABS: { id: string; label: string; cats: BlockCategory[] }[] = [
  { id: 'natural', label: 'Natural', cats: ['natural', 'ore'] },
  { id: 'wood', label: 'Wood', cats: ['wood'] },
  { id: 'plant', label: 'Plants', cats: ['plant'] },
  { id: 'building', label: 'Building', cats: ['building'] },
  { id: 'colour', label: 'Colours', cats: ['colour'] },
  { id: 'light', label: 'Lights & Utility', cats: ['light', 'utility'] },
];

export interface BlockPickerOptions {
  iconFor: IconFor;
  /** Current hotbar contents (12 item ids). */
  slots(): readonly number[];
  assign(slot: number, item: number): void;
  reset(): void;
  /** Block under the crosshair (for "Pick"), or null. */
  targetBlock(): number | null;
  extraTabs(): readonly PickerTab[];
  onClose(): void;
}

const nameOf = (item: number) => (item < FIRST_ITEM ? blockDef(item).name : itemName(item));

export class BlockPicker {
  private el: HTMLElement | null = null;
  private slot = 0;
  private tab = 'all';
  private filter = '';
  private grid: HTMLElement | null = null;
  private mini: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly o: BlockPickerOptions,
  ) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(slot: number): void {
    this.slot = Math.max(0, Math.min(this.o.slots().length - 1, slot));
    if (this.el) {
      this.renderMini();
      return;
    }
    const search = h('input', {
      class: 'bp-search',
      type: 'search',
      placeholder: 'Search blocks',
      'aria-label': 'Search blocks',
      oninput: (e: Event) => {
        this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
        this.renderGrid();
      },
    });
    this.tabsEl = h('div', { class: 'bp-tabs', role: 'tablist' });
    this.grid = h('div', { class: 'bp-grid' });
    this.mini = h('div', { class: 'bp-mini-hotbar' });
    const panel = h('div', { class: 'bp-panel' },
      h('div', { class: 'bp-head' },
        h('h2', null, 'Blocks'),
        search,
        h('button', { class: 'bp-pick', title: 'Pick the block you are looking at', onclick: () => this.pick() }, svg(GAME_ICONS.eyedropper), 'Pick'),
        h('button', { class: 'bp-close', 'aria-label': 'Close', onclick: () => this.close() }, '×'),
      ),
      this.tabsEl,
      this.grid,
      h('div', { class: 'bp-foot' }, this.mini, h('button', { class: 'bp-reset', onclick: () => { this.o.reset(); this.renderMini(); } }, 'Reset hotbar')),
    );
    this.el = h('div', {
      class: 'block-picker',
      'data-testid': 'block-picker',
      role: 'dialog',
      'aria-label': 'Blocks',
      onpointerdown: (e: Event) => {
        if (e.target === this.el) this.close();
      },
    }, panel);
    // Keep game keys (and pointer-lock clicks) away from the game while open.
    this.el.addEventListener('keydown', this.onKey);
    window.addEventListener('keydown', this.onKey, true);
    this.parent.appendChild(this.el);
    this.renderTabs();
    this.renderGrid();
    this.renderMini();
  }

  close(): void {
    if (!this.el) return;
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.el = this.grid = this.mini = this.tabsEl = null;
    this.o.onClose();
  }

  dispose(): void {
    this.close();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.el) return;
    const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
    if (e.code === 'Escape' || (e.code === 'KeyB' && !typing)) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  private items(): number[] {
    const extra = this.o.extraTabs().find((t) => t.id === this.tab);
    let list: readonly number[];
    if (extra) list = extra.items();
    else if (this.tab === 'all') list = [...CREATIVE_BLOCKS, ...this.o.extraTabs().flatMap((t) => t.items())];
    else {
      const cats = CATEGORY_TABS.find((t) => t.id === this.tab)?.cats ?? [];
      list = CREATIVE_BLOCKS.filter((b) => cats.includes(BLOCK_CATEGORY[b]));
    }
    return this.filter ? list.filter((i) => nameOf(i).toLowerCase().includes(this.filter)) : [...list];
  }

  private renderTabs(): void {
    const tabs = [{ id: 'all', label: 'All' }, ...CATEGORY_TABS, ...this.o.extraTabs()];
    this.tabsEl!.replaceChildren(
      ...tabs.map((t) =>
        h('button', {
          class: 'bp-tab',
          role: 'tab',
          'aria-selected': String(t.id === this.tab),
          onclick: () => {
            this.tab = t.id;
            this.renderTabs();
            this.renderGrid();
          },
        }, t.label),
      ),
    );
  }

  private renderGrid(): void {
    if (!this.grid) return;
    const items = this.items();
    this.grid.replaceChildren(
      ...items.map((item) => {
        const icon = this.o.iconFor(item, 48);
        icon.classList.add('bp-icon');
        return h('button', {
          class: 'bp-cell',
          'data-testid': `bp-cell-${item}`,
          title: nameOf(item),
          'aria-label': nameOf(item),
          onclick: () => this.assign(item),
        }, icon);
      }),
      ...(items.length ? [] : [h('p', { class: 'bp-empty' }, 'No blocks match.')]),
    );
  }

  private renderMini(): void {
    if (!this.mini) return;
    this.mini.replaceChildren(
      ...this.o.slots().map((item, i) =>
        h('button', {
          class: `bp-slot${i === this.slot ? ' target' : ''}`,
          'aria-label': `Slot ${i + 1}: ${item ? nameOf(item) : 'empty'}`,
          onclick: () => {
            this.slot = i;
            this.renderMini();
          },
        }, item ? this.o.iconFor(item, 32) : null),
      ),
    );
  }

  private assign(item: number): void {
    this.o.assign(this.slot, item);
    audio.play('click');
    this.renderMini();
    const el = this.mini?.children[this.slot];
    el?.classList.remove('flash');
    void (el as HTMLElement | undefined)?.offsetWidth;
    el?.classList.add('flash');
  }

  private pick(): void {
    const b = this.o.targetBlock();
    if (b !== null) this.assign(b);
  }
}
