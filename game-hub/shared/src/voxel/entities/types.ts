/**
 * Creature simulation data model (design-voxel-mobs §4.2): kinds, flags,
 * actions, the Mob object every brain works on, rules and caps per mode, the
 * host interface the server and the offline game implement, and the events a
 * step produces.
 */
import type { VoxelMode } from '../../constants';
import type { ActiveEffect, DamageKind, Damageable, EntityRef } from '../combat';
import { Team } from '../combat';
import type { WorldGenerator } from '../generator';
import type { BlockQuery } from '../physics';
import type { Box3i } from '../structures/types';
import type { BossController } from './bosses/boss';
import type { MobDef } from './defs';
import type { PathResult } from './pathfind';

/** Persisted in MOBS (tamed mobs) and sent as u8: never renumber. */
export enum MobKind {
  Woolback = 1,
  Hopling = 2,
  Cluckit = 3,
  Fernhart = 4,
  Glimmerfin = 5,
  Mudlurch = 16,
  Rattlebow = 17,
  Cragcrawler = 18,
  Puffcap = 19,
  Duskwing = 20,
  SunforgedSentinel = 32,
  RimeWarden = 33,
  Thornmaw = 34,
  AshenKnight = 35,
}

/** Biome and structure recolours (4 bits on the wire). */
export enum MobVariant {
  Default = 0,
  Sand = 1,
  Frost = 2,
  Moss = 3,
  Ash = 4,
  Tropical = 5,
}

export enum MobCategory {
  Friendly = 0,
  Hostile = 1,
  Boss = 2,
}

export const MobFlag = {
  Minion: 1,
  Guard: 2,
  Tamed: 4,
  Baby: 8,
  Boss: 16,
  Dying: 32,
  /** Its chunk is not available: it keeps its state and does nothing. */
  Frozen: 64,
  Named: 128,
} as const;

/** Animation action sent to clients (4 bits). */
export enum MobAction {
  Idle = 0,
  Walk = 1,
  Attack = 2,
  Cast = 3,
  Charge = 4,
  Slam = 5,
  Summon = 6,
  Stunned = 7,
  Burrow = 8,
  Emerge = 9,
  Inflate = 10,
  Graze = 11,
  Swoop = 12,
  Roar = 13,
  Draw = 14,
  Death = 15,
}

export enum AiState {
  Idle,
  Wander,
  Graze,
  Panic,
  Tempted,
  FollowOwner,
  SeekMate,
  Chase,
  Windup,
  Recover,
  Kite,
  Strafe,
  Lunge,
  Inflate,
  Patrol,
  Swoop,
  Retreat,
  ReturnHome,
  SeekShade,
  Swim,
  Boss,
}

/** What a brain asks the body to do this tick (consumed by stepMobBody). */
export interface MoveIntent {
  /** Desired horizontal velocity (world space, b/s). */
  vx: number;
  vz: number;
  jump: boolean;
  /** Crawlers against a wall climb it. */
  climb: boolean;
  /** Flyers, fish and floating bosses: desired vertical velocity (null = physics only). */
  vy: number | null;
  /** Turn toward this (else toward the movement). */
  faceYaw: number | null;
}

/** Ring of past tick positions kept for lag-tolerant hit tests (EntityWorldApi.raycast lagTicks). */
export const HISTORY_LENGTH = 8;

/** One creature. Implements the shared Damageable so applyDamage works on it unchanged. */
export class Mob implements Damageable {
  readonly ref: EntityRef;
  team: Team;
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  halfWidth: number;
  height: number;
  health: number;
  maxHealth: number;
  armor: number;
  knockbackResist: number;
  hurtTime = 0;
  lastHurtAmount = 0;
  immunity?: number;
  blockingYaw: number | null = null;
  alive = true;
  effects: ActiveEffect[] = [];

  variant: MobVariant;
  /** MobFlag bits. */
  flags: number;
  yaw = 0;
  headYaw = 0;
  headPitch = 0;
  onGround = false;
  inWater = false;
  /** Horizontally blocked during the last body step (climbers, stuck checks). */
  blockedH = false;
  landedSpeed = 0;
  /** Babies are drawn and collide smaller. */
  scale = 1;

  // ---- animation (sent to clients) ----
  action: MobAction = MobAction.Idle;
  /** Bumps when an action (re)starts: clients restart its animation. */
  actionSeq = 0;
  /** Seconds since the action started. */
  actionTime = 0;
  /** Expected action length (progress = actionTime / actionDur). */
  actionDur = 1;

