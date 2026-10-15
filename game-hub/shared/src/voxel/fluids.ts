/**
 * Flowing water: a small cellular simulation shared by the server (online,
 * authoritative) and the client (offline worlds).
 *
 * Block.Water is a still source that only players create. A cell that is air
 * or non-source water becomes:
 *  - falling water if any water is directly above it;
 *  - otherwise flowing water at the best level its 4 side neighbours supply.
 *    A neighbour supplies only while resting on a solid block or a source:
 *    sources supply 7, flowing water of level L supplies L - 1, and falling
 *    water passes on what the water feeding its column would: walking up the
 *    column, the first water that is not falling supplies 7 if it is a
 *    source and L - 1 if it is flowing at level L (anything else, 0);
 *  - otherwise air (it dries up).
 * So a source on flat ground settles into a diamond of radius 7, water
 * travels at most 7 blocks sideways from its source however far it falls on
 * the way (a slope does not restart it at every drop), and water cut off from
 * its source counts down to nothing. Solids, sources and other liquids are
 * never overwritten, and y = 0 is never touched.
 *
 * Work is a deduplicated FIFO queue of cells to re-check. Every applied
 * change queues its 6 neighbours (and, above a falling column, the cells
 * beside where it lands), so only cells near a change are visited and the
 * queue drains once the water has settled.
 */
import { Block, flowingWater, IS_SOLID, isWater, waterLevel } from './blocks';
import { chunkInWorld, chunkKey, packPos, toChunkCoord, unpackPos } from './chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE } from './constants';

export interface FluidAccess {
  get(x: number, y: number, z: number): number;
  /** Applies a change; returning false means it was refused and did not happen. */
  set(x: number, y: number, z: number, id: number): boolean | void;
  /**
   * Optional: false skips a queued cell for now, when the blocks around it are
   * not known yet. The access then has to schedule it again once they are.
   */
  ready?(x: number, y: number, z: number): boolean;
}

export interface FluidOptions {
  /** Most cells waiting at once; further schedules are dropped (see `dropped`). */
  maxQueue?: number;
  /** World height: cells outside 0..height-1 are ignored. At most 256 (packPos range). */
  height?: number;
}

export interface FluidChange {
  x: number;
  y: number;
  z: number;
  id: number;
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const PACK_LIMIT = 32767;

export class FluidSimulator {
  /** Cells not queued because the queue was full. */
  dropped = 0;
  private readonly maxQueue: number;
  private readonly height: number;
  private queue: number[] = [];
  private head = 0;
  private readonly queued = new Set<number>();

  constructor(
    private readonly access: FluidAccess,
    opts: FluidOptions = {},
  ) {
    this.maxQueue = opts.maxQueue ?? 50_000;
    this.height = Math.min(256, opts.height ?? CHUNK_HEIGHT);
  }

  /** Cells waiting to be checked. */
  get pending(): number {
    return this.queue.length - this.head;
  }

  /** Queues a cell and its 6 neighbours for a check on the next step. */
  schedule(x: number, y: number, z: number): void {
    this.enqueue(x, y, z);
    this.enqueueNeighbours(x, y, z);
  }

  /**
   * Call after a block edit made outside the simulation. Besides the cell's
   * own neighbourhood this re-checks the cells beside the block above, since
   * a solid or a source placed or removed here decides whether water above
   * rests on it (and so spreads sideways), and the cells beside where a
   * falling column below it lands, since this cell may be what feeds it.
   */
  notifyEdit(x: number, y: number, z: number): void {
    this.schedule(x, y, z);
    this.schedule(x, y + 1, z);
    this.scheduleLanding(x, y, z);
  }

  /**
   * Like schedule(), but queues only those of the 7 cells the rules would
   * change now, so settled water takes no queue space (for re-checking many
   * cells, such as a restored world's water). The blocks around the cells
   * must be known (see FluidAccess.ready).
   */
  scheduleIfUnsettled(x: number, y: number, z: number): void {
    if (this.wouldChange(x, y, z)) this.enqueue(x, y, z);
    for (const [dx, dy, dz] of NEIGHBOURS) if (this.wouldChange(x + dx, y + dy, z + dz)) this.enqueue(x + dx, y + dy, z + dz);
  }

  /** True when the rules would change the cell given the blocks around it now. */
  wouldChange(x: number, y: number, z: number): boolean {
    if (y < 1 || y >= this.height || Math.abs(x) > PACK_LIMIT || Math.abs(z) > PACK_LIMIT) return false;
    const current = this.access.get(x, y, z);
    return this.settle(x, y, z, current) !== current;
  }

