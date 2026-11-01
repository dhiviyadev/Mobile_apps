/**
 * Voxelvale combat contract shared by players (survival) and creatures (mobs),
 * on the server and in the offline browser simulation. Pure functions on plain
 * objects: no events, no I/O. Merged from design-voxel-mobs §3 and
 * design-voxel-survival §19 (INTEGRATION-voxel.md §1.3).
 *
 * Units: health points (players have 20), blocks/second, seconds; positions are
 * feet positions; yaw 0 faces -Z, forward = (-sin yaw, -cos yaw).
 */

/** Sent as u8 in events; stable within a build (never persisted). */
export enum DamageKind {
  Melee = 0,
  Projectile = 1,
  Burst = 2,
  Fall = 3,
  Drown = 4,
  Fire = 5,
  Contact = 6,
  Magic = 7,
  Suffocate = 8,
  Starve = 9,
  Void = 10,
}

/** Bosses are Team.Hostile with MobFlag.Boss; friendly creatures are Neutral. */
export enum Team {
  Player = 0,
  Hostile = 1,
  Neutral = 2,
}

/**
 * Who dealt or took damage. Players: Colyseus sessionId online, 'local' offline
 * (on the wire players travel as VoxelPlayer.eid, see wire refs in protocol docs).
 */
export type EntityRef = { type: 'player'; id: string } | { type: 'mob'; id: number } | { type: 'world' };

/** Wire form of an EntityRef: u8 refType, u16 id. */
export const RefType = { World: 0, Player: 1, Mob: 2 } as const;

export const sameRef = (a: EntityRef | null, b: EntityRef | null): boolean =>
  !!a && !!b && a.type === b.type && (a.type === 'world' || (a as { id: unknown }).id === (b as { id: unknown }).id);

export enum StatusKind {
  Slow = 1,
  Burn = 2,
}

export interface StatusEffect {
  kind: StatusKind;
  /** Slow: fraction of speed removed (0..0.8). Burn: health per second. */
  strength: number;
  seconds: number;
}

export interface ActiveEffect extends StatusEffect {
  left: number;
}

export interface DamageRequest {
  /** Health points before shield and armor (crits already multiplied in by the attacker). */
  amount: number;
  kind: DamageKind;
  attacker: EntityRef | null;
  /** Where the hit comes from (attacker eye, projectile position, burst centre): knockback and shield direction. */
  fromX: number;
  fromY: number;
  fromZ: number;
  /** Horizontal speed added (b/s), before resistance. */
  knockback: number;
  /** Vertical speed raised to at least this (b/s). */
  lift: number;
  /** Fall, Drown, Contact, Suffocate, Starve, Void, Fire ticks. */
  ignoreArmor?: boolean;
  /** Burst, Magic, Fire and environment kinds: shields do not stop them. */
  unblockable?: boolean;
  effects?: StatusEffect[];
  /** FX only. */
  crit?: boolean;
  projectileId?: number;
  /** Item key of the weapon (death messages). */
  weapon?: string;
  /** Seconds a blocking shield is disabled when this hit is blocked (axes 1.6, Ashen Axe 2.5, boss slams). */
  shieldDisable?: number;
}

export interface DamageOutcome {
  /** Health actually removed. */
  dealt: number;
  /** A shield absorbed part or all of it. */
  blocked: boolean;
  killed: boolean;
  /** Dead target, immunity, zero amount, or (players) creative / protected / PvP off: nothing happened. */
  ignored: boolean;
  /** Velocity change applied (players: the server sends it to the owning client). */
  dvx: number;
  dvy: number;
  dvz: number;
  /** Blocked and req.shieldDisable > 0: the owner starts its shield-disabled timer. */
  shieldDisabled?: boolean;
}

