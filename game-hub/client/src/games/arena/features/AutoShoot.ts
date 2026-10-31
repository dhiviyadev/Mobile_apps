/**
 * Auto-shoot (an accessibility option, off by default): presses Fire for you while the crosshair is
 * on a visible opponent. It only ever sets the Fire bit of normal 60 Hz commands, so the server checks
 * fire rate, ammo, line of sight and lag compensation exactly as for a finger on the trigger.
 *
 * "On an opponent" is the server's own hit test on what this client draws: traceRay for hitscan
 * weapons, every ray of the knife fan, and the crossbow's dropping bolt path. Walls block it, team
 * mates are never targets, and it never moves the camera. Pure logic: no DOM, no three.js.
 */
import {
  type BoxWorld,
  CMD_DT,
  type HitTarget,
  hitboxesFor,
  meleeFan,
  type PlayerSim,
  projectilePathHits,
  traceRay,
  type Tuple3,
  viewDir,
  type WeaponDef,
  weaponDef,
} from '@hub/shared';

/** An enemy as drawn this frame, with the hitboxes the server would test. */
export interface AimTarget extends HitTarget {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
}

/** A pose as interpolated for drawing (RemotePose has these fields). */
export interface DrawnPose {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
  alive: boolean;
}

/** Living enemies from this frame's drawn poses (teammates and the dead are never targets). */
export function buildAimTargets(poses: ReadonlyMap<string, DrawnPose>, isEnemy: (id: string) => boolean): AimTarget[] {
  const out: AimTarget[] = [];
  for (const [id, p] of poses) {
    if (!p.alive || !isEnemy(id)) continue;
    out.push({ id, x: p.x, y: p.y, z: p.z, crouching: p.crouching, boxes: hitboxesFor(p) });
  }
  return out;
}

/** The hit must stay under the crosshair this long before firing starts (no flicker shots while sweeping). */
export const ACQUIRE_MS = 60;
/** Automatic and burst weapons keep firing this long after the target leaves the ray (tracking over edges). */
export const GRACE_MS = 90;
/** Hip-fired sniper shots are only taken this close. */
export const SNIPER_HIP_RANGE = 10;

export type AutoShootState = 'off' | 'idle' | 'firing';

export interface AutoShootContext {
  /** The setting. */
  enabled: boolean;
  /** Input is live (not paused, pointer locked or touch) and the phase allows shooting. */
  canAct: boolean;
  /** The predicted local player. */
  p: PlayerSim | null;
  /** Camera position and view angles: what is on screen. */
  eye: Tuple3;
  yaw: number;
  pitch: number;
  targets: readonly AimTarget[];
  world: BoxWorld;
}

/** Id of the enemy the held weapon would hit if fired now along the view, or null. */
export function targetUnderCrosshair(ctx: AutoShootContext, def: WeaponDef): string | null {
  const p = ctx.p;
  if (!p || ctx.targets.length === 0) return null;
  const [ex, ey, ez] = ctx.eye;
  if (def.melee) {
    for (const [dx, dy, dz] of meleeFan(ctx.yaw, ctx.pitch, def.melee)) {
      const hit = traceRay(ex, ey, ez, dx, dy, dz, def.range, ctx.world, ctx.targets).hitId;
      if (hit) return hit;
    }
    return null;
  }
  const [fx, fy, fz] = viewDir(ctx.yaw, ctx.pitch);
  if (def.projectile) {
    const s = def.projectile.speed;
    return projectilePathHits(ctx.eye, [fx * s, fy * s, fz * s], def.projectile, ctx.world, ctx.targets, def.autoRange / s);
  }
  // A bolt-action shot from the hip is a coin toss: only close up, or once scoped in.
  const range = def.cls === 'sniper' && p.ads < 0.95 ? Math.min(def.autoRange, SNIPER_HIP_RANGE) : def.autoRange;
  return traceRay(ex, ey, ez, fx, fy, fz, range, ctx.world, ctx.targets).hitId;
}

/**
 * Whether one command should carry Fire. `p` is the predicted state before the command. Semi-automatic
 * weapons press exactly on the command where the next shot becomes possible and release otherwise, which
 * is their maximum legal rate. Never while reloading or on an empty magazine (auto-reload handles that).
 */
export function fireBit(p: PlayerSim, def: WeaponDef, wants: boolean): boolean {
  if (!wants || !p.alive) return false;
  // A magazine reload that completes during this command refills before the trigger is read.
  const refilled = p.reload > 0 && def.reloadKind === 'mag' && p.reload - CMD_DT <= 1e-6;
  if (p.reload > 0 && !refilled) return false;
  const w = p.weapons[p.slot];
  if (def.magazine > 0 && w.mag === 0 && !refilled) return false;
  if (def.fireMode === 'semi') {
    const ready = p.cooldown - CMD_DT <= 1e-6 && p.switching - CMD_DT <= 1e-6;
    return ready && !p.fireHeld;
  }
  return true;
}

export class AutoShoot {
  /** Fire is wanted for the commands of this frame. */
  wants = false;
  /** The crosshair is on an enemy right now (before the acquire delay). */
  onTarget = false;
  state: AutoShootState = 'off';
  private seenSince = -1;
  private lastSeen = -1e9;

  /** Once per frame, before commands are built. */
  update(nowMs: number, ctx: AutoShootContext): boolean {
    const p = ctx.p;
    if (!ctx.enabled || !ctx.canAct || !p || !p.alive) {
      this.reset();
      this.state = ctx.enabled ? 'idle' : 'off';
      return false;
    }
    const def = weaponDef(p.weapons[p.slot].id);
    this.onTarget = targetUnderCrosshair(ctx, def) !== null;
    if (this.onTarget) {
      if (this.seenSince < 0) this.seenSince = nowMs;
      this.lastSeen = nowMs;
    } else this.seenSince = -1;
    const acquired = this.onTarget && nowMs - this.seenSince >= ACQUIRE_MS;
    const grace = this.wants && def.fireMode !== 'semi' && nowMs - this.lastSeen <= GRACE_MS;
    this.wants = acquired || grace;
    this.state = this.wants ? 'firing' : 'idle';
    return this.wants;
  }

  reset(): void {
    this.wants = false;
    this.onTarget = false;
    this.seenSince = -1;
    this.lastSeen = -1e9;
  }
}
