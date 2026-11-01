/**
 * Survival tuning and wire flags (design-voxel-survival §4, §12.2, §13;
 * INTEGRATION-voxel.md §1.5). Every number lives here so balance has one home.
 * Flag bits and enum values travel on the wire: append only.
 */
import { COMBAT } from '../combat';

export const SURVIVAL = {
  maxHealth: 20,
  maxFood: 20,
  maxAir: 10,
  regenFastFood: 12,
  regenFastInterval: 3,
  regenSlowInterval: 10,
  regenFoodCost: 0.5,
  regenDelayAfterHit: 5,
  foodDrainPerSecond: 1 / 60,
  sprintFoodPerSecond: 1 / 25,
  starveInterval: 8,
  starveFloor: 6,
  airDrainPerSecond: 1,
  airRefillPerSecond: 4,
  drownDamage: 2,
  drownInterval: 1,
  fallSafe: 4,
  contactInterval: 0.5,
  voidY: -16,
  respawnFood: 16,
  spawnProtection: 3,
  eatTime: 1.0,
  pickupRadius: 1.4,
  pickupDelay: 0.6,
  throwPickupDelay: 2.0,
  arrowPickupRadius: 1.2,
  dropLifetime: 300,
  maxDrops: 160,
  mergeRadius: 1.0,
  satchelOwnerOnly: 300,
  satchelLifetime: 1800,
  maxSatchelsPerPlayer: 3,
  stationRadius: 4,
  hardnessScale: 2.5,
  wrongToolPenalty: 3.33,
  breakTimingFactor: 0.8,
  breakLatencySlack: 0.15,
  meleeReachSlack: 0.6,
  meleeHistoryMs: 300,
  meleePad: 0.3,
  aimAngleSlack: 0.6,
  originSlack: 1.0,
  critMultiplier: 1.5,
  sprintKnockBonus: 3,
  shieldBash: 2.0,
  guardRaiseTime: 0.2,
  /** Front arc of a raised shield: horizontal dot >= cos(arc / 2) (0.5 for 120°). */
  guardArcCos: Math.cos(COMBAT.shieldArc / 2),
  guardSpeedMul: 0.45,
  drawSpeedMul: 0.5,
  loadSpeedMul: 0.6,
  eatSpeedMul: 0.5,
  restRadius: 12,
  restSeconds: 2,
  interestRadius: 80,
  /** Seconds of +knockGraceSpeed b/s move allowance after a knockback. */
  knockGrace: 0.9,
  knockGraceSpeed: 9,
  containerRange: 6,
  /** A crossbow-fired arrow does this fraction of the crossbow's damage. */
  crossbowArrowMul: 0.82,
  /** Lava contact keeps burning this long after leaving it. */
  lavaBurnSeconds: 3,
} as const;

/** Hand message flags (C→S `hd`). */
export const HandFlags = { Guard: 1, Use: 2 } as const;
/** VoxelPlayer.act bits (remote animation). */
export const ActFlags = { Guard: 1, Draw: 2, Load: 4, Loaded: 8, Eat: 16, Dead: 32, Rest: 64, Burning: 128 } as const;
/** Owner vitals flags (S→C `vt`). */
export const VitalFlags = { Dead: 1, Starving: 2, Resting: 4, Protected: 8, ShieldDisabled: 16 } as const;
/** VoxelState.rules bits; bits 2..3 reserved for a difficulty. */
export const RuleFlags = { PvP: 1, KeepInventory: 2 } as const;

export interface SurvivalRules {
  pvp: boolean;
  keepInventory: boolean;
  /** Sandbox: nobody is hurt, no inventories, infinite ammo. */
  creative: boolean;
}

export const rulesToFlags = (r: { pvp: boolean; keepInventory: boolean }): number => (r.pvp ? RuleFlags.PvP : 0) | (r.keepInventory ? RuleFlags.KeepInventory : 0);

/** Slot refs (u8 on the wire): 0..8 hotbar, 9..35 main, 36 off-hand, 64..90 the open container. */
export const HOTBAR = 9;
export const MAIN_START = 9;
export const MAIN_END = 36;
export const OFFHAND = 36;
export const PLAYER_SLOTS = 37;
export const CONTAINER_BASE = 64;
export const CONTAINER_SLOTS = 27;

export enum InteractKind {
  OpenChest = 1,
  UseBedroll = 2,
  StopRest = 3,
  CloseContainer = 4,
}

/** Positional sounds in `S` record 7 (u8). Append only. */
export enum SurvivalSfx {
  ToolBreak = 1,
  EatDone = 2,
  ShieldBreak = 3,
  XbowLoaded = 4,
  Pickup = 5,
  SatchelDrop = 6,
  Craft = 7,
  BowShot = 8,
  XbowShot = 9,
  Eat = 10,
}

/** Crossbow meta: bits 12..13 hold the loaded ammo, bits 0..11 the wear. */
export const LOAD_SHIFT = 12;
export const WEAR_MASK = 0xfff;
export enum LoadedAmmo {
  None = 0,
  Arrow = 1,
  Bolt = 2,
  EmberArrow = 3,
}
export const loadedOf = (meta: number): LoadedAmmo => ((meta >> LOAD_SHIFT) & 3) as LoadedAmmo;
export const wearOf = (meta: number): number => meta & WEAR_MASK;
export const withLoad = (meta: number, ammo: LoadedAmmo): number => (meta & WEAR_MASK) | (ammo << LOAD_SHIFT);
