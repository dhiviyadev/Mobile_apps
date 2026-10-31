/**
 * The creature roster (design-voxel-mobs §5): numbers, drops, likes, variants
 * and the biome spawn tables. All names and designs are original.
 */
import type { StatusEffect } from '../combat';
import { Team } from '../combat';
import { StatusKind } from '../combat';
import { Biome } from '../worldgen';
import { ProjectileKind } from './api';
import { MobCategory, MobKind, MobVariant } from './types';

export interface AttackDef {
  type: 'melee' | 'ranged' | 'lunge' | 'burst' | 'swoop';
  damage: number;
  reach: number;
  windup: number;
  cooldown: number;
  knockback: number;
  lift: number;
  projectile?: ProjectileKind;
  speed?: number;
  /** Preferred distance band (ranged, lunge). */
  range?: [number, number];
  /** Burst radius. */
  radius?: number;
  effects?: StatusEffect[];
}

export interface DropDef {
  item: string;
  min: number;
  max: number;
  chance: number;
}

export type BrainKind = 'friendly' | 'fish' | 'melee' | 'ranged' | 'climber' | 'burster' | 'flyer' | 'boss';

export interface MobDef {
  kind: MobKind;
  /** Stable key (dev hooks, logs): 'woolback', 'sunforged-sentinel'. */
  key: string;
  name: string;
  category: MobCategory;
  team: Team;
  brain: BrainKind;
  maxHealth: number;
  armor: number;
  knockbackResist: number;
  halfWidth: number;
  height: number;
  eyeHeight: number;
  wanderSpeed: number;
  runSpeed: number;
  jumpVelocity: number;
  maxDrop: number;
  climb: boolean;
  fly: boolean;
  swim: 'float' | 'fish' | 'sink';
  fallImmune: boolean;
  fireImmune: boolean;
  noAutoJump: boolean;
  /** Moves only by hops (Hopling). */
  hop?: boolean;
  /** Falls at most 3 b/s (Cluckit). */
  flutter?: boolean;
  /** Woolback / Fernhart / Cluckit graze or peck while idle. */
  graze?: boolean;
  /** Panic spreads to same-kind mobs within 8 (herds). */
  herd?: boolean;
  /** Flees from any non-crouching player within 10 (Fernhart). */
  skittish?: boolean;
  attack: AttackDef | null;
  /** Cragcrawler bite (close range). */
  attack2?: AttackDef;
  aggroRange: number;
  loseRange: number;
  daylight: 'none' | 'dry' | 'shade' | 'flee';
  drops: DropDef[];
  /** Item keys that tempt and tame it (empty = not tamable). */
  likes: string[];
  tameChance: number;
  sounds: { idle: string; hurt: string; death: string; attack?: string };
  /** Seconds between idle sounds (client timer). */
  idleEvery: [number, number];
}

const FRIENDLY_BASE = {
  category: MobCategory.Friendly,
  team: Team.Neutral,
  brain: 'friendly' as BrainKind,
  armor: 0,
  knockbackResist: 0,
  maxDrop: 2,
  climb: false,
  fly: false,
  swim: 'float' as const,
  fallImmune: false,
  fireImmune: false,
  noAutoJump: false,
  attack: null,
  aggroRange: 0,
  loseRange: 0,
  daylight: 'none' as const,
};

const HOSTILE_BASE = {
  category: MobCategory.Hostile,
  team: Team.Hostile,
  armor: 0,
  knockbackResist: 0,
  jumpVelocity: 8.4,
  maxDrop: 3,
  climb: false,
  fly: false,
  swim: 'float' as const,
  fallImmune: false,
  fireImmune: false,
  noAutoJump: false,
  likes: [] as string[],
  tameChance: 0,
};

const BOSS_BASE = {
  category: MobCategory.Boss,
  team: Team.Hostile,
  brain: 'boss' as BrainKind,
  jumpVelocity: 0,
  maxDrop: 0,
  climb: false,
  fly: false,
  swim: 'sink' as const,
  fallImmune: true,
  noAutoJump: true,
  attack: null,
  aggroRange: 0,
  loseRange: 0,
  daylight: 'none' as const,
  drops: [] as DropDef[],
  likes: [] as string[],
  tameChance: 0,
  idleEvery: [6, 12] as [number, number],
};

