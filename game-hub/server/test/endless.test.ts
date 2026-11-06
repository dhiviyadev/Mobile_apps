import { describe, expect, it } from 'vitest';
import { Block, ENDLESS_LIMIT } from '@hub/shared';
import { ServerVoxelWorld } from '../src/voxel/ServerVoxelWorld';
import { VoxelFluids } from '../src/voxel/VoxelFluids';

describe('endless server worlds (generator 3)', { timeout: 30_000 }, () => {
  it('keep memory bounded while a player walks 3000 blocks', () => {
    const world = new ServerVoxelWorld(5, 'survival');
    expect(world.genVersion).toBe(3);
    const read = world.reader();
    let maxCached = 0;
    let maxQueued = 0;
    let solid = 0;
    for (let x = 0; x <= 3000; x += 12) {
      const z = Math.round(Math.sin(x / 400) * 200);
      // What a player's presence asks for: the creature sim warms chunks around them, gameplay reads a few cells.
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) world.warm((x >> 4) + dx, (z >> 4) + dz);
      world.pumpWarm(Infinity);
      if (world.getBlock(x, 1, z) !== Block.Air) solid++;
      if (read(x, 1, z) !== Block.Bedrock) solid++;
      maxCached = Math.max(maxCached, world.cachedChunks);
      maxQueued = Math.max(maxQueued, world.warmQueued);
    }
    expect(solid).toBeGreaterThan(200);
    expect(maxCached).toBeLessThanOrEqual(384);
    expect(maxQueued).toBeLessThanOrEqual(256);
    // A far-away read after the walk still sees the right terrain.
    const fresh = new ServerVoxelWorld(5, 'survival');
    expect(world.getBlock(2990, 5, 100)).toBe(fresh.getBlock(2990, 5, 100));
  });

  it('accept edits anywhere inside +-32000 and none past it', () => {
    const world = new ServerVoxelWorld(5, 'sandbox');
    expect(world.blockInWorld(ENDLESS_LIMIT - 1, 40, -ENDLESS_LIMIT)).toBe(true);
    expect(world.blockInWorld(ENDLESS_LIMIT, 40, 0)).toBe(false);
    expect(world.blockInWorld(0, 40, -ENDLESS_LIMIT - 1)).toBe(false);
    expect(world.setBlock(30000, 40, -29000, Block.Brick)).toBe(true);
    expect(world.getBlock(30000, 40, -29000)).toBe(Block.Brick);
    expect(world.setBlock(32500, 40, 0, Block.Brick)).toBe(false);
    expect(world.loadEdits([{ x: 31999, y: 40, z: 5, id: Block.Glass }, { x: 32100, y: 40, z: 5, id: Block.Glass }])).toBe(1);
    // Edits travel as i16: the far edit round-trips through the encoded list.
    const bytes = world.encodedEdits();
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(0, true)).toBe(2);
    expect([view.getInt16(4, true), view.getInt16(10, true)].sort()).toEqual([30000, 31999]);
    // Generator-2 worlds keep their 1024 x 1024 bound.
    const old = new ServerVoxelWorld(5, 'sandbox', undefined, 2);
    expect(old.blockInWorld(511, 40, 0)).toBe(true);
    expect(old.blockInWorld(512, 40, 0)).toBe(false);
  });

  it('let water flow far from the origin', () => {
    const world = new ServerVoxelWorld(5, 'sandbox');
    const x = 20000, z = -15000;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      world.setBlock(x + dx, 60, z + dz, Block.Stone);
      world.setBlock(x + dx, 61, z + dz, Block.Air);
      world.setBlock(x + dx, 62, z + dz, Block.Air);
    }
    const fluids = new VoxelFluids(world, () => {});
    world.setBlock(x, 61, z, Block.Water);
    fluids.notifyEdit(x, 61, z);
    for (let i = 0; i < 40; i++) fluids.step();
    expect(world.allEdits().filter((e) => e.y === 61 && e.id !== Block.Air && e.id !== Block.Water).length).toBeGreaterThan(4);
  });
});
