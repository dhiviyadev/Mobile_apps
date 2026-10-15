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
  packPos,
  toChunkCoord,
  unpackPos,
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
  /**
   * Called after a step in which water was refused a change because it
   * reached its share of the edit budget (or the whole budget is spent); at
   * most once a minute.
   */
  onLimit?: () => void;
}

/**
 * Restored cells looked at per step at most, so resuming a big save never
 * stalls a tick (the first look at a chunk generates it).
 */
const RESUME_SCAN = 2048;
/** Shortest time between two onLimit calls. */
const LIMIT_NOTICE_MS = 60_000;

export class VoxelFluids {
  private readonly sim: FluidSimulator;
  private readonly maxUpdates: number;
  /** Edit count past which water may not add edits. */
  private readonly waterLimit: number;
  private readonly onLimit: (() => void) | undefined;
  /** Packed cells from a restored world still to feed in, oldest edit first (fed from the end). */
  private restored: Float64Array | null = null;
  /** Cells of `restored` not fed in yet (the first restoredLeft). */
  private restoredLeft = 0;
  /** True once a change was refused for the edit budget during the current step. */
  private refused = false;
  private limitNoticeAt = -Infinity;

  constructor(
    private readonly world: ServerVoxelWorld,
    private readonly onChange: (x: number, y: number, z: number, id: number) => void,
    opts: VoxelFluidsOptions = {},
  ) {
    this.maxUpdates = opts.maxUpdates ?? 512;
    this.waterLimit = Math.floor(world.maxEdits * Math.min(1, Math.max(0, opts.editShare ?? 0.75)));
    this.onLimit = opts.onLimit;
    this.sim = new FluidSimulator(
      {
        get: (x, y, z) => this.blockAt(x, y, z),
        set: (x, y, z, id) => inWorld(x, z) && this.write(x, y, z, id),
      },
      { maxQueue: opts.maxQueue, height: CHUNK_HEIGHT },
    );
  }

  /** Cells waiting to be checked. */
  get pending(): number {
    return this.sim.pending;
  }

  /** Cells from a restored world not yet fed to the simulation (see resumeFrom). */
  get backlog(): number {
    return this.restoredLeft;
  }

  /** Cells dropped because the queue was full. */
  get dropped(): number {
    return this.sim.dropped;
  }

  /** Call after every accepted player edit. */
  notifyEdit(x: number, y: number, z: number): void {
    this.sim.notifyEdit(x, y, z);
  }

  /**
   * Feeds in restored cells (see resumeFrom), then runs one simulation step,
   * reporting each applied change. Returns how many there were.
   */
  step(): number {
    this.resume();
    this.refused = false;
    const changes = this.sim.step(this.maxUpdates);
    for (const c of changes) this.onChange(c.x, c.y, c.z, c.id);
    if (this.refused) this.limitReached();
    return changes.length;
  }

  /**
   * Picks up flows that were still moving when a saved world was stored.
   * Water edits are re-checked (a source saved before it spread has only air
   * around it), and so are dug-out cells beside or under water, which the
   * water may not have filled before the save.
   *
   * Nothing is queued here: a world with a lot of water would overflow the
   * queue and lose flows for good. step() feeds the cells in instead, newest
   * edit first, only while less than a step's work is queued, and queues only
   * the cells the rules would change, so new water never waits long behind
   * the saved world.
   */
  resumeFrom(edits: Iterable<BlockEdit>): void {
    const cells = this.restored ? Array.from(this.restored.subarray(0, this.restoredLeft)) : [];
    for (const e of edits) if (isWater(e.id) || e.id === Block.Air) cells.push(packPos(e.x, e.y, e.z));
    this.restored = cells.length ? Float64Array.from(cells) : null;
    this.restoredLeft = cells.length;
  }

  /** Feeds restored cells to the simulation while it holds less than one step's work. */
  private resume(): void {
    const restored = this.restored;
    if (!restored) return;
    let left = this.restoredLeft;
    const stop = Math.max(0, left - RESUME_SCAN);
    while (left > stop && this.sim.pending < this.maxUpdates) {
      const [x, y, z] = unpackPos(restored[--left]);
      if (this.nearWater(x, y, z)) this.sim.scheduleIfUnsettled(x, y, z);
    }
    this.restoredLeft = left;
    if (left === 0) this.restored = null;
  }

  /** Only a cell holding water, or with water above or beside it, can change (or change its neighbours). */
  private nearWater(x: number, y: number, z: number): boolean {
    const wet = (bx: number, by: number, bz: number) => isWater(this.blockAt(bx, by, bz));
    return wet(x, y, z) || wet(x, y + 1, z) || wet(x - 1, y, z) || wet(x + 1, y, z) || wet(x, y, z - 1) || wet(x, y, z + 1);
  }

  /** The world's block; outside the world reads as bedrock, so water stops at the world edge. */
  private blockAt(x: number, y: number, z: number): number {
    return inWorld(x, z) ? this.world.getBlock(x, y, z) : Block.Bedrock;
  }

  private limitReached(): void {
    const now = Date.now();
    if (now - this.limitNoticeAt < LIMIT_NOTICE_MS) return;
    this.limitNoticeAt = now;
    this.onLimit?.();
  }

  /**
   * Applies a simulated change; false leaves the cell alone. setBlock refuses
   * once the whole budget is spent. Past water's share, a change that added an
   * edit is undone: putting back the generated block drops that edit again.
   */
  private write(x: number, y: number, z: number, id: number): boolean {
    const world = this.world;
    const count = world.editCount;
    if (count < this.waterLimit) {
      if (world.setBlock(x, y, z, id)) return true;
    } else {
      const previous = world.getBlock(x, y, z);
      if (world.setBlock(x, y, z, id)) {
        if (world.editCount <= count) return true;
        world.setBlock(x, y, z, previous);
      }
    }
    this.refused = true;
    return false;
  }
}

function inWorld(x: number, z: number): boolean {
  return chunkInWorld(toChunkCoord(x), toChunkCoord(z));
}
