/**
 * Server-authoritative projectiles (crossbow bolts): analytic ballistics,
 * lag-compensated hits, and the ProjectileSystem the simulation drives.
 *
 * A bolt's position is always computed from its launch values and flight time
 * (projPos), never integrated step by step, and its path is tested in fixed
 * 1/60 s straight segments. The server stepper, the client's predicted trace
 * and auto-shoot's path test therefore agree to the bit.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import { TICK_RATE } from './constants';
import { type BoxWorld, rayBox } from './geometry';
import { type HitTarget, hitboxesFor, inflate } from './hitscan';
import type { Shot } from './player';
import type { ArenaSimulation, SimPlayer, Tuple3 } from './sim';
import { type ProjectileSpec, type WeaponId, weaponDef } from './weapons';

export const PROJ = {
  /** Bolts in flight per match. */
  maxActive: 64,
  /** Bolts in flight per shooter. */
  maxPerOwner: 6,
  /** Collision sub-step (s): two per 30 Hz tick. */
  step: 1 / 60,
} as const;

/** Below this height a bolt has left the map. */
const FLOOR_Y = -30;

export interface Projectile {
  id: number;
  owner: string;
  ownerIndex: number;
  team: number;
  weapon: WeaponId;
  /** Origin and launch velocity. */
  ox: number;
  oy: number;
  oz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Flight time so far (s). */
  age: number;
  spawnTick: number;
  /** Ticks of lag compensation still to apply to hit tests. */
  rewind: number;
  seq: number;
}

export interface ProjectileImpact {
  kind: 'world' | 'player' | 'expire';
  /** Flight time at impact (s). */
  t: number;
  pos: Tuple3;
  normal: Tuple3 | null;
  hitId: string | null;
  headshot: boolean;
}

/** Analytic position at flight time t (no incremental integration; server and client agree exactly). */
export function projPos(o: Tuple3, v: Tuple3, gravity: number, t: number): Tuple3 {
  return [o[0] + v[0] * t, o[1] + v[1] * t - 0.5 * gravity * t * t, o[2] + v[2] * t];
}

/** Low-arc launch pitch to hit a point (dx, dy, dz) away; null when out of reach. Bots use it. */
export function ballisticAim(dx: number, dy: number, dz: number, speed: number, gravity: number): { pitch: number; time: number } | null {
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return { pitch: dy >= 0 ? Math.PI / 2 : -Math.PI / 2, time: Math.abs(dy) / speed };
  if (gravity <= 0) return { pitch: Math.atan2(dy, d), time: Math.hypot(d, dy) / speed };
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * d * d + 2 * dy * v2);
  if (disc < 0) return null;
  const pitch = Math.atan((v2 - Math.sqrt(disc)) / (gravity * d));
  return { pitch, time: d / (speed * Math.cos(pitch)) };
}

/**
 * Tests path segment k (flight time k·step to (k+1)·step) as a straight line: the first wall, then each
 * target's head and body grown by the bolt radius (head first, like traceRay); the closest hit wins.
 */
function traceSegment(o: Tuple3, v: Tuple3, spec: ProjectileSpec, k: number, world: BoxWorld, targets: readonly HitTarget[]): ProjectileImpact | null {
  const t0 = k * PROJ.step;
  const a = projPos(o, v, spec.gravity, t0);
  const b = projPos(o, v, spec.gravity, (k + 1) * PROJ.step);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const wall = world.raycast(a[0], a[1], a[2], ux, uy, uz, len);
  let best = wall ? wall.t : len;
  let hitId: string | null = null;
  let headshot = false;
  for (const t of targets) {
    const th = rayBox(a[0], a[1], a[2], ux, uy, uz, inflate(t.boxes.head, spec.radius), best);
    if (th >= 0 && th < best) {
      best = th;
      hitId = t.id;
      headshot = true;
    }
    const tb = rayBox(a[0], a[1], a[2], ux, uy, uz, inflate(t.boxes.body, spec.radius), best);
    if (tb >= 0 && tb < best) {
      best = tb;
      hitId = t.id;
      headshot = false;
    }
  }
  if (!hitId && !wall) return null;
  const pos: Tuple3 = [a[0] + ux * best, a[1] + uy * best, a[2] + uz * best];
  const t = t0 + (best / len) * PROJ.step;
  if (hitId) return { kind: 'player', t, pos, normal: null, hitId, headshot };
  return { kind: 'world', t, pos, normal: [wall!.nx, wall!.ny, wall!.nz], hitId: null, headshot: false };
}

