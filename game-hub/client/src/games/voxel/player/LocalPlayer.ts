/**
 * The local player: fixed-step physics (60 Hz, shared code), camera with
 * interpolation, crouch, sprint FOV kick, view bobbing and movement sounds.
 */
import * as THREE from 'three';
import {
  type BlockQuery,
  clamp,
  collides,
  createBody,
  type MoveInput,
  PLAYER_CROUCH_EYE,
  PLAYER_EYE,
  type PlayerBody,
  stepBody,
} from '@hub/shared';
import { audio } from '../../../core/audio/audio';

export const PHYSICS_DT = 1 / 60;
const BASE_FOV = 72;

export class LocalPlayer {
  readonly body: PlayerBody;
  yaw = 0;
  pitch = 0;
  private prev = new THREE.Vector3();
  private eye = PLAYER_EYE;
  private accumulator = 0;
  private stepDistance = 0;
  private bob = 0;
  private fov = BASE_FOV;
  private wasInWater = false;
  crouching = false;
  sprinting = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    x: number,
    y: number,
    z: number,
  ) {
    this.body = createBody(x, y, z);
    this.prev.set(x, y, z);
  }

  teleport(x: number, y: number, z: number): void {
    const b = this.body;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = b.vy = b.vz = 0;
    this.prev.set(x, y, z);
  }

  /** Moves up until the player no longer overlaps blocks (spawn safety). */
  unstick(get: BlockQuery): void {
    for (let i = 0; i < 64 && collides(get, this.body.x, this.body.y, this.body.z); i++) this.body.y += 1;
    this.prev.set(this.body.x, this.body.y, this.body.z);
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  /**
   * Runs as many fixed physics steps as fit in `dt` (at most 5, to avoid a
   * spiral of death after a hitch).
   */
  update(dt: number, input: Omit<MoveInput, 'yaw'>, get: BlockQuery, frozen: boolean): void {
    this.accumulator = Math.min(this.accumulator + dt, PHYSICS_DT * 5);
    this.crouching = input.crouch;
    this.sprinting = input.sprint && !input.crouch && (input.forward > 0.3 || Math.abs(input.strafe) > 0.3);
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      this.prev.set(this.body.x, this.body.y, this.body.z);
      if (frozen) continue;
      stepBody(this.body, { ...input, sprint: this.sprinting, yaw: this.yaw }, get, PHYSICS_DT, this.eye);
      this.afterStep();
    }
    this.updateCamera(dt);
  }

  private afterStep(): void {
    const b = this.body;
    const hSpeed = Math.hypot(b.vx, b.vz);
    if (b.onGround && hSpeed > 0.5) {
      this.stepDistance += hSpeed * PHYSICS_DT;
      if (this.stepDistance > 1.7) {
        this.stepDistance = 0;
        audio.play('step', { volume: this.crouching ? 0.4 : 1, pitch: 0.9 + Math.random() * 0.2 });
      }
    }
    if (b.jumped) audio.play('jump');
    if (b.landedSpeed > 7) audio.play('land', { volume: Math.min(1, b.landedSpeed / 16) });
    if (b.inWater && !this.wasInWater && b.vy < -3) audio.play('splash');
    this.wasInWater = b.inWater;
  }

  private updateCamera(dt: number): void {
    const b = this.body;
    const alpha = this.accumulator / PHYSICS_DT;
    const x = this.prev.x + (b.x - this.prev.x) * alpha;
    const y = this.prev.y + (b.y - this.prev.y) * alpha;
    const z = this.prev.z + (b.z - this.prev.z) * alpha;
    const targetEye = this.crouching && !b.inWater ? PLAYER_CROUCH_EYE : PLAYER_EYE;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 12);

    const hSpeed = Math.hypot(b.vx, b.vz);
    if (b.onGround && hSpeed > 0.5) this.bob += dt * hSpeed * 2.2;
    else this.bob *= 0.9;
    const bobY = Math.sin(this.bob * 2) * 0.04 * Math.min(1, hSpeed / 4);
    const bobX = Math.cos(this.bob) * 0.03 * Math.min(1, hSpeed / 4);

    this.camera.position.set(x + bobX * Math.cos(this.yaw), y + this.eye + bobY, z - bobX * Math.sin(this.yaw));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const targetFov = BASE_FOV + (this.sprinting && hSpeed > 4.5 ? 8 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 8);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  get eyeHeight(): number {
    return this.eye;
  }
}
