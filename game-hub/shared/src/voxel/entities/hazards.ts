/**
 * Hazard zones on the floor (design-voxel-mobs §3.5): spore clouds, frost and
 * thorn patches, fire trails and the expanding thorn ring. Damage in 0.5 s
 * pulses (the ring: once per target as its band passes).
 */
import { DamageKind, StatusKind, type EntityRef, type Team } from '../combat';
import { HazardKind, type HazardSpawn } from './api';
import type { EntityWorld } from './world';

export class Hazard {
  left: number;
  pulse = 0;
  readonly struck = new Set<string>();
  constructor(
    readonly id: number,
    readonly kind: HazardKind,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    public radius: number,
    readonly seconds: number,
    readonly dps: number,
    readonly slow: number,
    readonly team: Team,
    readonly owner: EntityRef | null,
    readonly growRate: number,
  ) {
    this.left = seconds;
  }
}

const RING_BAND = 0.6;

export class HazardSystem {
  readonly list: Hazard[] = [];

  constructor(private readonly w: EntityWorld) {}

  spawn(s: HazardSpawn): number {
    if (this.list.length >= this.w.caps.maxHazards) {
      const old = this.list.shift()!;
      this.w.ids.release(old.id);
    }
    const id = this.w.ids.take();
    if (!id) return 0;
    this.list.push(new Hazard(id, s.kind, s.x, s.y, s.z, s.radius, s.seconds, s.dps, s.slow, s.team, s.owner, s.growRate ?? 0));
    return id;
  }

  step(dt: number): void {
    const w = this.w;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const h = this.list[i];
      h.left -= dt;
      if (h.left <= 0) {
        this.list.splice(i, 1);
        w.ids.release(h.id);
        continue;
      }
      if (h.kind === HazardKind.ThornRing) {
        h.radius += h.growRate * dt;
        this.ring(h);
        continue;
      }
      h.pulse -= dt;
      if (h.pulse > 0) continue;
      h.pulse = 0.5;
      const kind = h.kind === HazardKind.FireTrail ? DamageKind.Fire : DamageKind.Magic;
      const effects = h.slow > 0 ? [{ kind: StatusKind.Slow, strength: h.slow, seconds: 0.6 }] : undefined;
      w.forTargetsIn(h.x, h.z, h.radius, h.team, (t) => {
        if (Math.abs(t.y - h.y) >= 1.2) return;
        const req = { amount: h.dps * 0.5, kind, attacker: h.owner, fromX: h.x, fromY: h.y, fromZ: h.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true, effects };
        if (t.mob) w.damageMob(t.mob.id, req);
        else w.hurtPlayer(t.playerId!, req);
      });
    }
  }

  /** The thorn ring hits a target once, when its band passes the target's feet. */
  private ring(h: Hazard): void {
    const w = this.w;
    w.forTargetsIn(h.x, h.z, h.radius + RING_BAND, h.team, (t) => {
      const key = t.mob ? `m${t.mob.id}` : `p${t.playerId}`;
      if (h.struck.has(key)) return;
      const d = Math.hypot(t.x - h.x, t.z - h.z);
      if (Math.abs(d - h.radius) > RING_BAND / 2 + 0.3 || Math.abs(t.y - h.y) > 0.7) return;
      h.struck.add(key);
      const req = { amount: h.dps, kind: DamageKind.Burst, attacker: h.owner, fromX: h.x, fromY: h.y, fromZ: h.z, knockback: 5, lift: 3, unblockable: true };
      if (t.mob) w.damageMob(t.mob.id, req);
      else w.hurtPlayer(t.playerId!, req);
    });
  }
}
