/**
 * Player hazards (design-voxel-survival §4.3, §4.6): fall tracking from pose
 * samples, contact damage (cactus, lava) and the drowning check. Evaluated by
 * the server from its own world, never from client flags.
 */
import { Block, CONTACT_DAMAGE, isWater } from '../blocks';
import { PLAYER_EYE, PLAYER_HEIGHT, PLAYER_WIDTH } from '../constants';
import type { BlockQuery } from '../physics';
import { SURVIVAL } from './constants';

export class FallTracker {
  private peakY: number | null = null;

  /** Feeds a pose sample. Returns the fall distance when the sample lands, else 0. */
  update(y: number, grounded: boolean, cushioned: boolean): number {
    if (cushioned) {
      this.peakY = null;
      return 0;
    }
    if (!grounded) {
      this.peakY = this.peakY === null ? y : Math.max(this.peakY, y);
      return 0;
    }
    const d = this.peakY === null ? 0 : this.peakY - y;
    this.peakY = null;
    return Math.max(0, d);
  }

  reset(): void {
    this.peakY = null;
  }
}

/** Safe up to 4 blocks, then 1 HP per extra block. */
export function playerFallDamage(distance: number): number {
  return distance <= SURVIVAL.fallSafe ? 0 : Math.round(distance - SURVIVAL.fallSafe);
}

/** Highest contact damage (HP/s) of the cells the player box touches (slightly inflated), and whether one is lava. */
export function contactAt(get: BlockQuery, x: number, y: number, z: number): { dps: number; lava: boolean } {
  const half = PLAYER_WIDTH / 2 + 0.05;
  let dps = 0;
  let lava = false;
  for (let by = Math.floor(y - 0.05); by <= Math.floor(y + PLAYER_HEIGHT - 0.1); by++) {
    for (let bz = Math.floor(z - half); bz <= Math.floor(z + half); bz++) {
      for (let bx = Math.floor(x - half); bx <= Math.floor(x + half); bx++) {
        const b = get(bx, by, bz);
        if (CONTACT_DAMAGE[b] > dps) dps = CONTACT_DAMAGE[b];
        if (b === Block.Lava) lava = true;
      }
    }
  }
  return { dps, lava };
}

/** Head in water (drowning; lava burns instead). */
export function headInWater(get: BlockQuery, x: number, y: number, z: number, crouch = false): boolean {
  const ey = y + (crouch ? 1.32 : PLAYER_EYE);
  return isWater(get(Math.floor(x), Math.floor(ey), Math.floor(z)));
}
