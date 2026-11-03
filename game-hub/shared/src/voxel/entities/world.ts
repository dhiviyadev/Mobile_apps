/**
 * EntityWorld: the creature simulation (design-voxel-mobs §4.3-4.4). One class
 * holds mobs, projectiles and hazards; the server steps it inside VoxelRoom's
 * 20 Hz tick (ServerEntities) and the browser steps it offline (LocalEntities).
 * It implements EntityWorldApi for the survival side.
 */
import { Block, CONTACT_DAMAGE, IS_SOLID } from '../blocks';
import {
  applyDamage,
  DamageKind,
  ignoredResult,
  tickEffects,
  Team,
  fallDamage,
  type DamageOutcome,
  type DamageRequest,
  type EntityRef,
  type StatusEffect,
} from '../combat';
import { daylightAt, skyLevelAt } from '../daylight';
import { collidesBox } from '../physics';
import type { StructureInfo } from '../structures/types';
import { mulberry32 } from '../../util/rng';
import { cleanText } from '../../util/text';
import { wrapAngle } from '../../util/math';
import type { EntityWorldApi, HazardSpawn, PlayerHooks, PlayerTarget, ProjectileSpawn } from './api';
import { brainFor } from './ai/brains';
import { liquidAt, stepMobBody } from './body';
import { BOSS_DROPS, MOB_DEFS, displayName, type DropDef } from './defs';
import { HazardSystem } from './hazards';
import { PathScheduler, Pathfinder } from './pathfind';
import { lineOfSight } from './perception';
import { VoxelProjectileSystem } from './projectiles';
import { IdAllocator, SpatialHash } from './spatial';
import { Spawner } from './spawner';
import { interactMob, MAX_TAMED, tickTaming } from './taming';
import {
  EntityEventType,
  Mob,
  MobAction,
  MobCategory,
  MobFlag,
  MobKind,
  MobVariant,
  type EntityCaps,
  type EntityEvent,
  type EntityHost,
  type InteractResult,
  type MobRules,
  type SavedMob,
  BurstKind,
} from './types';

/** Hooks used until survival plugs in its own: nobody is hurt, nothing drops, feeding is free. */
export function defaultPlayerHooks(targets: () => readonly PlayerTarget[], held: (id: string) => string | null = () => null): PlayerHooks {
  return {
    playerTargets: targets,
    damagePlayer: () => ignoredResult(),
    dropItems: () => undefined,
    consumeHeld: () => true,
    heldItem: held,
    playerName: (id) => targets().find((t) => t.id === id)?.name ?? 'Someone',
  };
}

export interface EntityWorldOptions {
  seed: number;
  rules: MobRules;
  caps: EntityCaps;
}

export interface EntityStats {
  mobs: number;
  friendly: number;
  hostile: number;
  extra: number;
  projectiles: number;
  hazards: number;
  pathExpanded: number;
  stepMs: number;
}

const TICK = 0.05;
const DYING_TICKS = 10;
const BOSS_DYING_TICKS = 50;

export class EntityWorld implements EntityWorldApi {
  readonly mobs = new Map<number, Mob>();
  readonly ids = new IdAllocator();
  readonly projectiles: VoxelProjectileSystem;
  readonly hazards: HazardSystem;
  readonly pathfinder: Pathfinder;
  readonly paths: PathScheduler;
  readonly spawner: Spawner;
  readonly spatial = new SpatialHash();
  /** Events of the last step (the owner drains them). */
  readonly events: EntityEvent[] = [];
  readonly rng: () => number;
  hooks: PlayerHooks;
  rules: MobRules;
  caps: EntityCaps;
  tick = 0;
  /** Sim seconds. */
  time = 0;
  daylight = 1;
  skyLevel = 15;
  /** Players this tick (from hooks.playerTargets()). */
  players: readonly PlayerTarget[] = [];
  /** Tamed creatures far from every player (re-created when someone comes near). */
  dormant: SavedMob[] = [];
  /** Synthetic structures (dev test arenas, tests) on top of the generator's. */
  readonly extraStructures: StructureInfo[] = [];
  private losUsed = 0;
  private readonly heldCache = new Map<string, string | null>();
  private readonly scratch: Mob[] = [];
  private persistChanged = false;
  private lastStepMs = 0;

