/**
 * Players' survival side on the server (WP-B owns this file). WP0 stub: sandbox
 * rules (nobody is hurt, no inventories). WP-B: SurvivalSim, binary messages
 * (hd k s g i x r rules / S I vt C dead), PLYR/CHST/SATC/SURV sections, and
 * PlayerHooks for ServerEntities (entities.setPlayerHooks(this)).
 */
import type { JoinOptions } from '@hub/shared';
import type { ServerEntities } from './ServerEntities';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';

export class SurvivalRoomHost implements VoxelSubsystem {
  constructor(
    protected readonly room: VoxelRoomApi,
    protected readonly entities: ServerEntities,
    /** SHA-256 prefix (32 hex chars) of a joiner's playerKey, or null. */
    protected readonly keyHash: (options: JoinOptions) => string | null,
    protected readonly saved: ReadonlyMap<string, Uint8Array> | null,
  ) {}

  /** Registers the survival message handlers (WP-B). */
  bind(): void {}
}
