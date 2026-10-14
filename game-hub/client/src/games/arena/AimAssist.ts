/**
 * Light touch-only aim assist: when the crosshair is over (or right next to)
 * a visible opponent, look sensitivity drops so the thumb doesn't overshoot.
 * It never moves the camera by itself.
 */
import type { BoxWorld } from '@hub/shared';

export interface AssistTarget {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
}

const SLOWDOWN = 0.45;

export class AimAssist {
  multiplier = 1;

  update(dt: number, enabled: boolean, eye: [number, number, number], forward: [number, number, number], targets: AssistTarget[], world: BoxWorld): number {
    let target = 1;
    if (enabled) {
      for (const t of targets) {
        const cy = t.y + (t.crouching ? 0.75 : 1.05);
        const dx = t.x - eye[0];
        const dy = cy - eye[1];
        const dz = t.z - eye[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.5 || dist > 60) continue;
        const cos = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / dist;
        const angle = Math.acos(Math.min(1, cos));
        // Roughly the angular half-width of a body, plus a little magnetism.
        const radius = Math.atan2(0.55, dist) * 1.5 + 0.01;
        if (angle < radius && world.visible(eye[0], eye[1], eye[2], t.x, cy, t.z)) {
          target = SLOWDOWN;
          break;
        }
      }
    }
    this.multiplier += (target - this.multiplier) * Math.min(1, dt * 12);
    return this.multiplier;
  }
}