/** The end of a bolt's flight after `age` seconds without a hit, or null while it may still fly. */
function expiry(o: Tuple3, v: Tuple3, spec: ProjectileSpec, age: number): ProjectileImpact | null {
  const pos = projPos(o, v, spec.gravity, age);
  if (age < spec.life - 1e-9 && pos[1] > FLOOR_Y) return null;
  return { kind: 'expire', t: age, pos, normal: null, hitId: null, headshot: false };
}

/** Advances one bolt by `segments` collision steps (advancing pr.age); the impact, or null while in flight. */
export function stepProjectile(
  pr: Projectile,
  spec: ProjectileSpec,
  world: BoxWorld,
  targetsAt: (ageEnd: number) => readonly HitTarget[],
  segments = 2,
): ProjectileImpact | null {
  const o: Tuple3 = [pr.ox, pr.oy, pr.oz];
  const v: Tuple3 = [pr.vx, pr.vy, pr.vz];
  for (let s = 0; s < segments; s++) {
    const k = Math.round(pr.age / PROJ.step);
    const ageEnd = (k + 1) * PROJ.step;
    const hit = traceSegment(o, v, spec, k, world, targetsAt(ageEnd));
    pr.age = ageEnd;
    if (hit) return hit;
    const end = expiry(o, v, spec, ageEnd);
    if (end) return end;
  }
  return null;
}

/** Where a bolt fired from `o` with velocity `v` meets the world (same segments as the server). */
export function traceProjectileWorld(o: Tuple3, v: Tuple3, spec: ProjectileSpec, world: BoxWorld): ProjectileImpact {
  for (let k = 0; ; k++) {
    const hit = traceSegment(o, v, spec, k, world, []);
    if (hit) return hit;
    const end = expiry(o, v, spec, (k + 1) * PROJ.step);
    if (end) return end;
  }
}

/** Id of the first target the path crosses within maxTime, in front of any wall (auto-shoot), or null. */
export function projectilePathHits(o: Tuple3, v: Tuple3, spec: ProjectileSpec, world: BoxWorld, targets: readonly HitTarget[], maxTime: number): string | null {
  for (let k = 0; k * PROJ.step < Math.min(maxTime, spec.life); k++) {
    const hit = traceSegment(o, v, spec, k, world, targets);
    if (hit) return hit.hitId;
    if (projPos(o, v, spec.gravity, (k + 1) * PROJ.step)[1] < FLOOR_Y) return null;
  }
  return null;
}

/** Server-authoritative bolts (design-arena-weapons §5.3). sim.fire() calls spawn(); sim.step() calls step() once per tick. */
export class ProjectileSystem {
  readonly list: Projectile[] = [];
  private nextId = 1;

