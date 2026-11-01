import { describe, expect, it } from 'vitest';
import { ArenaGrid, Block, Pathfinder, PathScheduler, MobKind, type PathRequest } from '../src/index';
import { FLOOR, FlatBlocks, setupWorld } from './mobWorld';

const req = (o: Partial<PathRequest> = {}): PathRequest => ({
  sx: 0, sy: FLOOR, sz: 0, tx: 10, ty: FLOOR, tz: 0, height: 2, maxDrop: 3, climb: false, swim: 'avoid', maxNodes: 300, goalRadius: 0, leash: null, ...o,
});

const cells = (r: { cells: Int16Array; length: number }) => Array.from({ length: r.length }, (_, i) => [r.cells[i * 3], r.cells[i * 3 + 1], r.cells[i * 3 + 2]]);

describe('pathfinding', () => {
  it('walks straight on flat ground', () => {
    const r = new Pathfinder(new FlatBlocks().get).find(req());
    expect(r.complete).toBe(true);
    expect(r.length).toBe(10);
  });

  it('detours around a wall through a gap', () => {
    const b = new FlatBlocks();
    b.fill(5, FLOOR, -6, 5, FLOOR + 3, 6, Block.Stone);
    b.fill(5, FLOOR, 4, 5, FLOOR + 1, 4, Block.Air);
    const r = new Pathfinder(b.get).find(req());
    expect(r.complete).toBe(true);
    expect(cells(r).some(([x, , z]) => x === 5 && z === 4)).toBe(true);
  });

  it('takes a 1-block step and refuses a 2-block one', () => {
    const b = new FlatBlocks();
    b.fill(5, FLOOR, -20, 30, FLOOR, 20, Block.Stone);
    expect(new Pathfinder(b.get).find(req({ ty: FLOOR + 1 })).complete).toBe(true);
    const b2 = new FlatBlocks();
    b2.fill(5, FLOOR, -40, 40, FLOOR + 1, 40, Block.Stone);
    expect(new Pathfinder(b2.get).find(req({ tx: 10, ty: FLOOR + 2 })).complete).toBe(false);
  });

  it('refuses a 4-block drop at maxDrop 3 and takes it at 5', () => {
    const b = new FlatBlocks(14);
    b.fill(4, 10, -40, 12, 13, 40, Block.Air);
    // Ledge at x <= 3 (floor 14), pit floor at 10 for x >= 4.
    const p = (maxDrop: number) => new Pathfinder(b.get).find(req({ sx: 0, sy: 14, tx: 8, ty: 10, maxDrop }));
    expect(p(3).complete).toBe(false);
    expect(p(5).complete).toBe(true);
  });

  it('never steps on lava or cactus and avoids water when a dry path exists', () => {
    const b = new FlatBlocks();
    b.fill(5, FLOOR - 1, -1, 5, FLOOR - 1, 1, Block.Lava);
    b.set(4, FLOOR, 2, Block.Cactus);
    const r = new Pathfinder(b.get).find(req());
    expect(r.complete).toBe(true);
    for (const [x, y, z] of cells(r)) {
      expect(b.get(x, y - 1, z)).not.toBe(Block.Lava);
      expect(b.get(x, y, z)).not.toBe(Block.Cactus);
    }
    const w = new FlatBlocks();
    w.fill(3, FLOOR - 1, -1, 7, FLOOR - 1, 1, Block.Water);
    const r2 = new Pathfinder(w.get).find(req());
    expect(cells(r2).every(([x, y, z]) => w.get(x, y - 1, z) !== Block.Water)).toBe(true);
  });

  it('respects maxNodes with a partial path toward the goal', () => {
    const r = new Pathfinder(new FlatBlocks().get).find(req({ tx: 60, maxNodes: 20 }));
    expect(r.complete).toBe(false);
    expect(r.expanded).toBeLessThanOrEqual(20);
    expect(r.length).toBeGreaterThan(0);
    expect(r.cells[(r.length - 1) * 3]).toBeGreaterThan(0);
  });

  it('climbs a wall with climb paths', () => {
    const b = new FlatBlocks();
    b.fill(3, FLOOR, -30, 30, FLOOR + 3, 30, Block.Stone);
    const r = new Pathfinder(b.get).find(req({ tx: 6, ty: FLOOR + 4, height: 1, climb: true, maxDrop: 5 }));
    expect(r.complete).toBe(true);
    expect(new Pathfinder(b.get).find(req({ tx: 6, ty: FLOOR + 4, height: 1 })).complete).toBe(false);
  });

  it('stays inside a leash box', () => {
    const r = new Pathfinder(new FlatBlocks().get).find(req({ tx: 20, leash: { x0: -2, y0: FLOOR, z0: -2, x1: 6, y1: FLOOR + 4, z1: 3 } }));
    expect(cells(r).every(([x]) => x < 6)).toBe(true);
  });

  it('PathScheduler never exceeds its budget in one pump', () => {
    const s = setupWorld();
    const sched = new PathScheduler(new Pathfinder(s.blocks.get));
    for (let i = 0; i < 10; i++) {
      const m = s.world.spawnMob(MobKind.Mudlurch, 0.5, FLOOR, i + 0.5)!;
      sched.request(m, req({ sz: i, tx: 200, tz: i }), 0);
    }
    sched.pump(250);
    expect(sched.lastSpent).toBeLessThanOrEqual(250);
    expect(sched.pending).toBeGreaterThan(0);
  });

  it('ArenaGrid routes around pillars', () => {
    const b = new FlatBlocks();
    b.fill(5, FLOOR, -1, 5, FLOOR + 5, 1, Block.Stone);
    const g = new ArenaGrid(b.get, { x0: -8, y0: FLOOR, z0: -8, x1: 9, y1: FLOOR + 8, z1: 9 }, FLOOR, 0.8);
    expect(g.clearLine(0.5, 0.5, 8.5, 0.5)).toBe(false);
    const wp = g.nextWaypoint(0.5, 0.5, 8.5, 0.5);
    expect(Math.abs(wp.z - 0.5)).toBeGreaterThan(0.9);
  });
});
