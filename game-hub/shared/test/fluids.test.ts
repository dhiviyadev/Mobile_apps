import { describe, expect, it } from 'vitest';
import {
  Block,
  createBody,
  type FluidAccess,
  type FluidChange,
  FluidSimulator,
  flowingWater,
  HOTBAR_BLOCKS,
  IS_LIQUID,
  IS_SOLID,
  isPlaceable,
  isWater,
  LIQUID_HEIGHT,
  mulberry32,
  packPos,
  PLAYER_EYE,
  stepBody,
  StreamedFluids,
  type StreamedWorld,
  toChunkCoord,
  unpackPos,
  waterLevel,
} from '../src';

/** A small in-memory world: unset cells are air, below y = 0 is bedrock. */
class Grid implements FluidAccess {
  readonly blocks = new Map<number, number>();
  /** Positions the simulator wrote to. */
  readonly written = new Set<number>();
  /** Writes left before set() starts refusing. */
  budget = Infinity;

  get(x: number, y: number, z: number): number {
    return y < 0 ? Block.Bedrock : (this.blocks.get(packPos(x, y, z)) ?? Block.Air);
  }

  set(x: number, y: number, z: number, id: number): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    this.written.add(packPos(x, y, z));
    this.put(x, y, z, id);
    return true;
  }

  put(x: number, y: number, z: number, id: number): void {
    if (id === Block.Air) this.blocks.delete(packPos(x, y, z));
    else this.blocks.set(packPos(x, y, z), id);
  }

  /** Fills a box (inclusive) with a block. */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.put(x, y, z, id);
  }

  /** Every water block in the grid. */
  water(): number[] {
    return [...this.blocks.values()].filter(isWater);
  }
}

const R = 12;

/** Stone floor at y = 0 over |x|, |z| <= R. */
function flatGrid(): Grid {
  const g = new Grid();
  g.fill(-R, 0, -R, R, 0, R, Block.Stone);
  return g;
}

/** Steps until the queue drains; fails if it does not settle. Returns every applied change. */
function settle(sim: FluidSimulator, maxSteps = 500): FluidChange[] {
  const all: FluidChange[] = [];
  for (let i = 0; i < maxSteps; i++) {
    all.push(...sim.step());
    if (sim.pending === 0) return all;
  }
  throw new Error(`fluids did not settle in ${maxSteps} steps`);
}

/** Places (or removes) a block the way a player edit would. */
function edit(g: Grid, sim: FluidSimulator, x: number, y: number, z: number, id: number): void {
  g.put(x, y, z, id);
  sim.notifyEdit(x, y, z);
}

type Edit = [number, number, number, number];

/**
 * A Grid streamed like the client World: chunks from cx = unloadFrom on are
 * not loaded and read as bedrock, and every write stays an edit, even one
 * that puts back what was there.
 */
class StreamedGrid implements StreamedWorld {
  readonly edits = new Map<number, number>();
  unloadFrom = Infinity;
  /** isLoaded() calls so far. */
  loadChecks = 0;

  constructor(readonly grid: Grid) {}

  isLoaded(x: number): boolean {
    this.loadChecks++;
    return toChunkCoord(x) < this.unloadFrom;
  }

  getBlock(x: number, y: number, z: number): number {
    return toChunkCoord(x) < this.unloadFrom ? this.grid.get(x, y, z) : Block.Bedrock;
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    this.grid.put(x, y, z, id);
    this.edits.set(packPos(x, y, z), id);
  }

  allEdits(): Edit[] {
    return [...this.edits].map(([key, id]): Edit => [...unpackPos(key), id]);
  }
}

/** A player edit in a streamed world: applied, then reported. */
function playerEdit(w: StreamedGrid, fluids: StreamedFluids, x: number, y: number, z: number, id: number): void {
  w.setBlock(x, y, z, id);
  fluids.notifyEdit(x, y, z);
}

function settleStreamed(fluids: StreamedFluids, maxSteps = 500): void {
  for (let i = 0; i < maxSteps; i++) {
    fluids.step();
    if (fluids.pending === 0) return;
  }
  throw new Error(`fluids did not settle in ${maxSteps} steps`);
}

