/**
 * Server-side flowing water for a Voxelvale world. Runs the shared
 * FluidSimulator over the authoritative ServerVoxelWorld; every change it
 * applies is an ordinary edit (counted against the room's edit budget) that
 * the room broadcasts like a player edit, so clients never simulate water.
 * Water may fill only part of that budget (editShare), so however far it
 * spreads, players can still build.
 */
import {
  Block,
  type BlockEdit,
  CHUNK_HEIGHT,
  chunkInWorld,
  FluidSimulator,
  isWater,
  toChunkCoord,
} from '@hub/shared';
import type { ServerVoxelWorld } from './ServerVoxelWorld';

export interface VoxelFluidsOptions {
  /** Most cells waiting at once (see FluidSimulator). */
  maxQueue?: number;
  /** Cells checked per step(). */
  maxUpdates?: number;
  /**
   * Share of the world's edit budget water may fill (0..1, default 0.75), so
   * a flood never takes the edits kept for building. Past it, water still
   * changes or dries cells that are already edits but claims no new ones.
   */
  editShare?: number;
}

export class VoxelFluids {
  private readonly sim: FluidSimulator;
  private readonly maxUpdates: number;
  /** Edit count past which water may not add edits. */
  private readonly waterLimit: number;

  constructor(
    private readonly world: ServerVoxelWorld,
    private readonly onChange: (x: number, y: number, z: number, id: number) => void,
    opts: VoxelFluidsOptions = {},
  ) {
    this.maxUpdates = opts.maxUpdates ?? 512;
    this.waterLimit = Math.floor(world.maxEdits * Math.min(1, Math.max(0, opts.editShare ?? 0.75)));
    // Outside the world reads as bedrock, so water stops at the world edge.
    const inWorld = (x: number, z: number) => chunkInWorld(toChunkCoord(x), toChunkCoord(z));
    this.sim = new FluidSimulator(
      {
        get: (x, y, z) => (inWorld(x, z) ? world.getBlock(x, y, z) : Block.Bedrock),
        set: (x, y, z, id) => inWorld(x, z) && this.write(x, y, z, id),
      },
      { maxQueue: opts.maxQueue, height: CHUNK_HEIGHT },
    );
  }

  /** Cells waiting to be checked. */
  get pending(): number {
    return this.sim.pending;
  }

  /** Cells dropped because the queue was full. */
  get dropped(): number {
    return this.sim.dropped;
  }

  /** Call after every accepted player edit. */
  notifyEdit(x: number, y: number, z: number): void {
    this.sim.notifyEdit(x, y, z);
  }

  /** Runs one simulation step, reporting each applied change. Returns how many there were. */
  step(): number {
    const changes = this.sim.step(this.maxUpdates);
    for (const c of changes) this.onChange(c.x, c.y, c.z, c.id);
    return changes.length;
  }

  /**
   * Picks up flows that were still moving when a saved world was stored.
   * Flowing and falling water is re-checked; sources are too, since a
   * source saved before it spread has only air around it.
   */
  resumeFrom(edits: Iterable<BlockEdit>): void {
    for (const e of edits) if (isWater(e.id)) this.sim.schedule(e.x, e.y, e.z);
  }

  /**
   * Applies a simulated change; false leaves the cell alone. setBlock refuses
   * once the whole budget is spent. Past water's share, a change that added an
   * edit is undone: putting back the generated block drops that edit again.
   */
  private write(x: number, y: number, z: number, id: number): boolean {
    const world = this.world;
    const count = world.editCount;
    if (count < this.waterLimit) return world.setBlock(x, y, z, id);
    const previous = world.getBlock(x, y, z);
    if (!world.setBlock(x, y, z, id)) return false;
    if (world.editCount <= count) return true;
    world.setBlock(x, y, z, previous);
    return false;
  }
}
