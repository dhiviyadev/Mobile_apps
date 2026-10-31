/**
 * Item drops lying in the world: block drops, thrown items, mob loot and the
 * Lost Satchel (design-voxel-survival §10.8). Simple box physics, sleeping,
 * merging, despawn and pickup. The same code runs on the server and offline;
 * clients simulate between DropMove corrections with stepDrop().
 */
import { IS_LIQUID, isLava } from '../blocks';
import { collidesBox, type BlockQuery } from '../physics';
import { SURVIVAL } from './constants';
import type { ItemStack } from './inventory';
import { Item, type ItemId, maxStack } from './items';

export const DROP_HALF = 0.125;
export const DROP_HEIGHT = 0.25;
const GRAVITY = 20;
const AIR_DRAG = 2;
const MOVE_INTERVAL = 0.5;
const MERGE_INTERVAL = 0.5;

export interface SatchelData {
  /** Owner identity: hashed playerKey, else the player id. */
  owner: string;
  items: ItemStack[];
  /** Sim ms when it was dropped. */
  createdMs: number;
}

export interface ItemDrop {
  id: number;
  item: ItemId;
  count: number;
  meta: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since spawn. */
  age: number;
  /** Sim ms when pickup becomes possible. */
  pickupAt: number;
  /** Player id that threw it (blocked until pickupAt; others may take it after pickupDelay). */
  thrower: string | null;
  asleep: boolean;
  onGround: boolean;
  satchel?: SatchelData;
  moveTimer: number;
}

export type DropEvent =
  | { type: 'dropSpawn'; drop: ItemDrop }
  | { type: 'dropMove'; id: number; x: number; y: number; z: number }
  | { type: 'dropRemove'; id: number; picker: string | null };

/** One physics step for a drop (shared with the client renderer). Returns true when it touched lava. */
export function stepDrop(d: { x: number; y: number; z: number; vx: number; vy: number; vz: number; onGround: boolean }, get: BlockQuery, dt: number): boolean {
  const cell = get(Math.floor(d.x), Math.floor(d.y + 0.1), Math.floor(d.z));
  const lava = isLava(cell);
  if (IS_LIQUID[cell]) {
    d.vy += (1 - d.vy) * Math.min(1, dt * 4);
    d.vx *= Math.max(0, 1 - 3 * dt);
    d.vz *= Math.max(0, 1 - 3 * dt);
  } else {
    d.vy = Math.max(-30, d.vy - GRAVITY * dt);
    const k = Math.max(0, 1 - AIR_DRAG * dt);
    d.vx *= k;
    d.vz *= k;
  }
  let ny = d.y + d.vy * dt;
  d.onGround = false;
  if (collidesBox(get, d.x, ny, d.z, DROP_HALF, DROP_HEIGHT)) {
    if (d.vy < 0) {
      ny = Math.floor(ny) + 1;
      if (collidesBox(get, d.x, ny, d.z, DROP_HALF, DROP_HEIGHT)) ny = d.y;
      d.onGround = true;
    } else ny = d.y;
    d.vy = 0;
  }
  d.y = ny;
  const nx = d.x + d.vx * dt;
  if (collidesBox(get, nx, d.y, d.z, DROP_HALF, DROP_HEIGHT)) d.vx = 0;
  else d.x = nx;
  const nz = d.z + d.vz * dt;
  if (collidesBox(get, d.x, d.y, nz, DROP_HALF, DROP_HEIGHT)) d.vz = 0;
  else d.z = nz;
  if (!d.onGround && d.vy <= 0 && collidesBox(get, d.x, d.y - 0.02, d.z, DROP_HALF, DROP_HEIGHT)) d.onGround = true;
  if (d.onGround) {
    const f = Math.max(0, 1 - 8 * dt);
    d.vx *= f;
    d.vz *= f;
  }
  // Pushed out of a block that appeared around it.
  if (collidesBox(get, d.x, d.y, d.z, DROP_HALF, DROP_HEIGHT)) d.y = Math.floor(d.y) + 1;
  return lava;
}

