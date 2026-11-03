/**
 * Teleport menu on the server (Package W): the shared TeleportCore with the
 * room as its world. The server is authoritative: places belong to the player
 * who saved them, requests must be accepted by their target, the destination
 * is checked for a safe spot (generating its chunks if needed) and the jump
 * uses the room's teleport (Teleport message + movement grace), so the speed
 * check never fights it. Places persist in the WAYP section by hashed playerKey.
 */
import type { Client } from '@colyseus/core';
import {
  decodeWaypoints,
  encodeWaypoints,
  type JoinOptions,
  parseTeleportOp,
  SECTION_TAGS,
  TELEPORT,
  TeleportCore,
  type TeleportEvent,
  TokenBucket,
  VoxelMsg,
  type WaypointRecord,
} from '@hub/shared';
import type { VoxelPlayer } from '../rooms/schema/VoxelState';
import type { ServerEntities } from './ServerEntities';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';

/** Players' place lists kept in a world (the most recently seen first beyond this are dropped). */
const MAX_RECORDS = 256;

export class TeleportHost implements VoxelSubsystem {
  readonly core: TeleportCore;
  private readonly keys = new Map<string, string | null>();
  private readonly records = new Map<string, WaypointRecord>();
  private readonly buckets = new Map<string, TokenBucket>();
  private unreadable = false;
  private hadSection = false;

  constructor(
    private readonly room: VoxelRoomApi,
    private readonly entities: ServerEntities | null,
    private readonly keyHash: (options: JoinOptions) => string | null,
  ) {
    const player = (id: string): VoxelPlayer | undefined => room.state.players.get(id);
    this.core = new TeleportCore({
      now: () => Date.now(),
      survival: () => room.mode === 'survival',
      pos: (id) => {
        const p = player(id);
        return p ? { x: p.x, y: p.y, z: p.z } : null;
      },
      health: (id) => (room.mode === 'survival' ? (player(id)?.hp ?? null) : null),
      name: (id) => player(id)?.name ?? null,
      bossNear: (x, _y, z) => !!this.entities?.api?.mobsNear(x, z, TELEPORT.bossRadius).some((m) => m.boss),
      getBlock: (x, y, z) => room.world.getBlock(x, y, z),
      move: (id, x, y, z) => {
        room.teleport(id, x, y, z);
        const p = player(id);
        if (p) {
          p.x = x;
          p.y = y;
          p.z = z;
        }
      },
      send: (id, e) => this.send(id, e),
    });
  }

  bind(): void {
    this.room.onJson(VoxelMsg.TeleportOp, (client, data) => {
      const op = parseTeleportOp(data);
      if (!op) return;
      let b = this.buckets.get(client.sessionId);
      if (!b) this.buckets.set(client.sessionId, (b = new TokenBucket(8, 2)));
      if (!b.take()) return;
      this.core.handle(client.sessionId, op);
    });
  }

  join(client: Client, _player: VoxelPlayer, options: JoinOptions): void {
    let key = this.keyHash(options);
    // A second session with the same key keeps its places for this visit only.
    if (key && [...this.keys.values()].includes(key)) key = null;
    this.keys.set(client.sessionId, key);
    const rec = key ? this.records.get(key) : undefined;
    this.core.addPlayer(client.sessionId, rec?.places ?? [], rec?.autoDecline ?? false);
  }

  reconnect(client: Client): void {
    const id = client.sessionId;
    this.send(id, { kind: 'places', list: [...this.core.places(id)], autoDecline: this.core.autoDecline(id) });
    for (const r of this.core.pendingFor(id)) this.send(id, { kind: 'request', ...r });
  }

  leave(sessionId: string): void {
    const kept = this.core.removePlayer(sessionId);
    const key = this.keys.get(sessionId);
    if (key && kept) this.records.set(key, { key, ...kept });
    this.keys.delete(sessionId);
    this.buckets.delete(sessionId);
  }

  tick(): void {
    this.core.tick();
  }

  saveSections(out: Map<string, Uint8Array>): void {
    if (this.unreadable) return;
    const recs = new Map(this.records);
    for (const [id, key] of this.keys) {
      if (key) recs.set(key, { key, places: [...this.core.places(id)], autoDecline: this.core.autoDecline(id) });
    }
    const list = [...recs.values()].filter((r) => r.places.length || r.autoDecline).slice(-MAX_RECORDS);
    if (list.length || this.hadSection) {
      out.set(SECTION_TAGS.waypoints, encodeWaypoints(list));
      this.hadSection = true;
    }
  }

  restoreSections(sections: ReadonlyMap<string, Uint8Array>): void {
    const bytes = sections.get(SECTION_TAGS.waypoints);
    if (!bytes) return;
    this.hadSection = true;
    try {
      for (const r of decodeWaypoints(bytes)) this.records.set(r.key, r);
    } catch (err) {
      // Kept as restored (the room writes unknown/unread sections back unchanged).
      this.unreadable = true;
      this.room.log.warn('could not read the WAYP section; keeping it unchanged', err);
    }
  }

  hasProgress(): boolean {
    if (this.records.size) return true;
    for (const [id, key] of this.keys) if (key && this.core.places(id).length) return true;
    return false;
  }

  private send(id: string, e: TeleportEvent): void {
    if (e.kind === 'places') this.room.markDirty();
    this.room.client(id)?.send(VoxelMsg.TeleportEvent, e);
  }
}
