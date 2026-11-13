/**
 * Rift Gates on the server (package D): the shared PortalCore with the room as
 * its world. Lighting a gate and crossing are server-validated: the stone must
 * be in reach, a complete ring is required, survival takes a Dusk Lens from the
 * player's inventory, and the crossing is an ordinary teleport (Teleport message
 * + movement grace) that may generate the other side's chunks and build the
 * partner gate with server edits. Breaking a lit stone closes its gate.
 */
import type { Client } from '@colyseus/core';
import { type BlockEdit, Item, parsePortalOp, PortalCore, type PortalEvent, TELEPORT, TokenBucket, VoxelMsg } from '@hub/shared';
import type { VoxelPlayer } from '../rooms/schema/VoxelState';
import type { ServerEntities } from './ServerEntities';
import type { SurvivalRoomHost } from './SurvivalRoomHost';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';

export class PortalHost implements VoxelSubsystem {
  readonly core: PortalCore;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly room: VoxelRoomApi,
    entities: ServerEntities | null,
    survival: SurvivalRoomHost | null,
  ) {
    const player = (id: string): VoxelPlayer | undefined => room.state.players.get(id);
    this.core = new PortalCore({
      now: () => Date.now(),
      survival: () => room.mode === 'survival',
      genVersion: () => room.state.genVersion,
      pos: (id) => {
        const p = player(id);
        return p && p.connected ? { x: p.x, y: p.y, z: p.z } : null;
      },
      alive: (id) => survival?.sim.players.get(id)?.alive ?? true,
      read: (x, y, z) => (room.world.blockInWorld(x, y, z) ? room.world.getBlock(x, y, z) : 0),
      edit: (x, y, z, id) => {
        room.applyServerEdit(x, y, z, id);
      },
      takeKey: (id) => (room.mode === 'survival' ? !!survival?.sim.takeItem(id, Item.DuskLens, 1) : true),
      bossNear: (x, _y, z) => !!entities?.api?.mobsNear(x, z, TELEPORT.bossRadius).some((m) => m.boss),
      move: (id, x, y, z) => {
        room.teleport(id, x, y, z);
        const p = player(id);
        if (p) {
          p.x = x;
          p.y = y;
          p.z = z;
        }
        // Chunks of the far side stream in behind the jump: a little extra grace for the fall.
        room.graceUntil(id, 4000);
      },
      send: (id, e) => this.send(id, e),
    });
  }

  bind(): void {
    this.room.onJson(VoxelMsg.PortalOp, (client, data) => {
      const op = parsePortalOp(data);
      if (!op) return;
      let b = this.buckets.get(client.sessionId);
      if (!b) this.buckets.set(client.sessionId, (b = new TokenBucket(6, 2)));
      if (!b.take()) return;
      this.core.handle(client.sessionId, op);
    });
  }

  join(client: Client): void {
    this.core.addPlayer(client.sessionId);
  }

  leave(sessionId: string): void {
    this.core.removePlayer(sessionId);
    this.buckets.delete(sessionId);
  }

  afterEdit(_sessionId: string | null, e: BlockEdit, before: number): void {
    this.core.afterEdit(e.x, e.y, e.z, before, e.id);
  }

  tick(): void {
    this.core.tick();
  }

  private send(id: string, e: PortalEvent): void {
    this.room.client(id)?.send(VoxelMsg.PortalEvent, e);
  }
}
