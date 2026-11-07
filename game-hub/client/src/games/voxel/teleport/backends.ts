/**
 * Where teleport ops go: offline, a TeleportCore in the browser (one player);
 * online, the server (TeleportHost), which sends TeleportEvents back.
 */
import {
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  chunkBlock,
  safeSpotNear,
  TeleportCore,
  type TeleportEvent,
  type TeleportOp,
  TELEPORT,
  VoxelMsg,
  type Waypoint,
} from '@hub/shared';
import type { NetSession } from '../../../net/session';
import type { VoxelGame } from '../VoxelGame';

export interface TeleportPeer {
  id: string;
  name: string;
  color: number;
}

export interface TeleportBackend {
  send(op: TeleportOp): void;
  /** Other players in the world. */
  peers(): TeleportPeer[];
  update(dt: number): void;
  dispose(): void;
}

const LOCAL = 'local';

/**
 * Block reader that also answers for chunks the game has not loaded (a far
 * saved place): generated terrain, without edits there. The game re-checks
 * the landing spot once the real chunk is in (LocalTeleport.update).
 */
function farReader(game: VoxelGame): (x: number, y: number, z: number) => number {
  const cache = new Map<string, Uint8Array>();
  return (x, y, z) => {
    if (game.world.isLoaded(x, z)) return game.world.getBlock(x, y, z);
    if (y < 0 || y >= CHUNK_HEIGHT) return game.world.getBlock(x, y, z);
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    let blocks = cache.get(key);
    if (!blocks) {
      if (cache.size > 8) cache.clear();
      blocks = game.generator.generateChunk(cx, cz);
      cache.set(key, blocks);
    }
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    return chunkBlock(blocks, lx, y, lz);
  };
}

export class LocalTeleport implements TeleportBackend {
  readonly core: TeleportCore;
  private clock = 0;
  /** Landed in a chunk that was not loaded: check the spot once it is. */
  private landing: { x: number; y: number; z: number } | null = null;

  constructor(
    private readonly game: VoxelGame,
    survival: boolean,
    places: readonly Waypoint[],
    autoDecline: boolean,
    onEvent: (e: TeleportEvent) => void,
  ) {
    const read = farReader(game);
    this.core = new TeleportCore({
      now: () => this.clock,
      survival: () => survival,
      pos: () => {
        const b = game.player.body;
        return { x: b.x, y: b.y, z: b.z };
      },
      health: () => (survival ? (game.survival?.health ?? null) : null),
      name: (id) => (id === LOCAL ? 'You' : null),
      bossNear: (x, _y, z) => !!game.localEntities?.api.mobsNear(x, z, TELEPORT.bossRadius).some((m) => m.boss),
      getBlock: read,
      move: (_id, x, y, z) => {
        game.player.teleport(x, y, z);
        this.landing = game.world.isLoaded(x, z) ? null : { x, y, z };
      },
      send: (_id, e) => onEvent(e),
    });
    this.core.addPlayer(LOCAL, places, autoDecline);
  }

  send(op: TeleportOp): void {
    this.core.handle(LOCAL, op);
  }

  peers(): TeleportPeer[] {
    return [];
  }

  update(dt: number): void {
    this.clock += dt * 1000;
    this.core.tick();
    const l = this.landing;
    if (l && this.game.world.isLoaded(l.x, l.z)) {
      this.landing = null;
      const spot = safeSpotNear(this.game.world.getBlock, l.x, l.y, l.z);
      if (spot && (Math.floor(spot.x) !== Math.floor(l.x) || spot.y !== l.y || Math.floor(spot.z) !== Math.floor(l.z))) this.game.player.teleport(spot.x, spot.y, spot.z);
    }
  }

  /** For the world file. */
  saveData(): { places: Waypoint[]; autoDecline: boolean } {
    return { places: [...this.core.places(LOCAL)], autoDecline: this.core.autoDecline(LOCAL) };
  }

  dispose(): void {}
}

interface StatePlayer {
  name: string;
  color: number;
}

export class NetTeleport implements TeleportBackend {
  private readonly off: () => void;

  constructor(
    private readonly session: NetSession,
    onEvent: (e: TeleportEvent) => void,
  ) {
    this.off = session.onMessage(VoxelMsg.TeleportEvent, onEvent);
  }

  send(op: TeleportOp): void {
    this.session.send(VoxelMsg.TeleportOp, op);
  }

  peers(): TeleportPeer[] {
    const out: TeleportPeer[] = [];
    this.session.state?.players?.forEach((p: StatePlayer & { connected: boolean }, id: string) => {
      if (id !== this.session.sessionId && p.connected) out.push({ id, name: p.name, color: p.color });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  update(): void {}

  dispose(): void {
    this.off();
  }
}
