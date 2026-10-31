/**
 * Steering, path following, wander points, target selection and attack
 * resolution shared by every creature brain (design-voxel-mobs §4.8-4.9).
 */
import type { DamageOutcome, DamageRequest } from '../../combat';
import { DamageKind } from '../../combat';
import { IS_LIQUID, IS_SOLID } from '../../blocks';
import type { PlayerTarget } from '../api';
import { variantHitEffects, type AttackDef } from '../defs';
import { openSky } from '../perception';
import { EntityEventType, MobAction, type Mob } from '../types';
import type { EntityWorld } from '../world';

export interface Brain {
  /** 5 Hz (staggered), right after a hit, or every tick for bosses: decide state, goals and attacks. */
  think(w: EntityWorld, m: Mob): void;
  /** Every tick: fill m.intent from the state. */
  act(w: EntityWorld, m: Mob, dt: number): void;
  onHurt?(w: EntityWorld, m: Mob, req: DamageRequest, res: DamageOutcome): void;
}

export const hdist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

export function stop(m: Mob): void {
  m.intent.vx = 0;
  m.intent.vz = 0;
  m.intent.jump = false;
  m.intent.climb = false;
  m.intent.faceYaw = null;
  if (!m.def.fly) m.intent.vy = null;
}

export function yawTo(m: Mob, x: number, z: number): number {
  return Math.atan2(-(x - m.x), -(z - m.z));
}

/** Steers straight at (x, z); returns the remaining horizontal distance. */
export function steer(m: Mob, x: number, z: number, speed: number, stopAt = 0.2): number {
  const dx = x - m.x;
  const dz = z - m.z;
  const d = Math.hypot(dx, dz);
  if (d <= stopAt) {
    m.intent.vx = 0;
    m.intent.vz = 0;
  } else {
    const s = Math.min(speed, d * 4);
    m.intent.vx = (dx / d) * s;
    m.intent.vz = (dz / d) * s;
  }
  return d;
}

/** Feet height of a standable cell in column (x, z) near y (±range), or null. */
export function standY(w: EntityWorld, x: number, y: number, z: number, height: number, range = 3, allowWater = false): number | null {
  const get = w.host.getBlock;
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const by = Math.floor(y);
  const h = Math.max(1, Math.ceil(height - 0.01));
  for (let i = 0; i <= range * 2; i++) {
    const yy = by + (i % 2 === 0 ? i / 2 : -(i + 1) / 2);
    if (yy < 1 || yy > 62) continue;
    if (!IS_SOLID[get(bx, yy - 1, bz)] && !(allowWater && IS_LIQUID[get(bx, yy - 1, bz)])) continue;
    let free = true;
    for (let k = 0; k < h && free; k++) if (IS_SOLID[get(bx, yy + k, bz)]) free = false;
    if (!free) continue;
    if (!allowWater && IS_LIQUID[get(bx, yy, bz)]) continue;
    return yy;
  }
  return null;
}

/** A random reachable-looking point min..max blocks away (null when none was found in 4 tries). */
export function wanderPoint(w: EntityWorld, m: Mob, min: number, max: number, cx = m.x, cz = m.z): { x: number; y: number; z: number } | null {
  for (let i = 0; i < 4; i++) {
    const a = w.rng() * Math.PI * 2;
    const d = min + w.rng() * (max - min);
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    if (!w.host.isAvailable(x, z)) continue;
    if (m.leash && !insideBox(m.leash, x, m.y, z, 0.5)) continue;
    const y = standY(w, x, m.y, z, m.height);
    if (y !== null) return { x: Math.floor(x) + 0.5, y, z: Math.floor(z) + 0.5 };
  }
  return null;
}

/** A point `dist` blocks away from (fx, fz), ±40° jitter, with a floor. */
export function fleePoint(w: EntityWorld, m: Mob, fx: number, fz: number, dist: number): { x: number; y: number; z: number } {
  const base = Math.atan2(m.z - fz, m.x - fx);
  for (let i = 0; i < 4; i++) {
    const a = base + (w.rng() - 0.5) * 1.4;
    const x = m.x + Math.cos(a) * dist;
    const z = m.z + Math.sin(a) * dist;
    if (!w.host.isAvailable(x, z)) continue;
    const y = standY(w, x, m.y, z, m.height, 4);
    if (y !== null) return { x, y, z };
  }
  return { x: m.x + Math.cos(base) * dist, y: m.y, z: m.z + Math.sin(base) * dist };
}

export function insideBox(b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }, x: number, y: number, z: number, grow = 0): boolean {
  return x >= b.x0 - grow && x < b.x1 + grow && z >= b.z0 - grow && z < b.z1 + grow && y >= b.y0 - 1 - grow && y < b.y1 + grow;
}

