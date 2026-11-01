/**
 * Mob physics (design-voxel-mobs §4.5): the voxel collision rules of
 * physics.ts applied to any box size, with sub-steps so fast bodies never
 * tunnel, swimming, flying, climbing, hopping and fluttering.
 */
import { IS_LIQUID, LIQUID_HEIGHT, waterLevel } from '../blocks';
import { collidesBox, landingHeight, stepUpTarget, type BlockQuery } from '../physics';
import type { Mob } from './types';

export const MOB_PHYSICS = {
  gravity: 28,
  maxFall: 30,
  groundAccel: 30,
  airAccel: 8,
  waterBuoyancy: 12,
  waterDrag: 2.5,
  swimUp: 2.0,
  climbSpeed: 2.6,
  flyAccel: 12,
  maxSubstep: 0.4,
  maxSubsteps: 4,
} as const;

const EPS = 1e-4;

/** True when (x, y, z) is inside liquid (flowing water only below its surface). */
export function liquidAt(get: BlockQuery, x: number, y: number, z: number): boolean {
  const by = Math.floor(y);
  const b = get(Math.floor(x), by, Math.floor(z));
  if (!IS_LIQUID[b]) return false;
  return waterLevel(b) === 8 || y - by < LIQUID_HEIGHT[b];
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}

/** Advances a mob's body by dt with its intent. speedMul scales the intended horizontal speed (Slow, drying). */
export function stepMobBody(m: Mob, get: BlockQuery, dt: number, speedMul: number): void {
  const P = MOB_PHYSICS;
  const def = m.def;
  const it = m.intent;
  const half = m.halfWidth;
  const height = m.height;
  m.landedSpeed = 0;
  m.inWater = liquidAt(get, m.x, m.y + Math.min(0.4, height * 0.4), m.z);
  const flying = def.fly;

  // ---- horizontal ----
  const tvx = it.vx * speedMul;
  const tvz = it.vz * speedMul;
  const accel = m.onGround || m.inWater || flying ? P.groundAccel : P.airAccel;
  m.vx = approach(m.vx, tvx, accel * dt);
  m.vz = approach(m.vz, tvz, accel * dt);

  // ---- vertical ----
  if (flying) {
    m.vy = approach(m.vy, it.vy ?? 0, P.flyAccel * dt);
  } else if (m.inWater && def.swim === 'fish') {
    m.vy = approach(m.vy, it.vy ?? 0, 8 * dt);
  } else if (m.inWater && def.swim === 'float') {
    m.vy = Math.min(m.vy + P.waterBuoyancy * dt, P.swimUp);
    m.vy *= Math.max(0, 1 - P.waterDrag * dt);
  } else {
    m.vy = Math.max(-P.maxFall, m.vy - P.gravity * dt);
    if (def.flutter && !m.onGround) m.vy = Math.max(m.vy, -3);
    if (m.inWater) m.vy *= Math.max(0, 1 - P.waterDrag * dt);
    if (def.climb && it.climb && m.blockedH) m.vy = P.climbSpeed;
    if (it.jump && m.onGround) m.vy = def.jumpVelocity;
  }

  // ---- integrate with sub-steps, Y then X then Z ----
  const fastest = Math.max(Math.abs(m.vx), Math.abs(m.vy), Math.abs(m.vz));
  const n = Math.min(P.maxSubsteps, Math.max(1, Math.ceil((fastest * dt) / P.maxSubstep)));
  const sdt = dt / n;
  const wasOnGround = m.onGround;
  const fallSpeed = -m.vy;
  let blocked = false;
  m.onGround = false;
  for (let s = 0; s < n; s++) {
    let ny = m.y + m.vy * sdt;
    if (collidesBox(get, m.x, ny, m.z, half, height)) {
      if (m.vy < 0) {
        ny = landingHeight(get, m.x, ny, m.z, half);
        if (collidesBox(get, m.x, ny, m.z, half, height)) ny = m.y;
        m.onGround = true;
      } else {
        ny = Math.ceil(ny + height) - height - EPS * 2;
        if (collidesBox(get, m.x, ny, m.z, half, height)) ny = m.y;
      }
      m.vy = 0;
    }
    m.y = ny;
    const nx = m.x + m.vx * sdt;
    if (collidesBox(get, nx, m.y, m.z, half, height)) {
      const up = m.onGround || wasOnGround ? stepUpTarget(get, nx, m.y, m.z, half, height) : null;
      if (up !== null) {
        m.y = up;
        m.x = nx;
      } else {
        blocked = true;
        m.vx = 0;
      }
    } else m.x = nx;
    const nz = m.z + m.vz * sdt;
    if (collidesBox(get, m.x, m.y, nz, half, height)) {
      const up = m.onGround || wasOnGround ? stepUpTarget(get, m.x, m.y, nz, half, height) : null;
      if (up !== null) {
        m.y = up;
        m.z = nz;
      } else {
        blocked = true;
        m.vz = 0;
      }
    } else m.z = nz;
  }
  if (!m.onGround && m.vy <= 0 && collidesBox(get, m.x, m.y - 0.02, m.z, half, height)) m.onGround = true;
  if (m.onGround && !wasOnGround && fallSpeed > 0) m.landedSpeed = fallSpeed;
  m.blockedH = blocked;

  // ---- auto-jump onto a 1-block step with headroom ----
  const wantLen = Math.hypot(it.vx, it.vz);
  if (blocked && !def.noAutoJump && !def.hop && m.onGround && !m.inWater && wantLen > 0.2) {
    const px = m.x + (it.vx / wantLen) * (half + 0.3);
    const pz = m.z + (it.vz / wantLen) * (half + 0.3);
    if (!collidesBox(get, px, m.y + 1.01, pz, half, height)) m.vy = def.jumpVelocity;
  }
  // Swimmers push up against a bank so they can climb out.
  if (blocked && m.inWater && def.swim === 'float' && wantLen > 0.2) m.vy = Math.max(m.vy, 4.5);
}