  /** Forgets all queued work. */
  clear(): void {
    this.queue = [];
    this.head = 0;
    this.queued.clear();
  }

  /**
   * Checks up to `maxUpdates` queued cells, in the order they were queued,
   * and returns the changes that were applied. Cells queued during this step
   * wait for the next one.
   */
  step(maxUpdates = 512): FluidChange[] {
    const changes: FluidChange[] = [];
    const end = Math.min(this.queue.length, this.head + Math.max(0, maxUpdates));
    while (this.head < end) {
      const key = this.queue[this.head++];
      this.queued.delete(key);
      const [x, y, z] = unpackPos(key);
      if (this.access.ready?.(x, y, z) === false) continue;
      const current = this.access.get(x, y, z);
      const id = this.settle(x, y, z, current);
      if (id === current || this.access.set(x, y, z, id) === false) continue;
      changes.push({ x, y, z, id });
      this.enqueueNeighbours(x, y, z);
      this.scheduleLanding(x, y, z);
    }
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > 4096 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return changes;
  }

  /** The block a cell should hold given its neighbours (its current block if the rules leave it alone). */
  private settle(x: number, y: number, z: number, current: number): number {
    if (current !== Block.Air && (current === Block.Water || !isWater(current))) return current;
    const access = this.access;
    if (y + 1 < this.height && isWater(access.get(x, y + 1, z))) return Block.WaterFalling;
    let best = 0;
    for (const [dx, dz] of SIDES) {
      const side = access.get(x + dx, y, z + dz);
      // Nothing supplies more than 7, so an upper bound skips most sides cheaply.
      if (Math.min(7, waterLevel(side) - 1) <= best) continue;
      const below = access.get(x + dx, y - 1, z + dz);
      if (IS_SOLID[below] || below === Block.Water) best = Math.max(best, this.supply(x + dx, y, z + dz, side));
    }
    return flowingWater(best);
  }

  /** What water cell `id` at (x, y, z) supplies to its sides while it rests. */
  private supply(x: number, y: number, z: number, id: number): number {
    // Falling water passes on what the water feeding its column supplies.
    for (let top = y + 1; id === Block.WaterFalling; top++) id = top < this.height ? this.access.get(x, top, z) : Block.Air;
    if (id === Block.Water) return 7;
    return isWater(id) ? waterLevel(id) - 1 : 0;
  }

  /**
   * Re-checks the cells beside where the falling column below (x, y, z)
   * lands, if there is one: what they get from it depends on the water
   * feeding the column, which may just have changed.
   */
  private scheduleLanding(x: number, y: number, z: number): void {
    let by = y - 1;
    if (by < 1 || this.access.get(x, by, z) !== Block.WaterFalling) return;
    while (by > 1 && this.access.get(x, by - 1, z) === Block.WaterFalling) by--;
    for (const [dx, dz] of SIDES) this.enqueue(x + dx, by, z + dz);
  }

  private enqueueNeighbours(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of NEIGHBOURS) this.enqueue(x + dx, y + dy, z + dz);
  }

  private enqueue(x: number, y: number, z: number): void {
    // y = 0 is never modified, so it is never queued either.
    if (y < 1 || y >= this.height || Math.abs(x) > PACK_LIMIT || Math.abs(z) > PACK_LIMIT) return;
    const key = packPos(x, y, z);
    if (this.queued.has(key)) return;
    if (this.queued.size >= this.maxQueue) {
      this.dropped++;
      return;
    }
    this.queued.add(key);
    this.queue.push(key);
  }
}

// ---- worlds that stream chunks (offline play) ---------------------------------------

/** What StreamedFluids needs from a world that only holds the chunks around the player. */
export interface StreamedWorld {
  /** Block id; columns whose chunk is not loaded read as solid. */
  getBlock(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): void;
  /** True when the chunk holding column (x, z) has its blocks. */
  isLoaded(x: number, z: number): boolean;
}

/** An edit as [x, y, z, id]. */
type EditTuple = [number, number, number, number];

/**
 * Flowing water over a world that streams chunks in and out (offline play on
 * the client; online, the server runs the water).
 *
 * Unloaded chunks read as solid, so a cell in or beside one could dry up or
 * spread wrongly (or be skipped for good): it is not checked but waits,
 * grouped by chunk, until that chunk and its 4 side neighbours have loaded.
 * Saved water waits the same way. Waiting costs one check per chunk per
 * step, not one per cell.
 *
 * It also remembers which cells hold a player's edit (made this session or
 * loaded from the save). Every other edited cell was only ever written by the
 * simulation over generated air, so saves leave it out; saved sources flow
 * again after loading.
 */