export interface DropOptions {
  /** Online: satchels dissolve after satchelLifetime. Offline they never expire. */
  satchelsExpire: boolean;
}

export class DropSystem {
  readonly list = new Map<number, ItemDrop>();
  private nextId = 1;
  private mergeTimer = MERGE_INTERVAL;

  constructor(
    private readonly get: () => BlockQuery,
    private readonly now: () => number,
    private readonly emit: (e: DropEvent) => void,
    private readonly opts: DropOptions,
  ) {}

  private allocId(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.nextId;
      this.nextId = (this.nextId % 65535) + 1;
      if (!this.list.has(id)) return id;
    }
    return 0;
  }

  /** Spawns a drop; over the cap the oldest ordinary drop goes first. */
  spawn(item: ItemId, count: number, meta: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, thrower: string | null = null, pickupDelay: number = SURVIVAL.pickupDelay, satchel?: SatchelData): ItemDrop | null {
    if (count <= 0) return null;
    if (this.list.size >= SURVIVAL.maxDrops) {
      let oldest: ItemDrop | null = null;
      for (const d of this.list.values()) if (!d.satchel && (!oldest || d.age > oldest.age)) oldest = d;
      if (oldest) this.remove(oldest.id, null);
    }
    const id = this.allocId();
    if (!id) return null;
    const d: ItemDrop = { id, item, count: Math.min(count, 255), meta, x, y, z, vx, vy, vz, age: 0, pickupAt: this.now() + pickupDelay * 1000, thrower, asleep: false, onGround: false, moveTimer: MOVE_INTERVAL };
    if (satchel) d.satchel = satchel;
    this.list.set(id, d);
    this.emit({ type: 'dropSpawn', drop: d });
    return d;
  }

  /** A stack popping out of a broken block or a dead creature (centre of the cell, small upward burst). */
  burst(s: ItemStack, x: number, y: number, z: number, rng: () => number): void {
    let left = s.count;
    const cap = maxStack(s.item);
    while (left > 0) {
      const n = Math.min(left, cap, 255);
      left -= n;
      this.spawn(s.item, n, s.meta, x, y, z, (rng() - 0.5) * 2.4, 2.5 + rng(), (rng() - 0.5) * 2.4);
    }
  }

  spawnSatchel(owner: string, items: ItemStack[], x: number, y: number, z: number): ItemDrop | null {
    // At most 3 per owner: the oldest dissolves into ordinary drops.
    const mine = [...this.list.values()].filter((d) => d.satchel?.owner === owner).sort((a, b) => a.satchel!.createdMs - b.satchel!.createdMs);
    while (mine.length >= SURVIVAL.maxSatchelsPerPlayer) this.dissolve(mine.shift()!);
    return this.spawn(Item.Satchel, 1, 0, x, y, z, 0, 2, 0, null, 0, { owner, items, createdMs: this.now() });
  }

  remove(id: number, picker: string | null): void {
    if (this.list.delete(id)) this.emit({ type: 'dropRemove', id, picker });
  }

  private dissolve(d: ItemDrop): void {
    this.remove(d.id, null);
    for (const s of d.satchel?.items ?? []) this.spawn(s.item, s.count, s.meta, d.x, d.y + 0.2, d.z, (Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2);
  }

  /** Wakes drops near a changed cell (support removed, block placed into them). */
  wake(x: number, y: number, z: number): void {
    for (const d of this.list.values()) {
      if (Math.abs(d.x - (x + 0.5)) < 1.2 && Math.abs(d.z - (z + 0.5)) < 1.2 && d.y > y - 0.5 && d.y < y + 2.2) d.asleep = false;
    }
  }

  tick(dt: number): void {
    const get = this.get();
    const now = this.now();
    for (const d of [...this.list.values()]) {
      d.age += dt;
      if (d.satchel) {
        if (this.opts.satchelsExpire && now - d.satchel.createdMs > SURVIVAL.satchelLifetime * 1000) {
          this.dissolve(d);
          continue;
        }
      } else if (d.age > SURVIVAL.dropLifetime) {
        this.remove(d.id, null);
        continue;
      }
      if (d.asleep) continue;
      if (stepDrop(d, get, dt) && !d.satchel) {
        this.remove(d.id, null);
        continue;
      }
      if (d.y < -20) {
        if (d.satchel) d.y = 2;
        else this.remove(d.id, null);
        continue;
      }
      if (d.onGround && Math.hypot(d.vx, d.vy, d.vz) < 0.05) {
        d.asleep = true;
        d.vx = d.vy = d.vz = 0;
        this.emit({ type: 'dropMove', id: d.id, x: d.x, y: d.y, z: d.z });
      } else if ((d.moveTimer -= dt) <= 0) {
        d.moveTimer = MOVE_INTERVAL;
        this.emit({ type: 'dropMove', id: d.id, x: d.x, y: d.y, z: d.z });
      }
    }
    if ((this.mergeTimer -= dt) <= 0) {
      this.mergeTimer = MERGE_INTERVAL;
      this.merge();
    }
  }

  /** Asleep identical stacks within mergeRadius combine (up to maxStack). */
  private merge(): void {
    const asleep = [...this.list.values()].filter((d) => d.asleep && !d.satchel && maxStack(d.item) > 1);
    for (let i = 0; i < asleep.length; i++) {
      const a = asleep[i];
      if (!this.list.has(a.id)) continue;
      for (let j = i + 1; j < asleep.length; j++) {
        const b = asleep[j];
        if (!this.list.has(b.id) || b.item !== a.item || b.meta !== a.meta) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > SURVIVAL.mergeRadius) continue;
        const room = maxStack(a.item) - a.count;
        if (room <= 0) break;
        const n = Math.min(room, b.count);
        a.count += n;
        b.count -= n;
        a.age = Math.min(a.age, b.age);
        if (b.count <= 0) this.remove(b.id, null);
        else this.emit({ type: 'dropSpawn', drop: b });
        this.emit({ type: 'dropSpawn', drop: a });
      }
    }
  }

  /**
   * Offers nearby drops to a player. `give` adds a stack to the inventory and
   * returns how many it took. Satchels are owner-only for satchelOwnerOnly s.
   */
  collect(playerId: string, owner: string, x: number, y: number, z: number, give: (s: ItemStack) => number): void {
    const now = this.now();
    const r2 = SURVIVAL.pickupRadius * SURVIVAL.pickupRadius;
    for (const d of this.list.values()) {
      const dx = d.x - x;
      const dz = d.z - z;
      if (dx * dx + dz * dz > r2 || d.y < y - 0.6 || d.y > y + 1.8) continue;
      if (d.satchel) {
        if (d.satchel.owner !== owner && now - d.satchel.createdMs < SURVIVAL.satchelOwnerOnly * 1000) continue;
        const rest: ItemStack[] = [];
        for (const s of d.satchel.items) {
          const took = give(s);
          if (took < s.count) rest.push({ ...s, count: s.count - took });
        }
        if (rest.length === 0) this.remove(d.id, playerId);
        else if (rest.length !== d.satchel.items.length || rest.some((s, i) => s.count !== d.satchel!.items[i].count)) {
          d.satchel.items = rest;
          this.emit({ type: 'dropSpawn', drop: d });
        }
        continue;
      }
      if (now < d.pickupAt && (d.thrower === null || d.thrower === playerId)) continue;
      if (d.thrower === playerId && now < d.pickupAt) continue;
      const took = give({ item: d.item, count: d.count, meta: d.meta });
      if (took <= 0) continue;
      if (took >= d.count) this.remove(d.id, playerId);
      else {
        d.count -= took;
        this.emit({ type: 'dropSpawn', drop: d });
      }
    }
  }
}
