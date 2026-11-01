/**
 * Friendly creature brains (design-voxel-mobs §5.4): idle / wander / graze,
 * panic (herds panic together), tempted by liked food, tamed creatures follow
 * their owner and seek mates, babies follow adults, Hoplings hop, Cluckits
 * flutter; and the Glimmerfin swim brain.
 */
import { IS_LIQUID } from '../../blocks';
import { MobFlag, AiState, MobAction, type Mob } from '../types';
import type { EntityWorld } from '../world';
import { fleePoint, hdist, lookAt, moveToGoal, setGoal, startAction, steer, stop, wanderPoint, yawTo, type Brain } from './common';

const PANIC_SECONDS = 4;
const HERD_RADIUS = 8;

function likes(m: Mob, item: string | null): boolean {
  return !!item && m.def.likes.includes(item);
}

/** A player that frightens this creature right now, if any. */
function threat(w: EntityWorld, m: Mob): { x: number; z: number } | null {
  if (w.time - m.lastHitAt < 0.1 && m.lastHitBy) return { x: m.threatX, z: m.threatZ };
  if (m.has(MobFlag.Tamed)) return null;
  for (const p of w.players) {
    if (!p.alive) continue;
    const d = hdist(p.x, p.z, m.x, m.z);
    if (m.def.skittish && d < 10 && !p.crouching && Math.abs(p.y - m.y) < 6) return p;
    if (p.sprinting && d < 6) return p;
  }
  return null;
}

