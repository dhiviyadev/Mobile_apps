/**
 * Player inventory (37 slots: 9 hotbar, 27 main, 1 off-hand), chest containers
 * (27 slots) and the validated operations both the server and the predicting
 * client apply (design-voxel-survival §6). Pure data: no events, no I/O.
 */
import { CONTAINER_BASE, CONTAINER_SLOTS, HOTBAR, MAIN_END, MAIN_START, OFFHAND, PLAYER_SLOTS } from './constants';
import { type ItemId, ItemKind, itemDef, maxStack } from './items';

export interface ItemStack {
  item: ItemId;
  count: number;
  /** Wear / crossbow load bits; 0 for stackables. */
  meta: number;
}

/** Fixed-size slot storage shared by inventories and containers. */
export class SlotStore {
  readonly items: Uint16Array;
  readonly counts: Uint8Array;
  readonly metas: Uint16Array;

  constructor(readonly size: number) {
    this.items = new Uint16Array(size);
    this.counts = new Uint8Array(size);
    this.metas = new Uint16Array(size);
  }

  get(slot: number): ItemStack | null {
    if (slot < 0 || slot >= this.size || this.counts[slot] === 0) return null;
    return { item: this.items[slot], count: this.counts[slot], meta: this.metas[slot] };
  }

  set(slot: number, s: ItemStack | null): void {
    if (slot < 0 || slot >= this.size) return;
    if (!s || s.count <= 0) {
      this.items[slot] = 0;
      this.counts[slot] = 0;
      this.metas[slot] = 0;
    } else {
      this.items[slot] = s.item;
      this.counts[slot] = Math.min(255, s.count);
      this.metas[slot] = s.meta;
    }
  }

  isEmptySlot(slot: number): boolean {
    return this.counts[slot] === 0;
  }

  copyFrom(o: SlotStore): void {
    this.items.set(o.items);
    this.counts.set(o.counts);
    this.metas.set(o.metas);
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.size; i++) if (this.counts[i]) return false;
    return true;
  }

  forEachSlot(fn: (slot: number, s: ItemStack) => void): void {
    for (let i = 0; i < this.size; i++) if (this.counts[i]) fn(i, { item: this.items[i], count: this.counts[i], meta: this.metas[i] });
  }

  clear(): void {
    this.items.fill(0);
    this.counts.fill(0);
    this.metas.fill(0);
  }

  /** Merges into matching stacks in `order`, then fills empty slots of `order`. Returns what did not fit. */
  addInto(order: readonly number[], item: ItemId, count: number, meta = 0): number {
    const cap = maxStack(item);
    if (cap > 1) {
      for (const i of order) {
        if (count <= 0) break;
        if (this.counts[i] && this.items[i] === item && this.metas[i] === meta && this.counts[i] < cap) {
          const n = Math.min(count, cap - this.counts[i]);
          this.counts[i] += n;
          count -= n;
        }
      }
    }
    for (const i of order) {
      if (count <= 0) break;
      if (!this.counts[i]) {
        const n = Math.min(count, cap);
        this.items[i] = item;
        this.counts[i] = n;
        this.metas[i] = meta;
        count -= n;
      }
    }
    return count;
  }
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
/** Hotbar, then main. */
export const BAG_ORDER: readonly number[] = range(0, MAIN_END);
const HOTBAR_ORDER = range(0, HOTBAR);
const MAIN_ORDER = range(MAIN_START, MAIN_END);
const CONTAINER_ORDER = range(0, CONTAINER_SLOTS);

export class Inventory extends SlotStore {
  constructor() {
    super(PLAYER_SLOTS);
  }

  clone(): Inventory {
    const c = new Inventory();
    c.copyFrom(this);
    return c;
  }

  /** Adds into existing stacks first (hotbar, main), then empty slots (hotbar, main). Returns what did not fit. */
  add(item: ItemId, count: number, meta = 0): number {
    return this.addInto(BAG_ORDER, item, count, meta);
  }

  /** How many fit (without changing anything). */
  room(item: ItemId, meta = 0): number {
    const cap = maxStack(item);
    let n = 0;
    for (let i = 0; i < MAIN_END; i++) {
      if (!this.counts[i]) n += cap;
      else if (cap > 1 && this.items[i] === item && this.metas[i] === meta) n += cap - this.counts[i];
    }
    return n;
  }

