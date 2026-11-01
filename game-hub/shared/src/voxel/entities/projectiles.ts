/**
 * Every projectile of the voxel game (design-voxel-mobs §3.4, INTEGRATION §1.4):
 * player arrows and bolts as well as creature and boss volleys. Ballistic
 * flight in sub-steps of at most 0.5 block, hits against real block shapes and
 * creature/player boxes, sticking, bursts, caps.
 */
import { DamageKind, Team, type EntityRef, type StatusEffect } from '../combat';
import { PROJECTILE_DEFS, type ProjectileDef, type ProjectileKind, type ProjectileSpawn, type ProjectileState } from './api';
import { segmentBox, segmentHitSolid } from './perception';
import { EntityEventType } from './types';
import type { EntityWorld } from './world';

export class VoxelProjectile implements ProjectileState {
  stuck = false;
  /** Seconds left in flight, or stuck. */
  life: number;
  age = 0;
  pierceLeft: number;
  readonly hit = new Set<string>();
  stuckCell: [number, number, number] | null = null;
  readonly def: ProjectileDef;
  readonly pickupItem: string | null;

  constructor(
    readonly id: number,
    readonly kind: ProjectileKind,
    readonly owner: EntityRef,
    readonly team: Team,
    public x: number,
    public y: number,
    public z: number,
    public vx: number,
    public vy: number,
    public vz: number,
    readonly damage: number,
    readonly knockback: number,
    readonly lift: number,
    readonly crit: boolean,
    readonly effects: StatusEffect[] | undefined,
    readonly hitsPlayers: boolean,
    readonly seq: number,
    readonly stickSeconds: number,
    pierce: number,
    pickupItem: string | null,
  ) {
    this.def = PROJECTILE_DEFS[kind];
    this.life = this.def.maxLife;
    this.pierceLeft = pierce;
    this.pickupItem = pickupItem;
  }
}

const SEGMENT = 0.5;

export class VoxelProjectileSystem {
  readonly list: VoxelProjectile[] = [];

  constructor(private readonly w: EntityWorld) {}

  spawn(s: ProjectileSpawn): number {
    const def = PROJECTILE_DEFS[s.kind];
    if (!def || ![s.x, s.y, s.z, s.vx, s.vy, s.vz, s.damage].every(Number.isFinite)) return 0;
    while (this.list.length >= this.w.caps.maxProjectiles) {
      let idx = this.list.findIndex((p) => p.stuck);
      if (idx < 0) idx = 0;
      this.removeAt(idx);
    }
    const id = this.w.ids.take();
    if (!id) return 0;
    const effects = [...(def.effects ?? []), ...(s.effects ?? [])];
    const p = new VoxelProjectile(
      id, s.kind, s.owner, s.team, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.damage, s.knockback, s.lift ?? 1.5, !!s.crit,
      effects.length ? effects : undefined, s.hitsPlayers, s.seq ?? 0,
      s.stickSeconds !== undefined ? Math.min(s.stickSeconds, def.stickSeconds) : def.stickSeconds,
      s.pierce ?? def.pierce, s.pickupItem ?? null,
    );
    this.list.push(p);
    return id;
  }

  remove(id: number): void {
    const i = this.list.findIndex((p) => p.id === id);
    if (i >= 0) this.removeAt(i);
  }

  private removeAt(i: number): void {
    const p = this.list[i];
    this.list.splice(i, 1);
    this.w.ids.release(p.id);
  }

