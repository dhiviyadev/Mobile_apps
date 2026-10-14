/**
 * Arcfire Arena room: round-based competitive shooter (1v1, 2v2, FFA).
 */
import type { Client } from '@colyseus/core';
import { ARENA_MODE_INFO, type ArenaMode, isArenaMode, type JoinOptions } from '@hub/shared';
import { HubRoom } from './HubRoom';
import { ArenaPlayer, ArenaState } from './schema/ArenaState';

export class ArenaRoom extends HubRoom<ArenaState, ArenaPlayer> {
  protected readonly gameId = 'arena' as const;

  protected resolveMode(requested: unknown): string {
    return isArenaMode(requested) ? requested : '1v1';
  }

  protected setup(_options: JoinOptions): void {
    this.maxClients = ARENA_MODE_INFO[this.mode as ArenaMode].maxPlayers;
    this.state = new ArenaState();
  }

  protected createPlayer(_client: Client, options: JoinOptions): ArenaPlayer {
    const p = new ArenaPlayer();
    p.color = typeof options.color === 'number' ? options.color & 0xffffff : 0xff7a45;
    return p;
  }

  protected override describeStatus(): string {
    return this.state.phase === 'waiting' ? 'Waiting for players' : 'In match';
  }
}