  /** Total count of an item in the hotbar, main and off-hand. */
  count(item: ItemId): number {
    let n = 0;
    for (let i = 0; i < PLAYER_SLOTS; i++) if (this.counts[i] && this.items[i] === item) n += this.counts[i];
    return n;
  }

  /** Removes n (hotbar, main, off-hand); returns how many were removed. */
  take(item: ItemId, n: number): number {
    let left = n;
    for (let i = 0; i < PLAYER_SLOTS && left > 0; i++) {
      if (!this.counts[i] || this.items[i] !== item) continue;
      const k = Math.min(left, this.counts[i]);
      this.counts[i] -= k;
      left -= k;
      if (!this.counts[i]) {
        this.items[i] = 0;
        this.metas[i] = 0;
      }
    }
    return n - left;
  }

  /** First slot (0..35) holding one of `items`, or -1. */
  findFirst(items: readonly ItemId[]): number {
    for (let i = 0; i < MAIN_END; i++) if (this.counts[i] && items.includes(this.items[i])) return i;
    return -1;
  }

  /** Removes one item from a slot; returns false if empty. */
  takeOne(slot: number): boolean {
    if (!this.counts[slot]) return false;
    this.counts[slot]--;
    if (!this.counts[slot]) {
      this.items[slot] = 0;
      this.metas[slot] = 0;
    }
    return true;
  }
}

export class Container extends SlotStore {
  /** Structure loot was rolled into it (structure chests only). */
  lootRolled = false;

  constructor() {
    super(CONTAINER_SLOTS);
  }

  clone(): Container {
    const c = new Container();
    c.copyFrom(this);
    c.lootRolled = this.lootRolled;
    return c;
  }

  add(item: ItemId, count: number, meta = 0): number {
    return this.addInto(CONTAINER_ORDER, item, count, meta);
  }
}

// ---- operations ---------------------------------------------------------------------------

/** Op codes on the wire (`i` message), in order. */
export const InvOpCode = { move: 1, quick: 2, split: 3, drop: 4, craft: 5, sort: 6, swapHands: 7 } as const;

export type InvOp =
  /** count 0 = whole stack; a whole stack onto a different item swaps. */
  | { op: 'move'; from: number; to: number; count: number }
  /** hotbar <-> main, off-hand -> main, or player <-> open container. */
  | { op: 'quick'; from: number }
  /** ceil(half) into an empty slot. */
  | { op: 'split'; from: number; to: number }
  /** count 0 = whole stack; the sim throws it. */
  | { op: 'drop'; from: number; count: number }
  /** 1..64 times. */
  | { op: 'craft'; recipe: number; times: number }
  /** Merge and sort the main section by (kind, id). */
  | { op: 'sort' }
  /** Selected hotbar slot <-> off-hand (shield or empty only). */
  | { op: 'swapHands' };

export interface InvEnv {
  /** Selected hotbar slot 0..8. */
  selected: number;
  /** The open container (null when none). */
  container: Container | null;
  /** StationFlags near the player. */
  stations: number;
  /** A sealed boss chest is open: no container ops. */
  sealedContainer: boolean;
  /** Crafting hook (recipes.ts); returns false when the craft is invalid. */
  craft?(inv: Inventory, recipe: number, times: number, stations: number, out: ItemStack[]): boolean;
}

const isShield = (item: ItemId): boolean => itemDef(item)?.kind === ItemKind.Shield;

/** Resolves a slot ref to its store and index (null when invalid in this env). */
function resolve(inv: Inventory, env: InvEnv, ref: number): [SlotStore, number] | null {
  if (ref >= 0 && ref < PLAYER_SLOTS) return [inv, ref];
  if (ref >= CONTAINER_BASE && ref < CONTAINER_BASE + CONTAINER_SLOTS && env.container && !env.sealedContainer) return [env.container, ref - CONTAINER_BASE];
  return null;
}

/** Off-hand only takes shields; everything else takes anything. */
const accepts = (ref: number, item: ItemId): boolean => ref !== OFFHAND || isShield(item);

/**
 * Validates and applies an operation. Returns false (and changes nothing) when
 * it is invalid. Thrown stacks and craft overflow land in out.thrown for the
 * sim to spawn as drops.
 */
