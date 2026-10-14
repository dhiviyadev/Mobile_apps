/**
 * Simple but believable bots. They produce the same input commands a human
 * client sends, so they obey identical movement, fire-rate and ammo rules.
 *
 *  - Perception: nearest enemy in line of sight within a 140° view cone
 *    (or very close behind them).
 *  - Reaction time before firing, aim that converges on the target with a
 *    turn-rate limit and shrinking error, strafing at a preferred range.
 *  - Navigation over a small waypoint graph with BFS, repathing when stuck.
 */
import type { ArenaMap } from './maps';
import type { BoxWorld } from './geometry';
import { eyeHeight } from './movement';
import { Buttons, type Command } from './player';
import type { ArenaSimulation, SimPlayer } from './sim';
import { WeaponId, weaponDef } from './weapons';

export class NavGraph {
  readonly points: { x: number; y: number; z: number }[];
  readonly adj: number[][];

  constructor(map: ArenaMap, world: BoxWorld) {
    this.points = map.waypoints;
    this.adj = this.points.map(() => []);
    const link = (a: number, b: number) => {
      if (a === b || this.adj[a].includes(b)) return;
      this.adj[a].push(b);
      this.adj[b].push(a);
    };
    for (const [a, b] of map.links) if (this.points[a] && this.points[b]) link(a, b);
    // Auto-link points on the same level with a clear walk between them.
    for (let i = 0; i < this.points.length; i++) {
      for (let j = i + 1; j < this.points.length; j++) {
        const p = this.points[i];
        const q = this.points[j];
        if (Math.abs(p.y - q.y) > 0.3 || Math.hypot(p.x - q.x, p.z - q.z) > 12) continue;
        if (world.visible(p.x, p.y + 0.5, p.z, q.x, q.y + 0.5, q.z) && world.visible(p.x, p.y + 1.5, p.z, q.x, q.y + 1.5, q.z)) link(i, j);
      }
    }
  }