  // ---- AI ----
  state: AiState = AiState.Idle;
  stateTime = 0;
  /** Seconds this state lasts (brains set it). */
  stateLength = 0;
  /** Player the mob is hunting (hostiles) or following (friendly), else null. */
  targetId: string | null = null;
  targetLostTime = 0;
  /** Thinks on ticks where tick % 4 === thinkSlot (5 Hz, staggered). */
  readonly thinkSlot: number;
  /** Think on the next tick regardless of the slot (hurt, attack ended). */
  thinkNow = false;
  path: PathResult | null = null;
  pathIndex = 0;
  pathPending = false;
  /** Sim time before which no new path is requested. */
  repathAt = 0;
  pathFails = 0;
  stuckTime = 0;
  lastProgressX = 0;
  lastProgressZ = 0;
  goalX = 0;
  goalY = 0;
  goalZ = 0;
  /** Steer straight at the goal (no path) until this sim time. */
  directUntil = 0;
  /** Attack cooldowns left (s): main and secondary (bite). */
  cooldown = 0;
  cooldown2 = 0;
  /** Brain scratch values (timers, flags, aim points); meaning depends on the brain. */
  t1 = 0;
  t2 = 0;
  t3 = 0;
  intent: MoveIntent = { vx: 0, vz: 0, jump: false, climb: false, vy: null, faceYaw: null };
  /** Speed multiplier from effects this tick (Slow). */
  speedMul = 1;
  /** Drying (Mudlurch in sun) or burning: clients show crumbs / embers. */
  drying = false;
  /** Cached open-sky answer for the mob's cell (refreshed every 20 ticks). */
  underSky = false;
  skyTick = -100;

  // ---- threat (friendly) and credit ----
  /** Who hit this mob last, and when (sim seconds). */
  lastHitBy: EntityRef | null = null;
  lastHitAt = -100;
  /** Sim time a panic ends. */
  panicUntil = 0;
  threatX = 0;
  threatZ = 0;

  // ---- lifecycle ----
  ageTicks = 0;
  dyingTicks = 0;
  /** Seconds without a player near (despawning). */
  idleFarTime = 0;
  /** Seconds spent in daylight without a player near (shade mobs) or fleeing (Duskwing). */
  sunTime = 0;
  /** Seconds since the last damage (Moss regeneration). */
  calmTime = 0;
  /** Contact/suffocation pulse timers. */
  contactTimer = 0;
  suffocateTimer = 0;
  home: { x: number; y: number; z: number } | null = null;
  /** Guards, minions and bosses never leave this box. */
  leash: Box3i | null = null;
  structureId = -1;
  guardIndex = -1;
  /** Minions: their boss's id; 0 otherwise. */
  bossId = 0;
  /** What killed it (MobDied cause). */
  deathCause = 0 as DamageKind;

  // ---- taming (friendly only) ----
  owner = '';
  name = '';
  /** Babies: seconds until grown. */
  growLeft = 0;
  /** Sim time love mode ends. */
  loveUntil = 0;
  /** Sim time breeding is allowed again. */
  breedCooldown = 0;

  // ---- lag tolerance: last HISTORY_LENGTH tick positions (x, y, z) ----
  readonly history = new Float32Array(HISTORY_LENGTH * 3);
  historyHead = 0;
  historyCount = 0;

  boss: BossController | null = null;

  constructor(
    readonly id: number,
    readonly kind: MobKind,
    readonly def: MobDef,
    x: number,
    y: number,
    z: number,
    variant: MobVariant,
    flags: number,
  ) {
    this.ref = { type: 'mob', id };
    this.team = def.team;
    this.x = x;
    this.y = y;
    this.z = z;
    this.variant = variant;
    this.flags = flags;
    this.halfWidth = def.halfWidth;
    this.height = def.height;
    this.maxHealth = def.maxHealth;
    this.health = def.maxHealth;
    this.armor = def.armor;
    this.knockbackResist = def.knockbackResist;
    this.thinkSlot = id % 4;
    if (def.category === MobCategory.Boss) this.immunity = 0.15;
    this.lastProgressX = x;
    this.lastProgressZ = z;
    this.goalX = x;
    this.goalY = y;
    this.goalZ = z;
  }

  has(flag: number): boolean {
    return (this.flags & flag) !== 0;
  }

  /** Feet-centred eye height (babies scaled). */
  get eyeY(): number {
    return this.y + this.def.eyeHeight * this.scale;
  }

  /** Starts an animation action (clients restart it when actionSeq changes). */
  setAction(action: MobAction, seconds = 1): void {
    this.action = action;
    this.actionSeq = (this.actionSeq + 1) & 15;
    this.actionTime = 0;
    this.actionDur = Math.max(0.05, seconds);
  }

