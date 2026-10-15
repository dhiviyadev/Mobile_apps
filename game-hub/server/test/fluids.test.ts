import { describe, expect, it, vi } from 'vitest';
import { Block, type BlockEdit, CHUNK_HEIGHT, flowingWater, IS_SOLID, isWater, SEA_LEVEL, WORLD_LIMIT } from '@hub/shared';
import { ServerVoxelWorld } from '../src/voxel/ServerVoxelWorld';
import { VoxelFluids } from '../src/voxel/VoxelFluids';

const SEED = 4242;
const R = 9;

/**
 * Builds a stone floor of radius R around (cx, cz), one block above anything
 * the terrain has there, so the test controls everything the water touches.
 * Returns the y of the first layer above the floor.
 */
function buildFloor(world: ServerVoxelWorld, cx: number, cz: number): number {
  let top = 0;
  for (let x = cx - R - 1; x <= cx + R + 1; x++) {
    for (let z = cz - R - 1; z <= cz + R + 1; z++) {
      for (let y = CHUNK_HEIGHT - 1; y > top; y--) {
        if (world.getBlock(x, y, z) !== Block.Air) {
          top = y;
          break;
        }
      }
    }
  }
  const floorY = top + 2;
  expect(floorY + 2).toBeLessThan(CHUNK_HEIGHT);
  for (let x = cx - R; x <= cx + R; x++) for (let z = cz - R; z <= cz + R; z++) expect(world.setBlock(x, floorY, z, Block.Stone)).toBe(true);
  return floorY + 1;
}

/** Steps until the queue and the restored backlog drain; fails if it does not settle. */
function settle(fluids: VoxelFluids, maxSteps = 500): void {
  for (let i = 0; i < maxSteps && (fluids.pending > 0 || fluids.backlog > 0); i++) fluids.step();
  expect(fluids.pending).toBe(0);
  expect(fluids.backlog).toBe(0);
}

function waterEdits(world: ServerVoxelWorld): BlockEdit[] {
  return world.allEdits().filter((e) => isWater(e.id));
}

