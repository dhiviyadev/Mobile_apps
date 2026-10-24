/**
 * Movement presentation: eye height (crouch / slide), jump and landing sounds.
 * Camera feel (speed FOV, slide roll, landing dip), footsteps, slide sound and
 * dust, and the touch slide button grow here (design-arena-movement §7).
 */
import { type CommandEvents, eyeHeight, type PlayerSim } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { ArenaClient, ArenaFeature, CameraFx } from './types';

export class MovementFx implements ArenaFeature {
  private eyeSmooth = 1.6;
  private readonly fx: CameraFx = { eye: 1.6, roll: 0, fovAdd: 0, dipY: 0 };

  constructor(readonly client: ArenaClient) {}

  /** Camera modifiers for the live player this frame (ArenaGame calls it while alive). */
  camera(p: PlayerSim, dt: number): CameraFx {
    this.eyeSmooth += (eyeHeight(p.crouching, p.sliding) - this.eyeSmooth) * Math.min(1, dt * 14);
    this.fx.eye = this.eyeSmooth;
    return this.fx;
  }

  onLocalCommand(ev: CommandEvents): void {
    if (ev.jumped) audio.play('jump');
    if (ev.landed > 6) audio.play('land', { volume: Math.min(1, ev.landed / 14) });
  }
}