export class StreamedFluids {
  private readonly sim: FluidSimulator;
  /** chunkKey -> packed cells waiting for that chunk and its side neighbours to load. */
  private readonly waiting = new Map<string, { cx: number; cz: number; cells: Set<number> }>();
  /** Packed positions of player edits. */
  private readonly edited = new Set<number>();

  constructor(
    private readonly world: StreamedWorld,
    opts: FluidOptions = {},
  ) {
    this.sim = new FluidSimulator(
      {
        get: (x, y, z) => world.getBlock(x, y, z),
        set: (x, y, z, id) => world.setBlock(x, y, z, id),
        ready: (x, y, z) => this.cellReady(x, y, z),
      },
      opts,
    );
  }

  /** Cells queued for the next steps. */
  get pending(): number {
    return this.sim.pending;
  }

  /** Cells waiting for their chunks to load. */
  get waitingCells(): number {
    let n = 0;
    for (const w of this.waiting.values()) n += w.cells.size;
    return n;
  }

  /**
   * Takes note of saved edits already applied to the world. Once its chunk
   * loads, saved water is re-checked, and so is a dug-out cell (it may border
   * water that filled it before the save, which is not saved).
   */
  restore(edits: Iterable<EditTuple>): void {
    for (const [x, y, z, id] of edits) {
      this.edited.add(packPos(x, y, z));
      if (isWater(id) || id === Block.Air) this.wait(x, y, z);
    }
  }

  /** Call after every player edit, once it is applied to the world. */
  notifyEdit(x: number, y: number, z: number): void {
    this.edited.add(packPos(x, y, z));
    this.sim.notifyEdit(x, y, z);
  }

  /** Queues the waiting cells whose chunks have loaded, then runs one simulation step. */
  step(maxUpdates?: number): FluidChange[] {
    for (const [key, w] of this.waiting) {
      if (!this.ready(w.cx * CHUNK_SIZE, w.cz * CHUNK_SIZE, CHUNK_SIZE)) continue;
      this.waiting.delete(key);
      for (const cell of w.cells) {
        const [x, y, z] = unpackPos(cell);
        if (this.nearWater(x, y, z)) this.sim.schedule(x, y, z);
      }
    }
    return this.sim.step(maxUpdates);
  }

  /** Forgets all queued and waiting work. */
  clear(): void {
    this.sim.clear();
    this.waiting.clear();
  }

  /**
   * The edits a save should keep, from the world's full edit list: cells only
   * the simulation wrote are left out, and simulated water over a player's
   * edit is kept as the air under it.
   */
  *saveEdits(edits: Iterable<EditTuple>): Generator<EditTuple> {
    for (const [x, y, z, id] of edits) {
      if (!this.edited.has(packPos(x, y, z))) continue;
      yield [x, y, z, isWater(id) && id !== Block.Water ? Block.Air : id];
    }
  }

  /** Only water, or a cell water could flow into, can change; the rest need no check. */
  private nearWater(x: number, y: number, z: number): boolean {
    const get = (bx: number, by: number, bz: number) => isWater(this.world.getBlock(bx, by, bz));
    return get(x, y, z) || get(x, y + 1, z) || get(x - 1, y, z) || get(x + 1, y, z) || get(x, y, z - 1) || get(x, y, z + 1);
  }

  private cellReady(x: number, y: number, z: number): boolean {
    if (this.ready(x, z, 1)) return true;
    this.wait(x, y, z);
    return false;
  }

  private wait(x: number, y: number, z: number): void {
    const cx = toChunkCoord(x);
    const cz = toChunkCoord(z);
    const key = chunkKey(cx, cz);
    let w = this.waiting.get(key);
    if (!w) this.waiting.set(key, (w = { cx, cz, cells: new Set() }));
    w.cells.add(packPos(x, y, z));
  }

  /**
   * True when column (x, z) is loaded and so are the columns `d` blocks away
   * on each side (columns outside the world read as solid anyway, so they
   * count as loaded). With d = 1 the rules see real blocks around the column;
   * with d = CHUNK_SIZE from a chunk's corner, that holds for the whole chunk.
   */
  private ready(x: number, z: number, d: number): boolean {
    const loaded = (bx: number, bz: number) => this.world.isLoaded(bx, bz) || !chunkInWorld(toChunkCoord(bx), toChunkCoord(bz));
    return loaded(x, z) && loaded(x - d, z) && loaded(x + d, z) && loaded(x, z - d) && loaded(x, z + d);
  }
}
