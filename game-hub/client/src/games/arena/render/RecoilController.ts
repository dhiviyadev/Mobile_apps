/**
 * Camera recoil (client only; the server always uses the command's yaw/pitch). Each shot of a spray
 * kicks the view up a little more than the last (up to the 6th), and sideways along a per-weapon sine
 * pattern with a little noise, so sprays are learnable rather than random. The kick is applied over
 * a few frames and about 70% of it settles back by itself. The spray count resets after 0.35 s.
 */
import { weaponDef, type WeaponId } from '@hub/shared';
import { WEAPON_VISUALS } from './weaponVisuals';

const SPRAY_RESET = 0.35;

export class RecoilController {
  private kickPitch = 0;
  private kickYaw = 0;
  private settle = 0;
  private shot = 0;
  private sinceShot = 1e9;

  /** A local shot: queues its kick. `aiming` softens it. */
  fire(weapon: WeaponId, aiming: boolean, rnd = Math.random): void {
    const d = weaponDef(weapon);
    const v = WEAPON_VISUALS[weapon].recoil;
    if (this.sinceShot > SPRAY_RESET) this.shot = 0;
    const i = this.shot++;
    this.sinceShot = 0;
    this.kickPitch += d.recoil * (1 + 0.05 * Math.min(i, 6)) * (aiming ? 0.6 : 1);
    this.kickYaw += d.recoilYaw * (v.A * Math.sin(i * v.w + v.phi) + (rnd() - 0.5) * 0.5);
  }

  /** Applies this frame's share of the kick; returns the pitch and yaw to add to the view. */
  update(dt: number): { pitch: number; yaw: number } {
    this.sinceShot += dt;
    const k = Math.min(1, dt * 30);
    const pitch = this.kickPitch * k;
    const yaw = this.kickYaw * k;
    this.kickPitch -= pitch;
    this.kickYaw -= yaw;
    this.settle += pitch * 0.7;
    const back = this.settle * Math.min(1, dt * 6);
    this.settle -= back;
    return { pitch: pitch - back, yaw };
  }

  reset(): void {
    this.kickPitch = this.kickYaw = this.settle = 0;
    this.shot = 0;
    this.sinceShot = 1e9;
  }
}