  nearest(x: number, y: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    this.points.forEach((p, i) => {
      const d = Math.hypot(p.x - x, (p.y - y) * 2, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Breadth-first path (waypoint indices, excluding the start). */
  path(from: number, to: number): number[] {
    if (from === to) return [to];
    const prev = new Array<number>(this.points.length).fill(-1);
    const queue = [from];
    prev[from] = from;
    while (queue.length) {
      const n = queue.shift()!;
      if (n === to) break;
      for (const m of this.adj[n]) {
        if (prev[m] === -1) {
          prev[m] = n;
          queue.push(m);
        }
      }
    }
    if (prev[to] === -1) return [];
    const out: number[] = [];
    for (let n = to; n !== from; n = prev[n]) out.unshift(n);
    return out;
  }
}

export interface BotBrain {
  seq: number;
  skill: number;
  reaction: number;
  yaw: number;
  pitch: number;
  targetId: string | null;
  acquiredAt: number;
  errYaw: number;
  errPitch: number;
  strafe: number;
  strafeUntil: number;
  path: number[];
  goal: number;
  lastSeen: { x: number; y: number; z: number; at: number } | null;
  stuckCheckAt: number;
  stuckPos: { x: number; z: number };
  jumpUntil: number;
  aimSince: number;
  rnd: () => number;
}

export function createBotBrain(rnd: () => number): BotBrain {
  // Tuned for touch players: noticeable reaction time and aim that needs a moment to settle.
  const skill = 0.2 + rnd() * 0.4;
  return {
    seq: 0,
    skill,
    reaction: 0.6 - skill * 0.3,
    yaw: 0,
    pitch: 0,
    targetId: null,
    acquiredAt: 0,
    errYaw: 0,
    errPitch: 0,
    strafe: 1,
    strafeUntil: 0,
    path: [],
    goal: -1,
    lastSeen: null,
    stuckCheckAt: 0,
    stuckPos: { x: 0, z: 0 },
    jumpUntil: 0,
    aimSince: 0,
    rnd,
  };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const turnToward = (cur: number, target: number, maxStep: number) => {
  const d = wrap(target - cur);
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
};

function preferredRange(weapon: WeaponId): number {
  switch (weapon) {
    case WeaponId.Shotgun:
      return 4;
    case WeaponId.Sniper:
      return 22;
    case WeaponId.Blade:
      return 1.2;
    default:
      return 11;
  }
}

/** Produces one 1/60 s command for a bot. */
export function botCommand(sim: ArenaSimulation, bot: SimPlayer, brain: BotBrain): Command {
  const dt = 1 / 60;
  const now = sim.time;
  const me = bot.sim;
  const cmd: Command = { seq: ++brain.seq, moveX: 0, moveY: 0, yaw: brain.yaw, pitch: brain.pitch, buttons: 0, slot: 255, viewTick: sim.tick };
  if (!me.alive) {
    brain.yaw = me.yaw;
    brain.targetId = null;
    brain.path = [];
    return { ...cmd, yaw: me.yaw };
  }
  if (sim.phase === 'loadout') {
    brain.yaw = me.yaw;
    brain.pitch = 0;
    return { ...cmd, yaw: me.yaw, pitch: 0 };
  }

  const eyeY = me.y + eyeHeight(me.crouching);
  const weapon = me.weapons[me.slot];
  const def = weaponDef(weapon.id);

  // ---- perception ------------------------------------------------------------------------
  let target: SimPlayer | null = null;
  let targetDist = Infinity;
  for (const o of sim.players.values()) {
    if (o === bot || !o.sim.alive) continue;
    if (sim.teams > 0 && o.team === bot.team) continue;
    const dx = o.sim.x - me.x;
    const dz = o.sim.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d >= targetDist) continue;
    const angle = Math.abs(wrap(Math.atan2(-dx, -dz) - brain.yaw));
    if (angle > 1.22 && d > 5) continue; // outside the view cone and not close
    const ty = o.sim.y + (o.sim.crouching ? 0.9 : 1.2);
    if (!sim.world.visible(me.x, eyeY, me.z, o.sim.x, ty, o.sim.z)) continue;
    target = o;
    targetDist = d;
  }

  let wantX = 0;
  let wantZ = 0;
  let lookYaw = brain.yaw;
  let lookPitch = 0;
  let firing = false;
  let aiming = false;

  if (target) {
    if (brain.targetId !== target.id) {
      brain.targetId = target.id;
      brain.acquiredAt = now;
      const miss = 0.35 * (1 - brain.skill) + 0.08;
      brain.errYaw = (brain.rnd() - 0.5) * miss * 2;
      brain.errPitch = (brain.rnd() - 0.5) * miss;
    }
    brain.lastSeen = { x: target.sim.x, y: target.sim.y, z: target.sim.z, at: now };
    brain.path = [];
    const dx = target.sim.x - me.x;
    const dz = target.sim.z - me.z;
    const aimY = target.sim.y + (target.sim.crouching ? 0.85 : 1.15) - eyeY;
    lookYaw = Math.atan2(-dx, -dz);
    lookPitch = Math.atan2(aimY, Math.hypot(dx, dz));
    // Aim error shrinks while tracking.
    const decay = Math.exp(-(1 + brain.skill * 2.2) * dt);
    brain.errYaw *= decay;
    brain.errPitch *= decay;
    lookYaw += brain.errYaw;
    lookPitch += brain.errPitch;

    // Keep a preferred range and strafe.
    const pref = preferredRange(weapon.id);
    const dirX = dx / (targetDist || 1);
    const dirZ = dz / (targetDist || 1);
    const approach = targetDist > pref + 3 ? 1 : targetDist < pref - 2 ? -0.7 : 0;
    if (now > brain.strafeUntil) {
      brain.strafe = brain.rnd() < 0.5 ? -1 : 1;
      brain.strafeUntil = now + 0.5 + brain.rnd() * 1.1;
    }
    wantX = dirX * approach + -dirZ * brain.strafe * 0.8;
    wantZ = dirZ * approach + dirX * brain.strafe * 0.8;

    const reacted = now - brain.acquiredAt > brain.reaction;
    const err = Math.abs(wrap(brain.yaw - (lookYaw - brain.errYaw))) + Math.abs(brain.pitch - (lookPitch - brain.errPitch));
    const tolerance = weapon.id === WeaponId.Sniper ? 0.03 : weapon.id === WeaponId.Shotgun ? 0.12 : 0.07 + 0.6 / Math.max(4, targetDist);
    const inRange = targetDist < def.range * (weapon.id === WeaponId.Shotgun ? 0.5 : 0.9);
    if (weapon.id === WeaponId.Sniper && targetDist > 6) {
      aiming = true;
      if (brain.aimSince === 0) brain.aimSince = now;
    } else brain.aimSince = 0;
    const scoped = weapon.id !== WeaponId.Sniper || now - brain.aimSince > 0.35 || targetDist <= 6;
    firing = reacted && err < tolerance && inRange && scoped;
  } else {
    brain.targetId = null;
    brain.aimSince = 0;
    // Navigate: chase the last sighting, otherwise roam the waypoint graph.
    if (brain.path.length === 0) {
      const from = sim.nav.nearest(me.x, me.y, me.z);
      let goal: number;
      if (brain.lastSeen && now - brain.lastSeen.at < 5) goal = sim.nav.nearest(brain.lastSeen.x, brain.lastSeen.y, brain.lastSeen.z);
      else goal = Math.floor(brain.rnd() * sim.nav.points.length);
      brain.goal = goal;
      brain.path = sim.nav.path(from, goal);
      if (brain.path.length === 0) brain.lastSeen = null;
    }
    const next = sim.nav.points[brain.path[0]];
    if (next) {
      const dx = next.x - me.x;
      const dz = next.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.1) {
        brain.path.shift();
        if (brain.path.length === 0) brain.lastSeen = null;
      } else {
        wantX = dx / d;
        wantZ = dz / d;
        lookYaw = Math.atan2(-dx, -dz);
      }
    }
    lookPitch = 0;
  }

  // ---- stuck detection -------------------------------------------------------------------------
  if (now > brain.stuckCheckAt) {
    const moved = Math.hypot(me.x - brain.stuckPos.x, me.z - brain.stuckPos.z);
    if (moved < 0.3 && (wantX || wantZ)) {
      brain.jumpUntil = now + 0.2;
      brain.path = [];
      brain.strafe = -brain.strafe;
    }
    brain.stuckPos = { x: me.x, z: me.z };
    brain.stuckCheckAt = now + 1;
  }

  // ---- turn with a rate limit -------------------------------------------------------------------
  const turn = (2.4 + brain.skill * 4) * dt;
  brain.yaw = turnToward(brain.yaw, lookYaw, turn);
  brain.pitch += Math.max(-turn, Math.min(turn, lookPitch - brain.pitch));

  // World-space wish direction → local strafe / forward.
  const sin = Math.sin(brain.yaw);
  const cos = Math.cos(brain.yaw);
  cmd.moveY = wantX * -sin + wantZ * -cos;
  cmd.moveX = wantX * cos + wantZ * -sin;
  cmd.yaw = brain.yaw;
  cmd.pitch = brain.pitch;

  let buttons = 0;
  if (firing) buttons |= Buttons.Fire;
  if (aiming) buttons |= Buttons.Aim;
  if (now < brain.jumpUntil) buttons |= Buttons.Jump;
  if (def.magazine > 0 && weapon.mag === 0 && weapon.reserve > 0) buttons |= Buttons.Reload;
  if (!target && def.magazine > 0 && weapon.mag < def.magazine * 0.4 && weapon.reserve > 0) buttons |= Buttons.Reload;
  cmd.buttons = buttons;
  // Out of ammo entirely: pistol, then blade.
  if (def.magazine > 0 && weapon.mag === 0 && weapon.reserve === 0) cmd.slot = me.slot === 0 ? 1 : 2;
  return cmd;
}
