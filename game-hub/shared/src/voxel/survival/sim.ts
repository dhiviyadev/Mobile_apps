/**
 * SurvivalSim: the players' side of Voxelvale survival and combat
 * (design-voxel-survival §12, reconciled in §19). One class, run by
 * SurvivalRoomHost on the server (authoritative) and by LocalSurvival in the
 * browser offline. Sandbox runs it in creative mode: weapons swing and shoot
 * (infinite ammo), nobody is hurt, no inventories or vitals.
 *
 * Players are keyed by their EntityRef id (sessionId online, 'local' offline)
 * and travel on the wire as their eid. Creatures and every projectile live in
 * the creature sim (EntityWorldApi, WP-C); this class implements the
 * PlayerHooks it calls.
 */
import { Block, canonicalBlock, isLava, SLAB_FULL } from '../blocks';
import { packPos, unpackPos } from '../chunk';
import {
  type ActiveEffect,
  applyDamage,
  type DamageOutcome,
  DamageKind,
  type DamageRequest,
  type Damageable,
  type EntityRef,
  ignoredResult,
  RefType,
  StatusKind,
  Team,
  tickEffects,
} from '../combat';
import { PLAYER_CROUCH_EYE, PLAYER_EYE, PLAYER_HEIGHT, PLAYER_WIDTH, REACH } from '../constants';
import { daylightAt, isNight } from '../daylight';
import type { EntityWorldApi, PlayerHooks, PlayerTarget, ProjectileState } from '../entities/api';
import { ProjectileKind } from '../entities/api';
import type { WorldGenerator } from '../generator';
import { collides, groundedAt, isLiquidAt, overlapsClimbable, type BlockQuery } from '../physics';
import type { BlockEdit } from '../protocol';
import { isBossDefeated, type StructureChest } from '../structures/types';
import { forwardFromYawPitch } from '../../util/math';
import { ContainerStore } from './chests';
import {
  ActFlags,
  CONTAINER_BASE,
  CONTAINER_SLOTS,
  HandFlags,
  HOTBAR,
  InteractKind,
  LoadedAmmo,
  loadedOf,
  OFFHAND,
  PLAYER_SLOTS,
  SURVIVAL,
  type SurvivalRules,
  SurvivalSfx,
  VitalFlags,
  wearOf,
  withLoad,
} from './constants';
import { type DropEvent, DropSystem, type ItemDrop } from './drops';
import { boxAt, PlayerHistory, rayAabb, solidRayDistance } from './history';
import { applyInvOp, type Container, Inventory, type InvOp, type ItemStack } from './inventory';
import { Item, type ItemId, ItemKind, itemDef, itemFromKey, itemKey, itemName, isBlockItem, meleeOf } from './items';
import { blockDrops, breakSeconds, breakWear } from './mining';
import { craftOp, stationsNear } from './recipes';
import { contactAt, FallTracker, headInWater, playerFallDamage } from './vitals';

// ---- host and events ------------------------------------------------------------------

export interface SurvivalHost {
  /** Hot-loop block reader (server: world.reader(); offline: world.getBlock). */
  getBlock(): BlockQuery;
  readonly generator: WorldGenerator;
  /** Monotonic sim clock in ms. */
  now(): number;
  random(): number;
  timeOfDay(): number;
  /** Everyone rested through the night: jump to dawn and count the day. */
  skipNight(): void;
  /** Moves a player (respawn): online Teleport + movement grace; offline the local body. */
  teleport(id: string, x: number, y: number, z: number): void;
  /** Message to every player (death messages, rules, night passes). */
  announce(text: string): void;
  /** Creature sim (null: none in this build/mode). */
  entities(): EntityWorldApi | null;
  /** Inventories, chests or satchels changed (server: autosave). */
  dirty?(): void;
}

/** A reference as it travels on the wire (RefType + eid / mob id). */
export interface WireRef {
  refType: number;
  id: number;
}

/** `S` record 6 (player targets only). */
export interface DamageEvent {
  type: 'damage';
  target: WireRef;
  source: WireRef;
  amount: number;
  kind: DamageKind;
  /** Crit 1, Blocked 2, Killed 4, ShieldDisabled 8. */
  flags: number;
  dvx: number;
  dvy: number;
  dvz: number;
  x: number;
  y: number;
  z: number;
  hpAfter: number;
  maxHp: number;
}
export const DamageFlags = { Crit: 1, Blocked: 2, Killed: 4, ShieldDisabled: 8 } as const;

export type SurvivalEvent =
  | DropEvent
  | DamageEvent
  /** `except`: the player who already heard it locally. */
  | { type: 'sound'; sfx: SurvivalSfx; x: number; y: number; z: number; except?: string }
  | { type: 'death'; target: WireRef; x: number; y: number; z: number };

export interface AttackIntent {
  seq: number;
  target: WireRef;
  ex: number;
  ey: number;
  ez: number;
  yaw: number;
  pitch: number;
  crit: boolean;
  sprint: boolean;
}

export interface ShootIntent {
  seq: number;
  ox: number;
  oy: number;
  oz: number;
  yaw: number;
  pitch: number;
  /** 0..1 */
  charge: number;
}

export interface InvSyncData {
  ack: number;
  full: boolean;
  containerFull: boolean;
  slots: [ref: number, item: number, count: number, meta: number][];
}

export interface VitalsData {
  hpHalf: number;
  foodHalf: number;
  air: number;
  flags: number;
  slowPct: number;
  slowTenths: number;
  burnTenths: number;
}

export interface ContainerEvent {
  open: boolean;
  x: number;
  y: number;
  z: number;
  sealed: boolean;
}

export interface SavedSurvivalPlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  dead: boolean;
  spawn: { x: number; y: number; z: number } | null;
  slots: [slot: number, item: number, count: number, meta: number][];
}

export interface SavedChest {
  x: number;
  y: number;
  z: number;
  /** 1 lootRolled, 2 claimed (structure loot taken, no container kept). */
  flags: number;
  slots: [slot: number, item: number, count: number, meta: number][];
}

export interface SavedSatchel {
  owner: string;
  x: number;
  y: number;
  z: number;
  createdMs: number;
  items: ItemStack[];
}

// ---- players ----------------------------------------------------------------------------

export class SurvivalPlayer implements Damageable {
  readonly ref: EntityRef;
  team = Team.Player;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;
  crouch = false;
  sprinting = false;
  readonly halfWidth = PLAYER_WIDTH / 2;
  readonly height = PLAYER_HEIGHT;
  health: number = SURVIVAL.maxHealth;
  readonly maxHealth = SURVIVAL.maxHealth;
  armor = 0;
  knockbackResist = 0;
  hurtTime = 0;
  lastHurtAmount = 0;
  blockingYaw: number | null = null;
  alive = true;
  effects: ActiveEffect[] = [];

