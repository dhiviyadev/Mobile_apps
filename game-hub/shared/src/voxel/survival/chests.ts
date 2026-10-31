/**
 * Chest contents (design-voxel-survival §9). Containers are created lazily on
 * first open; structure chests roll their loot table once, into deterministic
 * slots, so offline and online give the same chest.
 */
import { packPos } from '../chunk';
import { rollLoot } from '../loot';
import type { StructureChest } from '../structures/types';
import { mulberry32 } from '../../util/rng';
import { CONTAINER_SLOTS } from './constants';
import { Container, type ItemStack } from './inventory';
import { itemFromKey, maxStack } from './items';

/** Loot of a structure chest placed into a fresh container (unknown keys skipped). */
export function fillLoot(c: Container, chest: Pick<StructureChest, 'loot' | 'lootSeed'>): void {
  const stacks: ItemStack[] = [];
  for (const { item: key, count } of rollLoot(chest.loot, chest.lootSeed)) {
    const item = itemFromKey(key);
    if (item === null) continue;
    let left = count;
    while (left > 0) {
      const n = Math.min(left, maxStack(item));
      stacks.push({ item, count: n, meta: 0 });
      left -= n;
    }
  }
  // Fisher-Yates over the 27 slots, take the first n.
  const rnd = mulberry32(chest.lootSeed ^ 0x51075);
  const slots = Array.from({ length: CONTAINER_SLOTS }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  stacks.slice(0, CONTAINER_SLOTS).forEach((s, i) => c.set(slots[i], s));
  c.lootRolled = true;
}

export class ContainerStore {
  readonly containers = new Map<number, Container>();
  /** Structure chest cells whose loot was already rolled (a re-placed chest there is empty). */
  readonly claimed = new Set<number>();

  get(x: number, y: number, z: number): Container | null {
    return this.containers.get(packPos(x, y, z)) ?? null;
  }

  /** The container at a chest cell, created (and loot-filled for unclaimed structure chests) on first use. */
  open(x: number, y: number, z: number, structure: StructureChest | null): Container {
    const key = packPos(x, y, z);
    let c = this.containers.get(key);
    if (!c) {
      c = new Container();
      if (structure && !this.claimed.has(key)) {
        fillLoot(c, structure);
        this.claimed.add(key);
      }
      this.containers.set(key, c);
    }
    return c;
  }

  /** Chest broken: returns its contents and forgets it. */
  remove(x: number, y: number, z: number): ItemStack[] {
    const key = packPos(x, y, z);
    const c = this.containers.get(key);
    if (!c) return [];
    this.containers.delete(key);
    const out: ItemStack[] = [];
    c.forEachSlot((_, s) => out.push(s));
    return out;
  }

  get size(): number {
    return this.containers.size + this.claimed.size;
  }
}