export interface Damageable {
  readonly ref: EntityRef;
  team: Team;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  halfWidth: number;
  height: number;
  health: number;
  maxHealth: number;
  /** 0..20 armor points, 4% each, capped at 80%. */
  armor: number;
  /** 0..1 fraction of knockback ignored. */
  knockbackResist: number;
  /** Immunity seconds left; while > 0 only a bigger hit lands, for the difference. */
  hurtTime: number;
  lastHurtAmount: number;
  /** Immunity window this target gets after a hit (default by team: COMBAT.playerImmunity / mobImmunity; bosses 0.15). */
  immunity?: number;
  /** Shield raised: facing yaw; null when not blocking (mobs: always null). */
  blockingYaw: number | null;
  alive: boolean;
  effects: ActiveEffect[];
  /**
   * Players only (survival): fraction 0..1 of this hit a raised shield absorbs
   * (tier 0.70 / 0.85 / 1.00, raised >= 0.2 s, not disabled, within the arc).
   * When absent, blockingYaw decides (full block inside the arc).
   */
  guardFactor?(req: DamageRequest): number;
  /** Called after health, immunity, knockback and effects were updated. */
  onDamaged?(req: DamageRequest, res: DamageOutcome): void;
}

export const COMBAT = {
  playerImmunity: 0.5,
  mobImmunity: 0.3,
  bossImmunity: 0.15,
  armorPerPoint: 0.04,
  armorCap: 0.8,
  /** 120° in front of blockingYaw (survival: horizontal dot >= 0.5). */
  shieldArc: (Math.PI * 2) / 3,
  /** Damage multiplier for a full block when the target has no guardFactor. */
  shieldDamageMul: 0,
  shieldKnockbackMul: 0.35,
  maxEffects: 4,
  /** Lowest speed multiplier Slow can give. */
  minSpeedMul: 0.2,
} as const;

const IGNORED: Readonly<DamageOutcome> = { dealt: 0, blocked: false, killed: false, ignored: true, dvx: 0, dvy: 0, dvz: 0 };

/** A result for hits the caller refuses before applyDamage (creative players, PvP off, spawn protection). */
export function ignoredResult(): DamageOutcome {
  return { ...IGNORED };
}

/** True when (fromX, fromZ) lies within the shield arc in front of `yaw` as seen from (x, z). */
export function inShieldArc(x: number, z: number, yaw: number, fromX: number, fromZ: number): boolean {
  const dx = fromX - x;
  const dz = fromZ - z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return true;
  const dot = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / len;
  return dot >= Math.cos(COMBAT.shieldArc / 2);
}

/**
 * The one damage rule (order matters):
 * 1. dead target or amount <= 0: ignored.
 * 2. shield (only Melee/Projectile, not unblockable): g = guardFactor(req) or (blockingYaw arc ? 1 - shieldDamageMul : 0);
 *    amount *= 1 - g; knockback *= shieldKnockbackMul; blocked = g > 0; shieldDisabled = blocked && shieldDisable > 0.
 * 3. armor unless ignoreArmor.
 * 4. immunity: while hurtTime > 0 only the part above lastHurtAmount lands (else ignored; a blocked 0 hit still pushes).
 * 5. health; 6. knockback; 7. effects (same kind: max strength, max time; at most maxEffects); 8. death, onDamaged.
 */