  /** A block changed: stuck projectiles in that cell drop their item (or vanish). */
  onBlockChanged(x: number, y: number, z: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const c = p.stuckCell;
      if (!p.stuck || !c || c[0] !== x || c[1] !== y || c[2] !== z) continue;
      if (p.pickupItem) this.w.hooks.dropItems(p.x, p.y, p.z, [{ item: p.pickupItem, count: 1 }], p.owner);
      this.removeAt(i);
    }
  }

  step(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      p.life -= dt;
      if (p.life <= 0) {
        this.removeAt(i);
        continue;
      }
      if (p.stuck) continue;
      if (this.fly(p, dt)) this.removeAt(i);
    }
  }

  /** Advances one projectile; true when it is used up. */
  private fly(p: VoxelProjectile, dt: number): boolean {
    const w = this.w;
    const def = p.def;
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    const n = Math.max(1, Math.min(16, Math.ceil((speed * dt) / SEGMENT)));
    const sdt = dt / n;
    for (let s = 0; s < n; s++) {
      p.vy -= def.gravity * sdt;
      const inLiquid = w.isLiquid(p.x, p.y, p.z);
      const drag = Math.max(0, 1 - (def.drag + (inLiquid ? def.waterDrag : 0)) * sdt);
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
      const nx = p.x + p.vx * sdt;
      const ny = p.y + p.vy * sdt;
      const nz = p.z + p.vz * sdt;
      const block = segmentHitSolid(w.host.getBlock, p.x, p.y, p.z, nx, ny, nz);
      let tBlock = block ? block.t : Infinity;
      if (ny < -4) tBlock = 0;
      // Entities: nearest box the segment enters before the block.
      const hit = this.entityHit(p, nx, ny, nz, tBlock);
      if (hit) {
        const hx = p.x + (nx - p.x) * hit.t;
        const hy = p.y + (ny - p.y) * hit.t;
        const hz = p.z + (nz - p.z) * hit.t;
        if (def.burst) {
          this.explode(p, hx, hy, hz);
          return true;
        }
        const len = Math.max(1e-6, Math.hypot(p.vx, p.vy, p.vz));
        const req = {
          amount: p.damage,
          kind: def.damageKind,
          attacker: p.owner,
          fromX: hx - (p.vx / len) * 0.5,
          fromY: hy - (p.vy / len) * 0.5,
          fromZ: hz - (p.vz / len) * 0.5,
          knockback: p.knockback,
          lift: p.lift,
          unblockable: def.unblockable,
          effects: p.effects,
          crit: p.crit,
          projectileId: p.id,
        };
        if (hit.mob) {
          p.hit.add(`m${hit.mob}`);
          w.damageMob(hit.mob, req);
        } else if (hit.player) {
          p.hit.add(`p${hit.player}`);
          w.hurtPlayer(hit.player, req);
        }
        w.emit({ type: EntityEventType.ProjHit, projId: p.id, projKind: p.kind, what: hit.mob ? 1 : 2, x: hx, y: hy, z: hz });
        if (p.pierceLeft-- <= 0) return true;
        continue;
      }
      if (block || tBlock === 0) {
        const t = block ? block.t : 0;
        const hx = p.x + (nx - p.x) * t;
        const hy = p.y + (ny - p.y) * t;
        const hz = p.z + (nz - p.z) * t;
        if (def.burst) {
          this.explode(p, hx, hy, hz);
          return true;
        }
        w.emit({ type: EntityEventType.ProjHit, projId: p.id, projKind: p.kind, what: 0, x: hx, y: hy, z: hz });
        if (p.stickSeconds > 0 && block) {
          // Back off a hair so the tip sits on the surface.
          const len = Math.max(1e-6, Math.hypot(p.vx, p.vy, p.vz));
          p.x = hx - (p.vx / len) * 0.05;
          p.y = hy - (p.vy / len) * 0.05;
          p.z = hz - (p.vz / len) * 0.05;
          p.stuck = true;
          p.stuckCell = [block.x, block.y, block.z];
          p.life = p.stickSeconds;
          if (p.owner.type === 'player') w.hooks.onProjectileStuck?.(p);
          return false;
        }
        return true;
      }
      p.x = nx;
      p.y = ny;
      p.z = nz;
    }
    return false;
  }

  private entityHit(p: VoxelProjectile, nx: number, ny: number, nz: number, maxT: number): { t: number; mob?: number; player?: string } | null {
    const w = this.w;
    const r = p.def.radius;
    let best: { t: number; mob?: number; player?: string } | null = null;
    const mx = (p.x + nx) / 2;
    const mz = (p.z + nz) / 2;
    const reach = Math.hypot(nx - p.x, nz - p.z) / 2 + 3;
    for (const m of w.mobsAround(mx, mz, reach)) {
      if (!m.alive || m.team === p.team || (p.owner.type === 'mob' && p.owner.id === m.id) || p.hit.has(`m${m.id}`)) continue;
      // Hostile volleys never hit other hostiles; player shots hit everything else.
      const t = segmentBox(p.x, p.y, p.z, nx, ny, nz, m.x - m.halfWidth - r, m.y - r, m.z - m.halfWidth - r, m.x + m.halfWidth + r, m.y + m.height + r, m.z + m.halfWidth + r);
      if (t >= 0 && t <= maxT && (!best || t < best.t)) best = { t, mob: m.id };
    }
    if (p.hitsPlayers) {
      for (const pl of w.players) {
        if (!pl.alive || p.hit.has(`p${pl.id}`) || (p.owner.type === 'player' && p.owner.id === pl.id)) continue;
        if (p.team === Team.Player && p.owner.type !== 'player') continue;
        const t = segmentBox(p.x, p.y, p.z, nx, ny, nz, pl.x - pl.halfWidth - r, pl.y - r, pl.z - pl.halfWidth - r, pl.x + pl.halfWidth + r, pl.y + pl.height + r, pl.z + pl.halfWidth + r);
        if (t >= 0 && t <= maxT && (!best || t < best.t)) best = { t, player: pl.id };
      }
    }
    return best;
  }

  private explode(p: VoxelProjectile, x: number, y: number, z: number): void {
    const b = p.def.burst!;
    this.w.burst(x, y, z, b.radius, b.damage, b.knockback, b.lift, p.owner, p.team, 5, DamageKind.Burst, p.effects);
    if (b.hazard) {
      const fy = this.w.floorBelow(x, y, z);
      this.w.hazards.spawn({ ...b.hazard, x, y: fy, z, team: p.team, owner: p.owner });
    }
  }
}
