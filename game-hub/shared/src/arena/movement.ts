/**
 * Arena player movement: acceleration-based walking, crouch, jump, gravity,
 * step-up for stairs, and snapping down when walking off small steps.
 *
 * Shared by the server (authoritative), the client (prediction/replay) and
 * bots, so all three move identically for the same inputs.
 */
import { MOVE, PLAYER } from './constants';
import type { BoxWorld } from './geometry';

export interface MoveState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  crouching: boolean;
}

export interface ArenaMoveInput {
  moveX: number;
  moveY: number;
  yaw: number;
  jump: boolean;
  crouch: boolean;
  /** Weapon / aiming speed multiplier. */
  speedMul: number;
}

const R = PLAYER.radius;
const EPS = 1e-4;

export const bodyHeight = (crouching: boolean): number => (crouching ? PLAYER.crouchHeight : PLAYER.height);
export const eyeHeight = (crouching: boolean): number => (crouching ? PLAYER.crouchEye : PLAYER.eye);

function blocked(world: BoxWorld, x: number, y: number, z: number, h: number): boolean {
  return world.overlaps(x - R + EPS, y + EPS, z - R + EPS, x + R - EPS, y + h - EPS, z + R - EPS);
}

function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) return [tx, tz];
  return [vx + (dx / d) * maxDelta, vz + (dz / d) * maxDelta];
}

export interface MoveResult {
  jumped: boolean;
  landed: boolean;
  /** Downward speed at landing (for sounds / effects). */
  impact: number;
}

export function stepMovement(s: MoveState, input: ArenaMoveInput, world: BoxWorld, dt: number): MoveResult {
  const result: MoveResult = { jumped: false, landed: false, impact: 0 };

  // ---- crouch (stand up only if there is headroom) -------------------------------
  if (input.crouch) s.crouching = true;
  else if (s.crouching && !blocked(world, s.x, s.y, s.z, PLAYER.height)) s.crouching = false;
  const h = bodyHeight(s.crouching);

  // ---- horizontal velocity --------------------------------------------------------
  let mx = input.moveX;
  let my = input.moveY;
  const ml = Math.hypot(mx, my);
  if (ml > 1) {
    mx /= ml;
    my /= ml;
  }
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // forward = (-sin, -cos), right = (cos, -sin)
  const wx = mx * cos - my * sin;
  const wz = -mx * sin - my * cos;
  const speed = (s.crouching ? MOVE.crouchSpeed : MOVE.walkSpeed) * input.speedMul;
  const tx = wx * speed;
  const tz = wz * speed;
  if (s.onGround) {
    const accel = ml > 0.01 ? MOVE.groundAccel : MOVE.friction * MOVE.walkSpeed;
    [s.vx, s.vz] = approach2(s.vx, s.vz, tx, tz, accel * dt);
  } else if (ml > 0.01) {
    [s.vx, s.vz] = approach2(s.vx, s.vz, tx, tz, MOVE.airAccel * dt);
  }

  // ---- vertical ---------------------------------------------------------------------
  if (input.jump && s.onGround) {
    s.vy = MOVE.jumpVelocity;
    s.onGround = false;
    result.jumped = true;
  }
  s.vy = Math.max(-MOVE.maxFallSpeed, s.vy - MOVE.gravity * dt);

  const wasOnGround = s.onGround;

  // ---- horizontal move with step-up -----------------------------------------------
  const moveAxis = (axis: 'x' | 'z', delta: number) => {
    if (delta === 0) return;
    const nx = axis === 'x' ? s.x + delta : s.x;
    const nz = axis === 'z' ? s.z + delta : s.z;
    if (!blocked(world, nx, s.y, nz, h)) {
      s.x = nx;
      s.z = nz;
      return;
    }
    // Try stepping up onto a low obstacle (stairs, kerbs).
    if (wasOnGround || s.vy <= 0) {
      const top = world.highestTop(nx - R + EPS, nz - R + EPS, nx + R - EPS, nz + R - EPS, s.y + EPS, s.y + MOVE.stepHeight + EPS);
      if (top > -Infinity && !blocked(world, nx, top, nz, h)) {
        s.x = nx;
        s.z = nz;
        s.y = top;
        return;
      }
    }
    if (axis === 'x') s.vx = 0;
    else s.vz = 0;
  };
  moveAxis('x', s.vx * dt);
  moveAxis('z', s.vz * dt);

  // ---- vertical move ----------------------------------------------------------------
  const ny = s.y + s.vy * dt;
  if (s.vy <= 0) {
    // Land on the highest surface we would pass through.
    const top = world.highestTop(s.x - R + EPS, s.z - R + EPS, s.x + R - EPS, s.z + R - EPS, ny - EPS, s.y + EPS);
    if (top > -Infinity) {
      if (!wasOnGround) {
        result.landed = true;
        result.impact = -s.vy;
      }
      s.y = top;
      s.vy = 0;
      s.onGround = true;
    } else {
      s.y = ny;
      s.onGround = false;
      // Walking down stairs: stick to the ground instead of hopping off each step.
      if (wasOnGround && !result.jumped) {
        const below = world.highestTop(s.x - R + EPS, s.z - R + EPS, s.x + R - EPS, s.z + R - EPS, s.y - MOVE.stepHeight, s.y);
        if (below > -Infinity) {
          s.y = below;
          s.vy = 0;
          s.onGround = true;
        }
      }
    }
  } else {
    if (blocked(world, s.x, ny, s.z, h)) s.vy = 0; // head bump
    else s.y = ny;
    s.onGround = false;
  }
  return result;
}