/** Sets a navigation goal; a path is requested (budgeted) when the goal moved more than 2 blocks. */
export function setGoal(w: EntityWorld, m: Mob, x: number, y: number, z: number, opts: { maxNodes?: number; goalRadius?: number; priority?: number; minInterval?: number } = {}): void {
  const moved = Math.hypot(x - m.goalX, z - m.goalZ) > 2 || Math.abs(y - m.goalY) > 2;
  m.goalX = x;
  m.goalY = y;
  m.goalZ = z;
  if (!moved && (m.path || m.pathPending)) return;
  if (w.time < m.repathAt && m.path) return;
  if (w.time < m.directUntil) return;
  m.repathAt = w.time + (opts.minInterval ?? 1);
  const def = m.def;
  w.paths.request(
    m,
    {
      sx: Math.floor(m.x),
      sy: Math.floor(m.y + 0.01),
      sz: Math.floor(m.z),
      tx: Math.floor(x),
      ty: Math.floor(y),
      tz: Math.floor(z),
      height: m.height,
      maxDrop: def.maxDrop,
      climb: def.climb,
      swim: def.swim === 'fish' ? 'only' : 'avoid',
      maxNodes: opts.maxNodes ?? 200,
      goalRadius: opts.goalRadius ?? 1,
      leash: m.leash,
    },
    opts.priority ?? 0,
  );
}

/**
 * Moves toward the current goal: follows the path when there is one, else
 * steers straight (with auto-jump). Returns the distance to the goal.
 */
export function moveToGoal(w: EntityWorld, m: Mob, speed: number, dt: number, arrive = 0.4): number {
  const it = m.intent;
  it.jump = false;
  it.climb = m.def.climb;
  const goalD = hdist(m.x, m.z, m.goalX, m.goalZ);
  const p = m.path;
  if (p && p.length > 0 && m.pathIndex < p.length && w.time >= m.directUntil) {
    const i = m.pathIndex * 3;
    const cx = p.cells[i] + 0.5;
    const cy = p.cells[i + 1];
    const cz = p.cells[i + 2] + 0.5;
    const d = steer(m, cx, cz, speed, 0);
    const drop = cy < Math.floor(m.y + 0.01);
    if (d < (drop ? 0.6 : 0.35)) m.pathIndex++;
    if (cy > m.y + 0.6 && m.onGround && !m.def.climb) it.jump = true;
  } else {
    if (p && m.pathIndex >= p.length) m.path = null;
    steer(m, m.goalX, m.goalZ, speed, arrive);
  }
  // Stuck: barely moved for 1.5 s while trying to.
  if (Math.hypot(it.vx, it.vz) > 0.3) {
    m.stuckTime += dt;
    if (m.stuckTime > 1.5) {
      const progress = hdist(m.x, m.z, m.lastProgressX, m.lastProgressZ);
      if (progress < 0.25) {
        m.path = null;
        m.pathFails++;
        if (m.pathFails >= 3) {
          m.directUntil = w.time + 3;
          m.pathFails = 0;
        } else m.repathAt = 0;
        if (m.onGround) it.jump = true;
      }
      m.stuckTime = 0;
      m.lastProgressX = m.x;
      m.lastProgressZ = m.z;
    }
  } else {
    m.stuckTime = 0;
    m.lastProgressX = m.x;
    m.lastProgressZ = m.z;
  }
  return goalD;
}

/** Cached open-sky check for the mob's cell (every 20 ticks). */
export function underSky(w: EntityWorld, m: Mob): boolean {
  if (w.tick - m.skyTick >= 20) {
    m.skyTick = w.tick;
    m.underSky = openSky(w.host.getBlock, Math.floor(m.x), Math.floor(m.y + m.height - 0.01), Math.floor(m.z));
  }
  return m.underSky;
}

/**
 * Hostile target selection: keeps a valid target (LOS lost for 5 s or beyond
 * loseRange drops it), else the nearest targetable player within aggro range
 * with line of sight. Crouching players are noticed at 60% range.
 */
