/**
 * Hitboxes and hitscan resolution. Each player has two boxes: head and body.
 * Shots test the static world first (line of sight) and only count a player
 * hit if it is closer than the first wall along the ray.
 */
import { PLAYER } from './constants';
import { type Box, type BoxWorld, type RayHit, rayBox } from './geometry';
import { bodyHeight } from './movement';
import type { Shot } from './player';
import { falloffAt, weaponDef } from './weapons';

export interface PoseLike {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
}

export interface Hitboxes {
  head: Box;
  body: Box;
}

export function hitboxesFor(p: PoseLike): Hitboxes {
  const h = bodyHeight(p.crouching);
  const hs = PLAYER.headSize;
  const r = PLAYER.radius;
  return {
    body: { minX: p.x - r, maxX: p.x + r, minY: p.y, maxY: p.y + h - hs, minZ: p.z - r, maxZ: p.z + r },
    head: { minX: p.x - hs / 2, maxX: p.x + hs / 2, minY: p.y + h - hs, maxY: p.y + h, minZ: p.z - hs / 2, maxZ: p.z + hs / 2 },
  };
}

export interface HitTarget {
  id: string;
  boxes: Hitboxes;
}

export interface PelletResult {
  /** Where the tracer ends (world impact, player hit, or max range). */
  end: [number, number, number];
  hitId: string | null;
  headshot: boolean;
  distance: number;
  /** World surface normal at impact (for sparks), if a wall was hit. */
  wallNormal: [number, number, number] | null;
}

export interface DamageResult {
  id: string;
  damage: number;
  headshot: boolean;
}

/** One ray against the world and the targets. */
export interface RayResult {
  /** Closest target hit in front of the first wall, or null. */
  hitId: string | null;
  headshot: boolean;
  /** Distance to the hit (target, wall, or maxT when nothing is hit). */
  t: number;
  /** First wall within maxT (even when a target is closer). */
  wall: RayHit | null;
}

/**
 * The hit test every hitscan ray uses: walls first (line of sight), then each target's head and body,
 * closest wins. The server (resolveShot) and the client's auto-shoot share it, so they always agree.
 */
export function traceRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, world: BoxWorld, targets: readonly HitTarget[]): RayResult {
  const wall = world.raycast(ox, oy, oz, dx, dy, dz, maxT);
  let best = wall ? wall.t : maxT;
  let hitId: string | null = null;
  let headshot = false;
  for (const t of targets) {
    const th = rayBox(ox, oy, oz, dx, dy, dz, t.boxes.head, best);
    if (th >= 0 && th < best) {
      best = th;
      hitId = t.id;
      headshot = true;
    }
    const tb = rayBox(ox, oy, oz, dx, dy, dz, t.boxes.body, best);
    if (tb >= 0 && tb < best) {
      best = tb;
      hitId = t.id;
      headshot = false;
    }
  }
  return { hitId, headshot, t: best, wall };
}

/** A box grown by r on every side (projectile radius against hitboxes). */
export function inflate(b: Box, r: number): Box {
  return { minX: b.minX - r, minY: b.minY - r, minZ: b.minZ - r, maxX: b.maxX + r, maxY: b.maxY + r, maxZ: b.maxZ + r };
}

/**
 * Resolves every pellet of a shot. Damage per target is summed (shotguns), except for melee,
 * whose rays are one swing: a target takes the best ray's damage.
 */
export function resolveShot(shot: Shot, world: BoxWorld, targets: HitTarget[]): { pellets: PelletResult[]; damage: DamageResult[] } {
  const def = weaponDef(shot.weapon);
  const melee = def.kind === 'melee';
  const pellets: PelletResult[] = [];
  const dmg = new Map<string, DamageResult>();
  for (const [dx, dy, dz] of shot.dirs) {
    const { hitId, headshot, t: best, wall } = traceRay(shot.ox, shot.oy, shot.oz, dx, dy, dz, def.range, world, targets);
    const end: [number, number, number] = [shot.ox + dx * best, shot.oy + dy * best, shot.oz + dz * best];
    pellets.push({ end, hitId, headshot, distance: best, wallNormal: !hitId && wall ? [wall.nx, wall.ny, wall.nz] : null });
    if (hitId) {
      const amount = def.damage * falloffAt(def, best) * (headshot ? def.headMultiplier : 1);
      const prev = dmg.get(hitId);
      if (!prev) dmg.set(hitId, { id: hitId, damage: amount, headshot });
      else if (!melee) {
        prev.damage += amount;
        prev.headshot ||= headshot;
      } else if (amount > prev.damage) {
        prev.damage = amount;
        prev.headshot = headshot;
      }
    }
  }
  return { pellets, damage: [...dmg.values()].map((d) => ({ ...d, damage: Math.round(d.damage) })) };
}
