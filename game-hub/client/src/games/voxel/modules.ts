/**
 * How the Voxelvale packages plug into VoxelGame (WP0). Each package owns one
 * module class in its own folder; VoxelGame calls them at fixed points:
 *   world/WorldFeatures.ts (WP-A), survival/SurvivalController.ts (WP-B),
 *   entities/EntityView.ts + entities/LocalEntities.ts (WP-C).
 */
import type { PlayerBody } from '@hub/shared';
import type { InputFrame } from '../../core/input/InputManager';
import type { InteractionHost } from './player/BlockInteraction';
import type { SlotView } from './ui/VoxelHud';

/** Movement modifiers for this frame. */
export interface MoveMods {
  speedMul?: number;
  noSprint?: boolean;
  /** No movement or look-driven actions (dead, resting). */
  locked?: boolean;
}

/** Whoever owns the hotbar in this mode (sandbox: WorldFeatures; survival: SurvivalController). */
export interface HotbarSource {
  /** Current slot contents (sandbox 12, survival 9). */
  views(): readonly SlotView[];
  /** True when views() changed since the last call. */
  takeChanged(): boolean;
  /** Block id the secondary action places from slot i, or null. */
  placeable(i: number): number | null;
  /** Item id in slot i (0 = empty): held model, labels. */
  heldItem(i: number): number;
  /** Off-hand slot (survival); undefined hides it. */
  offhand?(): SlotView | null | undefined;
}

export type InteractionHooks = Pick<InteractionHost, 'breakSeconds' | 'onDigStart' | 'entityDistance' | 'onSecondary'>;

export interface VoxelModule {
  /** Every frame before physics. */
  beforePhysics?(dt: number, input: InputFrame): MoveMods | void;
  /** Every fixed physics step of the local body (offline survival: fall tracking). */
  onStep?(body: PlayerBody): void;
  /** Every frame after interaction, before rendering. */
  update?(dt: number, input: InputFrame, paused: boolean): void;
  /** A full-screen overlay (picker, inventory, death screen) is open: game input off. It closes itself on Esc. */
  isModalOpen?(): boolean;
  /** Optional interaction hooks; the first module that defines a hook wins (order: entities, survival, world). */
  interaction?: Partial<InteractionHooks>;
  /** A local edit was applied (offline: survival consumes/drops; entities wake stuck arrows). */
  afterLocalEdit?(x: number, y: number, z: number, before: number, after: number): void;
  dispose?(): void;
}
