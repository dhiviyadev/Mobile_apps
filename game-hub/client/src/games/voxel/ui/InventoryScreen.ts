/**
 * The bag (design-voxel-survival §16.2): inventory grid with hotbar and
 * off-hand, a searchable crafting list with station chips, and the chest
 * panel. Touch-first: tap to lift and tap to place, long-press for half,
 * double-tap to quick-move (invSelection.ts); desktop adds shift-click
 * (quick) and right-click (half).
 */
import {
  canUseStation,
  CONTAINER_BASE,
  type Ingredient,
  type InvOp,
  type Inventory,
  itemDef,
  ItemKind,
  itemName,
  maxCraftable,
  OFFHAND,
  type Recipe,
  type RecipeCategory,
  RECIPES,
  type SlotStore,
  Station,
  StationFlags,
  TAG_LABELS,
  TAGS,
  wearOf,
} from '@hub/shared';
import { h } from '../../../core/ui/dom';
import { IDLE, reduceSelection, type SelAction, type SelState } from './invSelection';

export interface InventoryScreenHost {
  iconFor(item: number, size: number): HTMLCanvasElement;
  /** Current view of the bag and the open chest. */
  inventory(): Inventory;
  container(): SlotStore | null;
  /** StationFlags near the player. */
  stations(): number;
  op(op: InvOp): void;
  onClose(): void;
  sound(name: 'click' | 'craft'): void;
}

const CATS: [RecipeCategory | 'all', string][] = [['all', 'All'], ['tools', 'Tools'], ['weapons', 'Weapons'], ['blocks', 'Blocks'], ['food', 'Food'], ['materials', 'Materials']];
const LONG_PRESS = 450;
const DOUBLE_TAP = 300;

export class InventoryScreen {
  private el: HTMLElement | null = null;
  private sel: SelState = IDLE;
  private slots = new Map<number, HTMLElement>();
  private sideBody: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private footer: HTMLElement | null = null;
  private search = '';
  private cat: RecipeCategory | 'all' = 'all';
  private canMake = true;
  private stationFilter: Station | null = null;
  private chest: { title: string; sealed: boolean } | null = null;
  private lastTap = { ref: -1, at: 0 };
  private stationTimer = 0;
  private stations = 0;

  constructor(private readonly parent: HTMLElement, private readonly host: InventoryScreenHost) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Opens the bag; `chest` shows the chest panel instead of crafting; `station` filters the list. */
  open(opts: { chest?: { title: string; sealed: boolean } | null; station?: Station | null } = {}): void {
    this.chest = opts.chest ?? null;
    this.stationFilter = opts.station ?? null;
    if (this.stationFilter !== null) this.canMake = false;
    this.sel = IDLE;
    if (!this.el) this.build();
    this.renderSide();
    this.refresh();
    window.clearInterval(this.stationTimer);
    this.stationTimer = window.setInterval(() => {
      const s = this.host.stations();
      if (s !== this.stations && !this.chest) {
        this.stations = s;
        this.renderSide();
      }
    }, 500);
  }

  setChest(chest: { title: string; sealed: boolean } | null): void {
    this.chest = chest;
    if (this.el) this.renderSide();
  }

  close(): void {
    if (!this.el) return;
    window.clearInterval(this.stationTimer);
    this.el.remove();
    this.el = null;
    this.slots.clear();
    this.host.onClose();
  }

