/**
 * Hostile creature brains (design-voxel-mobs §5.4): melee (Mudlurch), ranged
 * (Rattlebow), climber (Cragcrawler), burster (Puffcap) and flyer (Duskwing),
 * with the daylight rules (drying, seeking shade, fleeing at dawn) and leashes
 * for structure guards and boss minions.
 */
import { DamageKind } from '../../combat';
import { IS_SOLID } from '../../blocks';
import { FLIGHT_CEILING } from '../../constants';
import { HazardKind, PROJECTILE_DEFS, type PlayerTarget } from '../api';
import { variantHitEffects } from '../defs';
import { openSky } from '../perception';
import { AiState, BurstKind, EntityEventType, MobAction, MobVariant, type Mob } from '../types';
import type { EntityWorld } from '../world';
import {
  aimAt,
  hdist,
  insideBox,
  lookAt,
  meleeHit,
  moveToGoal,
  selectTarget,
  setGoal,
  startAction,
  steer,
  stop,
  underSky,
  wanderPoint,
  yawTo,
  type Brain,
} from './common';

const SUN = 0.55;

/** Wander / return home / seek shade when there is no target. Returns true when it handled the tick's thinking. */
function idleThink(w: EntityWorld, m: Mob): void {
  // Leashed (guards, minions): go home when outside.
  if (m.leash && m.home && !insideBox(m.leash, m.x, m.y, m.z, -1)) {
    m.setState(AiState.ReturnHome);
    setGoal(w, m, m.home.x, m.home.y, m.home.z, { maxNodes: 150 });
    return;
  }
  // Shade seekers walk out of the sun.
  if (m.def.daylight === 'shade' && w.daylight > SUN && underSky(w, m)) {
    if (m.state !== AiState.SeekShade || m.stateTime > 6) {
      for (let i = 0; i < 6; i++) {
        const p = wanderPoint(w, m, 2, 8);
        if (p && !openSky(w.host.getBlock, Math.floor(p.x), p.y + 1, Math.floor(p.z))) {
          m.setState(AiState.SeekShade);
          setGoal(w, m, p.x, p.y, p.z, { maxNodes: 120 });
          return;
        }
      }
    }
    return;
  }
  if (m.state === AiState.Wander && hdist(m.x, m.z, m.goalX, m.goalZ) > 0.8 && m.stateTime < 10) return;
  if (m.state !== AiState.Idle && m.state !== AiState.Wander) m.setState(AiState.Idle, 1 + w.rng() * 3);
  if (m.stateTime < m.stateLength) return;
  const p = m.home && m.leash ? wanderPoint(w, m, 1, 5, m.home.x, m.home.z) : wanderPoint(w, m, 3, 8);
  if (p && w.rng() < 0.6) {
    m.setState(AiState.Wander);
    setGoal(w, m, p.x, p.y, p.z, { maxNodes: 100 });
  } else m.setState(AiState.Idle, 2 + w.rng() * 4);
}

function idleAct(w: EntityWorld, m: Mob, dt: number): void {
  if (m.state === AiState.Wander || m.state === AiState.SeekShade || m.state === AiState.ReturnHome) {
    moveToGoal(w, m, m.state === AiState.Wander ? m.def.wanderSpeed : m.def.runSpeed * 0.8, dt);
  }
}

