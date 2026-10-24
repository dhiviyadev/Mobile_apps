/**
 * Players' survival and combat side in the running game (WP-B owns this
 * folder after WP0): vitals HUD, inventory screen, crafting, held-item view,
 * melee/bow/crossbow/shield, drops, death screen, damage numbers. Runs in
 * sandbox (creative: weapons, no vitals) and survival. Offline it owns
 * LocalSurvival; online NetSurvival (attachNet).
 * WP0 stub: creative sandbox behaviour (no hotbar of its own).
 */
import type { EntityWorldApi } from '@hub/shared';
import type { InputFrame } from '../../../core/input/InputManager';
import type { HotbarSource, MoveMods, VoxelModule } from '../modules';
import type { VoxelNet } from '../net/VoxelNet';
import type { VoxelGame } from '../VoxelGame';

export interface SurvivalControllerOptions {
  mode: 'sandbox' | 'survival';
  online: boolean;
  /** Offline survival save data (opaque to VoxelGame; see index.ts OfflineSave.survival). */
  saved: unknown;
}

export class SurvivalController implements VoxelModule {
  /** Survival: the 9-slot inventory hotbar. Null: the world area's sandbox hotbar is used. */
  readonly hotbar: HotbarSource | null = null;

  constructor(
    protected readonly game: VoxelGame,
    protected readonly opts: SurvivalControllerOptions,
  ) {}

  /** Offline: the creature sim to hand arrows, melee and PlayerHooks to (set by VoxelGame once LocalEntities exists). */
  setEntities(_api: EntityWorldApi | null): void {}

  /** Online: register the survival message handlers on net.session. */
  attachNet(_net: VoxelNet): void {}

  /** Opens the bag (survival). */
  openInventory(): void {}

  beforePhysics(_dt: number, _input: InputFrame): MoveMods | void {}

  update(_dt: number, _input: InputFrame, _paused: boolean): void {}

  isModalOpen(): boolean {
    return false;
  }

  /** Offline survival save payload (index.ts writes it under OfflineSave.survival). */
  saveData(): unknown {
    return undefined;
  }

  dispose(): void {}
}
