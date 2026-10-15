import { describe, expect, it } from 'vitest';
import { Block, type BlockEdit, CHUNK_HEIGHT, flowingWater, isWater, WORLD_LIMIT } from '@hub/shared';
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

/** Steps until the queue drains; fails if it does not settle. */
function settle(fluids: VoxelFluids, maxSteps = 500): void {
  for (let i = 0; i < maxSteps && fluids.pending > 0; i++) fluids.step();
  expect(fluids.pending).toBe(0);
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
});

function byPos(a: BlockEdit, b: BlockEdit): number {
  return a.x - b.x || a.y - b.y || a.z - b.z;
}
