/**
 * Respawning health packs and ammo crates (rules: design-arena-maps §4.2).
 *
 * Owned by the movement & items package. The foundation wires the system into
 * the simulation (reset on map, round and warmup; stepped in live and warmup)
 * and mirrors `ready` to the room state; the gameplay is a stub until then.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import type { ArenaMap, PickupKind } from './mapTypes';
import type { PlayerSim } from './player';
import type { ArenaSimulation } from './sim';

export class PickupSystem {
  /** Per map pickup: sim tick at which it is available again (0 = now). Mirrored to ArenaState.pickupReady. */
  ready: number[] = [];

  /** New map, round or warmup: everything is available. */
  reset(map: ArenaMap): void {
    this.ready = map.pickups.map(() => 0);
  }

  /** Called by sim.step() in 'live' and 'warmup' only, after commands and projectiles. Emits 'pickup' events. */
  step(sim: ArenaSimulation): void {}
}

/** Applies a pickup; returns HP or rounds gained (0 = not useful, so the pickup is not consumed). */
export function applyPickup(s: PlayerSim, kind: PickupKind): number {
  return 0;
}
