/**
 * Player movement for the voxel game: walk, sprint, crouch (with edge
 * protection), jump, auto-jump onto single steps, and swimming.
 *
 * Integrates one fixed step at a time and resolves collisions axis by axis
 * against solid voxels (classic swept-AABB-by-axis approach). Shared so the
 * server can sanity-check reported positions with the same limits.
 */
import { IS_LIQUID, IS_SOLID, LIQUID_HEIGHT, waterLevel } from './blocks';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from './constants';

export const VOXEL_PHYSICS = {
  gravity: 28,
  jumpVelocity: 8.4,
  // +16% over the original 4.3 / 5.8 / 1.6 / 3.0 (jump and gravity unchanged, so parkour jumps only get easier).
  walkSpeed: 5.0,
  sprintSpeed: 6.7,
  crouchSpeed: 1.85,
  swimSpeed: 3.4,
  groundAccel: 60,
  airAccel: 22,
  waterGravity: 7,
  swimUpVelocity: 3.6,
  waterDrag: 2.8,
  maxFallSpeed: 50,
  /** Ladders (world area): climb speed up, and the slowest slide down. */
  climbSpeed: 3.2,
  climbSlide: 2.0,
  /** Highest ledge walked up without a jump (slabs, chests; world area). */
  stepHeight: 0.5,
} as const;

/** Knockback on the local player (survival): reduced control while it lasts. */
export const KNOCKBACK = { controlTime: 0.35, controlFactor: 0.15, carry: 0.3 } as const;

/** Absolute upper bound on horizontal speed, used by the server to flag cheaters. */
export const MAX_HORIZONTAL_SPEED = VOXEL_PHYSICS.sprintSpeed * 1.35;

export interface BlockQuery {
  (x: number, y: number, z: number): number;
}

export interface MoveInput {
  /** Desired movement in camera space: x = strafe right, z = forward. Length <= 1. */
  strafe: number;
  forward: number;
  yaw: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  autoJump: boolean;
  /** Multiplies walk/sprint/crouch/swim speed (guard 0.45, bow draw 0.5, crossbow load 0.6, eating 0.5, Slow effects). Default 1. */
  speedMul?: number;
  /** Sprint is ignored (starving). */
  noSprint?: boolean;
}

export interface PlayerBody {
  x: number;
  y: number; // feet
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  inWater: boolean;
  /** Eye inside water (for the underwater tint). */
  headInWater: boolean;
  /** Set for one step when the body lands (for sounds). */
  landedSpeed: number;
  /** Set for one step when a jump starts. */
  jumped: boolean;
  /** Seconds of reduced control left after a knockback. */
  knockTime: number;
}

export function createBody(x: number, y: number, z: number): PlayerBody {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false, headInWater: false, landedSpeed: 0, jumped: false, knockTime: 0 };
}

/** Applies a knockback velocity change (b/s) from the server's damage record: keeps 30% of the current horizontal velocity. */
export function applyBodyKnockback(body: PlayerBody, dvx: number, dvy: number, dvz: number): void {
  body.vx = body.vx * KNOCKBACK.carry + dvx;
  body.vz = body.vz * KNOCKBACK.carry + dvz;
  if (dvy > 0) {
    body.vy = Math.max(body.vy, dvy);
    body.onGround = false;
  }
  body.knockTime = KNOCKBACK.controlTime;
}

const HALF = PLAYER_WIDTH / 2;
const EPS = 1e-4;

/** True if the player's box at (x, y, z) overlaps any solid block. */
export function collides(get: BlockQuery, x: number, y: number, z: number, height = PLAYER_HEIGHT): boolean {
  return collidesBox(get, x, y, z, HALF, height);
}

/**
 * True if a box (feet at y, half width `half`, `height` tall) overlaps any solid
 * block. Shared by players, mobs and item drops. The world area adds the
 * COLLISION_TOP rule here (slabs, chests, bedrolls).
 */
export function collidesBox(get: BlockQuery, x: number, y: number, z: number, half: number, height: number): boolean {
  const x0 = Math.floor(x - half + EPS);
  const x1 = Math.floor(x + half - EPS);
  const y0 = Math.floor(y + EPS);
  const y1 = Math.floor(y + height - EPS);
  const z0 = Math.floor(z - half + EPS);
  const z1 = Math.floor(z + half - EPS);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (IS_SOLID[get(bx, by, bz)]) return true;
      }
    }
  }
  return false;
}

/**
 * Feet height after landing on whatever stopped a fall at `ny` (WP0 stub: the
 * top of the full cell, today's behaviour; the world area returns slab/chest
 * collision tops).
 */
export function landingHeight(_get: BlockQuery, _x: number, ny: number, _z: number, _half = HALF): number {
  return Math.floor(ny) + 1;
}

/**
 * New feet y when a body blocked horizontally at (x, y, z) can step up a low
 * ledge (≤ VOXEL_PHYSICS.stepHeight) without jumping, else null.
 * WP0 stub: null (no step-up; full blocks still use auto-jump). World area implements.
 */
export function stepUpTarget(_get: BlockQuery, _x: number, _y: number, _z: number, _half = HALF, _height = PLAYER_HEIGHT): number | null {
  return null;
}

/** True when the box overlaps a climbable cell (ladders). WP0 stub: false. World area implements with IS_CLIMBABLE. */
export function overlapsClimbable(_get: BlockQuery, _x: number, _y: number, _z: number, _half = HALF, _height = PLAYER_HEIGHT): boolean {
  return false;
}

