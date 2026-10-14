/**
 * Hitboxes and hitscan resolution. Each player has two boxes: head and body.
 * Shots test the static world first (line of sight) and only count a player
 * hit if it is closer than the first wall along the ray.
 */
import { PLAYER } from './constants';
import { type Box, type BoxWorld, rayBox } from './geometry';
import { bodyHeight } from './movement';
import type { Shot } from './player';
import { weaponDef } from './weapons';

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

/** Resolves every pellet of a shot. Damage per target is summed (shotguns). */
export function resolveShot(shot: Shot, world: BoxWorld, targets: HitTarget[]): { pellets: PelletResult[]; damage: DamageResult[] } {
  const def = weaponDef(shot.weapon);
  const pellets: PelletResult[] = [];
  const dmg = new Map<string, DamageResult>();
  for (const [dx, dy, dz] of shot.dirs) {
    const wall = world.raycast(shot.ox, shot.oy, shot.oz, dx, dy, dz, def.range);
    let best = wall ? wall.t : def.range;
    let hitId: string | null = null;
    let headshot = false;
    for (const t of targets) {
      const th = rayBox(shot.ox, shot.oy, shot.oz, dx, dy, dz, t.boxes.head, best);
      if (th >= 0 && th < best) {
        best = th;
        hitId = t.id;
        headshot = true;
      }
      const tb = rayBox(shot.ox, shot.oy, shot.oz, dx, dy, dz, t.boxes.body, best);
      if (tb >= 0 && tb < best) {
        best = tb;
        hitId = t.id;
        headshot = false;
      }
    }
    const end: [number, number, number] = [shot.ox + dx * best, shot.oy + dy * best, shot.oz + dz * best];
    pellets.push({ end, hitId, headshot, distance: best, wallNormal: !hitId && wall ? [wall.nx, wall.ny, wall.nz] : null });
    if (hitId) {
      const falloff =
        best <= def.falloffStart ? 1 : Math.max(def.falloffMin, 1 - ((best - def.falloffStart) / Math.max(1, def.range - def.falloffStart)) * (1 - def.falloffMin));
      const amount = def.damage * falloff * (headshot ? def.headMultiplier : 1);
      const prev = dmg.get(hitId);
      if (prev) {
        prev.damage += amount;
        prev.headshot ||= headshot;
      } else dmg.set(hitId, { id: hitId, damage: amount, headshot });
    }
  }
  return { pellets, damage: [...dmg.values()].map((d) => ({ ...d, damage: Math.round(d.damage) })) };
}