export function applyInvOp(inv: Inventory, op: InvOp, env: InvEnv, out: { thrown: ItemStack[] }): boolean {
  switch (op.op) {
    case 'move': {
      if (op.from === op.to) return false;
      const a = resolve(inv, env, op.from);
      const b = resolve(inv, env, op.to);
      if (!a || !b) return false;
      const src = a[0].get(a[1]);
      if (!src) return false;
      const n = op.count === 0 ? src.count : op.count;
      if (n < 1 || n > src.count || !accepts(op.to, src.item)) return false;
      const dst = b[0].get(b[1]);
      if (!dst) {
        b[0].set(b[1], { ...src, count: n });
        a[0].set(a[1], src.count - n > 0 ? { ...src, count: src.count - n } : null);
        return true;
      }
      if (dst.item === src.item && dst.meta === src.meta && maxStack(src.item) > 1) {
        const k = Math.min(n, maxStack(src.item) - dst.count);
        if (k <= 0) return false;
        b[0].set(b[1], { ...dst, count: dst.count + k });
        a[0].set(a[1], src.count - k > 0 ? { ...src, count: src.count - k } : null);
        return true;
      }
      // Different items: only a whole stack swaps.
      if (n !== src.count || !accepts(op.from, dst.item)) return false;
      a[0].set(a[1], dst);
      b[0].set(b[1], src);
      return true;
    }
    case 'quick': {
      const a = resolve(inv, env, op.from);
      if (!a) return false;
      const src = a[0].get(a[1]);
      if (!src) return false;
      let left: number;
      if (op.from >= CONTAINER_BASE) left = inv.add(src.item, src.count, src.meta);
      else if (env.container && !env.sealedContainer) left = env.container.add(src.item, src.count, src.meta);
      else if (op.from < HOTBAR) left = inv.addInto(MAIN_ORDER, src.item, src.count, src.meta);
      else if (op.from === OFFHAND) left = inv.addInto(BAG_ORDER, src.item, src.count, src.meta);
      else if (isShield(src.item) && inv.isEmptySlot(OFFHAND)) left = inv.addInto([OFFHAND], src.item, src.count, src.meta);
      else left = inv.addInto(HOTBAR_ORDER, src.item, src.count, src.meta);
      if (left === src.count) return false;
      a[0].set(a[1], left > 0 ? { ...src, count: left } : null);
      return true;
    }
    case 'split': {
      const a = resolve(inv, env, op.from);
      const b = resolve(inv, env, op.to);
      if (!a || !b || op.from === op.to) return false;
      const src = a[0].get(a[1]);
      if (!src || src.count < 2 || !b[0].isEmptySlot(b[1]) || !accepts(op.to, src.item)) return false;
      const half = Math.ceil(src.count / 2);
      b[0].set(b[1], { ...src, count: half });
      a[0].set(a[1], { ...src, count: src.count - half });
      return true;
    }
    case 'drop': {
      const a = resolve(inv, env, op.from);
      if (!a) return false;
      const src = a[0].get(a[1]);
      if (!src) return false;
      const n = op.count === 0 ? src.count : op.count;
      if (n < 1 || n > src.count) return false;
      out.thrown.push({ ...src, count: n });
      a[0].set(a[1], src.count - n > 0 ? { ...src, count: src.count - n } : null);
      return true;
    }
    case 'craft': {
      if (!env.craft || !Number.isInteger(op.times) || op.times < 1 || op.times > 64) return false;
      return env.craft(inv, op.recipe, op.times, env.stations, out.thrown);
    }
    case 'sort': {
      const stacks: ItemStack[] = [];
      for (let i = MAIN_START; i < MAIN_END; i++) {
        const s = inv.get(i);
        if (s) stacks.push(s);
        inv.set(i, null);
      }
      stacks.sort((x, y) => (itemDef(x.item)?.kind ?? 0) - (itemDef(y.item)?.kind ?? 0) || x.item - y.item || x.meta - y.meta);
      for (const s of stacks) inv.addInto(MAIN_ORDER, s.item, s.count, s.meta);
      return true;
    }
    case 'swapHands': {
      const sel = env.selected;
      if (sel < 0 || sel >= HOTBAR) return false;
      const main = inv.get(sel);
      const off = inv.get(OFFHAND);
      if (main && !isShield(main.item)) return false;
      if (!main && !off) return false;
      inv.set(sel, off);
      inv.set(OFFHAND, main);
      return true;
    }
  }
  return false;
}
