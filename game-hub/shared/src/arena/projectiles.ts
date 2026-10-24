/**
 * Server-authoritative projectiles (crossbow bolts): analytic ballistics,
 * lag-compensated hits, and the ProjectileSystem the simulation drives.
 *
 * Owned by the weapons package (design-arena-weapons §5). The foundation ships
 * the types, the exact ballistics helpers bots need (projPos, ballisticAim) and
 * stubs; no weapon fires projectiles yet.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import type { BoxWorld } from './geometry';
import type { HitTarget } from './hitscan';
import type { Shot } from './player';
import type { ArenaSimulation, SimPlayer, Tuple3 } from './sim';
import type { ProjectileSpec, WeaponId } from './weapons';

export const PROJ = {
  /** Bolts in flight per match. */
  maxActive: 64,
  /** Bolts in flight per shooter. */
  maxPerOwner: 6,
  /** Collision sub-step (s). */
  step: 1 / 60,
} as const;

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

/** Advances one bolt by `segments` collision steps (design-arena-weapons §5.2). Stub: never hits. */
export function stepProjectile(
  pr: Projectile,
  spec: ProjectileSpec,
  world: BoxWorld,
  targetsAt: (ageEnd: number) => readonly HitTarget[],
  segments = 2,
): ProjectileImpact | null {
  return null;
}

/** Where a bolt fired from `o` with velocity `v` meets the world. Stub: flies its whole life. */
export function traceProjectileWorld(o: Tuple3, v: Tuple3, spec: ProjectileSpec, world: BoxWorld): ProjectileImpact {
  return { kind: 'expire', t: spec.life, pos: projPos(o, v, spec.gravity, spec.life), normal: null, hitId: null, headshot: false };
}

/** Id of the first target the path crosses within maxTime (auto-shoot), or null. Stub: none. */
export function projectilePathHits(o: Tuple3, v: Tuple3, spec: ProjectileSpec, world: BoxWorld, targets: readonly HitTarget[], maxTime: number): string | null {
  return null;
}

/** Server-authoritative bolts (design-arena-weapons §5.3). sim.fire() calls spawn(); sim.step() calls step() once per tick. */
export class ProjectileSystem {
  readonly list: Projectile[] = [];

  /** rewindTicks is already clamped (0 for bots). Emits 'proj' via sim.emit. */
  spawn(sim: ArenaSimulation, owner: SimPlayer, shot: Shot, rewindTicks: number): void {}

  /** Advances every bolt PROJ segments; hits go through sim.applyDamage + 'projEnd'. */
  step(sim: ArenaSimulation): void {}

  clear(): void {
    this.list.length = 0;
  }
}
