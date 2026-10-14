/**
 * Voxelvale room: a shared, seeded voxel world for up to 16 players.
 */
import type { Client } from '@colyseus/core';
import { type JoinOptions, isVoxelMode, VOXEL_MAX_PLAYERS } from '@hub/shared';
import { HubRoom } from './HubRoom';
import { VoxelPlayer, VoxelState } from './schema/VoxelState';

export class VoxelRoom extends HubRoom<VoxelState, VoxelPlayer> {
  protected readonly gameId = 'voxel' as const;
  override maxClients = VOXEL_MAX_PLAYERS;

  protected resolveMode(requested: unknown): string {
    return isVoxelMode(requested) ? requested : 'sandbox';
  }

  protected setup(_options: JoinOptions): void {
    this.state = new VoxelState();
    this.state.seed = (Math.random() * 0xffffffff) >>> 0;
  }

  protected createPlayer(_client: Client, options: JoinOptions): VoxelPlayer {
    const p = new VoxelPlayer();
    p.color = typeof options.color === 'number' ? options.color & 0xffffff : 0x4fa3ff;
    return p;
  }

  protected override describeStatus(): string {
    return this.mode === 'parkour' ? 'Parkour course' : 'Building';
  }
}