const byPos = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe('water blocks', () => {
  it('describes sources, flowing and falling water', () => {
    expect(waterLevel(Block.Water)).toBe(8);
    expect(waterLevel(Block.WaterFalling)).toBe(8);
    expect(waterLevel(Block.Stone)).toBe(0);
    for (let level = 1; level <= 7; level++) {
      const id = flowingWater(level);
      expect(id).toBe(Block.WaterFlow1 + level - 1);
      expect(waterLevel(id)).toBe(level);
      expect(isWater(id)).toBe(true);
      expect(IS_LIQUID[id]).toBe(1);
      expect(IS_SOLID[id]).toBe(0);
      expect(isPlaceable(id)).toBe(false);
      expect(LIQUID_HEIGHT[id]).toBeCloseTo((level + 1) / 9);
    }
    expect(flowingWater(0)).toBe(Block.Air);
    expect(isWater(Block.Ice)).toBe(false);
    expect(isPlaceable(Block.WaterFalling)).toBe(false);
    expect(LIQUID_HEIGHT[Block.Water]).toBeCloseTo(0.875);
    expect(LIQUID_HEIGHT[Block.WaterFalling]).toBeCloseTo(0.875);
    expect(LIQUID_HEIGHT[Block.Stone]).toBe(1);
  });

  it('puts the water source in the hotbar and keeps clay placeable', () => {
    expect(HOTBAR_BLOCKS).toContain(Block.Water);
    expect(HOTBAR_BLOCKS).not.toContain(Block.Clay);
    expect(isPlaceable(Block.Water)).toBe(true);
    expect(isPlaceable(Block.Clay)).toBe(true);
  });

  it('lets players wade through shallow flowing water without swimming', () => {
    const g = flatGrid();
    g.put(0, 1, 0, flowingWater(1));
    const body = createBody(0.5, 1, 0.5);
    const still = { strafe: 0, forward: 0, yaw: 0, jump: false, sprint: false, crouch: false, autoJump: false };
    stepBody(body, still, g.get.bind(g), 1 / 60, PLAYER_EYE);
    expect(body.inWater).toBe(false);
    g.put(0, 1, 0, flowingWater(7));
    stepBody(body, still, g.get.bind(g), 1 / 60, PLAYER_EYE);
    expect(body.inWater).toBe(true);
  });
});