export const MOB_DEFS: Readonly<Record<MobKind, MobDef>> = {
  [MobKind.Woolback]: {
    ...FRIENDLY_BASE, kind: MobKind.Woolback, key: 'woolback', name: 'Woolback',
    maxHealth: 10, halfWidth: 0.45, height: 1.3, eyeHeight: 1.0, wanderSpeed: 1.2, runSpeed: 3.6, jumpVelocity: 8.4,
    graze: true, herd: true,
    drops: [{ item: 'fleece', min: 1, max: 2, chance: 1 }, { item: 'raw_meat', min: 1, max: 2, chance: 1 }],
    likes: ['block:HayBale', 'block:TallGrass'], tameChance: 1 / 3,
    sounds: { idle: 'woolbackIdle', hurt: 'woolbackHurt', death: 'woolbackDeath' }, idleEvery: [5, 12],
  },
  [MobKind.Hopling]: {
    ...FRIENDLY_BASE, kind: MobKind.Hopling, key: 'hopling', name: 'Hopling',
    maxHealth: 4, halfWidth: 0.25, height: 0.55, eyeHeight: 0.45, wanderSpeed: 2.0, runSpeed: 5.5, jumpVelocity: 7.0,
    hop: true,
    drops: [{ item: 'raw_meat', min: 1, max: 1, chance: 1 }, { item: 'hide', min: 1, max: 1, chance: 0.4 }],
    likes: ['block:Sunpetal', 'apple'], tameChance: 1 / 3,
    sounds: { idle: 'hoplingIdle', hurt: 'hoplingHurt', death: 'hoplingDeath' }, idleEvery: [6, 14],
  },
  [MobKind.Cluckit]: {
    ...FRIENDLY_BASE, kind: MobKind.Cluckit, key: 'cluckit', name: 'Cluckit',
    maxHealth: 4, halfWidth: 0.22, height: 0.7, eyeHeight: 0.62, wanderSpeed: 1.0, runSpeed: 3.2, jumpVelocity: 6.0,
    flutter: true, fallImmune: true, graze: true, herd: true,
    drops: [{ item: 'feather', min: 1, max: 2, chance: 1 }, { item: 'raw_meat', min: 1, max: 1, chance: 1 }],
    likes: ['bread', 'block:TallGrass'], tameChance: 1 / 3,
    sounds: { idle: 'cluckitIdle', hurt: 'cluckitHurt', death: 'cluckitDeath' }, idleEvery: [4, 10],
  },
  [MobKind.Fernhart]: {
    ...FRIENDLY_BASE, kind: MobKind.Fernhart, key: 'fernhart', name: 'Fernhart',
    maxHealth: 12, halfWidth: 0.4, height: 1.6, eyeHeight: 1.5, wanderSpeed: 1.4, runSpeed: 6.0, jumpVelocity: 9.5,
    graze: true, skittish: true,
    drops: [{ item: 'hide', min: 1, max: 2, chance: 1 }, { item: 'raw_meat', min: 1, max: 3, chance: 1 }],
    likes: ['apple'], tameChance: 1 / 5,
    sounds: { idle: 'fernhartIdle', hurt: 'fernhartHurt', death: 'fernhartDeath' }, idleEvery: [8, 16],
  },
  [MobKind.Glimmerfin]: {
    ...FRIENDLY_BASE, kind: MobKind.Glimmerfin, key: 'glimmerfin', name: 'Glimmerfin', brain: 'fish',
    maxHealth: 3, halfWidth: 0.25, height: 0.35, eyeHeight: 0.2, wanderSpeed: 2.2, runSpeed: 4.5, jumpVelocity: 4,
    swim: 'fish', noAutoJump: true, fallImmune: true,
    drops: [{ item: 'raw_fish', min: 1, max: 1, chance: 1 }],
    likes: [], tameChance: 0,
    sounds: { idle: 'fishIdle', hurt: 'fishHurt', death: 'fishDeath' }, idleEvery: [6, 14],
  },
  [MobKind.Mudlurch]: {
    ...HOSTILE_BASE, kind: MobKind.Mudlurch, key: 'mudlurch', name: 'Mudlurch', brain: 'melee',
    maxHealth: 20, armor: 2, halfWidth: 0.3, height: 1.9, eyeHeight: 1.6, wanderSpeed: 1.6, runSpeed: 3.6,
    attack: { type: 'melee', damage: 3, reach: 1.6, windup: 0.4, cooldown: 1.1, knockback: 4.5, lift: 3.5 },
    aggroRange: 20, loseRange: 32, daylight: 'dry',
    drops: [{ item: 'block:Mud', min: 1, max: 2, chance: 1 }, { item: 'coal', min: 1, max: 1, chance: 0.35 }, { item: 'iron_ingot', min: 1, max: 1, chance: 0.03 }],
    sounds: { idle: 'mudlurchIdle', hurt: 'mudlurchHurt', death: 'mudlurchDeath', attack: 'mudlurchSwing' }, idleEvery: [5, 11],
  },
  [MobKind.Rattlebow]: {
    ...HOSTILE_BASE, kind: MobKind.Rattlebow, key: 'rattlebow', name: 'Rattlebow', brain: 'ranged',
    maxHealth: 16, halfWidth: 0.3, height: 1.9, eyeHeight: 1.65, wanderSpeed: 1.6, runSpeed: 3.4,
    attack: { type: 'ranged', damage: 3, reach: 14, windup: 0.9, cooldown: 2.2, knockback: 2.5, lift: 1.5, projectile: ProjectileKind.MobArrow, speed: 22, range: [7, 14] },
    aggroRange: 24, loseRange: 36, daylight: 'shade',
    drops: [{ item: 'bone', min: 1, max: 2, chance: 1 }, { item: 'arrow', min: 0, max: 3, chance: 1 }, { item: 'bow', min: 1, max: 1, chance: 0.04 }],
    sounds: { idle: 'rattlebowIdle', hurt: 'rattlebowHurt', death: 'rattlebowDeath', attack: 'mobShoot' }, idleEvery: [5, 11],
  },
  [MobKind.Cragcrawler]: {
    ...HOSTILE_BASE, kind: MobKind.Cragcrawler, key: 'cragcrawler', name: 'Cragcrawler', brain: 'climber',
    maxHealth: 14, armor: 3, knockbackResist: 0.2, halfWidth: 0.45, height: 0.7, eyeHeight: 0.5, wanderSpeed: 2.0, runSpeed: 4.2,
    maxDrop: 5, climb: true,
    attack: { type: 'lunge', damage: 3, reach: 1.0, windup: 0.3, cooldown: 1.8, knockback: 4, lift: 2, speed: 7.5, range: [2.5, 5] },
    attack2: { type: 'melee', damage: 2, reach: 1.2, windup: 0.25, cooldown: 1.0, knockback: 2.5, lift: 2 },
    aggroRange: 18, loseRange: 30, daylight: 'shade',
    drops: [{ item: 'silk', min: 1, max: 2, chance: 0.7 }, { item: 'bone', min: 1, max: 1, chance: 0.2 }],
    sounds: { idle: 'crawlerIdle', hurt: 'crawlerHurt', death: 'crawlerDeath', attack: 'crawlerLunge' }, idleEvery: [4, 9],
  },
  [MobKind.Puffcap]: {
    ...HOSTILE_BASE, kind: MobKind.Puffcap, key: 'puffcap', name: 'Puffcap', brain: 'burster',
    maxHealth: 12, halfWidth: 0.35, height: 1.2, eyeHeight: 0.9, wanderSpeed: 1.0, runSpeed: 2.8,
    attack: { type: 'burst', damage: 7, reach: 2.5, windup: 1.4, cooldown: 2, knockback: 8, lift: 5, radius: 3.5, range: [2.5, 4] },
    aggroRange: 16, loseRange: 24, daylight: 'shade',
    drops: [{ item: 'block:RedMushroom', min: 1, max: 2, chance: 1 }, { item: 'block:Duskcap', min: 1, max: 1, chance: 0.25 }],
    sounds: { idle: 'puffcapIdle', hurt: 'puffcapHurt', death: 'puffcapDeath', attack: 'puffInflate' }, idleEvery: [5, 12],
  },
  [MobKind.Duskwing]: {
    ...HOSTILE_BASE, kind: MobKind.Duskwing, key: 'duskwing', name: 'Duskwing', brain: 'flyer',
    maxHealth: 8, halfWidth: 0.4, height: 0.6, eyeHeight: 0.3, wanderSpeed: 6, runSpeed: 9,
    fly: true, fallImmune: true, noAutoJump: true,
    attack: { type: 'swoop', damage: 2, reach: 1.0, windup: 0, cooldown: 3, knockback: 2, lift: 1.5 },
    aggroRange: 24, loseRange: 40, daylight: 'flee',
    drops: [{ item: 'feather', min: 1, max: 2, chance: 0.6 }, { item: 'glow_dust', min: 1, max: 1, chance: 0.4 }],
    sounds: { idle: 'duskwingIdle', hurt: 'duskwingHurt', death: 'duskwingDeath', attack: 'duskwingAttack' }, idleEvery: [3, 7],
  },
  [MobKind.SunforgedSentinel]: {
    ...BOSS_BASE, kind: MobKind.SunforgedSentinel, key: 'sunforged-sentinel', name: 'Sunforged Sentinel',
    maxHealth: 300, armor: 4, knockbackResist: 0.9, halfWidth: 0.8, height: 3.2, eyeHeight: 2.9, wanderSpeed: 2.6, runSpeed: 2.6,
    fireImmune: true,
    sounds: { idle: 'bossStep', hurt: 'bossHurt', death: 'bossDefeat' },
  },
  [MobKind.RimeWarden]: {
    ...BOSS_BASE, kind: MobKind.RimeWarden, key: 'rime-warden', name: 'Rime Warden',
    maxHealth: 260, armor: 3, knockbackResist: 1, halfWidth: 0.6, height: 2.8, eyeHeight: 2.6, wanderSpeed: 2.2, runSpeed: 2.2,
    fly: true, fireImmune: false,
    sounds: { idle: 'shardWhoosh', hurt: 'bossHurt', death: 'bossDefeat' },
  },
  [MobKind.Thornmaw]: {
    ...BOSS_BASE, kind: MobKind.Thornmaw, key: 'thornmaw', name: 'Thornmaw',
    maxHealth: 320, armor: 2, knockbackResist: 1, halfWidth: 1.2, height: 3.0, eyeHeight: 2.4, wanderSpeed: 0, runSpeed: 0,
    fireImmune: false,
    sounds: { idle: 'vineLash', hurt: 'bossHurt', death: 'bossDefeat' },
  },
  [MobKind.AshenKnight]: {
    ...BOSS_BASE, kind: MobKind.AshenKnight, key: 'ashen-knight', name: 'Ashen Knight',
    maxHealth: 340, armor: 6, knockbackResist: 0.85, halfWidth: 0.7, height: 2.9, eyeHeight: 2.6, wanderSpeed: 2.4, runSpeed: 2.4,
    fireImmune: true,
    sounds: { idle: 'bossStep', hurt: 'bossHurt', death: 'bossDefeat' },
  },
};