describe('server fluids', () => {
  it('spreads water placed by a player and reports every change', () => {
    const world = new ServerVoxelWorld(SEED, 'sandbox');
    const y = buildFloor(world, 40, 40);
    const changes: BlockEdit[] = [];
    const fluids = new VoxelFluids(world, (x, y, z, id) => changes.push({ x, y, z, id }));
    world.setBlock(40, y, 40, Block.Water);
    fluids.notifyEdit(40, y, 40);
    settle(fluids);

    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d = Math.abs(dx) + Math.abs(dz);
        const expected = d === 0 ? Block.Water : d <= 7 ? flowingWater(8 - d) : Block.Air;
        expect(world.getBlock(40 + dx, y, 40 + dz)).toBe(expected);
      }
    }
    expect(waterEdits(world)).toHaveLength(113);
    // Replaying the reported changes reproduces the world's water exactly.
    const replay = new Map<string, number>();
    for (const c of changes) replay.set(`${c.x},${c.y},${c.z}`, c.id);
    expect(replay.size).toBe(112);
    for (const [key, id] of replay) {
      const [x, cy, z] = key.split(',').map(Number);
      expect(world.getBlock(x, cy, z)).toBe(id);
    }
    expect(fluids.step()).toBe(0);
  });

  it('dries up when the source is replaced by a block', () => {
    const world = new ServerVoxelWorld(SEED, 'sandbox');
    const y = buildFloor(world, -60, 20);
    const fluids = new VoxelFluids(world, () => {});
    world.setBlock(-60, y, 20, Block.Water);
    fluids.notifyEdit(-60, y, 20);
    settle(fluids);
    const edits = world.editCount;
    world.setBlock(-60, y, 20, Block.Stone);
    fluids.notifyEdit(-60, y, 20);
    settle(fluids);
    expect(waterEdits(world)).toEqual([]);
    // Dried cells are back to generated air, so they no longer use the edit budget.
    expect(world.editCount).toBe(edits - 112);
  });

  it('stops changing blocks once the edit budget is spent', () => {
    const probe = new ServerVoxelWorld(SEED, 'sandbox');
    buildFloor(probe, 40, 40);
    const floorEdits = probe.editCount;

    const world = new ServerVoxelWorld(SEED, 'sandbox', floorEdits + 1 + 5);
    const y = buildFloor(world, 40, 40);
    let reported = 0;
    const fluids = new VoxelFluids(world, () => reported++, { editShare: 1 });
    expect(world.setBlock(40, y, 40, Block.Water)).toBe(true);
    fluids.notifyEdit(40, y, 40);
    settle(fluids);
    expect(reported).toBe(5);
    expect(waterEdits(world)).toHaveLength(6);
    expect(world.editCount).toBe(world.maxEdits);
  });

  it('keeps the last quarter of the edit budget for players', () => {
    const probe = new ServerVoxelWorld(SEED, 'sandbox');
    buildFloor(probe, 40, 40);
    const floorEdits = probe.editCount;

    // Water's three quarters run out partway through the 112 cells the source would fill.
    const world = new ServerVoxelWorld(SEED, 'sandbox', floorEdits + 240);
    const waterLimit = Math.floor(world.maxEdits * 0.75);
    expect(waterLimit - floorEdits - 1).toBeGreaterThan(10);
    expect(waterLimit - floorEdits - 1).toBeLessThan(100);
    const y = buildFloor(world, 40, 40);
    const changes: BlockEdit[] = [];
    const fluids = new VoxelFluids(world, (x, y, z, id) => changes.push({ x, y, z, id }));
    world.setBlock(40, y, 40, Block.Water);
    fluids.notifyEdit(40, y, 40);
    settle(fluids);
    expect(world.editCount).toBe(waterLimit);
    expect(waterEdits(world)).toHaveLength(waterLimit - floorEdits);
    // Refused changes were rolled back and never reported.
    const replay = new Map<string, BlockEdit>();
    for (const c of changes) replay.set(`${c.x},${c.y},${c.z}`, c);
    expect(replay.size).toBe(waterLimit - floorEdits - 1);
    for (const c of replay.values()) expect(world.getBlock(c.x, c.y, c.z)).toBe(c.id);

    // More water can no longer claim new cells...
    world.setBlock(40 + R, y, 40 + R, Block.Water);
    fluids.notifyEdit(40 + R, y, 40 + R);
    settle(fluids);
    expect(world.editCount).toBe(waterLimit + 1);
    expect(world.getBlock(40 + R - 1, y, 40 + R)).toBe(Block.Air);

    // ...but players can still build with the rest of the budget.
    let built = 0;
    for (let x = 40 - R; x <= 40 + R; x++) for (let z = 40 - R; z <= 40 + R; z++) if (world.setBlock(x, y + 1, z, Block.Planks)) built++;
    expect(built).toBe(world.maxEdits - waterLimit - 1);
    expect(world.editCount).toBe(world.maxEdits);

    // With the budget full, removing the source still dries all of its water.
    world.setBlock(40, y, 40, Block.Stone);
    fluids.notifyEdit(40, y, 40);
    settle(fluids);
    expect(waterEdits(world).filter((e) => Math.abs(e.x - 40) + Math.abs(e.z - 40) <= 7)).toEqual([]);
    expect(world.editCount).toBe(world.maxEdits - replay.size);
  });

  it('keeps water inside the world', () => {
    const world = new ServerVoxelWorld(SEED, 'sandbox');
    const edge = WORLD_LIMIT - 1;
    const y = buildFloor(world, edge, 0);
    const fluids = new VoxelFluids(world, () => {});
    world.setBlock(edge - 1, y, 0, Block.Water);
    fluids.notifyEdit(edge - 1, y, 0);
    settle(fluids);
    const water = waterEdits(world);
    expect(water.length).toBeGreaterThan(20);
    expect(water.every((e) => e.x <= edge)).toBe(true);
  });

  it('resumes a half-finished flow from a saved edit list', () => {
    // Reference: the same source left to settle.
    const full = new ServerVoxelWorld(SEED, 'sandbox');
    const y = buildFloor(full, 40, 40);
    const fullFluids = new VoxelFluids(full, () => {});
    full.setBlock(40, y, 40, Block.Water);
    fullFluids.notifyEdit(40, y, 40);
    settle(fullFluids);

    // Saved after two steps, while the water is still spreading.
    const before = new ServerVoxelWorld(SEED, 'sandbox');
    buildFloor(before, 40, 40);
    const fluids = new VoxelFluids(before, () => {});
    before.setBlock(40, y, 40, Block.Water);
    fluids.notifyEdit(40, y, 40);
    fluids.step();
    fluids.step();
    expect(fluids.pending).toBeGreaterThan(0);
    const saved = before.allEdits();
    expect(saved.filter((e) => isWater(e.id)).length).toBeLessThan(113);

    // A restarted room restores the edits and picks the flow back up.
    const restored = new ServerVoxelWorld(SEED, 'sandbox');
    for (const e of saved) restored.setBlock(e.x, e.y, e.z, e.id);
    const changes: BlockEdit[] = [];
    const resumed = new VoxelFluids(restored, (x, y, z, id) => changes.push({ x, y, z, id }));
    resumed.resumeFrom(saved);
    settle(resumed);
    expect(changes.length).toBeGreaterThan(0);
    expect(restored.allEdits().sort(byPos)).toEqual(full.allEdits().sort(byPos));
  });

  it('resumes a source saved before it spread', () => {
    const world = new ServerVoxelWorld(SEED, 'sandbox');
    const y = buildFloor(world, 40, 40);
    world.setBlock(40, y, 40, Block.Water);
    const fluids = new VoxelFluids(world, () => {});
    fluids.resumeFrom(world.allEdits());
    settle(fluids);
    expect(waterEdits(world)).toHaveLength(113);
  });

  it('resumes a world with more water than the queue holds a little at a time, newest first', () => {
    // Reference: the flow left to settle.
    const full = new ServerVoxelWorld(SEED, 'sandbox');
    const y = buildFloor(full, 40, 40);
    const fullFluids = new VoxelFluids(full, () => {});
    full.setBlock(40, y, 40, Block.Water);
    fullFluids.notifyEdit(40, y, 40);
    settle(fullFluids);

    // A settled lake of sources dug deep underground and walled in, then the same flow,
    // saved while it was still spreading.
    const before = new ServerVoxelWorld(SEED, 'sandbox');
    const L = 65;
    for (let x = -135 - L - 1; x <= -135 + L + 1; x++) {
      for (let z = -L - 1; z <= L + 1; z++) {
        const wall = Math.abs(x + 135) > L || Math.abs(z) > L;
        for (let ly = 1; ly <= 3; ly++) before.setBlock(x, ly, z, wall ? Block.Stone : Block.Water);
      }
    }
    buildFloor(before, 40, 40);
    const fluids = new VoxelFluids(before, () => {});
    before.setBlock(40, y, 40, Block.Water);
    fluids.notifyEdit(40, y, 40);
    fluids.step();
    fluids.step();
    expect(fluids.pending).toBeGreaterThan(0);
    const saved = before.allEdits();
    expect(saved.filter((e) => isWater(e.id)).length).toBeGreaterThan(50_000);

    const restored = new ServerVoxelWorld(SEED, 'sandbox');
    restored.loadEdits(saved);
    const playerY = buildFloor(restored, 120, 120);
    const changes: BlockEdit[] = [];
    const resumed = new VoxelFluids(restored, (x, y, z, id) => changes.push({ x, y, z, id }));
    resumed.resumeFrom(saved);
    expect(resumed.pending).toBe(0);
    expect(resumed.backlog).toBeGreaterThan(50_000);

    // Water a player places right after the restart starts spreading on the next step.
    restored.setBlock(120, playerY, 120, Block.Water);
    resumed.notifyEdit(120, playerY, 120);
    resumed.step();
    expect(restored.getBlock(121, playerY, 120)).toBe(flowingWater(7));

    // The saved world is fed in without ever filling the queue, and the flow finishes.
    for (let i = 0; i < 500 && (resumed.pending > 0 || resumed.backlog > 0); i++) {
      resumed.step();
      expect(resumed.pending).toBeLessThan(2 * 512);
    }
    expect(resumed.pending).toBe(0);
    expect(resumed.backlog).toBe(0);
    expect(resumed.dropped).toBe(0);
    for (let x = 40 - R; x <= 40 + R; x++) for (let z = 40 - R; z <= 40 + R; z++) expect(restored.getBlock(x, y, z)).toBe(full.getBlock(x, y, z));
    // The lake was settled, so it only cost the checks.
    expect(changes.filter((c) => c.x < 0)).toEqual([]);
  });

  it('refills cells dug beside or under generated water before the save', () => {
    // Generated sea: a source at sea level with solid shore beside it, and sea floor under one.
    const world = new ServerVoxelWorld(SEED, 'sandbox');
    let shore: { x: number; z: number } | null = null;
    let bed: { x: number; y: number; z: number } | null = null;
    for (let x = -400; x < 400 && !(shore && bed); x++) {
      for (let z = -64; z <= 64 && !(shore && bed); z += 8) {
        if (world.getBlock(x, SEA_LEVEL, z) !== Block.Water) continue;
        if (!shore && IS_SOLID[world.getBlock(x + 1, SEA_LEVEL, z)] && IS_SOLID[world.getBlock(x + 1, SEA_LEVEL - 1, z)]) shore = { x, z };
        let y = SEA_LEVEL;
        while (y > 3 && world.getBlock(x, y - 1, z) === Block.Water) y--;
        if (!bed && y > 3 && IS_SOLID[world.getBlock(x, y - 1, z)] && IS_SOLID[world.getBlock(x, y - 2, z)]) bed = { x, y: y - 1, z };
      }
    }
    if (!shore || !bed) throw new Error('no generated sea found');

    // Dug out before the water got to them (no notifyEdit), then saved and restored.
    world.setBlock(shore.x + 1, SEA_LEVEL, shore.z, Block.Air);
    world.setBlock(bed.x, bed.y, bed.z, Block.Air);
    const saved = world.allEdits();
    expect(saved).toHaveLength(2);
    const restored = new ServerVoxelWorld(SEED, 'sandbox');
    restored.loadEdits(saved);
    const fluids = new VoxelFluids(restored, () => {});
    fluids.resumeFrom(saved);
    settle(fluids);
    expect(restored.getBlock(shore.x + 1, SEA_LEVEL, shore.z)).toBe(flowingWater(7));
    expect(restored.getBlock(bed.x, bed.y, bed.z)).toBe(Block.WaterFalling);
  });

  it('reports reaching the edit limit at most once a minute', () => {
    const probe = new ServerVoxelWorld(SEED, 'sandbox');
    buildFloor(probe, 40, 40);
    const world = new ServerVoxelWorld(SEED, 'sandbox', probe.editCount + 240);
    const y = buildFloor(world, 40, 40);
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let notices = 0;
      const fluids = new VoxelFluids(world, () => {}, { onLimit: () => notices++ });
      const pour = (x: number, z: number) => {
        expect(world.setBlock(x, y, z, Block.Water)).toBe(true);
        fluids.notifyEdit(x, y, z);
        settle(fluids);
      };
      pour(40, 40);
      expect(world.editCount).toBe(Math.floor(world.maxEdits * 0.75));
      expect(notices).toBe(1);
      // Refused again within the minute: no new notice.
      now += 59_000;
      pour(40 + R, 40 + R);
      expect(notices).toBe(1);
      now += 1_000;
      pour(40 - R, 40 - R);
      expect(notices).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

function byPos(a: BlockEdit, b: BlockEdit): number {
  return a.x - b.x || a.y - b.y || a.z - b.z;
}