/** Standing on something solid (server-side ground check from reported positions). */
export function groundedAt(get: BlockQuery, x: number, y: number, z: number): boolean {
  return collides(get, x, y - 0.06, z, 0.06);
}

/** True if the point is inside liquid (flowing water only below its surface). */
export function isLiquidAt(get: BlockQuery, x: number, y: number, z: number): boolean {
  return liquidAt(get, x, y, z);
}

function liquidAt(get: BlockQuery, x: number, y: number, z: number): boolean {
  const by = Math.floor(y);
  const b = get(Math.floor(x), by, Math.floor(z));
  if (!IS_LIQUID[b]) return false;
  // Flowing water is shallow: only points below its surface count.
  return waterLevel(b) === 8 || y - by < LIQUID_HEIGHT[b];
}

/** Advances the body by dt seconds. */
export function stepBody(body: PlayerBody, input: MoveInput, get: BlockQuery, dt: number, eyeHeight: number): void {
  const P = VOXEL_PHYSICS;
  body.landedSpeed = 0;
  body.jumped = false;
  body.inWater = liquidAt(get, body.x, body.y + 0.4, body.z);
  body.headInWater = liquidAt(get, body.x, body.y + eyeHeight, body.z);

  // ---- desired horizontal velocity ---------------------------------------------
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // Forward is -Z rotated by yaw; right is +X rotated by yaw.
  let wx = input.strafe * cos - input.forward * sin;
  let wz = -input.strafe * sin - input.forward * cos;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }
  const sprint = input.sprint && !input.noSprint;
  const speed =
    (body.inWater
      ? P.swimSpeed
      : input.crouch && body.onGround
        ? P.crouchSpeed
        : sprint
          ? P.sprintSpeed
          : P.walkSpeed) * (input.speedMul ?? 1);
  const targetVx = wx * speed;
  const targetVz = wz * speed;
  const control = body.knockTime > 0 ? KNOCKBACK.controlFactor : 1;
  const accel = (body.onGround || body.inWater ? P.groundAccel : P.airAccel) * control;
  body.vx = approach(body.vx, targetVx, accel * dt);
  body.vz = approach(body.vz, targetVz, accel * dt);

  // ---- vertical ------------------------------------------------------------------
  if (body.inWater) {
    body.vy -= P.waterGravity * dt;
    body.vy *= Math.max(0, 1 - P.waterDrag * dt);
    if (input.jump) body.vy = Math.max(body.vy, P.swimUpVelocity);
    else if (input.crouch) body.vy = Math.min(body.vy, -P.swimUpVelocity);
    // Hop out of water onto a ledge.
    if (input.jump && !body.headInWater && body.vy > 0) body.vy = Math.max(body.vy, P.jumpVelocity * 0.75);
  } else {
    body.vy = Math.max(-P.maxFallSpeed, body.vy - P.gravity * dt);
    if (input.jump && body.onGround) {
      body.vy = P.jumpVelocity;
      body.jumped = true;
    }
  }

  // ---- integrate with per-axis collision -------------------------------------------
  const wasOnGround = body.onGround;
  const fallSpeed = -body.vy;

  // Y first so ground contact is known for the horizontal pass.
  let ny = body.y + body.vy * dt;
  body.onGround = false;
  if (collides(get, body.x, ny, body.z)) {
    if (body.vy < 0) {
      ny = landingHeight(get, body.x, ny, body.z); // stand on top of the block we hit
      if (collides(get, body.x, ny, body.z)) ny = body.y;
      body.onGround = true;
      if (!wasOnGround) body.landedSpeed = fallSpeed;
    } else {
      ny = Math.ceil(ny + PLAYER_HEIGHT) - PLAYER_HEIGHT - EPS * 2; // bonk head
      if (collides(get, body.x, ny, body.z)) ny = body.y;
    }
    body.vy = 0;
  }
  body.y = ny;

  const crouchEdge = input.crouch && body.onGround && !body.inWater;
  let blockedX = false;
  let blockedZ = false;

  let nx = body.x + body.vx * dt;
  if (collides(get, nx, body.y, body.z) || (crouchEdge && !collides(get, nx, body.y - 0.1, body.z))) {
    blockedX = collides(get, nx, body.y, body.z);
    nx = body.x;
    body.vx = 0;
  }
  body.x = nx;

  let nz = body.z + body.vz * dt;
  if (collides(get, body.x, body.y, nz) || (crouchEdge && !collides(get, body.x, body.y - 0.1, nz))) {
    blockedZ = collides(get, body.x, body.y, nz);
    nz = body.z;
    body.vz = 0;
  }
  body.z = nz;

  // ---- auto-jump: walked into a 1-block step with headroom ------------------------
  if (input.autoJump && body.knockTime <= 0 && body.onGround && !body.inWater && (blockedX || blockedZ) && len > 0.3) {
    const probeX = body.x + Math.sign(wx) * (blockedX ? HALF + 0.2 : 0);
    const probeZ = body.z + Math.sign(wz) * (blockedZ ? HALF + 0.2 : 0);
    const stepFree = !collides(get, probeX, body.y + 1.01, probeZ);
    if (stepFree) {
      body.vy = P.jumpVelocity;
      body.jumped = true;
    }
  }

  // Still on the ground if standing on something (needed when vy was 0).
  if (!body.onGround && body.vy <= 0 && collides(get, body.x, body.y - 0.02, body.z)) body.onGround = true;
  body.knockTime = Math.max(0, body.knockTime - dt);
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}