export const ALL_MOB_KINDS: readonly MobKind[] = Object.keys(MOB_DEFS).map(Number) as MobKind[];
export const BOSS_KINDS: readonly MobKind[] = [MobKind.SunforgedSentinel, MobKind.RimeWarden, MobKind.Thornmaw, MobKind.AshenKnight];

export function mobDef(kind: MobKind): MobDef {
  return MOB_DEFS[kind];
}

export function isMobKind(v: unknown): v is MobKind {
  return typeof v === 'number' && MOB_DEFS[v as MobKind] !== undefined;
}

/** 'woolback' -> MobKind.Woolback (dev hooks, tests). */
export function mobKindFromKey(key: string): MobKind | null {
  for (const k of ALL_MOB_KINDS) if (MOB_DEFS[k].key === key) return k;
  return null;
}

export const isFriendlyKind = (k: MobKind): boolean => MOB_DEFS[k]?.category === MobCategory.Friendly;
export const isHostileKind = (k: MobKind): boolean => MOB_DEFS[k]?.category === MobCategory.Hostile;
export const isBossKind = (k: MobKind): boolean => MOB_DEFS[k]?.category === MobCategory.Boss;

/** Which kinds a variant applies to (others stay Default). */
const VARIANT_KINDS: Record<MobVariant, readonly MobKind[]> = {
  [MobVariant.Default]: [],
  [MobVariant.Sand]: [MobKind.Woolback, MobKind.Hopling, MobKind.Mudlurch, MobKind.Rattlebow],
  [MobVariant.Frost]: [MobKind.Woolback, MobKind.Hopling, MobKind.Fernhart, MobKind.Glimmerfin, MobKind.Mudlurch, MobKind.Rattlebow, MobKind.Cragcrawler],
  [MobVariant.Moss]: [MobKind.Mudlurch, MobKind.Puffcap, MobKind.Cragcrawler],
  [MobVariant.Ash]: [MobKind.Mudlurch, MobKind.Rattlebow, MobKind.Cragcrawler],
  [MobVariant.Tropical]: [MobKind.Cluckit],
};