  constructor(
    readonly host: EntityHost,
    opts: EntityWorldOptions,
  ) {
    this.rng = mulberry32(opts.seed ^ 0x6d0b);
    this.rules = opts.rules;
    this.caps = opts.caps;
    this.hooks = defaultPlayerHooks(() => []);
    this.projectiles = new VoxelProjectileSystem(this);
    this.hazards = new HazardSystem(this);
    this.pathfinder = new Pathfinder(host.getBlock);
    this.paths = new PathScheduler(this.pathfinder);
    this.spawner = new Spawner(this);
  }

  setPlayerHooks(hooks: PlayerHooks): void {
    this.hooks = hooks;
  }

  setRules(rules: MobRules): void {
    this.rules = rules;
  }

  setCaps(caps: EntityCaps): void {
    this.caps = caps;
  }

  // ---- step -----------------------------------------------------------------------

  step(dt = TICK): void {
    const t0 = now();
    this.events.length = 0;
    this.tick++;
    this.time += dt;
    const tod = this.host.timeOfDay();
    this.daylight = daylightAt(tod);
    this.skyLevel = skyLevelAt(tod);
    this.players = this.hooks.playerTargets();
    this.heldCache.clear();
    this.losUsed = 0;
    this.spatial.clear();
    for (const m of this.mobs.values()) if (m.alive) this.spatial.insert(m);

    this.paths.pump(this.caps.pathBudget);
    this.spawner.tick();

    const get = this.host.getBlock;
    for (const m of this.mobs.values()) {
      if (!m.alive) {
        if (--m.dyingTicks <= 0) this.removeMob(m);
        continue;
      }
      // Frozen while its chunk is missing (server warms it).
      if (!this.host.isAvailable(m.x, m.z) || !this.host.isAvailable(m.x + 1, m.z) || !this.host.isAvailable(m.x - 1, m.z) || !this.host.isAvailable(m.x, m.z + 1) || !this.host.isAvailable(m.x, m.z - 1)) {
        m.flags |= MobFlag.Frozen;
        this.host.warm?.(Math.floor(m.x / 16), Math.floor(m.z / 16));
        continue;
      }
      m.flags &= ~MobFlag.Frozen;
      m.ageTicks++;
      m.hurtTime = Math.max(0, m.hurtTime - dt);
      m.cooldown -= dt;
      m.cooldown2 -= dt;
      m.actionTime += dt;
      m.stateTime += dt;
      m.calmTime += dt;
      let mul = tickEffects(m, dt, (amount) => this.damageMob(m.id, { amount, kind: DamageKind.Fire, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true }));
      if (m.boss && m.kind === MobKind.RimeWarden) mul = 1;
      else if (m.boss) mul = 1 - (1 - mul) * 0.5;
      m.speedMul = mul;
      if (!m.alive) continue;
      if (m.variant === MobVariant.Moss && m.calmTime > 3 && m.health < m.maxHealth) m.health = Math.min(m.maxHealth, m.health + 0.5 * dt);

      const near = this.nearestPlayerDist(m.x, m.z);
      const brain = brainFor(m);
      if (near <= this.caps.simDist || m.boss) {
        if (m.thinkNow || this.tick % 4 === m.thinkSlot || m.boss) {
          m.thinkNow = false;
          brain.think(this, m);
        }
        if (!m.alive) continue;
        brain.act(this, m, dt);
      } else {
        m.intent.vx = m.intent.vz = 0;
        m.intent.jump = false;
        m.intent.vy = null;
      }
      if (!m.alive || !this.mobs.has(m.id)) continue;
      stepMobBody(m, get, dt, m.speedMul);
      this.afterMove(m, dt);
      if (!m.alive) continue;
      this.turn(m, dt);
      this.autoAction(m);
      m.pushHistory();
      this.spawner.despawnCheck(m, near, dt);
    }
    this.separate(dt);
    this.projectiles.step(dt);
    this.hazards.step(dt);
    tickTaming(this, dt);
    this.lastStepMs = now() - t0;
  }