  food: number = SURVIVAL.maxFood;
  air: number = SURVIVAL.maxAir;
  readonly inv = new Inventory();
  selected = 0;
  /** Sandbox: the item the hotbar holds (Hand message). */
  creativeItem = 0;
  /** Sandbox crossbow load state. */
  creativeLoad = LoadedAmmo.None;
  hand = 0;
  useStartMs = 0;
  useSlot = -1;
  guardSinceMs = 0;
  shieldDisabledUntil = 0;
  nextAttackMs = 0;
  swingSeq = 0;
  dig: { x: number; y: number; z: number; startMs: number } | null = null;
  container: { x: number; y: number; z: number } | null = null;
  /** Bedroll cell. */
  spawn: { x: number; y: number; z: number } | null = null;
  resting = false;
  restSinceMs = 0;
  restAt = { x: 0, y: 0, z: 0 };
  protectedUntil = 0;
  lastHurtMs = -1e9;
  readonly fall = new FallTracker();
  lastSafe = { x: 0, y: 0, z: 0 };
  falling = false;
  readonly history = new PlayerHistory();
  /** Move grace after a knockback (server move check). */
  knockUntil = 0;
  timers = { regen: 0, starve: 0, drown: 0, contact: 0, burn: 0 };
  /** Last applied InvOp seq. */
  invAck = 0;
  // ---- private sync state ----
  readonly sentInv = new Inventory();
  sentContainer: Container | null = null;
  sentAck = -1;
  needFullSync = true;
  needContainerFull = false;
  readonly containerEvents: ContainerEvent[] = [];
  readonly notices: string[] = [];
  dead: { cause: string; satchel: { x: number; y: number; z: number } | null } | null = null;
  private sentVitals = '';
  private vitalsAt = 0;
  private lastPoseMs = 0;
  private lastY: number[] = [];

  constructor(
    readonly id: string,
    readonly eid: number,
    public name: string,
    /** Hashed playerKey (hex), null for keyless players. */
    readonly key: string | null,
    private readonly sim: SurvivalSim,
  ) {
    this.ref = { type: 'player', id };
  }

  /** Satchel owner identity. */
  get owner(): string {
    return this.key ?? this.id;
  }

  heldItem(): ItemId {
    return this.sim.rules.creative ? this.creativeItem : this.inv.counts[this.selected] ? this.inv.items[this.selected] : 0;
  }

  /** Off-hand shield, else a main-hand shield: [slot, item] (slot -1 in creative). */
  activeShield(): [number, ItemId] | null {
    if (this.sim.rules.creative) return itemDef(this.creativeItem)?.kind === ItemKind.Shield ? [-1, this.creativeItem] : null;
    for (const slot of [OFFHAND, this.selected]) {
      if (this.inv.counts[slot] && itemDef(this.inv.items[slot])?.kind === ItemKind.Shield) return [slot, this.inv.items[slot]];
    }
    return null;
  }

  guarding(now: number): boolean {
    return (this.hand & HandFlags.Guard) !== 0 && now >= this.shieldDisabledUntil && this.activeShield() !== null && this.alive;
  }

  eyeY(): number {
    return this.y + (this.crouch ? PLAYER_CROUCH_EYE : PLAYER_EYE);
  }

  guardFactor(req: DamageRequest): number {
    const now = this.sim.now();
    const shield = this.activeShield();
    if (!shield || !this.guarding(now) || now - this.guardSinceMs < SURVIVAL.guardRaiseTime * 1000) return 0;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const dx = req.fromX - this.x;
    const dz = req.fromZ - this.z;
    const len = Math.hypot(dx, dz) || 1;
    return (fx * dx + fz * dz) / len >= SURVIVAL.guardArcCos ? (itemDef(shield[1])?.shield?.block ?? 0) : 0;
  }

  onPose(x: number, y: number, z: number, now: number): void {
    const dt = Math.max(0.016, (now - this.lastPoseMs) / 1000);
    if (this.lastPoseMs > 0 && dt < 1) {
      this.vx = this.vx * 0.5 + ((x - this.x) / dt) * 0.5;
      this.vy = this.vy * 0.5 + ((y - this.y) / dt) * 0.5;
      this.vz = this.vz * 0.5 + ((z - this.z) / dt) * 0.5;
    }
    this.lastPoseMs = now;
    this.lastY.push(y);
    if (this.lastY.length > 3) this.lastY.shift();
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Server crit check: the last samples went down. */
  wasFalling(): boolean {
    const l = this.lastY;
    return l.length >= 3 && l[0] - l[1] >= 0.04 && l[1] - l[2] >= 0.04;
  }

  /** Vitals for the owner when they changed (at most 10 per second unless forced). */
  takeVitals(now: number, force = false): VitalsData | null {
    let slow = 0;
    let slowLeft = 0;
    let burnLeft = 0;
    for (const e of this.effects) {
      if (e.kind === StatusKind.Slow && e.strength > slow) {
        slow = e.strength;
        slowLeft = e.left;
      } else if (e.kind === StatusKind.Burn) burnLeft = Math.max(burnLeft, e.left);
    }
    const v: VitalsData = {
      hpHalf: Math.max(0, Math.min(40, Math.ceil(this.health * 2))),
      foodHalf: Math.max(0, Math.min(40, Math.ceil(this.food * 2))),
      air: Math.max(0, Math.min(10, Math.ceil(this.air))),
      flags:
        (this.alive ? 0 : VitalFlags.Dead) |
        (this.food <= 0 ? VitalFlags.Starving : 0) |
        (this.resting ? VitalFlags.Resting : 0) |
        (now < this.protectedUntil ? VitalFlags.Protected : 0) |
        (now < this.shieldDisabledUntil ? VitalFlags.ShieldDisabled : 0),
      slowPct: Math.round(Math.min(0.8, slow) * 100),
      slowTenths: Math.min(255, Math.ceil(slowLeft * 10)),
      burnTenths: Math.min(255, Math.ceil(burnLeft * 10)),
    };
    const key = `${v.hpHalf},${v.foodHalf},${v.air},${v.flags},${v.slowPct},${v.slowTenths > 0},${v.burnTenths > 0}`;
    if (!force && (key === this.sentVitals || now - this.vitalsAt < 100)) return null;
    this.sentVitals = key;
    this.vitalsAt = now;
    return v;
  }

  /** Changed inventory (and open container) slots since the last call, with the op ack; null when nothing to send. */
  takeInvSync(container: Container | null): InvSyncData | null {
    const slots: InvSyncData['slots'] = [];
    const full = this.needFullSync;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      const changed = full || this.inv.items[i] !== this.sentInv.items[i] || this.inv.counts[i] !== this.sentInv.counts[i] || this.inv.metas[i] !== this.sentInv.metas[i];
      if (changed) slots.push([i, this.inv.counts[i] ? this.inv.items[i] : 0, this.inv.counts[i], this.inv.counts[i] ? this.inv.metas[i] : 0]);
    }
    const containerFull = !!container && (this.needContainerFull || !this.sentContainer);
    if (container) {
      const s = this.sentContainer;
      for (let i = 0; i < CONTAINER_SLOTS; i++) {
        const changed = containerFull || !s || container.items[i] !== s.items[i] || container.counts[i] !== s.counts[i] || container.metas[i] !== s.metas[i];
        if (changed) slots.push([CONTAINER_BASE + i, container.counts[i] ? container.items[i] : 0, container.counts[i], container.counts[i] ? container.metas[i] : 0]);
      }
      this.sentContainer = container.clone();
    } else this.sentContainer = null;
    this.needContainerFull = false;
    if (slots.length === 0 && this.sentAck === this.invAck && !full) return null;
    this.sentInv.copyFrom(this.inv);
    this.needFullSync = false;
    this.sentAck = this.invAck;
    return { ack: this.invAck, full, containerFull, slots };
  }

