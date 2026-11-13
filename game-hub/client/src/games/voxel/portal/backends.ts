/**
 * Where Lattice Ring ops go: offline, a PortalCore in the browser (one player,
 * reading unloaded terrain from the generator plus the recorded edits);
 * online, the server (PortalHost), which sends PortalEvents back.
 */
import { CHUNK_HEIGHT, CHUNK_SIZE, chunkBlock, Item, PortalCore, type PortalEvent, type PortalOp, TELEPORT, VoxelMsg } from '@hub/shared';
import type { NetSession } from '../../../net/session';
import type { VoxelGame } from '../VoxelGame';

export interface PortalBackend {
  send(op: PortalOp): void;
  update(dt: number): void;
  /** Offline: the core, for tests and edit hooks. */
  readonly core?: PortalCore;
  /** A block changed (offline: lit stones close their ring). */
  afterEdit?(x: number, y: number, z: number, before: number, after: number): void;
  dispose(): void;
}

const LOCAL = 'local';

/** Reads any cell: loaded chunks, else the recorded edit, else freshly generated terrain (cached). */
function reader(game: VoxelGame): (x: number, y: number, z: number) => number {
  const cache = new Map<string, Uint8Array>();
  return (x, y, z) => {
    if (game.world.isLoaded(x, z)) return game.world.getBlock(x, y, z);
    if (y < 0 || y >= CHUNK_HEIGHT) return game.world.getBlock(x, y, z);
    const edit = game.world.peekEdit(x, y, z);
    if (edit !== undefined) return edit;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    let blocks = cache.get(key);
    if (!blocks) {
      if (cache.size > 24) cache.clear();
      blocks = game.generator.generateChunk(cx, cz);
      cache.set(key, blocks);
    }
    return chunkBlock(blocks, x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
  };
}

export class LocalPortal implements PortalBackend {
  readonly core: PortalCore;
  private clock = 0;

  constructor(
    game: VoxelGame,
    survival: boolean,
    onEvent: (e: PortalEvent) => void,
  ) {
    const read = reader(game);
    this.core = new PortalCore({
      now: () => this.clock,
      survival: () => survival,
      genVersion: () => game.generator.genVersion,
      pos: () => {
        const b = game.player.body;
        return { x: b.x, y: b.y, z: b.z };
      },
      alive: () => !(game.survival?.isDead ?? false),
      read,
      edit: (x, y, z, id) => game.applyWorldEdit(x, y, z, id),
      takeKey: () => game.survival?.takeLocalItem(Item.DuskLens, 1) ?? true,
      bossNear: (x, _y, z) => !!game.localEntities?.api.mobsNear(x, z, TELEPORT.bossRadius).some((m) => m.boss),
      move: (_id, x, y, z) => game.player.teleport(x, y, z),
      send: (_id, e) => onEvent(e),
    });
    this.core.addPlayer(LOCAL);
  }

  send(op: PortalOp): void {
    this.core.handle(LOCAL, op);
  }

  update(dt: number): void {
    this.clock += dt * 1000;
    this.core.tick();
  }

  afterEdit(x: number, y: number, z: number, before: number, after: number): void {
    this.core.afterEdit(x, y, z, before, after);
  }

  dispose(): void {}
}

export class NetPortal implements PortalBackend {
  private readonly off: () => void;

  constructor(
    private readonly session: NetSession,
    onEvent: (e: PortalEvent) => void,
  ) {
    this.off = session.onMessage(VoxelMsg.PortalEvent, onEvent);
  }

  send(op: PortalOp): void {
    this.session.send(VoxelMsg.PortalOp, op);
  }

  update(): void {}

  dispose(): void {
    this.off();
  }
}
