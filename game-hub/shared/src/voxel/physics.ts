/**
 * Player movement for the voxel game: walk, sprint, crouch (with edge
 * protection), jump, auto-jump onto single steps, and swimming.
 *
 * Integrates one fixed step at a time and resolves collisions axis by axis
 * against solid voxels (classic swept-AABB-by-axis approach). Shared so the
 * server can sanity-check reported positions with the same limits.
 */
import { COLLISION_TOP, IS_CLIMBABLE, IS_LIQUID, IS_SOLID, LIQUID_HEIGHT, waterLevel } from './blocks';
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
 * block. Shared by players, mobs and item drops. A solid cell only blocks up
 * to its collision top (slabs 0.5, chests 0.875, bedrolls 0.3125).
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
        const b = get(bx, by, bz);
        if (IS_SOLID[b] && y + EPS < by + COLLISION_TOP[b]) return true;
      }
    }
  }
  return false;
}

/** Highest collision top above `above` of the solid cells in rows y0..y1 under a box footprint, or -Infinity. */
function topIn(get: BlockQuery, x: number, z: number, half: number, y0: number, y1: number, above: number): number {
  const x0 = Math.floor(x - half + EPS);
  const x1 = Math.floor(x + half - EPS);
  const z0 = Math.floor(z - half + EPS);
  const z1 = Math.floor(z + half - EPS);
  let top = -Infinity;
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        const b = get(bx, by, bz);
        if (!IS_SOLID[b]) continue;
        const t = by + COLLISION_TOP[b];
        if (t > above && t > top) top = t;
      }
    }
  }
  return top;
}

/**
 * Feet height after landing on whatever stopped a fall at `ny`: the highest
 * collision top the feet sank into (a slab's 0.5, a full block's 1).
 */
export function landingHeight(get: BlockQuery, x: number, ny: number, z: number, half = HALF): number {
  const top = topIn(get, x, z, half, Math.floor(ny), Math.floor(ny + EPS), ny);
  return top > -Infinity ? top : Math.floor(ny) + 1;
}

/**
 * New feet y when a body blocked horizontally at (x, y, z) can step up a low
 * ledge (≤ VOXEL_PHYSICS.stepHeight: slabs, chests, bedrolls) without jumping,
 * else null. Full blocks are left to auto-jump.
 */
export function stepUpTarget(get: BlockQuery, x: number, y: number, z: number, half = HALF, height = PLAYER_HEIGHT): number | null {
  const up = topIn(get, x, z, half, Math.floor(y + EPS), Math.floor(y + VOXEL_PHYSICS.stepHeight), y);
  if (up === -Infinity || up - y > VOXEL_PHYSICS.stepHeight + EPS) return null;
  return collidesBox(get, x, up, z, half, height) ? null : up;
}

/** True when the box overlaps a climbable cell (ladders) at its feet or chest height. */
export function overlapsClimbable(get: BlockQuery, x: number, y: number, z: number, half = HALF, height = PLAYER_HEIGHT): boolean {
  const x0 = Math.floor(x - half + EPS);
  const x1 = Math.floor(x + half - EPS);
  const z0 = Math.floor(z - half + EPS);
  const z1 = Math.floor(z + half - EPS);
  const rows = [Math.floor(y + EPS), Math.floor(y + Math.min(0.9, height * 0.5))];
  for (const by of rows) for (let bz = z0; bz <= z1; bz++) for (let bx = x0; bx <= x1; bx++) if (IS_CLIMBABLE[get(bx, by, bz)]) return true;
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
  const climb = !body.inWater && overlapsClimbable(get, body.x, body.y, body.z);
  if (climb) {
    // Ladders: hold jump or forward to climb, crouch to hold on, otherwise slide down slowly.
    if (input.jump || input.forward > 0.3) body.vy = P.climbSpeed;
    else if (input.crouch) body.vy = 0;
    else body.vy = Math.max(body.vy - P.gravity * dt, -P.climbSlide);
  } else if (body.inWater) {
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

  // Low ledges (slabs, chests) are stepped onto without a jump.
  const canStep = (body.onGround || climb) && !body.inWater;
  let nx = body.x + body.vx * dt;
  let stepY: number | null = null;
  if (collides(get, nx, body.y, body.z) && canStep && (stepY = stepUpTarget(get, nx, body.y, body.z)) !== null) {
    body.y = stepY;
  } else if (collides(get, nx, body.y, body.z) || (crouchEdge && !collides(get, nx, body.y - 0.1, body.z))) {
    blockedX = collides(get, nx, body.y, body.z);
    nx = body.x;
    body.vx = 0;
  }
  body.x = nx;

  let nz = body.z + body.vz * dt;
  if (collides(get, body.x, body.y, nz) && canStep && (stepY = stepUpTarget(get, body.x, body.y, nz)) !== null) {
    body.y = stepY;
  } else if (collides(get, body.x, body.y, nz) || (crouchEdge && !collides(get, body.x, body.y - 0.1, nz))) {
    blockedZ = collides(get, body.x, body.y, nz);
    nz = body.z;
    body.vz = 0;
  }
  body.z = nz;

  // ---- auto-jump: walked into a 1-block step with headroom ------------------------
  if (input.autoJump && !climb && body.knockTime <= 0 && body.onGround && !body.inWater && (blockedX || blockedZ) && len > 0.3) {
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
