/**
 * Creatures on the server (WP-C owns this file). WP0 stub: no creatures.
 * WP-C: EntityWorld + snapshots ('N' 10 Hz) + events ('V') + 'mi'/'mn' handlers,
 * implements EntityWorldApi for survival and calls PlayerHooks (setPlayerHooks).
 */
import type { BlockEdit, EntityWorldApi, PlayerHooks } from '@hub/shared';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';

export class ServerEntities implements VoxelSubsystem {
  /** The creature sim, or null when none runs (parkour, stub). */
  readonly api: EntityWorldApi | null = null;
  private hooks: PlayerHooks | null = null;

  constructor(
    protected readonly room: VoxelRoomApi,
    protected readonly saved: ReadonlyMap<string, Uint8Array> | null,
  ) {}

  /** Survival plugs in its player side here (sandbox: null = defaults). */
  setPlayerHooks(hooks: PlayerHooks | null): void {
    this.hooks = hooks;
  }

  /** Placement check: a solid block may not be placed into a creature. */
  validateEdit(_sessionId: string, _e: BlockEdit, _current: number): string | null {
    void this.hooks;
    return null;
  }
}