  /** Contact damage, falls, suffocation, the void. */
  private afterMove(m: Mob, dt: number): void {
    const get = this.host.getBlock;
    const def = m.def;
    if (m.y < -8) {
      this.damageMob(m.id, { amount: 1000, kind: DamageKind.Void, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
      return;
    }
    if (m.landedSpeed > 0 && !def.fallImmune && !m.inWater) {
      const dmg = fallDamage(m.landedSpeed);
      if (dmg > 0) this.damageMob(m.id, { amount: dmg, kind: DamageKind.Fall, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
    }
    // Contact (lava, cactus) in 0.5 s pulses.
    m.contactTimer -= dt;
    if (m.contactTimer <= 0) {
      let worst = 0;
      let lava = false;
      const x0 = Math.floor(m.x - m.halfWidth - 0.05);
      const x1 = Math.floor(m.x + m.halfWidth + 0.05);
      const z0 = Math.floor(m.z - m.halfWidth - 0.05);
      const z1 = Math.floor(m.z + m.halfWidth + 0.05);
      const y0 = Math.floor(m.y - 0.05);
      const y1 = Math.floor(m.y + m.height);
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const b = get(x, y, z);
        if (CONTACT_DAMAGE[b] > worst) worst = CONTACT_DAMAGE[b];
        if (b === Block.Lava) lava = true;
      }
      m.contactTimer = 0.2;
      if (worst > 0 && !(lava && def.fireImmune)) {
        m.contactTimer = 0.5;
        this.damageMob(m.id, { amount: worst * 0.5, kind: lava ? DamageKind.Fire : DamageKind.Contact, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
      }
    }
    // Suffocation: head inside a solid block after trying to push up.
    if (!def.fly && IS_SOLID[get(Math.floor(m.x), Math.floor(m.y + m.height * 0.8), Math.floor(m.z))]) {
      if (!collidesBox(get, m.x, m.y + 1, m.z, m.halfWidth, m.height)) m.y += 1;
      else {
        m.suffocateTimer -= dt;
        if (m.suffocateTimer <= 0) {
          m.suffocateTimer = 1;
          this.damageMob(m.id, { amount: 1, kind: DamageKind.Suffocate, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
        }
      }
    }
    // Fish out of water: 1 damage per second.
    if (def.swim === 'fish' && !m.inWater) {
      m.suffocateTimer -= dt;
      if (m.suffocateTimer <= 0) {
        m.suffocateTimer = 1;
        this.damageMob(m.id, { amount: 1, kind: DamageKind.Suffocate, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
      }
    }
  }

  /** Body yaw eases toward the intent (or the movement); the head looks at faceYaw. */
  private turn(m: Mob, dt: number): void {
    const it = m.intent;
    let want = it.faceYaw;
    const sp = Math.hypot(m.vx, m.vz);
    if (want === null && sp > 0.3) want = Math.atan2(-m.vx, -m.vz);
    const rate = m.boss ? (m.kind === MobKind.Thornmaw ? 2 : 4) : 8;
    if (want !== null) {
      const d = wrapAngle(want - m.yaw);
      m.yaw = wrapAngle(m.yaw + Math.sign(d) * Math.min(Math.abs(d), rate * dt));
      m.headYaw = wrapAngle(m.yaw + Math.max(-1, Math.min(1, wrapAngle(want - m.yaw))));
    } else m.headYaw = m.yaw;
  }

  /** Idle/Walk follow the speed once a timed action is over. */
  private autoAction(m: Mob): void {
    const timed = m.action !== MobAction.Idle && m.action !== MobAction.Walk;
    if (timed && m.actionTime < m.actionDur) return;
    if (timed && (m.action === MobAction.Graze || m.action === MobAction.Inflate || m.action === MobAction.Stunned) && m.actionTime < m.actionDur) return;
    const moving = Math.hypot(m.vx, m.vz) > 0.25 || (m.def.fly && Math.abs(m.vy) > 0.5);
    const a = moving ? MobAction.Walk : MobAction.Idle;
    if (m.action !== a) {
      m.action = a;
      m.actionTime = 0;
      m.actionDur = 1;
    }
  }

  /** Overlapping non-flying mobs push apart (bosses barely move); players push mobs. */
  private separate(dt: number): void {
    const near = this.scratch;
    for (const a of this.mobs.values()) {
      if (!a.alive || a.def.fly) continue;
      this.spatial.query(a.x, a.z, 3, near);
      for (const b of near) {
        if (b.id <= a.id || !b.alive || b.def.fly) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = a.halfWidth + b.halfWidth;
        if (d >= min || a.y + a.height <= b.y || b.y + b.height <= a.y) continue;
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const push = Math.min(2, (min - d) * 8);
        const wa = 1 / a.maxHealth;
        const wb = 1 / b.maxHealth;
        const sum = wa + wb;
        a.vx -= nx * push * (wa / sum) * 2;
        a.vz -= nz * push * (wa / sum) * 2;
        b.vx += nx * push * (wb / sum) * 2;
        b.vz += nz * push * (wb / sum) * 2;
      }
      if (a.boss) continue;
      for (const p of this.players) {
        if (!p.alive) continue;
        const dx = a.x - p.x;
        const dz = a.z - p.z;
        const d = Math.hypot(dx, dz);
        const min = a.halfWidth + p.halfWidth;
        if (d >= min || a.y + a.height <= p.y || p.y + p.height <= a.y) continue;
        const push = Math.min(2, (min - d) * 8);
        a.vx += (d > 1e-4 ? dx / d : 1) * push;
        a.vz += (d > 1e-4 ? dz / d : 0) * push;
      }
    }
    void dt;
  }

  // ---- queries ----------------------------------------------------------------------

  /** Live mobs whose spatial cells are within radius (unfiltered by exact distance). */
  mobsAround(x: number, z: number, radius: number): Mob[] {
    return this.spatial.query(x, z, radius, []);
  }

  mobsNear(x: number, z: number, radius: number): { id: number; team: Team; x: number; y: number; z: number; boss: boolean }[] {
    const out: { id: number; team: Team; x: number; y: number; z: number; boss: boolean }[] = [];
    for (const m of this.mobs.values()) {
      if (!m.alive || Math.hypot(m.x - x, m.z - z) > radius) continue;
      out.push({ id: m.id, team: m.team, x: m.x, y: m.y, z: m.z, boss: !!m.boss });
    }
    return out;
  }

  nearestPlayerDist(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.players) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    return best;
  }

  playerById(id: string): PlayerTarget | undefined {
    return this.players.find((p) => p.id === id);
  }

  /** Held item of a player, cached per tick. */
  heldItem(id: string): string | null {
    if (!this.heldCache.has(id)) this.heldCache.set(id, this.hooks.heldItem(id));
    return this.heldCache.get(id) ?? null;
  }

  isLiquid(x: number, y: number, z: number): boolean {
    return liquidAt(this.host.getBlock, x, y, z);
  }

  /** Feet height of the floor under a point (scans down at most 6 cells). */
  floorBelow(x: number, y: number, z: number): number {
    const get = this.host.getBlock;
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    for (let yy = Math.floor(y); yy > Math.floor(y) - 6 && yy > 0; yy--) if (IS_SOLID[get(bx, yy - 1, bz)]) return yy;
    return y;
  }

  /** Line of sight within this tick's budget; over budget returns `fallback`. */
  sees(ax: number, ay: number, az: number, bx: number, by: number, bz: number, mode: 'see' | 'shoot', fallback = false): boolean {
    if (this.losUsed >= this.caps.losBudget) return fallback;
    this.losUsed++;
    return lineOfSight(this.host.getBlock, ax, ay, az, bx, by, bz, mode);
  }

  /**
   * Structures (generator + synthetic) whose bounds come within `radius`
   * (horizontal) of (x, z). Endless worlds are queried around a point, never
   * as a whole.
   */
  structuresNear(x: number, z: number, radius: number): StructureInfo[] {
    const out = this.host.generator.structuresNear(x, z, radius);
    for (const s of this.extraStructures) {
      const b = s.bounds;
      const dx = Math.max(b.x0 - x, 0, x - b.x1);
      const dz = Math.max(b.z0 - z, 0, z - b.z1);
      if (dx * dx + dz * dz <= radius * radius) out.push(s);
    }
    return out;
  }

  /** Visits damageable targets (mobs, players) within a horizontal radius that a `team` effect may hurt. */
  forTargetsIn(x: number, z: number, radius: number, team: Team, fn: (t: { mob?: Mob; playerId?: string; x: number; y: number; z: number }) => void): void {
    for (const m of this.mobsAround(x, z, radius + 2)) {
      if (!m.alive || m.team === team) continue;
      if (Math.hypot(m.x - x, m.z - z) > radius + m.halfWidth) continue;
      fn({ mob: m, x: m.x, y: m.y, z: m.z });
    }
    if (team !== Team.Player) {
      for (const p of this.players) {
        if (!p.alive || !p.targetable) continue;
        if (Math.hypot(p.x - x, p.z - z) > radius + p.halfWidth) continue;
        fn({ playerId: p.id, x: p.x, y: p.y, z: p.z });
      }
    }
  }

  // ---- combat -------------------------------------------------------------------------

  emit(e: EntityEvent): void {
    this.events.push(e);
  }

  damageMob(id: number, req: DamageRequest): DamageOutcome | null {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return null;
    if (m.boss && !m.boss.vulnerable()) return ignoredResult();
    let r = req;
    if (m.boss) r = m.boss.adjustDamage(r);
    if (m.def.fireImmune && r.kind === DamageKind.Fire) return ignoredResult();
    const res = applyDamage(m, r);
    if (res.ignored) return res;
    if (res.dealt > 0) m.calmTime = 0;
    m.lastHitBy = req.attacker;
    m.lastHitAt = this.time;
    m.thinkNow = true;
    if (req.attacker) {
      m.threatX = req.fromX;
      m.threatZ = req.fromZ;
    }
    if (req.attacker?.type === 'player' && m.boss) m.boss.credit(req.attacker.id, res.dealt);
    this.emit({ type: EntityEventType.MobHurt, id, amount: res.dealt, crit: !!req.crit, killed: res.killed, attacker: req.attacker, x: m.x, y: m.y, z: m.z });
    brainFor(m).onHurt?.(this, m, req, res);
    if (res.killed) this.onKilled(m, req);
    return res;
  }

  /** Mob-caused damage on a player (scaled by rules.damageMul; sandbox: nothing). */
  hurtPlayer(id: string, req: DamageRequest): DamageOutcome {
    if (this.rules.damageMul <= 0) return ignoredResult();
    const p = this.playerById(id);
    if (!p || !p.alive) return ignoredResult();
    const scaled = req.attacker?.type === 'player' ? req : { ...req, amount: req.amount * this.rules.damageMul };
    return this.hooks.damagePlayer(id, scaled);
  }

  /**
   * Area hit (Puffcap, slams, novas, seed pods): every target of another team
   * with feet within radius and |dy| < 2; damage falls off with distance.
   */
  burst(x: number, y: number, z: number, radius: number, damage: number, knockback: number, lift: number, owner: EntityRef | null, team: Team, kind: BurstKind, dmgKind = DamageKind.Burst, effects?: StatusEffect[]): void {
    this.emit({ type: EntityEventType.Burst, kind, x, y, z, radius });
    if (damage <= 0 && knockback <= 0) return;
    this.forTargetsIn(x, z, radius, team, (t) => {
      if (Math.abs(t.y - y) >= 2) return;
      if (t.mob && owner?.type === 'mob' && owner.id === t.mob.id) return;
      const d = Math.min(radius, Math.hypot(t.x - x, t.z - z));
      const f = Math.sqrt(Math.max(0, 1 - d / radius));
      const req: DamageRequest = { amount: damage * f, kind: dmgKind, attacker: owner, fromX: x, fromY: y, fromZ: z, knockback: knockback * (1 - (0.5 * d) / radius), lift, unblockable: true, effects };
      if (t.mob) this.damageMob(t.mob.id, req);
      else this.hurtPlayer(t.playerId!, req);
    });
  }

  private onKilled(m: Mob, req: DamageRequest): void {
    m.alive = false;
    m.flags |= MobFlag.Dying;
    m.deathCause = req.kind;
    m.dyingTicks = m.boss ? BOSS_DYING_TICKS : DYING_TICKS;
    m.setAction(MobAction.Death, m.dyingTicks * TICK);
    this.paths.cancel(m);
    if (m.boss) {
      m.boss.onDefeated();
    } else {
      this.emit({ type: EntityEventType.MobDied, id: m.id, kind: m.kind, cause: req.kind, x: m.x, y: m.y, z: m.z });
      if (!m.has(MobFlag.Minion) && !m.has(MobFlag.Baby) && !(m.kind === MobKind.Puffcap && req.kind === DamageKind.Burst && req.attacker?.type === 'mob' && req.attacker.id === m.id)) {
        this.dropFor(m, req.attacker);
      }
      if (m.structureId >= 0 && m.guardIndex >= 0) this.spawner.guardDied(m);
    }
    if (m.has(MobFlag.Tamed)) this.persistChanged = true;
  }

  private dropFor(m: Mob, cause: EntityRef | null): void {
    const stacks = rollDrops(m.def.drops, this.rng, m.has(MobFlag.Guard));
    // Ash Mudlurch: coal instead of mud.
    if (m.kind === MobKind.Mudlurch && m.variant === MobVariant.Ash) {
      for (const s of stacks) if (s.item === 'block:Mud') s.item = 'coal';
    }
    if (stacks.length) this.hooks.dropItems(m.x, m.y + 0.3, m.z, stacks, cause);
  }

  /** Boss drops: the unique once per participant (max 4), the rest once. */
  dropBossLoot(kind: MobKind, x: number, y: number, z: number, participants: number): void {
    const d = BOSS_DROPS[kind];
    if (!d) return;
    const stacks = [{ item: d.unique, count: Math.max(1, Math.min(4, participants)) }, ...rollDrops(d.rest, this.rng, false)];
    this.hooks.dropItems(x, y, z, stacks, null);
  }

  // ---- lifecycle ----------------------------------------------------------------------

  spawnMob(kind: MobKind, x: number, y: number, z: number, opts: { variant?: MobVariant; flags?: number; yaw?: number } = {}): Mob | null {
    const def = MOB_DEFS[kind];
    if (!def) return null;
    const id = this.ids.take();
    if (!id) return null;
    const m = new Mob(id, kind, def, x, y, z, opts.variant ?? MobVariant.Default, opts.flags ?? 0);
    m.yaw = opts.yaw ?? this.rng() * Math.PI * 2;
    m.headYaw = m.yaw;
    if (m.has(MobFlag.Baby)) {
      m.scale = 0.55;
      m.halfWidth = Math.max(0.15, def.halfWidth * 0.55);
      m.height = Math.max(0.3, def.height * 0.55);
      m.maxHealth = Math.max(1, Math.round(def.maxHealth * 0.5));
      m.health = m.maxHealth;
    }
    if (def.category === MobCategory.Boss) m.flags |= MobFlag.Boss;
    this.mobs.set(id, m);
    this.spatial.insert(m);
    return m;
  }

  removeMob(m: Mob): void {
    if (!this.mobs.delete(m.id)) return;
    this.paths.cancel(m);
    this.ids.release(m.id);
  }

  /** Minion crumble / despawn without drops. */
  crumble(m: Mob): void {
    if (!m.alive) return;
    this.damageMob(m.id, { amount: 1e6, kind: DamageKind.Magic, attacker: null, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 0, lift: 0, ignoreArmor: true, unblockable: true });
  }

  // ---- EntityWorldApi -------------------------------------------------------------------

  raycast(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
    opts: { lagTicks?: number; pad?: number; ignore?: number; filter?: (m: Mob) => boolean } = {},
  ): { id: number; distance: number } | null {
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const pad = opts.pad ?? 0;
    const lag = Math.max(0, Math.min(6, Math.floor(opts.lagTicks ?? 0)));
    let best: { id: number; distance: number } | null = null;
    const pos = { x: 0, y: 0, z: 0 };
    for (const m of this.mobs.values()) {
      if (!m.alive || m.id === opts.ignore || (opts.filter && !opts.filter(m))) continue;
      if (Math.hypot(m.x - ox, m.z - oz) > maxDist + m.halfWidth + 3) continue;
      for (let k = 0; k <= lag; k++) {
        if (k === 0) {
          pos.x = m.x;
          pos.y = m.y;
          pos.z = m.z;
        } else if (!m.historyAt(k, pos)) break;
        const t = mobRayBox(ox, oy, oz, ux, uy, uz, pos.x - m.halfWidth - pad, pos.y - pad, pos.z - m.halfWidth - pad, pos.x + m.halfWidth + pad, pos.y + m.height + pad, pos.z + m.halfWidth + pad);
        if (t >= 0 && t <= maxDist && (!best || t < best.distance)) best = { id: m.id, distance: t };
      }
    }
    return best;
  }

  spawnProjectile(spec: ProjectileSpawn): number {
    return this.projectiles.spawn(spec);
  }

  removeProjectile(id: number): void {
    this.projectiles.remove(id);
  }

  spawnHazard(spec: HazardSpawn): number {
    return this.hazards.spawn(spec);
  }

  onBlockChanged(x: number, y: number, z: number): void {
    this.projectiles.onBlockChanged(x, y, z);
  }

  overlapsCell(x: number, y: number, z: number): boolean {
    for (const m of this.mobsAround(x + 0.5, z + 0.5, 3)) {
      if (!m.alive) continue;
      if (x + 1 > m.x - m.halfWidth && x < m.x + m.halfWidth && z + 1 > m.z - m.halfWidth && z < m.z + m.halfWidth && y + 1 > m.y && y < m.y + m.height) return true;
    }
    return false;
  }

  mobName(id: number): string {
    const m = this.mobs.get(id);
    if (!m) return 'a creature';
    if (m.name) return m.name;
    if (m.boss) return `the ${m.def.name}`;
    const n = displayName(m.kind, m.variant, m.has(MobFlag.Baby), '');
    return `${/^[AEIOU]/.test(n) ? 'an' : 'a'} ${n}`;
  }

  // ---- taming and persistence ------------------------------------------------------------

  interact(mobId: number, player: PlayerTarget, held: string | null): InteractResult {
    const r = interactMob(this, mobId, player, held);
    if (r === 'tamed' || r === 'love') this.persistChanged = true;
    return r;
  }

  rename(mobId: number, playerName: string, name: string): boolean {
    const m = this.mobs.get(mobId);
    if (!m || !m.alive || !m.has(MobFlag.Tamed) || m.owner !== playerName) return false;
    const clean = cleanText(name, 16);
    m.name = clean;
    if (clean) m.flags |= MobFlag.Named;
    else m.flags &= ~MobFlag.Named;
    this.persistChanged = true;
    this.emit({ type: EntityEventType.MobInfo, id: m.id, name: m.name, owner: m.owner, x: m.x, y: m.y, z: m.z });
    return true;
  }

  tamedCount(): number {
    let n = this.dormant.length;
    for (const m of this.mobs.values()) if (m.alive && m.has(MobFlag.Tamed)) n++;
    return n;
  }

  get tamedCap(): number {
    return MAX_TAMED;
  }

  markPersistChanged(): void {
    this.persistChanged = true;
  }

  /** Tamed creatures, live and dormant. */
  saveMobs(): SavedMob[] {
    const out: SavedMob[] = [...this.dormant];
    for (const m of this.mobs.values()) {
      if (!m.alive || !m.has(MobFlag.Tamed)) continue;
      out.push(toSaved(m));
    }
    return out.slice(0, MAX_TAMED);
  }

  loadMobs(list: readonly SavedMob[]): void {
    for (const s of list.slice(0, MAX_TAMED)) this.dormant.push({ ...s });
  }

  get persistDirty(): boolean {
    return this.persistChanged;
  }

  markPersistClean(): void {
    this.persistChanged = false;
  }

  stats(): EntityStats {
    let friendly = 0;
    let hostile = 0;
    let extra = 0;
    for (const m of this.mobs.values()) {
      if (!m.alive) continue;
      if (m.boss || m.has(MobFlag.Guard) || m.has(MobFlag.Minion)) extra++;
      else if (m.team === Team.Hostile) hostile++;
      else friendly++;
    }
    return { mobs: this.mobs.size, friendly, hostile, extra, projectiles: this.projectiles.list.length, hazards: this.hazards.list.length, pathExpanded: this.paths.lastSpent, stepMs: this.lastStepMs };
  }
}

export function toSaved(m: Mob): SavedMob {
  return {
    kind: m.kind,
    variant: m.variant,
    flags: m.flags & (MobFlag.Baby | MobFlag.Tamed | MobFlag.Named),
    x: m.x,
    y: m.y,
    z: m.z,
    yaw: m.yaw,
    health: m.health,
    growLeft: m.growLeft,
    owner: m.owner,
    name: m.name,
  };
}

/** Rolls a drop table; guards drop half (rounded down, the 100% entries at least once). */
export function rollDrops(drops: readonly DropDef[], rnd: () => number, half: boolean): { item: string; count: number }[] {
  const out: { item: string; count: number }[] = [];
  for (const d of drops) {
    if (rnd() >= d.chance) continue;
    let n = d.min + Math.floor(rnd() * (d.max - d.min + 1));
    if (half) n = d.chance >= 1 ? Math.max(1, Math.floor(n / 2)) : Math.floor(n / 2);
    if (n > 0) out.push({ item: d.item, count: n });
  }
  return out;
}

/** Ray against a box: entry distance or -1. */
export function mobRayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
      continue;
    }
    let t0 = (lo[a] - o[a]) / d[a];
    let t1 = (hi[a] - o[a]) / d[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return Math.max(0, tmin);
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