  /** ActFlags for the schema (remote animation). */
  actFlags(now: number): number {
    const item = itemDef(this.heldItem());
    const use = (this.hand & HandFlags.Use) !== 0 && this.useStartMs > 0 && this.useSlot === this.selected;
    const xbow = item?.ranged?.type === 'crossbow';
    const loaded = xbow && (this.sim.rules.creative ? this.creativeLoad : loadedOf(this.inv.metas[this.selected])) !== LoadedAmmo.None;
    let f = 0;
    if (this.guarding(now)) f |= ActFlags.Guard;
    if (use && item?.ranged?.type === 'bow') f |= ActFlags.Draw;
    if (use && xbow && !loaded) f |= ActFlags.Load;
    if (loaded) f |= ActFlags.Loaded;
    if (use && item?.food && !this.sim.rules.creative) f |= ActFlags.Eat;
    if (!this.alive) f |= ActFlags.Dead;
    if (this.resting) f |= ActFlags.Rest;
    if (this.effects.some((e) => e.kind === StatusKind.Burn)) f |= ActFlags.Burning;
    return f;
  }

  onDamaged(req: DamageRequest, res: DamageOutcome): void {
    this.sim.afterPlayerDamaged(this, req, res);
  }
}

// ---- the sim ----------------------------------------------------------------------------------

const wire = (r: EntityRef | null, sim: SurvivalSim): WireRef => {
  if (!r || r.type === 'world') return { refType: RefType.World, id: 0 };
  if (r.type === 'mob') return { refType: RefType.Mob, id: r.id };
  return { refType: RefType.Player, id: sim.players.get(r.id)?.eid ?? 0 };
};

const INTERACTIVE = new Set<number>([Block.Chest, Block.Bedroll, Block.Workbench, Block.Furnace]);
/** Blocks secondary interacts with (instead of placing) unless crouching. */
export function isInteractiveBlock(id: number): boolean {
  return INTERACTIVE.has(id);
}

/** Item a placement consumes: the slab for a slab merge, else the canonical block. */
export function placementItem(newId: number, current: number): ItemId {
  if (SLAB_FULL[current] && SLAB_FULL[current] === newId) return current;
  return canonicalBlock(newId);
}

const ammoItem = (a: LoadedAmmo): ItemId => (a === LoadedAmmo.Bolt ? Item.Bolt : a === LoadedAmmo.EmberArrow ? Item.EmberArrow : Item.Arrow);
const loadOf = (item: ItemId): LoadedAmmo => (item === Item.Bolt ? LoadedAmmo.Bolt : item === Item.EmberArrow ? LoadedAmmo.EmberArrow : LoadedAmmo.Arrow);

export class SurvivalSim implements PlayerHooks {
  readonly players = new Map<string, SurvivalPlayer>();
  private readonly byEid = new Map<number, SurvivalPlayer>();
  readonly chests = new ContainerStore();
  readonly drops: DropSystem;
  /** Container viewers by packed cell. */
  private readonly viewers = new Map<number, Set<string>>();
  /** Collectable stuck projectiles (player arrows and bolts). */
  private readonly stuck = new Map<number, { x: number; y: number; z: number; item: ItemId; at: number }>();
  private readonly events: SurvivalEvent[] = [];
  rules: SurvivalRules;

  constructor(
    readonly host: SurvivalHost,
    rules: SurvivalRules,
    opts: { satchelsExpire: boolean },
  ) {
    this.rules = { ...rules };
    this.drops = new DropSystem(() => host.getBlock(), () => host.now(), (e) => this.events.push(e), opts);
  }

  now(): number {
    return this.host.now();
  }

  takeEvents(): SurvivalEvent[] {
    return this.events.splice(0);
  }

  playerByEid(eid: number): SurvivalPlayer | undefined {
    return this.byEid.get(eid);
  }

  setRules(r: Partial<SurvivalRules>): void {
    Object.assign(this.rules, r);
  }

  // ---- lifecycle ----

  addPlayer(id: string, eid: number, name: string, key: string | null, saved: SavedSurvivalPlayer | null, pos: { x: number; y: number; z: number }): SurvivalPlayer {
    const p = new SurvivalPlayer(id, eid, name, key, this);
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    p.lastSafe = { ...pos };
    if (saved && !this.rules.creative) {
      p.yaw = saved.yaw;
      p.pitch = saved.pitch;
      p.food = Math.max(0, Math.min(SURVIVAL.maxFood, saved.food));
      p.health = saved.dead ? SURVIVAL.maxHealth : Math.max(1, Math.min(SURVIVAL.maxHealth, saved.health));
      if (saved.dead) p.food = Math.max(p.food, SURVIVAL.respawnFood);
      p.spawn = saved.spawn;
      for (const [slot, item, count, meta] of saved.slots) if (slot >= 0 && slot < PLAYER_SLOTS && itemDef(item) && !itemDef(item)!.special) p.inv.set(slot, { item, count, meta });
    }
    p.protectedUntil = this.now() + SURVIVAL.spawnProtection * 1000;
    this.players.set(id, p);
    this.byEid.set(eid, p);
    return p;
  }

  removePlayer(id: string): SavedSurvivalPlayer | null {
    const p = this.players.get(id);
    if (!p) return null;
    this.closeContainer(p, false);
    this.players.delete(id);
    this.byEid.delete(p.eid);
    return this.savePlayer(p);
  }