export function variantAllowed(kind: MobKind, v: MobVariant): MobVariant {
  return VARIANT_KINDS[v]?.includes(kind) ? v : MobVariant.Default;
}

export const VARIANT_NAMES: Record<MobVariant, string> = {
  [MobVariant.Default]: '',
  [MobVariant.Sand]: 'Sand',
  [MobVariant.Frost]: 'Frost',
  [MobVariant.Moss]: 'Moss',
  [MobVariant.Ash]: 'Ash',
  [MobVariant.Tropical]: 'Tropical',
};

const FROST_BIOMES = new Set<number>([Biome.Snow, Biome.Frostpine, Biome.GlacierPeaks, Biome.IcySea, Biome.FrozenShore]);
const SAND_BIOMES = new Set<number>([Biome.Desert, Biome.Redrock, Biome.Savanna]);
const WET_BIOMES = new Set<number>([Biome.Marshland, Biome.Rainforest]);
const MOSS_BIOMES = new Set<number>([Biome.Marshland, Biome.Rainforest, Biome.Duskwood]);

/** Variant for a natural spawn by biome (and deep caves for hostiles: Ash at 50%). */
export function variantFor(kind: MobKind, biome: Biome, y: number, rnd: () => number): MobVariant {
  let v = MobVariant.Default;
  if (FROST_BIOMES.has(biome)) v = MobVariant.Frost;
  else if (SAND_BIOMES.has(biome)) v = kind === MobKind.Cluckit ? MobVariant.Default : MobVariant.Sand;
  else if (WET_BIOMES.has(biome) && kind === MobKind.Cluckit) v = MobVariant.Tropical;
  else if (MOSS_BIOMES.has(biome) && isHostileKind(kind)) v = MobVariant.Moss;
  if (isHostileKind(kind) && y <= 12 && rnd() < 0.5) v = MobVariant.Ash;
  return variantAllowed(kind, v);
}