export function applyDamage(t: Damageable, r: DamageRequest): DamageOutcome {
  if (!t.alive || r.amount <= 0) return ignoredResult();
  let amount = r.amount;
  let knockback = r.knockback;
  let lift = r.lift;
  let blocked = false;
  let shieldDisabled = false;
  if (!r.unblockable && (r.kind === DamageKind.Melee || r.kind === DamageKind.Projectile)) {
    const g = t.guardFactor
      ? Math.min(1, Math.max(0, t.guardFactor(r)))
      : t.blockingYaw !== null && inShieldArc(t.x, t.z, t.blockingYaw, r.fromX, r.fromZ)
        ? 1 - COMBAT.shieldDamageMul
        : 0;
    if (g > 0) {
      blocked = true;
      amount *= 1 - g;
      knockback *= COMBAT.shieldKnockbackMul;
      lift = 0;
      shieldDisabled = (r.shieldDisable ?? 0) > 0;
    }
  }
  if (!r.ignoreArmor) amount *= 1 - Math.min(COMBAT.armorCap, t.armor * COMBAT.armorPerPoint);

  let dealt: number;
  if (t.hurtTime > 0) {
    if (amount <= t.lastHurtAmount) {
      if (!(blocked && amount <= 0)) return ignoredResult();
      dealt = 0;
    } else {
      dealt = amount - t.lastHurtAmount;
      t.lastHurtAmount = amount;
    }
  } else if (amount <= 0) {
    dealt = 0; // fully blocked: pushes, sets no immunity
  } else {
    dealt = amount;
    t.lastHurtAmount = amount;
    t.hurtTime = t.immunity ?? (t.team === Team.Player ? COMBAT.playerImmunity : COMBAT.mobImmunity);
  }
  t.health = Math.max(0, t.health - dealt);

  const vx0 = t.vx;
  const vy0 = t.vy;
  const vz0 = t.vz;
  applyKnockback(t, r.fromX, r.fromZ, knockback, lift);

  if (r.effects && dealt > 0) {
    for (const ef of r.effects) {
      const cur = t.effects.find((a) => a.kind === ef.kind);
      if (cur) {
        cur.strength = Math.max(cur.strength, ef.strength);
        cur.left = Math.max(cur.left, ef.seconds);
        cur.seconds = Math.max(cur.seconds, ef.seconds);
      } else if (t.effects.length < COMBAT.maxEffects) {
        t.effects.push({ ...ef, left: ef.seconds });
      }
    }
  }

  const killed = t.health <= 0;
  if (killed) t.alive = false;
  const res: DamageOutcome = { dealt, blocked, killed, ignored: false, dvx: t.vx - vx0, dvy: t.vy - vy0, dvz: t.vz - vz0 };
  if (shieldDisabled) res.shieldDisabled = true;
  t.onDamaged?.(r, res);
  return res;
}

/** Pushes away from (fromX, fromZ) horizontally; resistance scales both parts. */
export function applyKnockback(t: Damageable, fromX: number, fromZ: number, strength: number, lift: number): void {
  const k = 1 - Math.min(1, Math.max(0, t.knockbackResist));
  if (k <= 0 || (strength <= 0 && lift <= 0)) return;
  let dx = t.x - fromX;
  let dz = t.z - fromZ;
  let len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    dx = 1;
    dz = 0;
    len = 1;
  }
  t.vx += (dx / len) * strength * k;
  t.vz += (dz / len) * strength * k;
  if (lift > 0) t.vy = Math.max(t.vy, lift * k);
}

/** Mob fall damage from landing speed: 13 b/s (~3 blocks at gravity 28) is safe. Players use survival's distance rule. */
export function fallDamage(landedSpeed: number, safeSpeed = 13, perUnit = 0.6): number {
  return Math.max(0, Math.round((landedSpeed - safeSpeed) * perUnit));
}

/**
 * Advances effects by dt. Burn calls onBurn(strength * dt) each tick (the caller
 * routes it as DamageKind.Fire, ignoreArmor, unblockable). Returns the speed multiplier.
 */
export function tickEffects(t: Damageable, dt: number, onBurn: (amount: number) => void): number {
  let slow = 0;
  for (let i = t.effects.length - 1; i >= 0; i--) {
    const ef = t.effects[i];
    if (ef.kind === StatusKind.Burn) onBurn(ef.strength * Math.min(dt, ef.left));
    else if (ef.kind === StatusKind.Slow) slow = Math.max(slow, ef.strength);
    ef.left -= dt;
    if (ef.left <= 0) t.effects.splice(i, 1);
  }
  return Math.max(COMBAT.minSpeedMul, 1 - slow);
}
