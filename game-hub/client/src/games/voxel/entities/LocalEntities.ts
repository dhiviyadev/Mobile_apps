/**
 * Offline creature simulation (WP-C): an EntityWorld stepped at 20 Hz on the
 * main thread, implementing EntityHost with the local world and the survival
 * controller's PlayerHooks. WP0 stub: no creatures.
 */
import type { EntityWorldApi, PlayerHooks, VoxelMode } from '@hub/shared';
import type { VoxelGame } from '../VoxelGame';

export interface LocalEntitiesOptions {
  mode: VoxelMode;
  /** Offline save `mobs` payload ({ v: 1, list }), or undefined. */
  saved: unknown;
}

export class LocalEntities {
  /** The sim for survival's attacks and arrows (null in the stub). */
  readonly api: EntityWorldApi | null = null;

  constructor(
    protected readonly game: VoxelGame,
    protected readonly opts: LocalEntitiesOptions,
  ) {}

  /** Survival's player side (sandbox: null = defaults). */
  setPlayerHooks(_hooks: PlayerHooks | null): void {}

  /** Fixed 20 Hz steps (at most 3 per frame); nothing while paused. */
  update(_dt: number, _paused: boolean): void {}

  /** Offline save `mobs` payload (tamed creatures), or undefined when none. */
  saveData(): unknown {
    return undefined;
  }

  dispose(): void {}
}