describe('fluid simulation', () => {
  it('spreads a source on flat ground into a diamond of radius 7 and stops', () => {
    const g = flatGrid();
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 1, 0, Block.Water);
    settle(sim);
    for (let z = -R; z <= R; z++) {
      for (let x = -R; x <= R; x++) {
        const d = Math.abs(x) + Math.abs(z);
        const expected = d === 0 ? Block.Water : flowingWater(8 - d);
        expect(g.get(x, 1, z), `${x},${z}`).toBe(expected);
        expect(g.get(x, 2, z)).toBe(Block.Air);
      }
    }
    expect(g.water()).toHaveLength(1 + 4 * (1 + 2 + 3 + 4 + 5 + 6 + 7));
    expect(sim.pending).toBe(0);
    expect(sim.step()).toEqual([]);
  });

  it('only runs cells queued before a step; new work waits for the next step', () => {
    const g = flatGrid();
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 1, 0, Block.Water);
    const first = sim.step(10_000);
    expect(first.map((c) => c.id)).toEqual([flowingWater(7), flowingWater(7), flowingWater(7), flowingWater(7)]);
    expect(sim.pending).toBeGreaterThan(0);
    const second = sim.step(1);
    expect(second.length).toBeLessThanOrEqual(1);
  });

  it('falls into a pit and spreads again at the bottom', () => {
    // Ground at y = 2 with a pit (floor at y = 0) for 3 <= x <= 10, |z| <= 6.
    const g = flatGrid();
    g.fill(-R, 1, -R, R, 2, R, Block.Stone);
    g.fill(3, 1, -6, 10, 2, 6, Block.Air);
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 3, 0, Block.Water);
    settle(sim);
    expect(g.get(1, 3, 0)).toBe(flowingWater(7));
    expect(g.get(2, 3, 0)).toBe(flowingWater(6));
    // Over the pit edge it still flows one block, then pours down.
    expect(g.get(3, 3, 0)).toBe(flowingWater(5));
    expect(g.get(3, 2, 0)).toBe(Block.WaterFalling);
    expect(g.get(3, 1, 0)).toBe(Block.WaterFalling);
    // Water that is not resting on anything does not spread sideways.
    expect(g.get(4, 3, 0)).toBe(Block.Air);
    expect(g.get(4, 2, 0)).toBe(Block.Air);
    // The bottom of the fall acts like a source.
    expect(g.get(4, 1, 0)).toBe(flowingWater(7));
    expect(g.get(5, 1, 0)).toBe(flowingWater(6));
    expect(g.get(10, 1, 0)).toBe(flowingWater(1));
    expect(g.get(0, 0, 0)).toBe(Block.Stone);
  });

  it('dries up everything once the source is removed', () => {
    const g = flatGrid();
    g.fill(-R, 1, -R, R, 2, R, Block.Stone);
    g.fill(3, 1, -6, 10, 2, 6, Block.Air);
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 3, 0, Block.Water);
    settle(sim);
    expect(g.water().length).toBeGreaterThan(50);
    edit(g, sim, 0, 3, 0, Block.Air);
    settle(sim);
    expect(g.water()).toEqual([]);
  });

  it('dries a flat diamond and refills it when the source returns', () => {
    const g = flatGrid();
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 1, 0, Block.Water);
    settle(sim);
    const filled = new Map(g.blocks);
    edit(g, sim, 0, 1, 0, Block.Air);
    settle(sim);
    expect(g.water()).toEqual([]);
    edit(g, sim, 0, 1, 0, Block.Water);
    settle(sim);
    expect(g.blocks).toEqual(filled);
  });

  it('starts spreading when a block is placed under hanging water', () => {
    // A source on a one-block pillar pours down beside it.
    const g = flatGrid();
    g.fill(-1, 1, -1, 1, 4, 1, Block.Stone);
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 5, 0, Block.Water);
    settle(sim);
    expect(g.get(1, 5, 0)).toBe(flowingWater(7));
    expect(g.get(2, 5, 0)).toBe(flowingWater(6));
    expect(g.get(3, 5, 0)).toBe(Block.Air);
    expect(g.get(2, 4, 0)).toBe(Block.WaterFalling);
    // A solid block under the flowing water lets it rest and spread further.
    edit(g, sim, 2, 4, 0, Block.Stone);
    settle(sim);
    expect(g.get(3, 5, 0)).toBe(flowingWater(5));
  });

  it('never replaces solids, other sources or the bottom layer', () => {
    const g = flatGrid();
    g.put(1, 0, 0, Block.Air); // a hole in the bottom layer
    g.put(0, 1, 2, Block.Glass);
    g.put(-2, 1, 0, Block.Stone);
    g.put(0, 1, -3, Block.Water);
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 1, 0, Block.Water);
    sim.schedule(0, 1, -3);
    settle(sim);
    expect(g.get(0, 1, 2)).toBe(Block.Glass);
    expect(g.get(-2, 1, 0)).toBe(Block.Stone);
    expect(g.get(0, 1, -3)).toBe(Block.Water);
    expect(g.get(1, 0, 0)).toBe(Block.Air);
    expect(g.get(1, 1, 0)).toBe(flowingWater(7));
    for (const key of [packPos(0, 1, 2), packPos(-2, 1, 0), packPos(0, 1, -3), packPos(0, 1, 0), packPos(1, 0, 0)]) {
      expect(g.written.has(key)).toBe(false);
    }
    // The two sources meet in the middle at the higher level.
    expect(g.get(0, 1, -1)).toBe(flowingWater(7));
    expect(g.get(0, 1, -2)).toBe(flowingWater(7));
  });

  it('counts refused writes as not applied', () => {
    const g = flatGrid();
    g.budget = 3;
    const sim = new FluidSimulator(g);
    edit(g, sim, 0, 1, 0, Block.Water);
    const changes = settle(sim);
    expect(changes).toHaveLength(3);
    expect(g.water()).toHaveLength(4);
  });

  it('bounds the queue and counts dropped cells', () => {
    const g = flatGrid();
    const sim = new FluidSimulator(g, { maxQueue: 10 });
    for (let i = 0; i < 5; i++) sim.schedule(i * 4, 1, 0); // 6 cells each (y = 0 is never queued)
    expect(sim.pending).toBe(10);
    expect(sim.dropped).toBe(20);

    const small = new FluidSimulator(g, { maxQueue: 20 });
    edit(g, small, 0, 1, 0, Block.Water);
    for (let i = 0; i < 200 && small.pending > 0; i++) {
      small.step(8);
      expect(small.pending).toBeLessThanOrEqual(20);
    }
  });

  it('ignores cells outside the world height', () => {
    const g = flatGrid();
    const sim = new FluidSimulator(g, { height: 8 });
    sim.schedule(0, 7, 0);
    expect(sim.pending).toBe(6); // the cell, 4 sides and the one below; y = 8 is outside
    sim.clear();
    sim.schedule(0, 0, 0);
    expect(sim.pending).toBe(1); // only y = 1 above it: y = 0 and below are never queued
  });

  it('is deterministic', () => {
    const run = () => {
      const g = flatGrid();
      g.fill(-R, 1, -R, R, 2, R, Block.Stone);
      g.fill(3, 1, -6, 10, 2, 6, Block.Air);
      const sim = new FluidSimulator(g);
      edit(g, sim, 0, 3, 0, Block.Water);
      edit(g, sim, -4, 3, 3, Block.Water);
      const steps: FluidChange[][] = [];
      for (let i = 0; i < 40; i++) steps.push(sim.step(64));
      edit(g, sim, 0, 3, 0, Block.Air);
      for (let i = 0; i < 40; i++) steps.push(sim.step(64));
      return steps;
    };
    const a = run();
    expect(a.flat().length).toBeGreaterThan(100);
    expect(run()).toEqual(a);
  });

  it('settles to the same water whatever order the edits came in', () => {
    const sorted = (g: Grid) => [...g.blocks].sort((a, b) => a[0] - b[0]);
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const pick = (n: number) => Math.floor(rnd() * n);
      // Bumpy terrain with a few floating slabs.
      const g = flatGrid();
      for (let x = -R; x <= R; x++) {
        for (let z = -R; z <= R; z++) {
          g.fill(x, 1, z, x, pick(4), z, Block.Stone);
          if (rnd() < 0.05) g.put(x, 5 + pick(3), z, Block.Stone);
        }
      }
      // Random sources and solids added and removed, sometimes mid-flow.
      const sim = new FluidSimulator(g, { height: 10 });
      const sources: [number, number, number][] = [];
      for (let round = 0; round < 10; round++) {
        const [x, y, z] = [pick(2 * R) - R, 1 + pick(8), pick(2 * R) - R];
        const cur = g.get(x, y, z);
        const r = rnd();
        if (r < 0.5 && (cur === Block.Air || (isWater(cur) && cur !== Block.Water))) {
          edit(g, sim, x, y, z, Block.Water);
          sources.push([x, y, z]);
        } else if (r < 0.75 && sources.length) {
          const [sx, sy, sz] = sources.splice(pick(sources.length), 1)[0];
          edit(g, sim, sx, sy, sz, Block.Air);
        } else if (cur !== Block.Water) {
          edit(g, sim, x, y, z, r < 0.9 ? Block.Stone : Block.Air);
        }
        const steps = rnd() < 0.5 ? 3 : Infinity;
        for (let i = 0; i < steps && sim.pending > 0; i++) sim.step(rnd() < 0.5 ? 7 : 512);
      }
      settle(sim);

      // The same blocks and sources, flowed from scratch.
      const fresh = new Grid();
      for (const [key, id] of g.blocks) if (!isWater(id) || id === Block.Water) fresh.blocks.set(key, id);
      const sim2 = new FluidSimulator(fresh, { height: 10 });
      for (const [key, id] of fresh.blocks) if (id === Block.Water) sim2.notifyEdit(...unpackPos(key));
      settle(sim2);
      expect(sorted(g), `seed ${seed}`).toEqual(sorted(fresh));
    }
  });
});

