/**
 * Creatures as the client sees them (WP-C owns this folder after WP0): snapshot
 * interpolation (online 'N'/'V', offline frames from LocalEntities), instanced
 * rendering, decals, effects, sounds, boss bar and target label.
 * WP0 stub: no creatures.
 */
import type * as THREE from 'three';
import type { InputFrame } from '../../../core/input/InputManager';
import type { VoxelModule } from '../modules';
import type { VoxelNet } from '../net/VoxelNet';
import type { VoxelGame } from '../VoxelGame';

export class EntityView implements VoxelModule {
  constructor(protected readonly game: VoxelGame) {}

  /** Online: register 'N', 'V', 'mr' handlers on net.session. */
  attachNet(_net: VoxelNet): void {}

  /** Nearest rendered creature box hit by the ray (pad inflates boxes; touch aim help 0.15). */
  raycast(_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, _maxDist: number, _pad = 0): { id: number; distance: number } | null {
    return null;
  }

  /** A rendered creature overlaps the block cell (client-side placement check). */
  overlapsCell(_x: number, _y: number, _z: number): boolean {
    return false;
  }

  /** Every frame after interaction: interpolate, animate, draw. */
  render(_dt: number, _camera: THREE.Camera, _daylight: number): void {}

  update(_dt: number, _input: InputFrame, _paused: boolean): void {}

  dispose(): void {}
}