  savePlayer(p: SurvivalPlayer): SavedSurvivalPlayer {
    const slots: SavedSurvivalPlayer['slots'] = [];
    p.inv.forEachSlot((slot, s) => slots.push([slot, s.item, s.count, s.meta]));
    return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, health: p.health, food: p.food, dead: !p.alive, spawn: p.spawn, slots };
  }

  // ---- intents ----

  /**
   * A pose sample (online: accepted Move; offline: every physics step with the
   * body's own ground flags). Tracks falls, velocity, history and resting.
   */
  setPose(id: string, x: number, y: number, z: number, yaw: number, pitch: number, crouch: boolean, sprinting: boolean, ground?: { grounded: boolean; cushioned: boolean; falling: boolean }): void {
    const p = this.players.get(id);
    if (!p) return;
    const now = this.now();
    if (!p.alive) return;
    if (p.resting) {
      if (Math.hypot(x - p.restAt.x, z - p.restAt.z) > 0.5) this.stopRest(p);
      else return;
    }
    p.onPose(x, y, z, now);
    p.yaw = yaw;
    p.pitch = pitch;
    p.crouch = crouch;
    p.sprinting = sprinting;
    if (this.rules.creative) return;
    const get = this.host.getBlock();
    const grounded = ground ? ground.grounded : groundedAt(get, x, y, z);
    const cushioned = ground ? ground.cushioned : isLiquidAt(get, x, y + 0.4, z) || overlapsClimbable(get, x, y, z);
    p.falling = ground ? ground.falling : !grounded && p.wasFalling();
    if (grounded && !isLava(get(Math.floor(x), Math.floor(y), Math.floor(z))) && !isLava(get(Math.floor(x), Math.floor(y - 0.5), Math.floor(z)))) p.lastSafe = { x, y, z };
    const d = p.fall.update(y, grounded, cushioned);
    const dmg = playerFallDamage(d);
    if (dmg > 0) this.envDamage(p, dmg, DamageKind.Fall);
  }

  /** Teleports and respawns reset fall tracking. */
  resetFall(id: string): void {
    this.players.get(id)?.fall.reset();
  }

  setHand(id: string, slot: number, flags: number, creativeItem: number): void {
    const p = this.players.get(id);
    if (!p) return;
    const now = this.now();
    slot = Math.max(0, Math.min(HOTBAR - 1, slot | 0));
    const itemBefore = p.heldItem();
    p.selected = slot;
    if (this.rules.creative && itemDef(creativeItem)) p.creativeItem = creativeItem;
    else if (this.rules.creative) p.creativeItem = creativeItem < 256 ? creativeItem : 0;
    if (p.heldItem() !== itemBefore) {
      p.useStartMs = 0;
      if (this.rules.creative) p.creativeLoad = LoadedAmmo.None;
    }
    if (flags & HandFlags.Guard && !(p.hand & HandFlags.Guard)) p.guardSinceMs = now;
    if (flags & HandFlags.Use) {
      if (!(p.hand & HandFlags.Use) || p.useSlot !== slot || p.useStartMs === 0) {
        p.useStartMs = now;
        p.useSlot = slot;
      }
    } else p.useStartMs = 0;
    p.hand = flags;
  }

  digStart(id: string, x: number, y: number, z: number): void {
    const p = this.players.get(id);
    if (p) p.dig = { x, y, z, startMs: this.now() };
  }

  /** Server-side check of a break edit; null = allowed. */
  validateBreak(id: string, x: number, y: number, z: number, current: number): string | null {
    if (this.rules.creative) return null;
    const p = this.players.get(id);
    if (!p || !p.alive) return 'dead';
    if (this.sealedChest(x, y, z, current)) return 'sealed';
    const dig = p.dig;
    if (!dig || dig.x !== x || dig.y !== y || dig.z !== z) return 'not digging';
    const need = breakSeconds(current, p.heldItem()) * SURVIVAL.breakTimingFactor * 1000 - SURVIVAL.breakLatencySlack * 1000;
    if (this.now() - dig.startMs < need) return 'too fast';
    return null;
  }

  /** Server-side check of a place edit; null = allowed. */
  validatePlace(id: string, newId: number, current: number): string | null {
    if (this.rules.creative) return null;
    const p = this.players.get(id);
    if (!p || !p.alive) return 'dead';
    const need = placementItem(newId, current);
    if (!isBlockItem(need)) return 'not an item';
    const s = p.inv.get(p.selected);
    if (!s || s.item !== need) return 'not held';
    return null;
  }

  /** True for a structure boss chest whose altar is still active. */
  sealedChest(x: number, y: number, z: number, block: number): boolean {
    if (block !== Block.Chest) return false;
    const s = this.host.generator.structureAt(x, y, z);
    const c = s?.chests.find((ch) => ch.x === x && ch.y === y && ch.z === z);
    return !!s && !!c?.sealed && !isBossDefeated(this.host.getBlock(), s);
  }

  /** An accepted edit (player id, or null for gameplay edits): drops, wear, consumption, chests, waking drops. */
  onEdit(id: string | null, x: number, y: number, z: number, before: number, after: number): void {
    this.drops.wake(x, y, z);
    if (this.rules.creative) return;
    const p = id ? this.players.get(id) : undefined;
    if (before === Block.Chest && after !== Block.Chest) this.breakChest(x, y, z);
    if (after === Block.Air && before !== Block.Air) {
      const held = p ? p.heldItem() : 0;
      for (const s of blockDrops(before, held, () => this.host.random())) this.drops.burst(s, x + 0.5, y + 0.3, z + 0.5, () => this.host.random());
      if (p) {
        p.dig = null;
        const wear = breakWear(before, held);
        if (wear > 0) this.wear(p, p.selected, wear);
      }
    } else if (p && after !== Block.Air) {
      const need = placementItem(after, before);
      const s = p.inv.get(p.selected);
      if (s && s.item === need) p.inv.takeOne(p.selected);
      else {
        const slot = p.inv.findFirst([need]);
        if (slot >= 0) p.inv.takeOne(slot);
      }
    }
    this.host.dirty?.();
  }

  /** Cells removed by the world's support cascade drop as if harvested by hand. */
  blocksRemoved(cells: readonly BlockEdit[], before: readonly number[]): void {
    cells.forEach((c, i) => this.onEdit(null, c.x, c.y, c.z, before[i], Block.Air));
  }

  private breakChest(x: number, y: number, z: number): void {
    const key = packPos(x, y, z);
    for (const s of this.chests.remove(x, y, z)) this.drops.burst(s, x + 0.5, y + 0.5, z + 0.5, () => this.host.random());
    for (const vid of this.viewers.get(key) ?? []) {
      const v = this.players.get(vid);
      if (v) this.closeContainer(v, true);
    }
    this.viewers.delete(key);
  }

  attack(id: string, a: AttackIntent): void {
    const p = this.players.get(id);
    if (!p || !p.alive || p.resting) return;
    const now = this.now();
    if (now < p.nextAttackMs - 60 || p.guarding(now)) return;
    const held = p.heldItem();
    const stats = meleeOf(held);
    p.nextAttackMs = now + stats.cooldown * 1000;
    p.swingSeq = (p.swingSeq + 1) & 255;
    if (itemDef(held)?.food) p.useStartMs = 0;
    if (a.target.refType === RefType.World) return;
    // Eye: the client's if close to ours.
    const sy = p.eyeY();
    const near = Math.hypot(a.ex - p.x, a.ey - sy, a.ez - p.z) <= SURVIVAL.originSlack;
    const ex = near ? a.ex : p.x;
    const ey = near ? a.ey : sy;
    const ez = near ? a.ez : p.z;
    const d = forwardFromYawPitch(a.yaw, a.pitch);
    const view = forwardFromYawPitch(p.yaw, p.pitch);
    if (Math.acos(Math.max(-1, Math.min(1, d.x * view.x + d.y * view.y + d.z * view.z))) > SURVIVAL.aimAngleSlack) return;
    const reach = stats.reach + SURVIVAL.meleeReachSlack;
    const crit = a.crit && p.falling;
    const req: DamageRequest = {
      amount: stats.damage * (crit ? SURVIVAL.critMultiplier : 1),
      kind: DamageKind.Melee,
      attacker: p.ref,
      fromX: ex,
      fromY: ey,
      fromZ: ez,
      knockback: stats.knockback + (a.sprint ? SURVIVAL.sprintKnockBonus : 0),
      lift: stats.lift,
      crit,
      weapon: itemKey(held) ?? undefined,
      shieldDisable: stats.shieldDisable || undefined,
      effects: itemDef(held)?.effects,
    };
    const get = this.host.getBlock();
    if (a.target.refType === RefType.Mob) {
      const api = this.host.entities();
      const hit = api?.raycast(ex, ey, ez, d.x, d.y, d.z, reach, { lagTicks: 6, pad: SURVIVAL.meleePad });
      if (!api || !hit || solidRayDistance(get, ex, ey, ez, d.x, d.y, d.z, hit.distance) < hit.distance - 0.1) return;
      const res = api.damageMob(hit.id, req);
      if (res && !res.ignored && !this.rules.creative) this.wear(p, p.selected, stats.wear);
      return;
    }
    // Player target: PvP only, rewound boxes.
    const t = this.byEid.get(a.target.id);
    if (!t || t === p || !t.alive || !this.rules.pvp || this.rules.creative) return;
    let best = Infinity;
    const test = (x: number, y: number, z: number) => {
      best = Math.min(best, rayAabb(ex, ey, ez, d.x, d.y, d.z, boxAt(x, y, z, t.halfWidth, t.height, SURVIVAL.meleePad)));
    };
    test(t.x, t.y, t.z);
    t.history.within(now, SURVIVAL.meleeHistoryMs, test);
    if (best > reach) return;
    if (solidRayDistance(get, ex, ey, ez, d.x, d.y, d.z, best) < best - 0.1) return;
    const res = this.damagePlayerRef(t, req);
    if (!res.ignored) this.wear(p, p.selected, stats.wear);
    if (res.blocked && !res.ignored) this.push(p, t.x, t.z, SURVIVAL.shieldBash, { refType: RefType.Player, id: t.eid });
  }

  shoot(id: string, s: ShootIntent): void {
    const p = this.players.get(id);
    if (!p || !p.alive || p.resting) return;
    const now = this.now();
    const held = p.heldItem();
    const def = itemDef(held);
    const r = def?.ranged;
    if (!r) return;
    const creative = this.rules.creative;
    let ammo: ItemId;
    let charge: number;
    if (r.type === 'bow') {
      if (!p.useStartMs || p.useSlot !== p.selected) return;
      const serverCharge = Math.max(0, Math.min(1, (now - p.useStartMs + 150) / (r.drawTime * 1000)));
      charge = Math.min(Math.max(0, Math.min(1, s.charge)), serverCharge);
      if (charge < r.minCharge) return;
      p.useStartMs = 0;
      if (creative) ammo = Item.Arrow;
      else {
        const slot = p.inv.findFirst(r.ammo);
        if (slot < 0) return;
        ammo = p.inv.items[slot];
        p.inv.takeOne(slot);
      }
    } else {
      const load = creative ? p.creativeLoad : loadedOf(p.inv.metas[p.selected]);
      if (load === LoadedAmmo.None) return;
      ammo = ammoItem(load);
      if (creative) p.creativeLoad = LoadedAmmo.None;
      else p.inv.metas[p.selected] = withLoad(p.inv.metas[p.selected], LoadedAmmo.None);
      charge = 1;
    }
    const a = itemDef(ammo)!.ammo!;
    const speed = r.speedMin + (r.speedMax - r.speedMin) * charge;
    let damage = Math.round((r.damageMin + (r.damageMax - r.damageMin) * charge) * 2) / 2;
    if (r.type === 'crossbow' && ammo !== Item.Bolt) damage *= SURVIVAL.crossbowArrowMul;
    damage = damage * a.damageMul + a.bonus;
    const sy = p.eyeY();
    const near = Math.hypot(s.ox - p.x, s.oy - sy, s.oz - p.z) <= SURVIVAL.originSlack;
    const d = forwardFromYawPitch(s.yaw, s.pitch);
    const ox = near ? s.ox : p.x;
    const oy = near ? s.oy : sy;
    const oz = near ? s.oz : p.z;
    this.host.entities()?.spawnProjectile({
      kind: a.projectile,
      owner: p.ref,
      team: Team.Player,
      x: ox + d.x * 0.3,
      y: oy + d.y * 0.3 - 0.05,
      z: oz + d.z * 0.3,
      vx: d.x * speed,
      vy: d.y * speed,
      vz: d.z * speed,
      damage,
      knockback: r.knockMin + (r.knockMax - r.knockMin) * charge,
      lift: r.lift,
      crit: false,
      pierce: r.pierce,
      effects: def.effects,
      pickupItem: creative ? null : a.projectile === ProjectileKind.Bolt ? 'bolt' : 'arrow',
      hitsPlayers: this.rules.pvp && !creative,
      seq: s.seq,
      stickSeconds: creative ? 10 : undefined,
    });
    this.events.push({ type: 'sound', sfx: r.type === 'bow' ? SurvivalSfx.BowShot : SurvivalSfx.XbowShot, x: ox, y: oy, z: oz, except: p.id });
    if (!creative) this.wear(p, p.selected, 1);
  }

  invOp(id: string, seq: number, op: InvOp): void {
    const p = this.players.get(id);
    if (!p) return;
    p.invAck = seq;
    if (this.rules.creative || !p.alive) return;
    const container = this.openContainer(p);
    const sealed = !!p.container && this.sealedChest(p.container.x, p.container.y, p.container.z, Block.Chest);
    const get = this.host.getBlock();
    const out = { thrown: [] as ItemStack[] };
    const ok = applyInvOp(p.inv, op, {
      selected: p.selected,
      container: sealed ? null : container,
      stations: op.op === 'craft' ? stationsNear(get, p.x, p.y, p.z) : 0,
      sealedContainer: sealed,
      craft: craftOp,
    }, out);
    if (!ok) return;
    if (op.op === 'craft') this.events.push({ type: 'sound', sfx: SurvivalSfx.Craft, x: p.x, y: p.y + 1, z: p.z, except: p.id });
    for (const s of out.thrown) {
      if (op.op === 'drop') {
        const f = forwardFromYawPitch(p.yaw, p.pitch);
        this.drops.spawn(s.item, s.count, s.meta, p.x + f.x * 0.3, p.eyeY() - 0.3, p.z + f.z * 0.3, f.x * 5, f.y * 5 + 1.5, f.z * 5, p.id, SURVIVAL.throwPickupDelay);
      } else this.drops.spawn(s.item, s.count, s.meta, p.x, p.y + 0.5, p.z, 0, 0, 0, p.id, SURVIVAL.throwPickupDelay);
    }
    this.host.dirty?.();
  }

  interact(id: string, kind: InteractKind, x: number, y: number, z: number): void {
    const p = this.players.get(id);
    if (!p || this.rules.creative) return;
    if (kind === InteractKind.CloseContainer) return this.closeContainer(p, true);
    if (kind === InteractKind.StopRest) return this.stopRest(p);
    if (!p.alive) return;
    const get = this.host.getBlock();
    const block = get(x, y, z);
    if (Math.hypot(x + 0.5 - p.x, y + 0.5 - p.eyeY(), z + 0.5 - p.z) > REACH + 2) return;
    if (kind === InteractKind.OpenChest && block === Block.Chest) {
      this.closeContainer(p, false);
      if (this.sealedChest(x, y, z, block)) {
        p.containerEvents.push({ open: true, x, y, z, sealed: true });
        return;
      }
      const structure = this.structureChest(x, y, z);
      this.chests.open(x, y, z, structure);
      p.container = { x, y, z };
      p.needContainerFull = true;
      const key = packPos(x, y, z);
      if (!this.viewers.has(key)) this.viewers.set(key, new Set());
      this.viewers.get(key)!.add(p.id);
      p.containerEvents.push({ open: true, x, y, z, sealed: false });
      if (structure) this.host.dirty?.();
    } else if (kind === InteractKind.UseBedroll && block === Block.Bedroll) {
      p.spawn = { x, y, z };
      this.host.dirty?.();
      if (!isNight(this.host.timeOfDay())) {
        p.notices.push('Spawn point set');
        return;
      }
      const hostile = this.host.entities()?.mobsNear(x + 0.5, z + 0.5, SURVIVAL.restRadius).some((m) => m.team === Team.Hostile);
      if (hostile) {
        p.notices.push("Spawn point set. You can't rest now: creatures are nearby");
        return;
      }
      p.resting = true;
      p.restSinceMs = this.now();
      p.restAt = { x: p.x, y: p.y, z: p.z };
      p.useStartMs = 0;
      p.notices.push('Spawn point set. Resting…');
    }
  }

  private structureChest(x: number, y: number, z: number): StructureChest | null {
    return this.host.generator.structureAt(x, y, z)?.chests.find((c) => c.x === x && c.y === y && c.z === z) ?? null;
  }

  /** The container a player has open (null when none or the chest is gone). */
  openContainer(p: SurvivalPlayer): Container | null {
    return p.container ? this.chests.get(p.container.x, p.container.y, p.container.z) : null;
  }

  private closeContainer(p: SurvivalPlayer, notify: boolean): void {
    if (!p.container) return;
    const { x, y, z } = p.container;
    this.viewers.get(packPos(x, y, z))?.delete(p.id);
    p.container = null;
    if (notify) p.containerEvents.push({ open: false, x, y, z, sealed: false });
  }

  private stopRest(p: SurvivalPlayer): void {
    p.resting = false;
  }

  respawn(id: string): void {
    const p = this.players.get(id);
    if (!p || p.alive) return;
    const get = this.host.getBlock();
    let pos: { x: number; y: number; z: number } | null = null;
    if (p.spawn) {
      const { x, y, z } = p.spawn;
      if (get(x, y, z) === Block.Bedroll) {
        const tries: [number, number, number][] = [[x + 0.5, y + 0.3125, z + 0.5]];
        for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) tries.push([x + dx + 0.5, y + dy, z + dz + 0.5]);
        for (const [tx, ty, tz] of tries) {
          if (!collides(get, tx, ty, tz)) {
            pos = { x: tx, y: ty, z: tz };
            break;
          }
        }
      }
      if (!pos) {
        p.notices.push('Your bedroll was missing or blocked');
        p.spawn = null;
      }
    }
    pos ??= this.host.generator.findSpawn();
    p.alive = true;
    p.dead = null;
    p.health = SURVIVAL.maxHealth;
    p.food = Math.max(p.food, SURVIVAL.respawnFood);
    p.air = SURVIVAL.maxAir;
    p.effects = [];
    p.hurtTime = 0;
    p.lastHurtAmount = 0;
    p.hand = 0;
    p.useStartMs = 0;
    p.protectedUntil = this.now() + SURVIVAL.spawnProtection * 1000;
    p.fall.reset();
    p.history.clear();
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    p.lastSafe = { ...pos };
    this.host.teleport(id, pos.x, pos.y, pos.z);
  }

  // ---- damage ----

  /** PlayerHooks.damagePlayer: mob melee, bursts, hazards and projectiles. */
  damagePlayer(id: string, req: DamageRequest): DamageOutcome {
    const p = this.players.get(id);
    return p ? this.damagePlayerRef(p, req) : ignoredResult();
  }

  damagePlayerRef(p: SurvivalPlayer, req: DamageRequest): DamageOutcome {
    const now = this.now();
    if (this.rules.creative || !p.alive || (now < p.protectedUntil && req.kind !== DamageKind.Void)) return ignoredResult();
    if (req.attacker?.type === 'player' && (!this.rules.pvp || req.attacker.id === p.id)) return ignoredResult();
    p.blockingYaw = p.guarding(now) ? p.yaw : null;
    return applyDamage(p, req);
  }

  /** Called by SurvivalPlayer.onDamaged after applyDamage. */
  afterPlayerDamaged(p: SurvivalPlayer, req: DamageRequest, res: DamageOutcome): void {
    const now = this.now();
    if (res.dealt > 0) {
      p.lastHurtMs = now;
      p.timers.regen = 0;
      p.resting = false;
      if (itemDef(p.heldItem())?.food) p.useStartMs = 0;
    }
    if (res.blocked) {
      const shield = p.activeShield();
      if (shield) this.wear(p, shield[0], Math.ceil(Math.max(0, req.amount - res.dealt)));
      if (res.shieldDisabled) {
        p.shieldDisabledUntil = now + (req.shieldDisable ?? 0) * 1000;
        this.events.push({ type: 'sound', sfx: SurvivalSfx.ShieldBreak, x: p.x, y: p.y + 1, z: p.z });
      }
    }
    if (Math.hypot(res.dvx, res.dvz) > 0.01 || res.dvy > 0.01) p.knockUntil = now + SURVIVAL.knockGrace * 1000;
    let flags = 0;
    if (req.crit) flags |= DamageFlags.Crit;
    if (res.blocked) flags |= DamageFlags.Blocked;
    if (res.killed) flags |= DamageFlags.Killed;
    if (res.shieldDisabled) flags |= DamageFlags.ShieldDisabled;
    this.events.push({
      type: 'damage', target: { refType: RefType.Player, id: p.eid }, source: wire(req.attacker, this),
      amount: res.dealt, kind: req.kind, flags, dvx: res.dvx, dvy: res.dvy, dvz: res.dvz,
      x: p.x, y: p.y + 1.1, z: p.z, hpAfter: p.health, maxHp: p.maxHealth,
    });
    if (res.killed) this.die(p, req);
  }

  /** Knockback without damage (shield bash): a 0-damage record the victim's client applies. */
  private push(p: SurvivalPlayer, fromX: number, fromZ: number, strength: number, source: WireRef): void {
    let dx = p.x - fromX;
    let dz = p.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx = (dx / len) * strength;
    dz = (dz / len) * strength;
    p.knockUntil = this.now() + SURVIVAL.knockGrace * 1000;
    this.events.push({ type: 'damage', target: { refType: RefType.Player, id: p.eid }, source, amount: 0, kind: DamageKind.Melee, flags: DamageFlags.Blocked, dvx: dx, dvy: 0, dvz: dz, x: p.x, y: p.y + 1.1, z: p.z, hpAfter: p.health, maxHp: p.maxHealth });
  }

  /** Environment damage (fall, drowning, contact, starving, burning, void): no immunity, no knockback. */
  private envDamage(p: SurvivalPlayer, amount: number, kind: DamageKind, floor = 0): void {
    const now = this.now();
    if (!p.alive || this.rules.creative || amount <= 0) return;
    if (now < p.protectedUntil && kind !== DamageKind.Void) return;
    const dealt = Math.min(amount, Math.max(0, p.health - floor));
    if (dealt <= 0) return;
    p.health -= dealt;
    p.lastHurtMs = now;
    p.timers.regen = 0;
    p.resting = false;
    const killed = p.health <= 0;
    if (killed) p.alive = false;
    this.events.push({
      type: 'damage', target: { refType: RefType.Player, id: p.eid }, source: { refType: RefType.World, id: 0 },
      amount: dealt, kind, flags: killed ? DamageFlags.Killed : 0, dvx: 0, dvy: 0, dvz: 0, x: p.x, y: p.y + 1.1, z: p.z, hpAfter: p.health, maxHp: p.maxHealth,
    });
    if (killed) this.die(p, { amount, kind, attacker: { type: 'world' }, fromX: p.x, fromY: p.y, fromZ: p.z, knockback: 0, lift: 0 });
  }

  /** Test and dev hook: damage that ignores shields and armor. */
  debugDamage(id: string, amount: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.protectedUntil = 0;
    this.envDamage(p, amount, DamageKind.Magic);
  }

  private deathMessage(p: SurvivalPlayer, req: DamageRequest): string {
    const v = p.name;
    const a = req.attacker;
    if (a?.type === 'player') {
      const who = this.players.get(a.id)?.name ?? 'someone';
      if (req.kind === DamageKind.Projectile) return `${v} was shot by ${who}`;
      const w = req.weapon ? itemFromKey(req.weapon) : null;
      return `${v} was defeated by ${who}${w !== null ? ` (${itemName(w)})` : ''}`;
    }
    if (a?.type === 'mob') {
      const name = this.host.entities()?.mobName(a.id) ?? 'a creature';
      return req.kind === DamageKind.Projectile ? `${v} was shot by ${name}` : `${v} was defeated by ${name}`;
    }
    switch (req.kind) {
      case DamageKind.Fall: return `${v} fell from a high place`;
      case DamageKind.Drown: return `${v} ran out of air`;
      case DamageKind.Contact: return this.inLava(p) ? `${v} tried to swim in lava` : `${v} hugged a cactus`;
      case DamageKind.Fire: return `${v} burned up`;
      case DamageKind.Void: return `${v} fell out of the world`;
      case DamageKind.Starve: return `${v} starved`;
      default: return `${v} was defeated`;
    }
  }

  private inLava(p: SurvivalPlayer): boolean {
    return contactAt(this.host.getBlock(), p.x, p.y, p.z).lava;
  }

  private die(p: SurvivalPlayer, req: DamageRequest): void {
    p.alive = false;
    p.health = 0;
    p.resting = false;
    p.hand = 0;
    p.useStartMs = 0;
    p.effects = [];
    this.closeContainer(p, true);
    const cause = this.deathMessage(p, req);
    let satchel: { x: number; y: number; z: number } | null = null;
    if (!this.rules.keepInventory) {
      const items: ItemStack[] = [];
      p.inv.forEachSlot((_, s) => items.push(s));
      if (items.length) {
        const unsafe = req.kind === DamageKind.Void || this.inLava(p) || p.y < 1;
        const at = unsafe ? p.lastSafe : { x: p.x, y: p.y, z: p.z };
        const d = this.drops.spawnSatchel(p.owner, items, at.x, at.y + 0.3, at.z);
        if (d) {
          satchel = { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) };
          p.inv.clear();
          this.events.push({ type: 'sound', sfx: SurvivalSfx.SatchelDrop, x: at.x, y: at.y, z: at.z });
        }
      }
    }
    p.dead = { cause, satchel };
    this.events.push({ type: 'death', target: { refType: RefType.Player, id: p.eid }, x: p.x, y: p.y, z: p.z });
    this.host.announce(cause);
    this.host.dirty?.();
  }

  /** Adds wear to the item in a slot; breaks it at its durability. */
  private wear(p: SurvivalPlayer, slot: number, amount: number): void {
    if (this.rules.creative || amount <= 0 || slot < 0 || !p.inv.counts[slot]) return;
    const def = itemDef(p.inv.items[slot]);
    if (!def || def.durability <= 0) return;
    const meta = p.inv.metas[slot];
    const used = wearOf(meta) + amount;
    if (used >= def.durability) {
      p.inv.set(slot, null);
      p.notices.push(`Your ${def.name} broke`);
      this.events.push({ type: 'sound', sfx: SurvivalSfx.ToolBreak, x: p.x, y: p.y + 1.2, z: p.z });
    } else p.inv.metas[slot] = (meta & ~0xfff) | used;
  }

  // ---- tick ----

  /** Start of a sim tick: player history for lag-compensated hit tests. */
  preTick(): void {
    const now = this.now();
    for (const p of this.players.values()) p.history.record(now, p.x, p.y, p.z);
  }

  tick(dt: number): void {
    const now = this.now();
    const get = this.host.getBlock();
    for (const p of this.players.values()) {
      p.hurtTime = Math.max(0, p.hurtTime - dt);
      p.blockingYaw = p.guarding(now) && now - p.guardSinceMs >= SURVIVAL.guardRaiseTime * 1000 ? p.yaw : null;
      if (this.rules.creative) {
        this.tickUse(p, now);
        continue;
      }
      if (!p.alive) continue;
      // Status effects (mob attacks, lava, ember arrows): burn in 1 HP pulses.
      tickEffects(p, dt, (burn) => {
        p.timers.burn += burn;
      });
      if (p.timers.burn >= 0.999) {
        p.timers.burn = Math.max(0, p.timers.burn - 1);
        this.envDamage(p, 1, DamageKind.Fire);
      }
      if (!p.alive) continue;
      // Void.
      if (p.y < SURVIVAL.voidY) {
        this.envDamage(p, 1000, DamageKind.Void);
        continue;
      }
      // Drowning.
      if (headInWater(get, p.x, p.y, p.z, p.crouch)) {
        p.air = Math.max(0, p.air - SURVIVAL.airDrainPerSecond * dt);
        if (p.air <= 0 && (p.timers.drown += dt) >= SURVIVAL.drownInterval) {
          p.timers.drown = 0;
          this.envDamage(p, SURVIVAL.drownDamage, DamageKind.Drown);
        }
      } else {
        p.air = Math.min(SURVIVAL.maxAir, p.air + SURVIVAL.airRefillPerSecond * dt);
        p.timers.drown = 0;
      }
      // Contact (cactus, lava) in pulses.
      if ((p.timers.contact += dt) >= SURVIVAL.contactInterval) {
        p.timers.contact = 0;
        const c = contactAt(get, p.x, p.y, p.z);
        if (c.lava) {
          const burn = p.effects.find((e) => e.kind === StatusKind.Burn);
          if (burn) burn.left = Math.max(burn.left, SURVIVAL.lavaBurnSeconds);
          else p.effects.push({ kind: StatusKind.Burn, strength: 1, seconds: SURVIVAL.lavaBurnSeconds, left: SURVIVAL.lavaBurnSeconds });
        }
        if (c.dps > 0) this.envDamage(p, c.dps * SURVIVAL.contactInterval, DamageKind.Contact);
      }
      if (!p.alive) continue;
      // Food, regeneration, starvation.
      p.food = Math.max(0, p.food - dt * (SURVIVAL.foodDrainPerSecond + (p.sprinting ? SURVIVAL.sprintFoodPerSecond : 0)));
      if (p.food <= 0) {
        if ((p.timers.starve += dt) >= SURVIVAL.starveInterval) {
          p.timers.starve = 0;
          this.envDamage(p, 1, DamageKind.Starve, SURVIVAL.starveFloor);
        }
      } else p.timers.starve = 0;
      if (p.health < p.maxHealth && p.food > 0 && now - p.lastHurtMs >= SURVIVAL.regenDelayAfterHit * 1000) {
        const interval = p.food >= SURVIVAL.regenFastFood ? SURVIVAL.regenFastInterval : SURVIVAL.regenSlowInterval;
        if ((p.timers.regen += dt) >= interval) {
          p.timers.regen = 0;
          p.health = Math.min(p.maxHealth, p.health + 1);
          p.food = Math.max(0, p.food - SURVIVAL.regenFoodCost);
        }
      } else p.timers.regen = 0;
      this.tickUse(p, now);
      // Containers close out of range.
      if (p.container && Math.hypot(p.container.x + 0.5 - p.x, p.container.z + 0.5 - p.z) > SURVIVAL.containerRange + 1) this.closeContainer(p, true);
      // Pickups.
      this.drops.collect(p.id, p.owner, p.x, p.y, p.z, (s) => s.count - p.inv.add(s.item, s.count, s.meta));
      this.collectArrows(p, now);
    }
    this.tickRest(now);
    this.drops.tick(dt);
  }

  /** Eating, crossbow loading (bow draw needs no timer here). */
  private tickUse(p: SurvivalPlayer, now: number): void {
    if (!p.useStartMs || p.useSlot !== p.selected || !p.alive) return;
    const held = p.heldItem();
    const def = itemDef(held);
    if (!def) return;
    const elapsed = now - p.useStartMs;
    if (def.food && !this.rules.creative) {
      if (p.food >= SURVIVAL.maxFood) return;
      if (elapsed >= SURVIVAL.eatTime * 1000) {
        p.inv.takeOne(p.selected);
        p.food = Math.min(SURVIVAL.maxFood, p.food + def.food.food);
        p.health = Math.min(p.maxHealth, p.health + def.food.heal);
        p.useStartMs = now;
        this.events.push({ type: 'sound', sfx: SurvivalSfx.EatDone, x: p.x, y: p.y + 1.5, z: p.z });
        this.host.dirty?.();
      }
    } else if (def.ranged?.type === 'crossbow') {
      const loaded = this.rules.creative ? p.creativeLoad : loadedOf(p.inv.metas[p.selected]);
      if (loaded !== LoadedAmmo.None || elapsed < def.ranged.drawTime * 1000 - 100) return;
      if (this.rules.creative) p.creativeLoad = LoadedAmmo.Bolt;
      else {
        // Crossbows prefer bolts, then ember arrows, then arrows.
        let slot = -1;
        for (const a of def.ranged.ammo) if (slot < 0) slot = p.inv.findFirst([a]);
        if (slot < 0) return;
        const ammo = p.inv.items[slot];
        p.inv.takeOne(slot);
        p.inv.metas[p.selected] = withLoad(p.inv.metas[p.selected], loadOf(ammo));
      }
      p.useStartMs = 0;
      this.events.push({ type: 'sound', sfx: SurvivalSfx.XbowLoaded, x: p.x, y: p.y + 1.4, z: p.z, except: p.id });
    }
  }

  private tickRest(now: number): void {
    let alive = 0;
    let rested = 0;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      alive++;
      if (p.resting && now - p.restSinceMs >= SURVIVAL.restSeconds * 1000) rested++;
    }
    if (alive === 0 || rested < alive) return;
    for (const p of this.players.values()) p.resting = false;
    if (daylightAt(this.host.timeOfDay()) < 0.5) this.host.skipNight();
  }

  private collectArrows(p: SurvivalPlayer, now: number): void {
    if (this.stuck.size === 0) return;
    const api = this.host.entities();
    const r = SURVIVAL.arrowPickupRadius;
    for (const [id, s] of this.stuck) {
      if (now - s.at > 29_000) {
        this.stuck.delete(id);
        continue;
      }
      if (Math.hypot(s.x - p.x, s.z - p.z) > r || s.y < p.y - 0.8 || s.y > p.y + 2.2) continue;
      if (p.inv.add(s.item, 1) > 0) continue;
      this.stuck.delete(id);
      api?.removeProjectile(id);
      this.events.push({ type: 'sound', sfx: SurvivalSfx.Pickup, x: s.x, y: s.y, z: s.z, except: p.id });
    }
  }

  // ---- PlayerHooks (the creature sim calls these) ----

  playerTargets(): readonly PlayerTarget[] {
    const out: PlayerTarget[] = [];
    for (const p of this.players.values()) {
      out.push({
        id: p.id, eid: p.eid, name: p.name, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, yaw: p.yaw,
        crouching: p.crouch, sprinting: p.sprinting, targetable: !this.rules.creative && p.alive && !p.resting, alive: p.alive,
        halfWidth: p.halfWidth, height: p.height, blockingYaw: p.blockingYaw,
      });
    }
    return out;
  }

  dropItems(x: number, y: number, z: number, stacks: readonly { item: string; count: number }[]): void {
    if (this.rules.creative) return;
    for (const s of stacks) {
      const item = itemFromKey(s.item);
      if (item !== null && s.count > 0) this.drops.burst({ item, count: s.count, meta: 0 }, x, y + 0.3, z, () => this.host.random());
    }
  }

  consumeHeld(playerId: string, key: string): boolean {
    if (this.rules.creative) return true;
    const p = this.players.get(playerId);
    if (!p || itemKey(p.heldItem()) !== key) return false;
    p.inv.takeOne(p.selected);
    return true;
  }

  heldItem(playerId: string): string | null {
    const p = this.players.get(playerId);
    return p ? itemKey(p.heldItem()) : null;
  }

  onProjectileStuck(proj: ProjectileState): void {
    if (this.rules.creative || !proj.pickupItem) return;
    const item = itemFromKey(proj.pickupItem);
    if (item !== null) this.stuck.set(proj.id, { x: proj.x, y: proj.y, z: proj.z, item, at: this.now() });
  }

  playerName(id: string): string {
    return this.players.get(id)?.name ?? 'someone';
  }

  // ---- persistence ----

  saveChests(): SavedChest[] {
    const out: SavedChest[] = [];
    for (const [key, c] of this.chests.containers) {
      const [x, y, z] = unpackPos(key);
      const slots: SavedChest['slots'] = [];
      c.forEachSlot((slot, s) => slots.push([slot, s.item, s.count, s.meta]));
      out.push({ x, y, z, flags: c.lootRolled ? 1 : 0, slots });
    }
    for (const key of this.chests.claimed) {
      if (this.chests.containers.has(key)) continue;
      const [x, y, z] = unpackPos(key);
      out.push({ x, y, z, flags: 2, slots: [] });
    }
    return out;
  }

  loadChests(list: readonly SavedChest[]): void {
    for (const ch of list) {
      const key = packPos(ch.x, ch.y, ch.z);
      if (ch.flags & 1 || ch.flags & 2) this.chests.claimed.add(key);
      if (ch.flags & 2) continue;
      const c = this.chests.open(ch.x, ch.y, ch.z, null);
      c.lootRolled = (ch.flags & 1) !== 0;
      for (const [slot, item, count, meta] of ch.slots) if (itemDef(item)) c.set(slot, { item, count, meta });
    }
  }

  saveSatchels(): SavedSatchel[] {
    const out: SavedSatchel[] = [];
    for (const d of this.drops.list.values()) {
      if (d.satchel) out.push({ owner: d.satchel.owner, x: d.x, y: d.y, z: d.z, createdMs: d.satchel.createdMs, items: d.satchel.items.map((s) => ({ ...s })) });
    }
    return out;
  }

  loadSatchels(list: readonly SavedSatchel[]): void {
    for (const s of list) {
      const items = s.items.filter((i) => itemDef(i.item) && i.count > 0);
      if (!items.length) continue;
      const d: ItemDrop | null = this.drops.spawnSatchel(s.owner, items, s.x, s.y, s.z);
      if (d) {
        d.satchel!.createdMs = s.createdMs;
        d.vy = 0;
      }
    }
  }

  /** Something worth saving exists. */
  hasProgress(): boolean {
    return this.chests.size > 0 || this.saveSatchels().length > 0;
  }
}