export const friendlyBrain: Brain = {
  think(w, m) {
    const def = m.def;
    const t = threat(w, m);
    if (t) {
      m.panicUntil = Math.max(m.panicUntil, w.time + (w.time - m.lastHitAt < 0.5 ? PANIC_SECONDS : 1.5));
      m.threatX = t.x;
      m.threatZ = t.z;
    }
    if (w.time < m.panicUntil) {
      if (m.state !== AiState.Panic || m.stateTime > 1.5) {
        const p = fleePoint(w, m, m.threatX, m.threatZ, 10);
        m.setState(AiState.Panic);
        m.goalX = p.x;
        m.goalZ = p.z;
        setGoal(w, m, p.x, p.y, p.z, { maxNodes: 80, priority: 2, minInterval: 0.5 });
      }
      return;
    }
    // Tamed in love: find a mate.
    if (m.has(MobFlag.Tamed) && m.loveUntil > w.time && !m.has(MobFlag.Baby)) {
      let mate: Mob | null = null;
      let best = 8;
      for (const o of w.mobsAround(m.x, m.z, 8)) {
        if (o === m || !o.alive || o.kind !== m.kind || o.loveUntil <= w.time || o.has(MobFlag.Baby)) continue;
        const d = hdist(o.x, o.z, m.x, m.z);
        if (d < best) {
          best = d;
          mate = o;
        }
      }
      if (mate) {
        m.setState(AiState.SeekMate);
        m.t1 = mate.id;
        setGoal(w, m, mate.x, mate.y, mate.z, { maxNodes: 80, goalRadius: 1, minInterval: 0.5 });
        return;
      }
    }
    // Tempted: someone nearby holds food it likes (tamed: only its owner leads it).
    if (def.likes.length) {
      let best: { id: string; x: number; y: number; z: number } | null = null;
      let bestD = m.has(MobFlag.Tamed) ? 12 : 8;
      for (const p of w.players) {
        if (!p.alive) continue;
        if (m.has(MobFlag.Tamed) && p.name !== m.owner) continue;
        const d = hdist(p.x, p.z, m.x, m.z);
        if (d < bestD && Math.abs(p.y - m.y) < 4 && likes(m, w.heldItem(p.id))) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        m.setState(m.has(MobFlag.Tamed) ? AiState.FollowOwner : AiState.Tempted);
        m.targetId = best.id;
        setGoal(w, m, best.x, best.y, best.z, { maxNodes: 100, goalRadius: 2 });
        return;
      }
    }
    m.targetId = null;
    // Babies stay near an adult of their kind.
    if (m.has(MobFlag.Baby)) {
      let adult: Mob | null = null;
      let best = 12;
      for (const o of w.mobsAround(m.x, m.z, 12)) {
        if (o === m || !o.alive || o.kind !== m.kind || o.has(MobFlag.Baby)) continue;
        const d = hdist(o.x, o.z, m.x, m.z);
        if (d < best) {
          best = d;
          adult = o;
        }
      }
      if (adult && best > 4) {
        m.setState(AiState.FollowOwner);
        setGoal(w, m, adult.x, adult.y, adult.z, { maxNodes: 80, goalRadius: 2 });
        return;
      }
    }
    if (m.state === AiState.Panic || m.state === AiState.Tempted || m.state === AiState.FollowOwner || m.state === AiState.SeekMate) {
      m.setState(AiState.Idle, 1 + w.rng() * 2);
    }
    if (m.state === AiState.Wander) {
      if (hdist(m.x, m.z, m.goalX, m.goalZ) < 0.8 || m.stateTime > 12) m.setState(AiState.Idle, 2 + w.rng() * 4);
      return;
    }
    if (m.stateTime < m.stateLength) return;
    // Idle / graze over: graze (half the time), else wander.
    if (def.graze && m.state === AiState.Idle && w.rng() < 0.5) {
      m.setState(AiState.Graze, 2 + w.rng() * 3);
      startAction(w, m, MobAction.Graze, m.stateLength);
      return;
    }
    const home = m.has(MobFlag.Tamed) && m.home ? m.home : null;
    const p = home && hdist(m.x, m.z, home.x, home.z) > 10 ? wanderPoint(w, m, 1, 5, home.x, home.z) : wanderPoint(w, m, 3, 8);
    if (p) {
      m.setState(AiState.Wander);
      setGoal(w, m, p.x, p.y, p.z, { maxNodes: 120, goalRadius: 1 });
    } else m.setState(AiState.Idle, 2 + w.rng() * 4);
  },

  act(w, m, dt) {
    const def = m.def;
    stop(m);
    let speed = 0;
    switch (m.state) {
      case AiState.Panic:
        speed = def.runSpeed;
        moveToGoal(w, m, speed, dt);
        break;
      case AiState.Wander:
        speed = def.wanderSpeed;
        moveToGoal(w, m, speed, dt);
        break;
      case AiState.Tempted:
      case AiState.FollowOwner: {
        const p = m.targetId ? w.playerById(m.targetId) : undefined;
        speed = def.wanderSpeed * 1.4;
        if (m.has(MobFlag.Baby)) speed *= 1.2;
        const d = moveToGoal(w, m, speed, dt, 2);
        if (d < 2.2) stop(m);
        if (p) lookAt(m, p.x, p.y + 1.5, p.z);
        break;
      }
      case AiState.SeekMate: {
        const mate = w.mobs.get(m.t1);
        if (mate) {
          speed = def.wanderSpeed;
          m.goalX = mate.x;
          m.goalZ = mate.z;
          moveToGoal(w, m, speed, dt, 1);
        }
        break;
      }
      case AiState.Graze:
        m.headPitch = 0;
        break;
      default:
        m.headPitch *= 0.9;
    }
    if (def.hop) hop(m, dt, m.state === AiState.Panic);
  },

  onHurt(w, m) {
    m.panicUntil = w.time + PANIC_SECONDS;
    if (!m.def.herd) return;
    for (const o of w.mobsAround(m.x, m.z, HERD_RADIUS)) {
      if (o === m || !o.alive || o.kind !== m.kind || hdist(o.x, o.z, m.x, m.z) > HERD_RADIUS) continue;
      o.panicUntil = Math.max(o.panicUntil, w.time + 2);
      o.threatX = m.threatX;
      o.threatZ = m.threatZ;
      o.thinkNow = true;
    }
  },
};