/** Mudlurch drying in daylight (Sand variant and water are immune). */
function dayRules(w: EntityWorld, m: Mob, dt: number): void {
  m.drying = false;
  if (m.def.daylight !== 'dry' || m.variant === MobVariant.Sand || m.inWater) return;
  if (w.daylight > SUN && underSky(w, m)) {
    m.drying = true;
    m.speedMul *= 0.6;
    m.t3 += dt;
    if (m.t3 >= 1) {
      m.t3 = 0;
      w.damageMob(m.id, { amount: 1, kind: DamageKind.Fire, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
    }
  }
}

function target(w: EntityWorld, m: Mob): PlayerTarget | null {
  return m.targetId ? (w.playerById(m.targetId) ?? null) : null;
}

/** Chase: path toward the target, re-pathing when it moves. */
function chase(w: EntityWorld, m: Mob, t: PlayerTarget, goalRadius = 1.2): void {
  m.setState(AiState.Chase);
  setGoal(w, m, t.x, t.y, t.z, { maxNodes: 300, goalRadius, priority: 1 });
}

// ---- Mudlurch -------------------------------------------------------------------------

export const meleeBrain: Brain = {
  think(w, m) {
    if (m.state === AiState.Windup || m.state === AiState.Recover) return;
    const t = selectTarget(w, m);
    if (!t) return idleThink(w, m);
    const a = m.def.attack!;
    const d = hdist(t.x, t.z, m.x, m.z);
    if (d <= a.reach + m.halfWidth + 0.3 && Math.abs(t.y - m.y) < 1.5 && m.cooldown <= 0) {
      m.setState(AiState.Windup);
      m.t1 = a.windup;
      startAction(w, m, MobAction.Attack, a.windup + 0.3);
      return;
    }
    chase(w, m, t);
  },
  act(w, m, dt) {
    stop(m);
    dayRules(w, m, dt);
    const t = target(w, m);
    const a = m.def.attack!;
    switch (m.state) {
      case AiState.Windup:
        if (t) lookAt(m, t.x, t.y + 1.4, t.z);
        m.t1 -= dt;
        if (m.t1 <= 0) {
          meleeHit(w, m, t, a);
          m.cooldown = a.cooldown;
          m.setState(AiState.Recover, 0.35);
        }
        return;
      case AiState.Recover:
        if (m.stateTime >= m.stateLength) {
          m.setState(AiState.Chase);
          m.thinkNow = true;
        }
        return;
      case AiState.Chase:
        if (!t) return m.setState(AiState.Idle, 1);
        moveToGoal(w, m, m.def.runSpeed, dt, 0.8);
        lookAt(m, t.x, t.y + 1.5, t.z);
        if (hdist(t.x, t.z, m.x, m.z) < a.reach + 0.2) stop(m);
        return;
      default:
        idleAct(w, m, dt);
    }
  },
};

// ---- Rattlebow ------------------------------------------------------------------------

export const rangedBrain: Brain = {
  think(w, m) {
    if (m.state === AiState.Windup) return;
    const t = selectTarget(w, m);
    if (!t) return idleThink(w, m);
    const d = hdist(t.x, t.z, m.x, m.z);
    const los = w.sees(m.x, m.eyeY, m.z, t.x, t.y + 1.4, t.z, 'shoot', m.state === AiState.Kite);
    if (d > 15 || !los) return chase(w, m, t, 6);
    if (m.state !== AiState.Kite) {
      m.setState(AiState.Kite);
      m.t2 = w.rng() < 0.5 ? 1 : -1;
      m.t3 = 1.5 + w.rng() * 1.5;
    }
    if (m.cooldown <= 0) {
      m.setState(AiState.Windup);
      m.t1 = m.def.attack!.windup;
      startAction(w, m, MobAction.Draw, m.t1);
    }
  },
  act(w, m, dt) {
    stop(m);
    const t = target(w, m);
    const a = m.def.attack!;
    if (m.state === AiState.Chase) {
      if (!t) return m.setState(AiState.Idle, 1);
      moveToGoal(w, m, m.def.runSpeed, dt, 1);
      lookAt(m, t.x, t.y + 1.5, t.z);
      return;
    }
    if (m.state === AiState.Kite || m.state === AiState.Windup) {
      if (!t) return m.setState(AiState.Idle, 1);
      const d = hdist(t.x, t.z, m.x, m.z);
      const away = { x: (m.x - t.x) / (d || 1), z: (m.z - t.z) / (d || 1) };
      const speed = m.state === AiState.Windup ? 0.8 : m.def.wanderSpeed;
      if (d < 6) {
        // Back away unless that walks off a ledge.
        const nx = m.x + away.x * 1.2;
        const nz = m.z + away.z * 1.2;
        const get = w.host.getBlock;
        let floor = false;
        for (let k = 1; k <= 3 && !floor; k++) if (IS_SOLID[get(Math.floor(nx), Math.floor(m.y) - k, Math.floor(nz))]) floor = true;
        if (floor) steer(m, nx, nz, m.def.runSpeed, 0);
      } else {
        m.t3 -= dt;
        if (m.t3 <= 0) {
          m.t2 = -m.t2;
          m.t3 = 1.5 + w.rng() * 1.5;
        }
        steer(m, m.x - away.z * m.t2, m.z + away.x * m.t2, speed, 0);
      }
      lookAt(m, t.x, t.y + 1.4, t.z);
      if (m.state === AiState.Windup) {
        m.t1 -= dt;
        if (w.tick % 4 === m.thinkSlot && !w.sees(m.x, m.eyeY, m.z, t.x, t.y + 1.4, t.z, 'shoot', true)) {
          m.setState(AiState.Kite);
          m.cooldown = 0.5;
          return;
        }
        if (m.t1 <= 0) {
          const oy = m.eyeY - 0.2;
          const v = aimAt(w, m.x, oy, m.z, t, a.speed!, PROJECTILE_DEFS[a.projectile!].gravity);
          const len = Math.hypot(v.vx, v.vz) || 1;
          w.spawnProjectile({
            kind: a.projectile!,
            owner: m.ref,
            team: m.team,
            x: m.x + (v.vx / len) * 0.5,
            y: oy,
            z: m.z + (v.vz / len) * 0.5,
            ...v,
            damage: a.damage,
            knockback: a.knockback,
            lift: a.lift,
            hitsPlayers: true,
            pickupItem: null,
            effects: variantHitEffects(m.variant),
          });
          startAction(w, m, MobAction.Attack, 0.3, 1);
          m.cooldown = a.cooldown;
          m.setState(AiState.Kite);
        }
      }
      return;
    }
    idleAct(w, m, dt);
  },
};

// ---- Cragcrawler ----------------------------------------------------------------------

export const climberBrain: Brain = {
  think(w, m) {
    if (m.state === AiState.Windup || m.state === AiState.Lunge || m.state === AiState.Recover) return;
    const t = selectTarget(w, m);
    if (!t) return idleThink(w, m);
    const d = hdist(t.x, t.z, m.x, m.z);
    const lunge = m.def.attack!;
    const bite = m.def.attack2!;
    if (d <= bite.reach + m.halfWidth + 0.3 && m.cooldown2 <= 0 && Math.abs(t.y - m.y) < 1.5) {
      m.setState(AiState.Windup);
      m.t1 = bite.windup;
      m.t2 = 2; // bite
      startAction(w, m, MobAction.Attack, bite.windup + 0.2);
      return;
    }
    if (d > lunge.range![0] && d < lunge.range![1] && m.onGround && m.cooldown <= 0 && w.sees(m.x, m.eyeY, m.z, t.x, t.y + 1, t.z, 'shoot', false)) {
      m.setState(AiState.Windup);
      m.t1 = lunge.windup;
      m.t2 = 1; // lunge
      startAction(w, m, MobAction.Attack, lunge.windup + 0.5);
      return;
    }
    chase(w, m, t);
  },
  act(w, m, dt) {
    stop(m);
    const t = target(w, m);
    switch (m.state) {
      case AiState.Windup:
        if (t) lookAt(m, t.x, t.y + 1, t.z);
        m.t1 -= dt;
        if (m.t1 > 0) return;
        if (m.t2 === 2) {
          meleeHit(w, m, t, m.def.attack2!);
          m.cooldown2 = m.def.attack2!.cooldown;
          m.setState(AiState.Recover, 0.4);
        } else if (t) {
          // Leap at where the target will be.
          const lt = 0.35;
          const px = t.x + t.vx * lt;
          const pz = t.z + t.vz * lt;
          const d = hdist(px, pz, m.x, m.z) || 1;
          m.vx = ((px - m.x) / d) * m.def.attack!.speed!;
          m.vz = ((pz - m.z) / d) * m.def.attack!.speed!;
          m.vy = 6;
          m.onGround = false;
          m.t1 = 0;
          m.setState(AiState.Lunge);
          w.emit({ type: EntityEventType.MobAction, id: m.id, action: MobAction.Charge, param: 0, x: m.x, y: m.y, z: m.z });
        } else m.setState(AiState.Recover, 0.5);
        return;
      case AiState.Lunge: {
        m.intent.vx = m.vx;
        m.intent.vz = m.vz;
        if (t && m.t1 === 0 && Math.abs(t.x - m.x) < m.halfWidth + t.halfWidth + 0.3 && Math.abs(t.z - m.z) < m.halfWidth + t.halfWidth + 0.3 && t.y < m.y + m.height + 0.3 && t.y + t.height > m.y - 0.3) {
          m.t1 = 1;
          const a = m.def.attack!;
          w.hurtPlayer(t.id, { amount: a.damage, kind: DamageKind.Melee, attacker: m.ref, fromX: m.x - m.vx * 0.1, fromY: m.y, fromZ: m.z - m.vz * 0.1, knockback: a.knockback, lift: a.lift, effects: variantHitEffects(m.variant) });
        }
        if ((m.onGround && m.stateTime > 0.2) || m.stateTime > 1.5) {
          m.cooldown = m.def.attack!.cooldown;
          m.setState(AiState.Recover, 0.6);
        }
        return;
      }
      case AiState.Recover:
        if (m.stateTime >= m.stateLength) {
          m.setState(AiState.Chase);
          m.thinkNow = true;
        }
        return;
      case AiState.Chase:
        if (!t) return m.setState(AiState.Idle, 1);
        moveToGoal(w, m, m.def.runSpeed, dt, 0.8);
        m.intent.climb = true;
        lookAt(m, t.x, t.y + 1, t.z);
        return;
      default:
        idleAct(w, m, dt);
    }
  },
};

// ---- Puffcap --------------------------------------------------------------------------

function puffBurst(w: EntityWorld, m: Mob, mul: number): void {
  const a = m.def.attack!;
  w.burst(m.x, m.y + 0.5, m.z, a.radius!, a.damage * mul, a.knockback, a.lift, m.ref, m.team, BurstKind.Spores);
  w.hazards.spawn({ kind: HazardKind.SporeCloud, x: m.x, y: w.floorBelow(m.x, m.y + 0.5, m.z), z: m.z, radius: 2.5, seconds: 4, dps: 0.5, slow: 0.4, team: m.team, owner: m.ref });
  // The Puffcap is spent: dies without drops.
  if (m.alive) w.damageMob(m.id, { amount: 1e6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
}

export const bursterBrain: Brain = {
  think(w, m) {
    if (m.state === AiState.Inflate || m.state === AiState.Recover) return;
    const t = selectTarget(w, m);
    if (!t) return idleThink(w, m);
    const a = m.def.attack!;
    const d = Math.hypot(t.x - m.x, t.y - m.y, t.z - m.z);
    if (d <= a.reach && m.cooldown <= 0 && w.sees(m.x, m.eyeY, m.z, t.x, t.y + 1, t.z, 'see', false)) {
      m.setState(AiState.Inflate);
      m.t1 = a.windup;
      startAction(w, m, MobAction.Inflate, a.windup);
      return;
    }
    chase(w, m, t, 1.5);
  },
  act(w, m, dt) {
    stop(m);
    const t = target(w, m);
    const a = m.def.attack!;
    switch (m.state) {
      case AiState.Inflate:
        if (t) {
          lookAt(m, t.x, t.y + 1, t.z);
          steer(m, t.x, t.z, m.def.runSpeed * 0.3, 1);
        }
        m.t1 -= dt;
        if (m.t1 <= 0) {
          if (t && Math.hypot(t.x - m.x, t.y - m.y, t.z - m.z) <= a.range![1]) puffBurst(w, m, 1);
          else {
            m.setState(AiState.Recover, 1);
            m.cooldown = a.cooldown + 1;
            startAction(w, m, MobAction.Idle, 0.1);
          }
        }
        return;
      case AiState.Recover:
        if (m.stateTime >= m.stateLength) m.setState(AiState.Chase);
        return;
      case AiState.Chase:
        if (!t) return m.setState(AiState.Idle, 1);
        moveToGoal(w, m, m.def.runSpeed, dt, 1);
        lookAt(m, t.x, t.y + 1, t.z);
        return;
      default:
        idleAct(w, m, dt);
    }
  },
  onHurt(w, m, req, res) {
    // Hit while inflating: it pops at once, at 70%.
    if (m.state === AiState.Inflate && m.alive && !res.killed && req.attacker?.type !== 'mob') puffBurst(w, m, 0.7);
  },
};

// ---- Duskwing -------------------------------------------------------------------------

function groundBelow(w: EntityWorld, x: number, y: number, z: number): number {
  const get = w.host.getBlock;
  for (let yy = Math.floor(y); yy > 0; yy--) if (IS_SOLID[get(Math.floor(x), yy - 1, Math.floor(z))]) return yy;
  return 0;
}

export const flyerBrain: Brain = {
  think(w, m) {
    if (!m.home) m.home = { x: m.x, y: m.y, z: m.z };
    if (w.daylight > 0.4) {
      m.setState(AiState.Retreat, 99);
      m.targetId = null;
      return;
    }
    if (m.state === AiState.Swoop || m.state === AiState.Retreat) return;
    const t = selectTarget(w, m);
    if (t && m.cooldown <= 0 && w.sees(m.x, m.y, m.z, t.x, t.y + 1.5, t.z, 'see', false)) {
      m.setState(AiState.Swoop);
      startAction(w, m, MobAction.Swoop, 1.5);
      return;
    }
    if (m.state !== AiState.Patrol) {
      m.setState(AiState.Patrol);
      m.t2 = w.rng() * Math.PI * 2;
      m.t3 = 4 + w.rng() * 4;
    }
  },
  act(w, m, dt) {
    stop(m);
    const it = m.intent;
    const t = target(w, m);
    const speed = m.def.wanderSpeed;
    if (m.state === AiState.Retreat) {
      // Up and away (dawn: keep climbing until it leaves).
      const away = t ? Math.atan2(m.z - t.z, m.x - t.x) : m.t2;
      it.vx = Math.cos(away) * speed * 0.6;
      it.vz = Math.sin(away) * speed * 0.6;
      it.vy = 4;
      if (w.daylight <= 0.4 && m.stateTime > 2.5) m.setState(AiState.Patrol);
    } else if (m.state === AiState.Swoop && t) {
      const tx = t.x;
      const ty = t.y + 1.5;
      const tz = t.z;
      const d = Math.hypot(tx - m.x, ty - m.y, tz - m.z) || 1;
      const s = m.def.runSpeed;
      it.vx = ((tx - m.x) / d) * s;
      it.vz = ((tz - m.z) / d) * s;
      it.vy = ((ty - m.y) / d) * s;
      m.vx = it.vx;
      m.vz = it.vz;
      m.vy = it.vy;
      if (d < m.def.attack!.reach + 0.3) {
        const a = m.def.attack!;
        w.hurtPlayer(t.id, { amount: a.damage, kind: DamageKind.Melee, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: a.knockback, lift: a.lift });
        m.cooldown = a.cooldown;
        m.setState(AiState.Retreat, 2.5);
      } else if (m.stateTime > 3) {
        m.cooldown = 1.5;
        m.setState(AiState.Retreat, 1.5);
      }
    } else {
      // Patrol: circle 4-8 blocks above the ground around the target (or home).
      const cx = t ? t.x : m.home?.x ?? m.x;
      const cz = t ? t.z : m.home?.z ?? m.z;
      m.t2 += dt * (speed / 5);
      const gx = cx + Math.cos(m.t2) * 5;
      const gz = cz + Math.sin(m.t2) * 5;
      steer(m, gx, gz, speed, 0.2);
      const gy = groundBelow(w, m.x, m.y + 2, m.z) + m.t3;
      it.vy = Math.max(-3, Math.min(3, (gy - m.y) * 1.5));
    }
    // Obstacle avoidance: climb when the way ahead is blocked.
    const sp = Math.hypot(it.vx, it.vz);
    if (sp > 0.1) {
      const get = w.host.getBlock;
      const ax = m.x + (it.vx / sp) * 2;
      const az = m.z + (it.vz / sp) * 2;
      if (IS_SOLID[get(Math.floor(ax), Math.floor(m.y + 0.3), Math.floor(az))]) it.vy = Math.max(it.vy ?? 0, 4);
      it.faceYaw = yawTo(m, m.x + it.vx, m.z + it.vz);
    }
    // Never above the flight ceiling (tall builds reach close to the build height).
    if (m.y >= FLIGHT_CEILING && (it.vy ?? 0) > 0) it.vy = 0;
  },
};