  setState(state: AiState, seconds = 0): void {
    this.state = state;
    this.stateTime = 0;
    this.stateLength = seconds;
  }

  /** Records the current position in the lag-tolerance ring. */
  pushHistory(): void {
    const i = this.historyHead * 3;
    this.history[i] = this.x;
    this.history[i + 1] = this.y;
    this.history[i + 2] = this.z;
    this.historyHead = (this.historyHead + 1) % HISTORY_LENGTH;
    if (this.historyCount < HISTORY_LENGTH) this.historyCount++;
  }

  /** Position `ticksAgo` ticks back (1 = last tick); false when not recorded. */
  historyAt(ticksAgo: number, out: { x: number; y: number; z: number }): boolean {
    if (ticksAgo < 1 || ticksAgo > this.historyCount) return false;
    const i = ((this.historyHead - ticksAgo + HISTORY_LENGTH * 2) % HISTORY_LENGTH) * 3;
    out.x = this.history[i];
    out.y = this.history[i + 1];
    out.z = this.history[i + 2];
    return true;
  }
}

/** What the sim does in a mode (rulesForMode). */
export interface MobRules {
  friendly: boolean;
  hostile: boolean;
  bosses: boolean;
  taming: boolean;
  /** Mob damage multiplier (sandbox 0: creatures never hurt anyone there). */
  damageMul: number;
  /** Feeding takes the item from the player's hand (survival). */
  consumeFood: boolean;
}

export function rulesForMode(mode: VoxelMode, difficulty: 'peaceful' | 'normal' | 'hard' = 'normal'): MobRules {
  if (mode === 'survival') {
    const on = difficulty !== 'peaceful';
    return { friendly: true, hostile: on, bosses: on, taming: true, damageMul: difficulty === 'hard' ? 1.5 : 1, consumeFood: true };
  }
  if (mode === 'sandbox') return { friendly: true, hostile: false, bosses: false, taming: true, damageMul: 0, consumeFood: false };
  return { friendly: false, hostile: false, bosses: false, taming: false, damageMul: 0, consumeFood: false };
}

/** Population and work limits (the governor lowers them under load). */
export interface EntityCaps {
  /** Friendly + hostile spawned naturally, room-wide. */
  maxNatural: number;
  /** Within 48 blocks of one player. */
  friendlyPerPlayer: number;
  hostilePerPlayer: number;
  flyersPerPlayer: number;
  /** Not counted in maxNatural. */
  fishPerPlayer: number;
  /** Guards, minions and bosses on top of maxNatural. */
  maxExtra: number;
  maxProjectiles: number;
  maxHazards: number;
  /** A* expansions per tick. */
  pathBudget: number;
  /** Line-of-sight checks per tick (mobs over budget keep their previous answer). */
  losBudget: number;
  /** No spawns closer than this to any player (also 3D). */
  spawnMin: number;
  spawnMax: number;
  /** Removed at once beyond this from every player (tamed: dormant). */
  despawnDist: number;
  /** Mobs farther than this from every player stop thinking (physics continues). */
  simDist: number;
}

/**
 * Hostile caps were halved (12 -> 6 online, 10 -> 5 offline) so nights are
 * calmer; with the surface spawn attempt on every other pass only (Spawner),
 * night pressure is about half what it was.
 */
export const SERVER_CAPS: EntityCaps = {
  maxNatural: 40,
  friendlyPerPlayer: 10,
  hostilePerPlayer: 6,
  flyersPerPlayer: 2,
  fishPerPlayer: 4,
  maxExtra: 16,
  maxProjectiles: 96,
  maxHazards: 32,
  pathBudget: 600,
  losBudget: 48,
  spawnMin: 24,
  spawnMax: 40,
  despawnDist: 64,
  simDist: 56,
};

export const OFFLINE_CAPS: EntityCaps = {
  maxNatural: 28,
  friendlyPerPlayer: 8,
  hostilePerPlayer: 5,
  flyersPerPlayer: 1,
  fishPerPlayer: 3,
  maxExtra: 12,
  maxProjectiles: 48,
  maxHazards: 24,
  pathBudget: 300,
  losBudget: 24,
  spawnMin: 20,
  spawnMax: 40,
  despawnDist: 64,
  simDist: 56,
};

export const OFFLINE_LOW_CAPS: EntityCaps = {
  ...OFFLINE_CAPS,
  maxNatural: 20,
  friendlyPerPlayer: 6,
  hostilePerPlayer: 4,
  flyersPerPlayer: 1,
  fishPerPlayer: 2,
  maxHazards: 16,
  pathBudget: 200,
  losBudget: 16,
};

