/**
 * Respawning health packs and ammo crates (rules: design-arena-maps §4.2).
 *
 * Pickups are server-authoritative sim state: `ready[i]` is the tick at which
 * pickup i is available again (mirrored to ArenaState.pickupReady online).
 * A player collects a pickup by touching it while it would actually help
 * (missing HP, or room in a primary/secondary reserve); a useless touch does
 * not consume it. The client uses the same touch and usefulness rules for its
 * cosmetic pre-hide, but HP and ammo only change through snapshots.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import { MAX_HP, PICKUP, TICK_RATE } from './constants';
import type { ArenaMap, MapPickup, PickupKind } from './mapTypes';
import type { PlayerSim } from './player';
import type { ArenaSimulation } from './sim';
import { weaponDef } from './weapons';

export class PickupSystem {
  /** Per map pickup: sim tick at which it is available again (0 = now). Mirrored to ArenaState.pickupReady. */
  ready: number[] = [];

  /** New map, round or warmup: everything is available. */
  reset(map: ArenaMap): void {
    this.ready = map.pickups.map(() => 0);
  }

  /** Called by sim.step() in 'live' and 'warmup' only, after commands and projectiles. Emits 'pickup' events. */
  step(sim: ArenaSimulation): void {
    const list = sim.map.pickups;
    for (let i = 0; i < list.length; i++) {
      if (this.ready[i] > sim.tick) continue;
      const pk = list[i];
      // Insertion order: deterministic on the authority, so a tie goes to whoever joined first.
      for (const p of sim.players.values()) {
        if (!pickupTouches(p.sim, pk)) continue;
        const amount = applyPickup(p.sim, pk.kind);
        if (amount === 0) continue;
        this.ready[i] = sim.tick + Math.round(pickupRespawn(pk.kind, sim.phase === 'warmup') * TICK_RATE);
        sim.emit({ type: 'pickup', id: p.id, index: i, kind: pk.kind, amount });
        break;
      }
    }
  }
}

/** Seconds until a taken pickup is back. */
export function pickupRespawn(kind: PickupKind, warmup: boolean): number {
  if (warmup) return PICKUP.warmupRespawn;
  return kind === 'health' ? PICKUP.healthRespawn : PICKUP.ammoRespawn;
}

/** Whether a living player is close enough to collect the pickup (jumping over it still counts). */
export function pickupTouches(s: PlayerSim, pk: MapPickup): boolean {
  if (!s.alive) return false;
  if (s.y < pk.y - PICKUP.below || s.y > pk.y + PICKUP.above) return false;
  return Math.hypot(s.x - pk.x, s.z - pk.z) <= PICKUP.radius;
}

/** Rounds an ammo crate would add to a weapon slot's reserve (0 when full or a melee weapon). */
function ammoGain(s: PlayerSim, slot: 0 | 1): number {
  const w = s.weapons[slot];
  const max = weaponDef(w.id).reserve;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(max - w.reserve, Math.ceil(max * PICKUP.ammoFraction)));
}

/** HP or rounds a pickup would give right now, without applying it (0 = not useful). */
export function pickupValue(s: PlayerSim, kind: PickupKind): number {
  if (kind === 'health') return s.hp >= MAX_HP ? 0 : Math.min(MAX_HP, s.hp + PICKUP.healthAmount) - s.hp;
  return ammoGain(s, 0) + ammoGain(s, 1);
}

/** Applies a pickup; returns HP or rounds gained (0 = not useful, so the pickup is not consumed). */
export function applyPickup(s: PlayerSim, kind: PickupKind): number {
  if (kind === 'health') {
    const gained = pickupValue(s, 'health');
    s.hp += gained;
    return gained;
  }
  // Primary and secondary reserves only; the knife has none. Auto-reload refills an empty magazine.
  const a = ammoGain(s, 0);
  const b = ammoGain(s, 1);
  s.weapons[0].reserve += a;
  s.weapons[1].reserve += b;
  return a + b;
}
