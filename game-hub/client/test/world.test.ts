import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Block, blockIndex, CHUNK_SIZE, CHUNK_VOLUME, flowingWater } from '@hub/shared';
import { type ChunkMesh, meshChunk } from '@hub/shared/voxel/mesher';
import type { WorkerPool } from '../src/games/voxel/world/WorkerPool';
import { World } from '../src/games/voxel/world/World';

const GROUND = 4;

/** Flat stone up to y = GROUND - 1, air above. */
function flatChunk(): Uint8Array {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  for (let y = 0; y < GROUND; y++) for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) blocks[blockIndex(x, y, z)] = Block.Stone;
  return blocks;
}

/**
 * Stands in for the worker pool: jobs run on the main thread, and settle only
 * when the test calls flush(), so capacity and job order can be observed.
 */
class FakePool {
  readonly maxPerWorker = 2;
  slots = 2;
  readonly meshed: string[] = [];
  private jobs: (() => void)[] = [];
  private busy = 0;

  get capacity(): number {
    return this.slots - this.busy;
  }

  get queued(): number {
    return this.jobs.length;
  }

  generate(_seed: number, _mode: string, _cx: number, _cz: number): Promise<{ blocks: Uint8Array }> {
    return this.job(() => ({ blocks: flatChunk() }));
  }

  mesh(region: Uint8Array): Promise<{ mesh: ChunkMesh; region: Uint8Array }> {
    return this.job(() => ({ mesh: meshChunk(region), region }));
  }

  /** Runs every job submitted so far. */
  async flush(): Promise<void> {
    const jobs = this.jobs;
    this.jobs = [];
    for (const run of jobs) run();
    await new Promise((r) => setTimeout(r, 0));
  }

  private job<T>(make: () => T): Promise<T> {
    this.busy++;
    return new Promise<T>((resolve) => {
      this.jobs.push(() => {
        this.busy--;
        resolve(make());
      });
    });
  }
}

function makeWorld() {
  const pool = new FakePool();
  const world = new World(pool as unknown as WorkerPool, 1, 'sandbox', new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial());
  world.renderDistance = 1;
  const meshes = vi.spyOn(pool, 'mesh');
  /** Streams until an update starts no more jobs (rate-limited water remeshes may still wait). */
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      world.update(8, 8);
      if (pool.queued === 0) return;
      await pool.flush();
    }
    throw new Error('world did not settle');
  };
  return { pool, world, meshes, settle };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client world', () => {
  it('keeps the light of each meshed chunk and reports it per cell', async () => {
    const { world, settle } = makeWorld();
    await settle();
    expect(world.lightAt(3, GROUND, 3)).toBe(0xf0); // open sky, no lamp
    world.setBlock(5, GROUND, 5, Block.Lamp);
    await settle();
    expect(world.lightAt(6, GROUND, 5) & 15).toBe(14);
    expect(world.lightAt(5, GROUND + 3, 5) & 15).toBe(12);
    expect(world.lightAt(3, GROUND - 1, 3)).toBe(0); // inside stone
  });

  it('replaces its edits with the server snapshot, undoing cells that lost their edit', async () => {
    const { world, settle } = makeWorld();
    await settle();
    world.setBlock(2, GROUND, 2, Block.Water);
    world.setBlock(3, GROUND, 2, flowingWater(7));
    world.setBlock(9, GROUND, 9, Block.Brick);
    await settle();
    // While we were away the source was removed and its water dried; the brick stayed.
    world.replaceEdits([[9, GROUND, 9, Block.Brick], [1, GROUND, 1, Block.Glass]]);
    await settle();
    expect(world.getBlock(2, GROUND, 2)).toBe(Block.Air);
    expect(world.getBlock(3, GROUND, 2)).toBe(Block.Air);
    expect(world.getBlock(9, GROUND, 9)).toBe(Block.Brick);
    expect(world.getBlock(1, GROUND, 1)).toBe(Block.Glass);
    expect([...world.allEdits()].sort()).toEqual([[1, GROUND, 1, Block.Glass], [9, GROUND, 9, Block.Brick]].sort());
  });

  it('remeshes a player edit before chunks only flowing water changed, and rate limits water', async () => {
    const { pool, world, meshes, settle } = makeWorld();
    await settle();
    let now = performance.now() + 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const regionsMeshed = () => meshes.mock.calls.length;

    // Water flows in chunk (-1, 0) first, then the player builds in chunk (1, 0); one worker slot free.
    pool.slots = 1;
    world.setBlock(-8, GROUND, 8, flowingWater(5));
    world.setBlock(24, GROUND, 8, Block.Brick);
    const before = regionsMeshed();
    world.update(8, 8);
    expect(regionsMeshed()).toBe(before + 1);
    const first = meshes.mock.calls[before][0];
    // The region's centre chunk holds the brick, not the water.
    expect(first[(GROUND * 48 + 8 + 16) * 48 + 8 + 16]).toBe(Block.Brick);
    await pool.flush();
    await settle();

    // A chunk water changed is not meshed again within 250 ms...
    pool.slots = 2;
    world.setBlock(-7, GROUND, 8, flowingWater(4));
    await settle();
    const after = regionsMeshed();
    world.setBlock(-6, GROUND, 8, flowingWater(3));
    world.update(8, 8);
    expect(regionsMeshed()).toBe(after);
    // ...but is once that time has passed.
    now += 300;
    world.update(8, 8);
    expect(regionsMeshed()).toBeGreaterThan(after);
    await pool.flush();
  });
});
