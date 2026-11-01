/**
 * Attack building blocks shared by the four bosses: charges along a telegraphed
 * line, projectile fans and summons.
 */
import { DamageKind } from '../../combat';
import { HazardKind, ProjectileKind, PROJECTILE_DEFS } from '../api';
import { aimAt } from '../ai/common';
import { MobKind, TelegraphShape, type MobVariant } from '../types';
import type { BossController, Telegraph } from './boss';

/** Begin a charge: the line toward the target up to the first wall or pillar. */
export function beginCharge(b: BossController, width: number, max: number): Telegraph[] {
  const m = b.mob;
  const t = b.target();
  const yaw = t ? Math.atan2(-(t.x - m.x), -(t.z - m.z)) : m.yaw;
  const len = Math.max(2, b.freeLength(yaw, max));
  b.data.yaw = yaw;
  b.data.len = len;
  b.data.max = max;
  b.data.sx = m.x;
  b.data.sz = m.z;
  b.data.done = 0;
  m.intent.faceYaw = yaw;
  m.yaw = yaw;
  return [b.tele(TelegraphShape.Line, m.x, m.z, len, { width, yaw })];
}

export interface ChargeOpts {
  speed: number;
  width: number;
  damage: number;
  kb: number;
  lift: number;
  stun: number;
  /** FireTrail hazards on each block of the path (Ashen Knight phase 2+). */
  trail?: boolean;
  /** Charge again right away if not stunned (Ashen Knight phase 3). */
  again?: boolean;
}

/** One tick of a charge: move, hit players on the way once, stop (and stun) at the wall. */
export function updateCharge(b: BossController, dt: number, o: ChargeOpts): void {
  const m = b.mob;
  if (b.data.done) return;
  if (b.data.wait > 0) {
    b.data.wait -= dt;
    m.intent.vx = m.intent.vz = 0;
    return;
  }
  const yaw = b.data.yaw;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const px = m.x;
  const pz = m.z;
  m.intent.vx = fx * o.speed;
  m.intent.vz = fz * o.speed;
  m.vx = m.intent.vx;
  m.vz = m.intent.vz;
  m.intent.faceYaw = yaw;
  const nx = px + fx * o.speed * dt;
  const nz = pz + fz * o.speed * dt;
  for (const p of b.playersOnLine(px, pz, nx, nz, o.width / 2 + m.halfWidth * 0.5)) {
    const key = `hit_${p.id}`;
    if (b.data[key]) continue;
    b.data[key] = 1;
    // Knocked sideways off the charge line.
    const side = (p.x - px) * -fz + (p.z - pz) * fx >= 0 ? 1 : -1;
    b.w.hurtPlayer(p.id, { amount: o.damage, kind: DamageKind.Melee, attacker: m.ref, fromX: p.x - -fz * side, fromY: m.y + 1, fromZ: p.z - fx * side, knockback: o.kb, lift: o.lift, shieldDisable: 2 });
  }
  if (o.trail) {
    const step = Math.floor(Math.hypot(m.x - b.data.sx, m.z - b.data.sz));
    if (step > (b.data.trail ?? -1)) {
      b.data.trail = step;
      b.w.hazards.spawn({ kind: HazardKind.FireTrail, x: m.x, y: b.floorY, z: m.z, radius: 0.8, seconds: 4, dps: 2, slow: 0, team: m.team, owner: m.ref });
    }
  }
  const travelled = Math.hypot(m.x - b.data.sx, m.z - b.data.sz);
  const blocked = !b.grid.isOpen(m.x + fx * (m.halfWidth + 0.3), m.z + fz * (m.halfWidth + 0.3));
  if (travelled >= b.data.len - 0.2 || blocked || b.stepTime > 3) {
    m.intent.vx = m.intent.vz = m.vx = m.vz = 0;
    const hitWall = blocked || b.data.len < b.data.max - 0.5;
    if (hitWall) b.stun(o.stun);
    if (!hitWall && o.again && !b.data.second) {
      b.data.second = 1;
      const tele = beginCharge(b, o.width, b.data.max);
      b.data.second = 1;
      for (const t of tele) b.emitTelegraph({ ...t, seconds: 0.5 });
      b.data.wait = 0.5;
      b.stepTime = 0;
      return;
    }
    b.data.done = 1;
    b.endAttack(true);
  }
}

/** A fan of projectiles at the current target. */
export function fan(b: BossController, kind: ProjectileKind, count: number, spreadDeg: number, speed: number, damage: number, kb: number, fromY: number): void {
  const m = b.mob;
  const t = b.target();
  if (!t) return;
  const g = PROJECTILE_DEFS[kind].gravity;
  const v = aimAt(b.w, m.x, fromY, m.z, t, speed, g, false);
  const base = Math.atan2(v.vz, v.vx);
  const hs = Math.hypot(v.vx, v.vz);
  for (let i = 0; i < count; i++) {
    const a = base + (count > 1 ? ((i / (count - 1)) - 0.5) * ((spreadDeg * Math.PI) / 180) : 0);
    b.w.spawnProjectile({
      kind, owner: m.ref, team: m.team, x: m.x + Math.cos(a) * (m.halfWidth + 0.4), y: fromY, z: m.z + Math.sin(a) * (m.halfWidth + 0.4),
      vx: Math.cos(a) * hs, vy: v.vy, vz: Math.sin(a) * hs, damage, knockback: kb, hitsPlayers: true, pickupItem: null,
    });
  }
}

/** Projectile from a point at a given target point with gravity g and fixed flight time. */
export function lob(b: BossController, kind: ProjectileKind, ox: number, oy: number, oz: number, tx: number, ty: number, tz: number, time: number, damage: number): void {
  const g = PROJECTILE_DEFS[kind].gravity;
  b.w.spawnProjectile({
    kind, owner: b.mob.ref, team: b.mob.team, x: ox, y: oy, z: oz,
    vx: (tx - ox) / time, vy: (ty - oy + 0.5 * g * time * time) / time, vz: (tz - oz) / time,
    damage, knockback: 2, hitsPlayers: true, pickupItem: null,
  });
}

export function summonAt(b: BossController, kind: MobKind, variant: MobVariant, points: { x: number; z: number }[]): void {
  for (const p of points) b.summon(kind, variant, p.x, p.z);
}

export { MobKind };
