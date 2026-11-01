/**
 * Client view of the inventory (design-voxel-survival §6.3, §15.3): the last
 * server state (`auth`) plus our not yet acknowledged operations, replayed
 * with the same shared applyInvOp, so taps feel instant online and server
 * corrections win within one round trip. Offline acks arrive right away.
 */
import { applyInvOp, CONTAINER_BASE, Container, type InvEnv, type InvOp, Inventory, type InvSyncData, PLAYER_SLOTS } from '@hub/shared';

/** u16 sequence comparison (a <= b, with wrap-around). */
const seqLe = (a: number, b: number) => ((b - a) & 0xffff) < 0x8000;

export class InventoryModel {
  readonly auth = new Inventory();
  readonly authContainer = new Container();
  view = new Inventory();
  viewContainer = new Container();
  readonly pending: { seq: number; op: InvOp; env: InvEnv }[] = [];
  /** Blocks placed but not yet confirmed (online): slot -> count, expiry. */
  private readonly pendingPlaces = new Map<number, { n: number; until: number }>();
  private seq = 0;
  /** Increments on every change (UI redraws). */
  version = 0;

  /** Predicts an op; returns its seq, or null when it is invalid here. */
  apply(op: InvOp, env: InvEnv): number | null {
    const test = this.view.clone();
    const container = this.viewContainer.clone();
    if (!applyInvOp(test, op, { ...env, container: env.container ? container : null }, { thrown: [] })) return null;
    this.seq = (this.seq + 1) & 0xffff;
    this.pending.push({ seq: this.seq, op, env: { ...env } });
    this.view = test;
    this.viewContainer = container;
    this.version++;
    return this.seq;
  }

  applyServer(sync: InvSyncData): void {
    if (sync.full) this.auth.clear();
    if (sync.containerFull) this.authContainer.clear();
    for (const [ref, item, count, meta] of sync.slots) {
      if (ref < PLAYER_SLOTS) {
        this.auth.set(ref, count ? { item, count, meta } : null);
        this.pendingPlaces.delete(ref);
      } else if (ref >= CONTAINER_BASE) this.authContainer.set(ref - CONTAINER_BASE, count ? { item, count, meta } : null);
    }
    while (this.pending.length && seqLe(this.pending[0].seq, sync.ack)) this.pending.shift();
    this.replay();
  }

  /** Online placement: show one fewer until the server confirms (or 1 s passes). */
  notePlace(slot: number, now: number): void {
    const p = this.pendingPlaces.get(slot);
    this.pendingPlaces.set(slot, { n: (p?.n ?? 0) + 1, until: now + 1000 });
    this.version++;
  }

  /** Count shown for a hotbar slot (minus unconfirmed placements). */
  shownCount(slot: number, now: number): number {
    const c = this.view.counts[slot];
    const p = this.pendingPlaces.get(slot);
    if (!p) return c;
    if (now > p.until) {
      this.pendingPlaces.delete(slot);
      this.version++;
      return c;
    }
    return Math.max(0, c - p.n);
  }

  /** The container is gone (closed): forget its slots. */
  clearContainer(): void {
    this.authContainer.clear();
    this.viewContainer.clear();
    this.version++;
  }

  private replay(): void {
    const view = this.auth.clone();
    const container = this.authContainer.clone();
    for (const p of this.pending) applyInvOp(view, p.op, { ...p.env, container: p.env.container ? container : null }, { thrown: [] });
    this.view = view;
    this.viewContainer = container;
    this.version++;
  }
}
