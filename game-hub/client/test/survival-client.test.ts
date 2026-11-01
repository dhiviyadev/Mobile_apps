import { describe, expect, it } from 'vitest';
import { Block, craftOp, type InvEnv, Item, itemDef, survivalItemIds } from '@hub/shared';
import { InventoryModel } from '../src/games/voxel/survival/InventoryModel';
import { IDLE, reduceSelection, type SelState } from '../src/games/voxel/ui/invSelection';
import { buildItemModel, buildProjectileModel } from '../src/games/voxel/render/itemModels';
import { itemSprite, paintItemTile } from '../src/games/voxel/world/itemSprites';

const env: InvEnv = { selected: 0, container: null, stations: 0, sealedContainer: false, craft: craftOp };

describe('bag selection (touch)', () => {
  it('taps lift and place, long-press splits, double-tap quick-moves, drop and cancel', () => {
    let s: SelState = IDLE;
    let r = reduceSelection(s, { type: 'tap', ref: 9, count: 10 });
    expect(r.op).toBeNull();
    s = r.state;
    r = reduceSelection(s, { type: 'tap', ref: 3, count: 5 });
    expect(r.op).toEqual({ op: 'move', from: 9, to: 3, count: 0 });
    r = reduceSelection(IDLE, { type: 'longPress', ref: 9, count: 10 });
    expect(r.state).toEqual({ kind: 'lifted', ref: 9, count: 5 });
    expect(reduceSelection(r.state, { type: 'tap', ref: 12, count: 0 }).op).toEqual({ op: 'split', from: 9, to: 12 });
    expect(reduceSelection(r.state, { type: 'tap', ref: 13, count: 2 }).op).toEqual({ op: 'move', from: 9, to: 13, count: 5 });
    expect(reduceSelection(IDLE, { type: 'doubleTap', ref: 4, count: 1 }).op).toEqual({ op: 'quick', from: 4 });
    const lifted = reduceSelection(IDLE, { type: 'tap', ref: 4, count: 3 }).state;
    expect(reduceSelection(lifted, { type: 'drop', one: true }).op).toEqual({ op: 'drop', from: 4, count: 1 });
    expect(reduceSelection(lifted, { type: 'drop', one: false }).op).toEqual({ op: 'drop', from: 4, count: 0 });
    expect(reduceSelection(lifted, { type: 'tap', ref: 4, count: 3 }).state).toEqual(IDLE);
    expect(reduceSelection(lifted, { type: 'cancel' }).state).toEqual(IDLE);
    expect(reduceSelection(IDLE, { type: 'tap', ref: 7, count: 0 }).state).toEqual(IDLE);
  });
});

describe('InventoryModel', () => {
  it('predicts ops, replays pending ones over server state, and lets corrections win', () => {
    const m = new InventoryModel();
    m.applyServer({ ack: 0, full: true, containerFull: false, slots: [[0, Block.Dirt, 10, 0]] });
    const seq1 = m.apply({ op: 'move', from: 0, to: 5, count: 0 }, env)!;
    const seq2 = m.apply({ op: 'split', from: 5, to: 6 }, env)!;
    expect([m.view.counts[5], m.view.counts[6]]).toEqual([5, 5]);
    expect(m.apply({ op: 'move', from: 30, to: 1, count: 0 }, env)).toBeNull();
    // Server confirms the first op; the split is replayed on top.
    m.applyServer({ ack: seq1, full: false, containerFull: false, slots: [[0, 0, 0, 0], [5, Block.Dirt, 10, 0]] });
    expect(m.pending.map((p) => p.seq)).toEqual([seq2]);
    expect([m.view.counts[5], m.view.counts[6]]).toEqual([5, 5]);
    // The server rejected the split (ack advances, slots unchanged): the view follows the server.
    m.applyServer({ ack: seq2, full: false, containerFull: false, slots: [] });
    expect([m.view.counts[5], m.view.counts[6]]).toEqual([10, 0]);
  });

  it('shows unconfirmed placements for a second', () => {
    const m = new InventoryModel();
    m.applyServer({ ack: 0, full: true, containerFull: false, slots: [[2, Block.Stone, 3, 0]] });
    m.notePlace(2, 1000);
    expect(m.shownCount(2, 1500)).toBe(2);
    expect(m.shownCount(2, 2500)).toBe(3);
  });
});

describe('item models and sprites', () => {
  const triangles = (g: { index: { count: number } | null }) => (g.index?.count ?? 0) / 3;

  it('keeps weapons and tools within the triangle budgets and builds fast', () => {
    const t0 = performance.now();
    for (const id of survivalItemIds()) {
      const def = itemDef(id)!;
      const fp = buildItemModel(id, 'fp');
      const tp = buildItemModel(id, 'tp');
      if (def.melee || def.shield || def.ranged) {
        expect(triangles(fp), def.key).toBeLessThanOrEqual(300);
        expect(triangles(tp), def.key).toBeLessThanOrEqual(120);
      }
      expect(fp.getAttribute('color')).toBeDefined();
      expect(fp.getAttribute('light')).toBeDefined();
    }
    for (const k of ['arrow', 'bolt', 'ember'] as const) expect(triangles(buildProjectileModel(k))).toBeLessThanOrEqual(60);
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it('paints every item sprite with opaque and transparent pixels, deterministically', () => {
    for (const id of survivalItemIds()) {
      const a = itemSprite(id);
      expect(a, itemDef(id)!.key).not.toBeNull();
      let opaque = 0;
      for (let i = 3; i < 1024; i += 4) if (a![i] === 255) opaque++;
      expect(opaque, itemDef(id)!.key).toBeGreaterThan(8);
      expect(opaque, itemDef(id)!.key).toBeLessThan(256);
      const again = new Uint8ClampedArray(1024);
      expect(paintItemTile(itemDef(id)!.tile, again)).toBe(true);
      expect(again).toEqual(a);
    }
    expect(paintItemTile(150, new Uint8ClampedArray(1024))).toBe(false);
    expect(itemSprite(Item.Bow)).not.toBe(itemSprite(Item.Crossbow));
  });
});
