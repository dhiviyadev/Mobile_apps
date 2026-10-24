/**
 * Contract between the creature simulation (EntityWorld, WP-C) and the player
 * side (survival, WP-B). WP-C implements EntityWorldApi; WP-B implements
 * PlayerHooks and calls EntityWorldApi. Both run on the server (ServerEntities /
 * SurvivalRoomHost) and offline in the browser (LocalEntities / LocalSurvival).
 */
import type { DamageKind, DamageRequest, DamageOutcome, EntityRef, StatusEffect, Team } from '../combat';
import { DamageKind as DK, StatusKind } from '../combat';

/** u8 on the wire; never renumber. 1..2 and 8 are player ammo, 3..7 mob/boss volleys. */
export enum ProjectileKind {
  Arrow = 1,
  Bolt = 2,
  MobArrow = 3,
  SunBolt = 4,
  IceShard = 5,
  SeedPod = 6,
  Ember = 7,
  EmberArrow = 8,
}

export enum HazardKind {
  SporeCloud = 1,
  FrostPatch = 2,
  ThornPatch = 3,
  FireTrail = 4,
  ThornRing = 5,
}

export interface HazardSpawn {
  kind: HazardKind;
  /** y = floor surface. */
  x: number;
  y: number;
  z: number;
  radius: number;
  seconds: number;
  /** DamageKind.Magic (FireTrail: Fire), ignoreArmor, applied in 0.5 s pulses. */
  dps: number;
  /** Slow strength while inside (refreshed every 0.5 s). */
  slow: number;
  /** Hurts every team except this one. */
  team: Team;
  owner: EntityRef | null;
  /** ThornRing: radius grows by this per second (band 0.6 wide, hits feet within 0.7 of y). */
  growRate?: number;
}

export interface ProjectileDef {
  kind: ProjectileKind;
  gravity: number;
  /** Fraction of speed lost per second (air). */
  drag: number;
  /** Extra fraction lost per second in liquid. */
  waterDrag: number;
  /** Inflates target boxes. */
  radius: number;
  /** Seconds in flight before expiring. */
  maxLife: number;
  /** 0 = vanish on block hit; > 0 = stays stuck (rendered) this long. Sandbox (creative): min(stickSeconds, 10). */
  stickSeconds: number;
  /** Extra entities it passes through. */
  pierce: number;
  damageKind: DamageKind;
  unblockable?: boolean;
  effects?: StatusEffect[];
  burst?: { radius: number; damage: number; knockback: number; lift: number; hazard?: Omit<HazardSpawn, 'x' | 'y' | 'z' | 'team' | 'owner'> };
  /** Renderer hint (emissive head / glow). */
  glow?: boolean;
}

/** Numbers: player ammo from design-voxel-survival §19.4 (it owns them), the rest from design-voxel-mobs §3.4. */
export const PROJECTILE_DEFS: Readonly<Record<ProjectileKind, ProjectileDef>> = {
  [ProjectileKind.Arrow]: { kind: ProjectileKind.Arrow, gravity: 16, drag: 0.35, waterDrag: 3, radius: 0.1, maxLife: 6, stickSeconds: 30, pierce: 0, damageKind: DK.Projectile },
  [ProjectileKind.Bolt]: { kind: ProjectileKind.Bolt, gravity: 12, drag: 0.25, waterDrag: 3, radius: 0.1, maxLife: 4, stickSeconds: 30, pierce: 0, damageKind: DK.Projectile },
  [ProjectileKind.EmberArrow]: {
    kind: ProjectileKind.EmberArrow, gravity: 16, drag: 0.35, waterDrag: 3, radius: 0.1, maxLife: 6, stickSeconds: 30, pierce: 0, damageKind: DK.Projectile,
    effects: [{ kind: StatusKind.Burn, strength: 1, seconds: 2 }], glow: true,
  },
  [ProjectileKind.MobArrow]: { kind: ProjectileKind.MobArrow, gravity: 16, drag: 0.01, waterDrag: 3, radius: 0.1, maxLife: 6, stickSeconds: 8, pierce: 0, damageKind: DK.Projectile },
  [ProjectileKind.SunBolt]: {
    kind: ProjectileKind.SunBolt, gravity: 0, drag: 0, waterDrag: 0, radius: 0.25, maxLife: 4, stickSeconds: 0, pierce: 0, damageKind: DK.Projectile,
    effects: [{ kind: StatusKind.Burn, strength: 1, seconds: 2 }], glow: true,
  },
  [ProjectileKind.IceShard]: {
    kind: ProjectileKind.IceShard, gravity: 0, drag: 0, waterDrag: 0, radius: 0.2, maxLife: 4, stickSeconds: 0, pierce: 0, damageKind: DK.Projectile,
    effects: [{ kind: StatusKind.Slow, strength: 0.35, seconds: 2.5 }], glow: true,
  },
  [ProjectileKind.SeedPod]: {
    kind: ProjectileKind.SeedPod, gravity: 18, drag: 0, waterDrag: 0, radius: 0.3, maxLife: 3, stickSeconds: 0, pierce: 0, damageKind: DK.Burst, unblockable: true,
    burst: { radius: 2.2, damage: 4, knockback: 4, lift: 3, hazard: { kind: HazardKind.ThornPatch, radius: 1.6, seconds: 5, dps: 1, slow: 0.3 } },
  },
  [ProjectileKind.Ember]: {
    kind: ProjectileKind.Ember, gravity: 6, drag: 0, waterDrag: 0, radius: 0.2, maxLife: 4, stickSeconds: 0, pierce: 0, damageKind: DK.Projectile,
    effects: [{ kind: StatusKind.Burn, strength: 1, seconds: 3 }], glow: true,
  },
};