  private build(): void {
    const slot = (ref: number) => {
      const el = h('div', { class: `inv-slot${ref === OFFHAND ? ' offhand' : ''}`, 'data-testid': `inv-slot-${ref}`, dataset: { ref: String(ref) } });
      this.bindSlot(el, ref);
      this.slots.set(ref, el);
      return el;
    };
    const main = h('div', { class: 'inv-grid' }, Array.from({ length: 27 }, (_, i) => slot(9 + i)));
    const hot = h('div', { class: 'inv-grid hotbar-row' }, Array.from({ length: 9 }, (_, i) => slot(i)));
    const off = h('div', { class: 'inv-offhand' }, slot(OFFHAND), h('span', null, 'Off hand'));
    const btn = (label: string, fn: () => void, testid?: string) => h('button', { class: 'btn btn-sm', 'data-testid': testid, onclick: fn }, label);
    this.footer = h('div', { class: 'inv-footer' },
      btn('Drop', () => this.dispatch({ type: 'drop', one: false }), 'inv-drop'),
      btn('Drop 1', () => this.dispatch({ type: 'drop', one: true }), 'inv-drop1'),
      btn('Sort', () => this.host.op({ op: 'sort' })),
      btn('Swap hands', () => this.host.op({ op: 'swapHands' })),
    );
    this.hintEl = h('div', { class: 'inv-hint' });
    this.sideBody = h('section', { class: 'inv-panel side' });
    const bag = h('section', { class: 'inv-panel bag' },
      h('header', null, h('h3', null, 'Bag'), h('button', { class: 'inv-close', 'aria-label': 'Close', onclick: () => this.close() }, '×')),
      main, h('div', { class: 'inv-divider' }), h('div', { class: 'inv-hotbar-line' }, hot, off), this.hintEl, this.footer,
    );
    this.el = h('div', { class: 'inv-screen', 'data-testid': 'inventory', role: 'dialog', 'aria-label': 'Inventory' },
      h('div', { class: 'inv-backdrop', onclick: () => this.close() }),
      h('div', { class: 'inv-panels' }, bag, this.sideBody),
    );
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.parent.appendChild(this.el);
    this.stations = this.host.stations();
  }