/** Hoplings move only in hops: wait on the ground, then leap with the intended velocity. */
function hop(m: Mob, dt: number, panic: boolean): void {
  const it = m.intent;
  const want = Math.hypot(it.vx, it.vz);
  if (!m.onGround) {
    // Keep the take-off momentum in the air.
    it.vx = m.vx;
    it.vz = m.vz;
    return;
  }
  m.t2 -= dt;
  if (want > 0.1 && m.t2 <= 0) {
    m.vx = it.vx * 1.15;
    m.vz = it.vz * 1.15;
    it.jump = true;
    m.t2 = panic ? 0.25 : 0.45;
    m.intent.faceYaw = Math.atan2(-it.vx, -it.vz);
  } else {
    it.vx = 0;
    it.vz = 0;
    it.jump = false;
  }
}

/** Glimmerfin: schools in water, darts from players, flops on land. */
export const fishBrain: Brain = {
  think(w, m) {
    if (!m.inWater) {
      m.setState(AiState.Idle);
      return;
    }
    for (const p of w.players) {
      if (p.alive && Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z) < 4) {
        m.panicUntil = w.time + 1.5;
        m.threatX = p.x;
        m.threatZ = p.z;
      }
    }
    const get = w.host.getBlock;
    if (w.time < m.panicUntil && (m.state !== AiState.Panic || m.stateTime > 1)) {
      const a = Math.atan2(m.z - m.threatZ, m.x - m.threatX) + (w.rng() - 0.5);
      m.setState(AiState.Panic);
      m.goalX = m.x + Math.cos(a) * 6;
      m.goalZ = m.z + Math.sin(a) * 6;
      m.goalY = m.y;
      return;
    }
    if (m.state !== AiState.Swim || m.stateTime > m.stateLength || hdist(m.x, m.z, m.goalX, m.goalZ) < 0.5) {
      for (let i = 0; i < 6; i++) {
        const x = m.x + (w.rng() - 0.5) * 12;
        const y = m.y + (w.rng() - 0.5) * 3;
        const z = m.z + (w.rng() - 0.5) * 12;
        if (IS_LIQUID[get(Math.floor(x), Math.floor(y), Math.floor(z))] && IS_LIQUID[get(Math.floor(x), Math.floor(y) + 1, Math.floor(z))]) {
          m.setState(AiState.Swim, 2 + w.rng() * 2);
          m.goalX = x;
          m.goalY = Math.floor(y) + 0.3;
          m.goalZ = z;
          return;
        }
      }
      m.setState(AiState.Swim, 1);
      m.goalX = m.x;
      m.goalY = m.y;
      m.goalZ = m.z;
    }
  },

  act(w, m, dt) {
    stop(m);
    const it = m.intent;
    if (!m.inWater) {
      // Flop toward water.
      m.t2 -= dt;
      if (m.onGround && m.t2 <= 0) {
        const a = w.rng() * Math.PI * 2;
        m.vx = Math.cos(a) * 2;
        m.vz = Math.sin(a) * 2;
        it.jump = true;
        m.t2 = 0.6;
      }
      it.vx = m.vx;
      it.vz = m.vz;
      return;
    }
    const speed = m.state === AiState.Panic ? m.def.runSpeed : m.def.wanderSpeed * 0.6;
    const get = w.host.getBlock;
    // Never leave the water: steer only toward water cells.
    const nx = m.x + Math.sign(m.goalX - m.x) * 0.6;
    const nz = m.z + Math.sign(m.goalZ - m.z) * 0.6;
    if (!IS_LIQUID[get(Math.floor(nx), Math.floor(m.y + 0.1), Math.floor(nz))]) {
      m.goalX = m.x - (m.goalX - m.x);
      m.goalZ = m.z - (m.goalZ - m.z);
    }
    steer(m, m.goalX, m.goalZ, speed, 0.3);
    const surface = IS_LIQUID[get(Math.floor(m.x), Math.floor(m.y + 0.8), Math.floor(m.z))] ? 99 : Math.floor(m.y + 0.8) - 0.6;
    const ty = Math.min(m.goalY, surface);
    it.vy = Math.max(-1.5, Math.min(1.5, (ty - m.y) * 2));
    if (Math.hypot(it.vx, it.vz) > 0.2) it.faceYaw = yawTo(m, m.x + it.vx, m.z + it.vz);
  },

  onHurt(w, m) {
    m.panicUntil = w.time + 2;
  },
};