export function selectTarget(w: EntityWorld, m: Mob, interval = 0.2): PlayerTarget | null {
  const def = m.def;
  const eye = m.eyeY;
  let cur = m.targetId ? w.playerById(m.targetId) : undefined;
  if (cur) {
    const d = hdist(cur.x, cur.z, m.x, m.z);
    const outOfLeash = m.leash && !insideBox(m.leash, cur.x, cur.y, cur.z, 4);
    if (!cur.alive || !cur.targetable || d > def.loseRange || outOfLeash) cur = undefined;
    else {
      const hears = m.def.climb && d < 8;
      if (hears || w.sees(m.x, eye, m.z, cur.x, cur.y + 1.5, cur.z, 'see', true)) m.targetLostTime = 0;
      else m.targetLostTime += interval;
      if (m.targetLostTime > 5) cur = undefined;
    }
  }
  let best: PlayerTarget | undefined;
  let bestD = Infinity;
  for (const p of w.players) {
    if (!p.alive || !p.targetable || p === cur) continue;
    const d = Math.hypot(p.x - m.x, (p.y - m.y) * 0.5, p.z - m.z);
    const range = def.aggroRange * (p.crouching ? 0.6 : 1);
    if (d > range || d >= bestD) continue;
    if (m.leash && !insideBox(m.leash, p.x, p.y, p.z, 4)) continue;
    if (!(m.def.climb && d < 8) && !w.sees(m.x, eye, m.z, p.x, p.y + 1.5, p.z, 'see', false)) continue;
    best = p;
    bestD = d;
  }
  if (best && (!cur || bestD + 4 < hdist(cur.x, cur.z, m.x, m.z))) {
    cur = best;
    m.targetLostTime = 0;
  }
  m.targetId = cur ? cur.id : null;
  return cur ?? null;
}

/** Starts a timed action and tells clients (MobAction event). */
export function startAction(w: EntityWorld, m: Mob, action: MobAction, seconds: number, param = 0): void {
  m.setAction(action, seconds);
  w.emit({ type: EntityEventType.MobAction, id: m.id, action, param, x: m.x, y: m.y, z: m.z });
}

/**
 * Resolves a melee swing at the end of its windup (§4.9): the target must still
 * be within reach (+ its half width + 0.25 slack), at a similar height and in
 * line of sight. Returns true on a hit.
 */
export function meleeHit(w: EntityWorld, m: Mob, target: PlayerTarget | null, a: AttackDef): boolean {
  if (!target || !target.alive) return false;
  const d = hdist(m.x, m.z, target.x, target.z);
  if (d > a.reach + m.halfWidth + target.halfWidth + 0.25 || Math.abs(target.y - m.y) >= Math.max(1.5, m.height)) return false;
  if (!w.sees(m.x, m.eyeY, m.z, target.x, target.y + 1.2, target.z, 'shoot', true)) return false;
  w.hurtPlayer(target.id, {
    amount: a.damage,
    kind: DamageKind.Melee,
    attacker: m.ref,
    fromX: m.x,
    fromY: m.eyeY,
    fromZ: m.z,
    knockback: a.knockback,
    lift: a.lift,
    effects: a.effects ?? variantHitEffects(m.variant),
  });
  return true;
}

/**
 * Aim for a projectile with gravity g from (ox, oy, oz) at a moving target:
 * lead twice, lower ballistic root (45° when out of range), plus spread.
 */
export function aimAt(w: EntityWorld, ox: number, oy: number, oz: number, t: PlayerTarget, speed: number, g: number, spread = true): { vx: number; vy: number; vz: number } {
  let tx = t.x;
  let ty = t.y + 1.2;
  let tz = t.z;
  for (let i = 0; i < 2; i++) {
    const tt = Math.hypot(tx - ox, ty - oy, tz - oz) / speed;
    tx = t.x + t.vx * tt;
    tz = t.z + t.vz * tt;
    ty = t.y + 1.2 + Math.max(0, t.vy) * tt * 0.5;
  }
  const dx = tx - ox;
  const dz = tz - oz;
  const d = Math.hypot(dx, dz) || 0.001;
  const h = ty - oy;
  let pitch: number;
  if (g <= 0) pitch = Math.atan2(h, d);
  else {
    const s2 = speed * speed;
    const disc = s2 * s2 - g * (g * d * d + 2 * h * s2);
    pitch = disc < 0 ? Math.PI / 4 : Math.atan((s2 - Math.sqrt(disc)) / (g * d));
  }
  let yaw = Math.atan2(dz, dx);
  if (spread) {
    const sp = ((1.5 + (0.5 * d) / 5) * Math.PI) / 180;
    yaw += (w.rng() * 2 - 1) * sp;
    pitch += (w.rng() * 2 - 1) * sp;
  }
  const cp = Math.cos(pitch);
  return { vx: Math.cos(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: Math.sin(yaw) * cp * speed };
}

/** Looks at a point: head pitch from the eye, body faces it. */
export function lookAt(m: Mob, x: number, y: number, z: number): void {
  m.intent.faceYaw = yawTo(m, x, z);
  const d = Math.hypot(x - m.x, z - m.z) || 0.001;
  m.headPitch = Math.max(-1.2, Math.min(1.2, Math.atan2(y - m.eyeY, d)));
}