/** Display name: 'Frost Mudlurch', 'Baby Woolback', a tamed creature's given name. */
export function displayName(kind: MobKind, variant: MobVariant, baby: boolean, name: string): string {
  if (name) return name;
  const def = MOB_DEFS[kind];
  const prefix = def.category === MobCategory.Hostile ? VARIANT_NAMES[variant] : '';
  return `${baby ? 'Baby ' : ''}${prefix ? `${prefix} ` : ''}${def.name}`;
}

// ---- spawn tables (§6.3) ----

export interface SpawnEntry {
  kind: MobKind;
  weight: number;
  min: number;
  max: number;
}

const GROUP: Partial<Record<MobKind, [number, number]>> = {
  [MobKind.Woolback]: [2, 4],
  [MobKind.Cluckit]: [2, 4],
  [MobKind.Hopling]: [1, 3],
  [MobKind.Fernhart]: [1, 3],
};
const f = (kind: MobKind, weight: number): SpawnEntry => ({ kind, weight, min: GROUP[kind]![0], max: GROUP[kind]![1] });

/** Friendly spawn table per biome id (Ocean and IcySea: fish only). */
export const FRIENDLY_SPAWNS: Partial<Record<Biome, SpawnEntry[]>> = {
  [Biome.Plains]: [f(MobKind.Woolback, 35), f(MobKind.Cluckit, 30), f(MobKind.Hopling, 25)],
  [Biome.Forest]: [f(MobKind.Fernhart, 30), f(MobKind.Hopling, 25), f(MobKind.Cluckit, 20), f(MobKind.Woolback, 15)],
  [Biome.AspenGrove]: [f(MobKind.Fernhart, 35), f(MobKind.Hopling, 30), f(MobKind.Woolback, 20)],
  [Biome.Duskwood]: [f(MobKind.Fernhart, 30), f(MobKind.Hopling, 20)],
  [Biome.Pinewood]: [f(MobKind.Fernhart, 35), f(MobKind.Woolback, 25), f(MobKind.Hopling, 20)],
  [Biome.Frostpine]: [f(MobKind.Fernhart, 30), f(MobKind.Hopling, 30)],
  [Biome.Snow]: [f(MobKind.Woolback, 35), f(MobKind.Hopling, 30)],
  [Biome.GlacierPeaks]: [f(MobKind.Hopling, 15)],
  [Biome.Savanna]: [f(MobKind.Woolback, 30), f(MobKind.Cluckit, 30), f(MobKind.Hopling, 20)],
  [Biome.Desert]: [f(MobKind.Hopling, 25)],
  [Biome.Redrock]: [f(MobKind.Hopling, 15)],
  [Biome.Marshland]: [f(MobKind.Cluckit, 30), f(MobKind.Hopling, 15)],
  [Biome.Rainforest]: [f(MobKind.Cluckit, 40), f(MobKind.Fernhart, 20)],
  [Biome.Mountains]: [f(MobKind.Woolback, 40), f(MobKind.Hopling, 20)],
  [Biome.Beach]: [f(MobKind.Cluckit, 15)],
  [Biome.FrozenShore]: [f(MobKind.Cluckit, 15)],
};