/**
 * What the creature sim needs from its owner (ServerEntities online,
 * LocalEntities offline). Players come in through PlayerHooks (api.ts).
 */
export interface EntityHost {
  /** Fast block reader; Block.Bedrock where the chunk is unavailable. */
  readonly getBlock: BlockQuery;
  /** Chunk data (with edits) is present for the column. Mobs in unavailable chunks freeze. */
  isAvailable(x: number, z: number): boolean;
  /** Server: queue generation of this chunk (time-budgeted). Offline: absent. */
  warm?(cx: number, cz: number): void;
  readonly generator: WorldGenerator;
  /** 0..1 (VoxelState.timeOfDay / Sky.time). */
  timeOfDay(): number;
  /** Gameplay world edit (boss altar). Online: applyServerEdit; offline: VoxelGame.applyWorldEdit. */
  setBlock(x: number, y: number, z: number, id: number): void;
  /** System chat online, HUD toast offline. */
  announce(text: string): void;
}

// ---- events -------------------------------------------------------------------------

/** u8 on the wire (V message); stable within a build. */
export enum EntityEventType {
  MobHurt = 1,
  MobDied = 2,
  MobAction = 3,
  Telegraph = 4,
  Burst = 5,
  ProjHit = 6,
  BossPhase = 7,
  BossAwake = 8,
  BossDefeated = 9,
  Tamed = 10,
  MobInfo = 11,
}

export enum BurstKind {
  Spores = 1,
  Slam = 2,
  Nova = 3,
  Emerge = 4,
  Seed = 5,
  Hail = 6,
  Rupture = 7,
  Impact = 8,
  Pulse = 9,
}

export enum TelegraphShape {
  Circle = 0,
  Ring = 1,
  Line = 2,
  Arc = 3,
  Marker = 4,
}

/** How a creature was tamed or fed (Tamed event). */
export const TameHow = { Fed: 1, Tamed: 2, Born: 3, Love: 4 } as const;

/**
 * One thing that happened during a step. Every event carries a position used
 * for routing (online: who receives it); events decoded from the wire whose
 * layout has no position carry NaN there.
 */
export type EntityEvent =
  | { type: EntityEventType.MobHurt; id: number; amount: number; crit: boolean; killed: boolean; attacker: EntityRef | null; x: number; y: number; z: number; byYou?: boolean }
  | { type: EntityEventType.MobDied; id: number; kind: MobKind; cause: DamageKind; x: number; y: number; z: number }
  | { type: EntityEventType.MobAction; id: number; action: MobAction; param: number; x: number; y: number; z: number }
  | {
      type: EntityEventType.Telegraph;
      bossId: number;
      shape: TelegraphShape;
      seconds: number;
      x: number;
      y: number;
      z: number;
      radius: number;
      width: number;
      yaw: number;
      halfAngle: number;
    }
  | { type: EntityEventType.Burst; kind: BurstKind; x: number; y: number; z: number; radius: number }
  | { type: EntityEventType.ProjHit; projId: number; projKind: number; what: 0 | 1 | 2; x: number; y: number; z: number }
  | { type: EntityEventType.BossPhase; id: number; phase: number; x: number; y: number; z: number }
  | { type: EntityEventType.BossAwake; id: number; kind: MobKind; structureId: number; x: number; y: number; z: number }
  | { type: EntityEventType.BossDefeated; id: number; kind: MobKind; structureId: number; x: number; y: number; z: number }
  | { type: EntityEventType.Tamed; id: number; how: number; x: number; y: number; z: number }
  | { type: EntityEventType.MobInfo; id: number; name: string; owner: string; x: number; y: number; z: number };

/** Result of feeding / naming (index = 'mr' result byte). */
export const INTERACT_RESULTS = ['none', 'fed', 'tamed', 'love', 'name', 'not-owner', 'cap'] as const;
export type InteractResult = (typeof INTERACT_RESULTS)[number];

/** A tamed creature as saved (MOBS section, offline JSON, dormant records). */
export interface SavedMob {
  kind: MobKind;
  variant: MobVariant;
  /** Only Baby | Tamed | Named are kept. */
  flags: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  /** Babies: seconds until grown (0 for adults). */
  growLeft: number;
  owner: string;
  name: string;
}

/** The friendly team helper: Neutral mobs are the friendly creatures. */
export const isFriendlyTeam = (t: Team): boolean => t === Team.Neutral;