export interface ProjectileSpawn {
  kind: ProjectileKind;
  owner: EntityRef;
  /** Hits only other teams (Neutral mobs are hit by Player and Hostile projectiles). */
  team: Team;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Final damage (survival computes bow charge, ammo bonus; mobs × rules.damageMul). */
  damage: number;
  knockback: number;
  /** Default 1.5. */
  lift?: number;
  crit?: boolean;
  /** Overrides PROJECTILE_DEFS[kind].pierce (Thornheart Bow: 1). */
  pierce?: number;
  /** Added to the def's effects (Rimebound Crossbow bolts: Slow 0.35 for 2.5 s). */
  effects?: StatusEffect[];
  /** Survival: item key a stuck arrow gives back ('arrow', 'bolt'); null = none (creative, mobs). */
  pickupItem?: string | null;
  /** PvP off: player projectiles skip players. Mob projectiles: true. */
  hitsPlayers: boolean;
  /** Shooter's client seq (ghost hand-over); 0 for mobs. */
  seq?: number;
  /** Shorter stick time (sandbox arrows: 10 s). */
  stickSeconds?: number;
}

/** A projectile as the sim and the snapshot see it (read-only for survival). */
export interface ProjectileState {
  readonly id: number;
  readonly kind: ProjectileKind;
  readonly owner: EntityRef;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly stuck: boolean;
  readonly pickupItem: string | null;
}

/** A player as the creature sim sees it (built each tick by survival). */
export interface PlayerTarget {
  /** sessionId online, 'local' offline. */
  id: string;
  /** VoxelPlayer.eid (wire id). */
  eid: number;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Server: EMA (0.5) of position deltas per tick; offline: the body velocity. */
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  crouching: boolean;
  sprinting: boolean;
  /** Hostiles may attack: survival mode, alive, not resting. Sandbox: always false. */
  targetable: boolean;
  alive: boolean;
  halfWidth: number;
  height: number;
  /** Raised shield facing (mob AI reads it), else null. */
  blockingYaw: number | null;
}

/**
 * What the creature sim needs from the player side. Survival (WP-B) provides it;
 * until then (and in sandbox) ServerEntities/LocalEntities use SANDBOX_PLAYER_HOOKS-like defaults.
 */
export interface PlayerHooks {
  playerTargets(): readonly PlayerTarget[];
  /** Mob melee, bursts, hazards and projectiles that hit a player. */
  damagePlayer(id: string, req: DamageRequest): DamageOutcome;
  /** Mob loot and boss drops (item keys; unknown keys skipped). */
  dropItems(x: number, y: number, z: number, stacks: readonly { item: string; count: number }[], cause: EntityRef | null): void;
  /** Feeding: take one of `itemKey` from the player's selected slot (sandbox: true without consuming). */
  consumeHeld(playerId: string, itemKey: string): boolean;
  /** Item key in the player's hand ('block:HayBale', 'apple'), or null. */
  heldItem(playerId: string): string | null;
  /** A player arrow/bolt stuck in a block (survival makes it collectable). */
  onProjectileStuck?(p: ProjectileState): void;
  /** Display name for death messages ('Ana'). */
  playerName(id: string): string;
}

/** What survival (and the room/game) may call on the creature sim. */
export interface EntityWorldApi {
  /** Nearest mob hit by a ray, testing current and up to `lagTicks` (≤ 6) past boxes inflated by `pad`. */
  raycast(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
    opts?: { lagTicks?: number; pad?: number; ignore?: number },
  ): { id: number; distance: number } | null;
  /** Null when the mob does not exist or is dead. */
  damageMob(id: number, req: DamageRequest): DamageOutcome | null;
  /** Returns the projectile id (0 when refused by caps). */
  spawnProjectile(spec: ProjectileSpawn): number;
  /** Survival picked up a stuck arrow. */
  removeProjectile(id: number): void;
  /** A block changed: stuck projectiles in that cell drop (pickupItem via dropItems) or vanish. */
  onBlockChanged(x: number, y: number, z: number): void;
  /** Live mobs within `radius` (horizontal) of (x, z). */
  mobsNear(x: number, z: number, radius: number): readonly { id: number; team: Team; x: number; y: number; z: number; boss: boolean }[];
  /** Any live mob box intersects the block cell (placement validation). */
  overlapsCell(x: number, y: number, z: number): boolean;
  /** 'a Mudlurch', 'the Rime Warden', 'Fluffy' (tamed name): death messages. */
  mobName(id: number): string;
}