  /** rewindTicks is already clamped (0 for bots). Emits 'proj' via sim.emit. */
  spawn(sim: ArenaSimulation, owner: SimPlayer, shot: Shot, rewindTicks: number): void {
    const spec = weaponDef(shot.weapon).projectile;
    const dir = shot.dirs[0];
    if (!spec || !dir) return;
    const mine = this.list.filter((p) => p.owner === owner.id);
    if (mine.length >= PROJ.maxPerOwner) this.drop(sim, mine[0]);
    if (this.list.length >= PROJ.maxActive) this.drop(sim, this.list[0]);
    const pr: Projectile = {
      id: this.nextId,
      owner: owner.id,
      ownerIndex: owner.index,
      team: owner.team,
      weapon: shot.weapon,
      ox: shot.ox,
      oy: shot.oy,
      oz: shot.oz,
      vx: dir[0] * spec.speed,
      vy: dir[1] * spec.speed,
      vz: dir[2] * spec.speed,
      age: 0,
      spawnTick: sim.tick,
      rewind: rewindTicks,
      seq: shot.seq,
    };
    this.nextId = (this.nextId % 0xffff) + 1;
    this.list.push(pr);
    sim.emit({ type: 'proj', id: pr.id, shooter: owner.id, weapon: pr.weapon, origin: [pr.ox, pr.oy, pr.oz], vel: [pr.vx, pr.vy, pr.vz], tick: sim.tick, seq: pr.seq });
  }

  /** Advances every bolt two segments (one tick); hits go through sim.applyDamage, every end emits 'projEnd'. */
  step(sim: ArenaSimulation): void {
    for (let i = 0; i < this.list.length; ) {
      const pr = this.list[i];
      const spec = weaponDef(pr.weapon).projectile;
      const hit = spec ? stepProjectile(pr, spec, sim.world, (ageEnd) => this.targets(sim, pr, ageEnd), 2) : null;
      if (spec && !hit) {
        i++;
        continue;
      }
      this.list.splice(i, 1);
      if (hit) this.finish(sim, pr, hit);
    }
  }

  clear(): void {
    this.list.length = 0;
  }

  /**
   * Enemy hitboxes as the shooter saw them at flight age `ageEnd`: a constant rewind over the whole flight
   * (shooter time = spawnTick − rewind + age·TICK_RATE), the live pose once that time reaches the present.
   * The owner, teammates (team modes) and the dead are never targets.
   */
  private targets(sim: ArenaSimulation, pr: Projectile, ageEnd: number): HitTarget[] {
    const tick = pr.spawnTick - pr.rewind + ageEnd * TICK_RATE;
    const out: HitTarget[] = [];
    for (const o of sim.players.values()) {
      if (o.id === pr.owner || (sim.teams > 0 && o.team === pr.team) || !o.sim.alive) continue;
      const live = { x: o.sim.x, y: o.sim.y, z: o.sim.z, crouching: o.sim.crouching, alive: true };
      const pose = tick >= sim.tick ? live : (sim.poseAt(o.id, tick) ?? live);
      if (!pose.alive) continue;
      out.push({ id: o.id, boxes: hitboxesFor(pose) });
    }
    return out;
  }

  private finish(sim: ArenaSimulation, pr: Projectile, hit: ProjectileImpact): void {
    sim.emit({ type: 'projEnd', id: pr.id, pos: hit.pos, normal: hit.normal, hitId: hit.hitId, headshot: hit.headshot, tick: sim.tick });
    const owner = sim.players.get(pr.owner);
    // A bolt from a player who has left still lands, but deals no damage.
    if (hit.kind !== 'player' || !hit.hitId || !owner) return;
    const def = weaponDef(pr.weapon);
    owner.stats.hits++;
    sim.applyDamage(owner, hit.hitId, Math.round(def.damage * (hit.headshot ? def.headMultiplier : 1)), hit.headshot, pr.weapon);
  }

  /** Removes a bolt over the caps; clients end it where it is. */
  private drop(sim: ArenaSimulation, pr: Projectile): void {
    const i = this.list.indexOf(pr);
    if (i >= 0) this.list.splice(i, 1);
    const pos = projPos([pr.ox, pr.oy, pr.oz], [pr.vx, pr.vy, pr.vz], weaponDef(pr.weapon).projectile?.gravity ?? 0, pr.age);
    sim.emit({ type: 'projEnd', id: pr.id, pos, normal: null, hitId: null, headshot: false, tick: sim.tick });
  }
}