describe('fluids in a streamed world', () => {
  it('holds changes beside unloaded chunks and makes them once the chunks load', () => {
    // Floor over chunks cx = 0 and 1 (x = 0..31), z = 0..15.
    const g = new Grid();
    g.fill(0, 0, 0, 31, 0, 15, Block.Stone);
    const w = new StreamedGrid(g);
    const fluids = new StreamedFluids(w);
    playerEdit(w, fluids, 12, 1, 8, Block.Water);
    settleStreamed(fluids);
    expect(g.water()).toHaveLength(113);

    // Chunks from x = 16 on unload, then the source is removed.
    w.unloadFrom = 1;
    playerEdit(w, fluids, 12, 1, 8, Block.Air);
    settleStreamed(fluids);
    // Water beside the unloaded chunk cannot see what feeds it, so it waits (and still feeds its neighbours).
    const loadedWater = () => [...g.blocks].filter(([key, id]) => isWater(id) && unpackPos(key)[0] < 16).length;
    const left = loadedWater();
    expect(left).toBeGreaterThan(0);
    expect(fluids.waitingCells).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) fluids.step();
    expect(loadedWater()).toBe(left);

    // Once the chunks are back, the waiting cells are checked again and everything dries.
    w.unloadFrom = Infinity;
    settleStreamed(fluids);
    expect(g.water()).toEqual([]);
    expect(fluids.waitingCells).toBe(0);
  });

  it('picks up cells whose chunk unloaded while they were queued', () => {
    // A one-wide channel along x at z = 8 that crosses from chunk cx = 0 into cx = 1.
    const g = new Grid();
    g.fill(0, 0, 0, 31, 1, 15, Block.Stone);
    g.fill(8, 1, 8, 31, 1, 8, Block.Air);
    const w = new StreamedGrid(g);
    const fluids = new StreamedFluids(w);
    playerEdit(w, fluids, 12, 1, 8, Block.Water);
    for (let i = 0; i < 4; i++) fluids.step();
    expect(g.get(16, 1, 8)).toBe(flowingWater(4));
    expect(g.get(17, 1, 8)).toBe(Block.Air);
    expect(fluids.pending).toBeGreaterThan(0);

    // The front unloads before its next step: it waits rather than being dropped.
    w.unloadFrom = 1;
    settleStreamed(fluids);
    expect(fluids.waitingCells).toBeGreaterThan(0);
    w.unloadFrom = Infinity;
    settleStreamed(fluids);
    for (let x = 13; x <= 19; x++) expect(g.get(x, 1, 8), `x = ${x}`).toBe(flowingWater(20 - x));
    expect(g.get(20, 1, 8)).toBe(Block.Air);
    expect(fluids.waitingCells).toBe(0);
  });

  it('checks waiting cells once per chunk, however many there are', () => {
    const w = new StreamedGrid(flatGrid());
    w.unloadFrom = 3;
    const fluids = new StreamedFluids(w);
    // Saved water in chunk cx = 2 (loaded, but its neighbour is not) and cx = 3 (not loaded).
    const saved: Edit[] = [];
    for (let x = 32; x < 64; x++) for (let z = 0; z < 16; z++) for (let y = 1; y <= 40; y++) saved.push([x, y, z, Block.Water]);
    fluids.restore(saved);
    expect(fluids.waitingCells).toBe(saved.length);
    w.loadChecks = 0;
    fluids.step();
    expect(w.loadChecks).toBeLessThanOrEqual(2 * 5);
    expect(fluids.pending).toBe(0);
    expect(fluids.waitingCells).toBe(saved.length);

    w.unloadFrom = Infinity;
    fluids.step();
    expect(fluids.waitingCells).toBe(0);
    expect(fluids.pending).toBeGreaterThan(0);
  });

  it('saves player edits only, and saved sources flow back after loading', () => {
    // Ground at y = 1, with a trench dug next to a source on top of it.
    const terrain = () => {
      const g = flatGrid();
      g.fill(-R, 1, -R, R, 1, R, Block.Stone);
      return g;
    };
    const w = new StreamedGrid(terrain());
    const fluids = new StreamedFluids(w);
    const trench: Edit[] = [];
    for (let x = 1; x <= 5; x++) {
      playerEdit(w, fluids, x, 1, 0, Block.Air);
      trench.push([x, 1, 0, Block.Air]);
    }
    playerEdit(w, fluids, 0, 2, 0, Block.Water);
    settleStreamed(fluids);
    // A block placed in the flow is a player edit too.
    playerEdit(w, fluids, 0, 2, -3, Block.Glass);
    settleStreamed(fluids);
    expect(w.grid.get(3, 1, 0)).toBe(Block.WaterFalling);
    expect(w.grid.get(2, 2, 2)).toBe(flowingWater(4));
    expect(w.edits.size).toBeGreaterThan(100);

    // Simulated water is left out; water poured into the trench is saved as the air under it.
    const saved = [...fluids.saveEdits(w.allEdits())];
    expect(saved.sort(byPos)).toEqual([...trench, [0, 2, 0, Block.Water], [0, 2, -3, Block.Glass]].sort(byPos));

    // Loading the save flows the same water again.
    const loaded = new StreamedGrid(terrain());
    for (const [x, y, z, id] of saved) loaded.setBlock(x, y, z, id);
    const again = new StreamedFluids(loaded);
    again.restore(saved);
    settleStreamed(again);
    expect(loaded.grid.blocks).toEqual(w.grid.blocks);

    // Trying water and taking it away again leaves nothing extra to save.
    playerEdit(w, fluids, 0, 2, 0, Block.Stone);
    playerEdit(w, fluids, 0, 2, 0, Block.Air);
    settleStreamed(fluids);
    expect(w.grid.water()).toEqual([]);
    expect([...fluids.saveEdits(w.allEdits())].sort(byPos)).toEqual(
      [...trench, [0, 2, 0, Block.Air], [0, 2, -3, Block.Glass]].sort(byPos),
    );
  });
});