  private bindSlot(el: HTMLElement, ref: number): void {
    let timer = 0;
    let long = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      long = false;
      window.clearTimeout(timer);
      if (e.button === 2) {
        long = true;
        this.dispatch({ type: 'longPress', ref, count: this.countAt(ref) });
        return;
      }
      timer = window.setTimeout(() => {
        long = true;
        this.dispatch({ type: 'longPress', ref, count: this.countAt(ref) });
      }, LONG_PRESS);
    });
    el.addEventListener('pointerleave', () => window.clearTimeout(timer));
    el.addEventListener('pointerup', (e) => {
      window.clearTimeout(timer);
      if (long) return;
      const count = this.countAt(ref);
      if (e.shiftKey) {
        this.dispatch({ type: 'doubleTap', ref, count });
        return;
      }
      const now = performance.now();
      const double = this.lastTap.ref === ref && now - this.lastTap.at < DOUBLE_TAP && this.sel.kind === 'lifted' && this.sel.ref === ref;
      this.lastTap = { ref, at: now };
      this.dispatch(double ? { type: 'doubleTap', ref, count } : { type: 'tap', ref, count });
    });
  }

  private countAt(ref: number): number {
    if (ref >= CONTAINER_BASE) return this.host.container()?.counts[ref - CONTAINER_BASE] ?? 0;
    return this.host.inventory().counts[ref];
  }

  private dispatch(a: SelAction): void {
    const { state, op } = reduceSelection(this.sel, a);
    this.sel = state;
    if (op) this.host.op(op);
    else this.host.sound('click');
    this.refresh();
  }

  /** Redraws slots and the side panel counts (call when the model changes). */
  refresh(): void {
    if (!this.el) return;
    const inv = this.host.inventory();
    const box = this.host.container();
    for (const [ref, el] of this.slots) {
      const store: SlotStore | null = ref >= CONTAINER_BASE ? box : inv;
      const i = ref >= CONTAINER_BASE ? ref - CONTAINER_BASE : ref;
      const s = store?.get(i) ?? null;
      const key = s ? `${s.item}:${s.count}:${s.meta}` : '';
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        const parts: Node[] = [];
        if (s) {
          parts.push(this.host.iconFor(s.item, 40));
          if (s.count > 1) parts.push(h('span', { class: 'slot-count' }, String(s.count)));
          const dur = itemDef(s.item)?.durability ?? 0;
          if (dur && wearOf(s.meta) > 0) {
            const f = 1 - wearOf(s.meta) / dur;
            parts.push(h('div', { class: 'slot-dur' }, h('i', { style: `width:${Math.round(f * 100)}%;background:hsl(${Math.round(120 * f)},70%,50%)` })));
          }
          if ((s.meta >> 12) & 3) parts.push(h('span', { class: 'slot-loaded' }));
          el.title = itemName(s.item);
        } else el.title = ref === OFFHAND ? 'Off hand (shields)' : '';
        el.replaceChildren(...parts);
        el.classList.toggle('empty', !s);
      }
      el.classList.toggle('lifted', this.sel.kind === 'lifted' && this.sel.ref === ref);
    }
    if (this.hintEl) {
      const lifted = this.sel.kind === 'lifted' ? this.sel : null;
      this.hintEl.textContent = lifted
        ? `${lifted.count ? `Half of ` : ''}${itemName(this.itemAt(lifted.ref))}: tap a slot to place it, or Drop`
        : 'Tap an item to pick it up · hold for half · double-tap to quick-move';
    }
    this.footer?.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
      if (i < 2) b.disabled = this.sel.kind !== 'lifted';
    });
    if (!this.chest) this.updateRecipeCounts();
  }

  private itemAt(ref: number): number {
    if (ref >= CONTAINER_BASE) return this.host.container()?.items[ref - CONTAINER_BASE] ?? 0;
    return this.host.inventory().items[ref];
  }

  // ---- side panel: crafting or chest ----

  private renderSide(): void {
    const side = this.sideBody;
    if (!side) return;
    for (const ref of [...this.slots.keys()]) if (ref >= CONTAINER_BASE) this.slots.delete(ref);
    if (this.chest) {
      const c = this.chest;
      const content = c.sealed
        ? h('p', { class: 'chest-sealed' }, "Sealed by the altar's power. Defeat the guardian to open it.")
        : h('div', { class: 'inv-grid chest' }, Array.from({ length: 27 }, (_, i) => {
            const ref = CONTAINER_BASE + i;
            const el = h('div', { class: 'inv-slot', 'data-testid': `inv-slot-${ref}`, dataset: { ref: String(ref) } });
            this.bindSlot(el, ref);
            this.slots.set(ref, el);
            return el;
          }));
      side.replaceChildren(
        h('header', null, h('h3', null, c.title)),
        content,
        ...(c.sealed ? [] : [h('div', { class: 'inv-footer' }, h('button', { class: 'btn btn-sm', 'data-testid': 'take-all', onclick: () => this.takeAll() }, 'Take all'))]),
      );
      this.refresh();
      return;
    }
    const st = this.host.stations();
    this.stations = st;
    const search = h('input', { class: 'recipe-search', type: 'search', placeholder: 'Search recipes', value: this.search, 'data-testid': 'recipe-search' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.search = search.value;
      this.renderList();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const chip = (label: string, on: boolean, fn: () => void, cls = '') => h('button', { class: `chip ${on ? 'on' : ''} ${cls}`, onclick: fn }, label);
    const stationChip = (label: string, ok: boolean, station: Station) =>
      chip(`${label} ${ok ? '✓' : '✗'}`, this.stationFilter === station, () => {
        this.stationFilter = this.stationFilter === station ? null : station;
        this.renderSide();
      }, ok ? 'ok' : 'missing');
    side.replaceChildren(
      h('header', null, h('h3', null, 'Crafting'), search),
      h('div', { class: 'chips' }, CATS.map(([id, label]) => chip(label, this.cat === id, () => {
        this.cat = id;
        this.renderSide();
      }))),
      h('div', { class: 'chips stations' },
        stationChip('Hand', true, Station.Hand),
        stationChip('Workbench', (st & StationFlags.Workbench) !== 0, Station.Workbench),
        stationChip('Furnace', (st & StationFlags.Furnace) !== 0, Station.Furnace),
        chip('Can make', this.canMake, () => {
          this.canMake = !this.canMake;
          this.renderSide();
        }, 'can-make'),
      ),
      h('div', { class: 'recipe-list', 'data-testid': 'recipe-list' }),
    );
    this.renderList();
  }

  private renderList(): void {
    const list = this.sideBody?.querySelector('.recipe-list');
    if (!list) return;
    const inv = this.host.inventory();
    const st = this.stations;
    const q = this.search.trim().toLowerCase();
    const rows = RECIPES.filter((r) => (this.cat === 'all' || r.category === this.cat) && (this.stationFilter === null || r.station === this.stationFilter) && (!q || itemName(r.output).toLowerCase().includes(q)))
      .map((r) => ({ r, n: maxCraftable(inv, r), ok: canUseStation(r, st) }))
      .filter((x) => !this.canMake || (x.n > 0 && x.ok))
      .sort((a, b) => Number(b.n > 0 && b.ok) - Number(a.n > 0 && a.ok) || a.r.id - b.r.id);
    list.replaceChildren(
      ...rows.map(({ r }) => this.recipeRow(r)),
      ...(rows.length ? [] : [h('p', { class: 'muted recipe-empty' }, this.canMake ? 'Nothing to make yet. Turn off "Can make" to see every recipe.' : 'No recipes match.')]),
    );
    this.updateRecipeCounts();
  }

  private recipeRow(r: Recipe): HTMLElement {
    const ing = (i: Ingredient) => {
      const item = 'item' in i ? i.item : TAGS[i.tag][0];
      return h('span', { class: 'ing', dataset: { need: String(i.n), tag: 'tag' in i ? i.tag : '', item: String('item' in i ? i.item : '') } },
        this.host.iconFor(item, 22), h('span', { class: 'ing-count' }), 'tag' in i ? h('span', { class: 'ing-tag' }, TAG_LABELS[i.tag]) : null);
    };
    const craft = (times: number | 'max') => () => {
      const n = times === 'max' ? Math.max(1, maxCraftable(this.host.inventory(), r)) : times;
      this.host.op({ op: 'craft', recipe: r.id, times: Math.min(64, n) });
      this.host.sound('craft');
    };
    const def = itemDef(r.output);
    return h('div', { class: 'recipe-row', 'data-testid': `recipe-${r.id}`, dataset: { id: String(r.id) } },
      h('div', { class: 'recipe-out' }, this.host.iconFor(r.output, 36), h('div', null, h('b', null, itemName(r.output)), r.count > 1 ? h('span', { class: 'muted' }, ` ×${r.count}`) : null,
        h('div', { class: 'recipe-station muted' }, r.station === Station.Hand ? '' : r.station === Station.Workbench ? 'Workbench' : 'Furnace'),
        def?.kind === ItemKind.Sword || def?.melee ? h('div', { class: 'recipe-stat muted' }, `${def.melee!.damage} damage`) : null)),
      h('div', { class: 'recipe-ings' }, r.inputs.map(ing)),
      h('div', { class: 'recipe-btns' },
        h('button', { class: 'btn btn-sm btn-primary craft-1', 'data-testid': `craft-${r.id}`, onclick: craft(1) }, 'Craft'),
        h('button', { class: 'btn btn-sm craft-max', onclick: craft('max') }, 'Max')),
    );
  }

  /** Updates have/need chips and button states without rebuilding rows. */
  private updateRecipeCounts(): void {
    const list = this.sideBody?.querySelector('.recipe-list');
    if (!list) return;
    const inv = this.host.inventory();
    const st = this.stations;
    list.querySelectorAll<HTMLElement>('.recipe-row').forEach((row) => {
      const r = RECIPES.find((x) => x.id === Number(row.dataset.id))!;
      const n = maxCraftable(inv, r);
      const ok = canUseStation(r, st);
      row.querySelectorAll<HTMLElement>('.ing').forEach((el) => {
        const need = Number(el.dataset.need);
        const tag = el.dataset.tag as keyof typeof TAGS | '';
        const have = tag ? TAGS[tag].reduce((s, m) => s + inv.count(m), 0) : inv.count(Number(el.dataset.item));
        el.querySelector('.ing-count')!.textContent = `${Math.min(have, 999)}/${need}`;
        el.classList.toggle('short', have < need);
      });
      row.classList.toggle('blocked', !ok);
      row.title = ok ? '' : `Needs a ${r.station === Station.Workbench ? 'Workbench' : 'Furnace'} nearby`;
      row.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = n < 1 || !ok));
    });
  }

  private takeAll(): void {
    const box = this.host.container();
    if (!box) return;
    for (let i = 0; i < 27; i++) if (box.counts[i]) this.host.op({ op: 'quick', from: CONTAINER_BASE + i });
  }
}