export const FISH_BIOMES = new Set<number>([Biome.Ocean, Biome.Beach, Biome.Marshland, Biome.Rainforest, Biome.IcySea, Biome.FrozenShore]);

export function hostileSurfaceTable(biome: Biome): SpawnEntry[] {
  const puff = MOSS_BIOMES.has(biome) ? 26 : 13;
  return [
    { kind: MobKind.Mudlurch, weight: 40, min: 1, max: 3 },
    { kind: MobKind.Rattlebow, weight: 25, min: 1, max: 2 },
    { kind: MobKind.Cragcrawler, weight: 12, min: 1, max: 2 },
    { kind: MobKind.Puffcap, weight: puff, min: 1, max: 1 },
    { kind: MobKind.Duskwing, weight: 10, min: 1, max: 2 },
  ];
}

export function hostileCaveTable(nearDuskcap: boolean): SpawnEntry[] {
  return [
    { kind: MobKind.Cragcrawler, weight: 35, min: 1, max: 2 },
    { kind: MobKind.Rattlebow, weight: 25, min: 1, max: 2 },
    { kind: MobKind.Mudlurch, weight: 25, min: 1, max: 3 },
    { kind: MobKind.Puffcap, weight: nearDuskcap ? 30 : 15, min: 1, max: 1 },
  ];
}

export function pickWeighted<T extends { weight: number }>(list: readonly T[], rnd: () => number): T | null {
  let total = 0;
  for (const e of list) total += e.weight;
  if (total <= 0) return null;
  let r = rnd() * total;
  for (const e of list) {
    r -= e.weight;
    if (r < 0) return e;
  }
  return list[list.length - 1];
}

/** Frost hostile hits slow; Ash hostile hits burn (§5.5). */
export function variantHitEffects(v: MobVariant): StatusEffect[] | undefined {
  if (v === MobVariant.Frost) return [{ kind: StatusKind.Slow, strength: 0.3, seconds: 2 }];
  if (v === MobVariant.Ash) return [{ kind: StatusKind.Burn, strength: 1, seconds: 2 }];
  return undefined;
}

/** Boss drops (§7.7): the unique once per participant (max 4), the rest once. */
export interface BossDrops {
  unique: string;
  fallback: string;
  rest: DropDef[];
}

export const BOSS_DROPS: Partial<Record<MobKind, BossDrops>> = {
  [MobKind.SunforgedSentinel]: { unique: 'sunforged_sword', fallback: 'cobalt_sword', rest: [{ item: 'gold_ingot', min: 4, max: 8, chance: 1 }, { item: 'cobalt_gem', min: 2, max: 3, chance: 1 }] },
  [MobKind.RimeWarden]: { unique: 'rimebound_crossbow', fallback: 'cobalt_crossbow', rest: [{ item: 'iron_ingot', min: 6, max: 10, chance: 1 }, { item: 'cobalt_gem', min: 2, max: 3, chance: 1 }, { item: 'bolt', min: 16, max: 24, chance: 1 }] },
  [MobKind.Thornmaw]: { unique: 'thornheart_bow', fallback: 'bow', rest: [{ item: 'arrow', min: 24, max: 32, chance: 1 }, { item: 'cobalt_gem', min: 2, max: 3, chance: 1 }, { item: 'block:Melon', min: 2, max: 2, chance: 1 }] },
  [MobKind.AshenKnight]: { unique: 'ashen_axe', fallback: 'cobalt_axe', rest: [{ item: 'ember_shard', min: 2, max: 3, chance: 1 }, { item: 'cobalt_gem', min: 2, max: 3, chance: 1 }] },
};

/** Every item key creatures can emit or like (survival's key-resolution test). */
export function mobItemKeys(): string[] {
  const keys = new Set<string>();
  for (const k of ALL_MOB_KINDS) {
    for (const d of MOB_DEFS[k].drops) keys.add(d.item);
    for (const l of MOB_DEFS[k].likes) keys.add(l);
  }
  for (const b of Object.values(BOSS_DROPS)) {
    if (!b) continue;
    keys.add(b.unique);
    for (const d of b.rest) keys.add(d.item);
  }
  return [...keys];
}
