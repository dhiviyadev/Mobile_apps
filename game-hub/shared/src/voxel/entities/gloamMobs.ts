/**
 * The Gloamreach's creatures (package D): Lanternhorn, Bobblesnout and
 * Glimmerhare (friendly), Wispling (flies, slows), Shardback (climber),
 * Hushwalker (melee), Glintcaster (ranged), Murkpuff (swells and bursts) and
 * the Eclipse Colossus (boss). Numbers, drops and the realm's spawn tables;
 * defs.ts spreads GLOAM_MOB_DEFS into the roster. Names and designs are original.
 */
import { StatusKind, Team } from '../combat';
import { Biome } from '../worldgen/biomes';
import { ProjectileKind } from './api';
import type { DropDef, MobDef, SpawnEntry } from './defs';
import { MobCategory, MobKind } from './types';

const FRIENDLY = {
  category: MobCategory.Friendly,
  team: Team.Neutral,
  brain: 'friendly' as const,
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

const HOSTILE = {
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
  // The Gloamreach has no sun: nothing here dries, hides or flees at dawn.
  daylight: 'none' as const,
};

const BOSS = {
  category: MobCategory.Boss,
  team: Team.Hostile,
  brain: 'boss' as const,
  jumpVelocity: 0,
  maxDrop: 0,
  climb: false,
  fly: true,
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

export const GLOAM_MOB_DEFS = {
  [MobKind.Lanternhorn]: {
    ...FRIENDLY, kind: MobKind.Lanternhorn, key: 'lanternhorn', name: 'Lanternhorn',
    maxHealth: 14, halfWidth: 0.42, height: 1.75, eyeHeight: 1.6, wanderSpeed: 1.3, runSpeed: 4.6, jumpVelocity: 9,
    graze: true, herd: true,
    drops: [{ item: 'murk_pelt', min: 1, max: 2, chance: 1 }, { item: 'raw_meat', min: 1, max: 3, chance: 1 }, { item: 'glow_dust', min: 1, max: 1, chance: 0.3 }],
    likes: ['block:WispTuft', 'apple'], tameChance: 1 / 4,
    sounds: { idle: 'lanternhornIdle', hurt: 'lanternhornHurt', death: 'lanternhornDeath' }, idleEvery: [7, 14],
  },
  [MobKind.Bobblesnout]: {
    ...FRIENDLY, kind: MobKind.Bobblesnout, key: 'bobblesnout', name: 'Bobblesnout',
    maxHealth: 7, halfWidth: 0.3, height: 0.75, eyeHeight: 0.6, wanderSpeed: 1.2, runSpeed: 3.8, jumpVelocity: 7,
    graze: true, herd: true,
    drops: [{ item: 'raw_meat', min: 1, max: 1, chance: 1 }, { item: 'murk_pelt', min: 1, max: 1, chance: 0.4 }],
    likes: ['block:LumenBell', 'apple'], tameChance: 1 / 3,
    sounds: { idle: 'bobblesnoutIdle', hurt: 'bobblesnoutHurt', death: 'bobblesnoutDeath' }, idleEvery: [5, 11],
  },
  [MobKind.Glimmerhare]: {
    ...FRIENDLY, kind: MobKind.Glimmerhare, key: 'glimmerhare', name: 'Glimmerhare',
    maxHealth: 4, halfWidth: 0.24, height: 0.55, eyeHeight: 0.45, wanderSpeed: 2.0, runSpeed: 5.6, jumpVelocity: 7,
    hop: true,
    drops: [{ item: 'raw_meat', min: 1, max: 1, chance: 1 }, { item: 'glow_dust', min: 1, max: 1, chance: 0.5 }],
    likes: ['block:GlimmerCluster', 'block:LumenBell'], tameChance: 1 / 3,
    sounds: { idle: 'glimmerhareIdle', hurt: 'glimmerhareHurt', death: 'glimmerhareDeath' }, idleEvery: [6, 14],
  },
  [MobKind.Wispling]: {
    ...HOSTILE, kind: MobKind.Wispling, key: 'wispling', name: 'Wispling', brain: 'flyer' as const,
    maxHealth: 9, halfWidth: 0.3, height: 0.6, eyeHeight: 0.4, wanderSpeed: 5, runSpeed: 8.5,
    fly: true, fallImmune: true, noAutoJump: true,
    attack: { type: 'swoop' as const, damage: 2, reach: 1.0, windup: 0, cooldown: 3, knockback: 2, lift: 1.5, effects: [{ kind: StatusKind.Slow, strength: 0.35, seconds: 2.5 }] },
    aggroRange: 22, loseRange: 38,
    drops: [{ item: 'wisp_dust', min: 1, max: 2, chance: 0.8 }, { item: 'glow_dust', min: 1, max: 1, chance: 0.3 }],
    sounds: { idle: 'wisplingIdle', hurt: 'wisplingHurt', death: 'wisplingDeath', attack: 'wisplingAttack' }, idleEvery: [3, 8],
  },
  [MobKind.Shardback]: {
    ...HOSTILE, kind: MobKind.Shardback, key: 'shardback', name: 'Shardback', brain: 'climber' as const,
    maxHealth: 18, armor: 4, knockbackResist: 0.2, halfWidth: 0.45, height: 0.75, eyeHeight: 0.5, wanderSpeed: 2.0, runSpeed: 4.4,
    maxDrop: 5, climb: true,
    attack: { type: 'lunge' as const, damage: 3, reach: 1.0, windup: 0.3, cooldown: 1.8, knockback: 4, lift: 2, speed: 7.5, range: [2.5, 5] as [number, number] },
    attack2: { type: 'melee' as const, damage: 2, reach: 1.2, windup: 0.25, cooldown: 1.0, knockback: 2.5, lift: 2 },
    aggroRange: 18, loseRange: 30,
    drops: [{ item: 'prism_shard', min: 1, max: 2, chance: 0.7 }, { item: 'bone', min: 1, max: 1, chance: 0.2 }],
    sounds: { idle: 'shardbackIdle', hurt: 'shardbackHurt', death: 'shardbackDeath', attack: 'shardbackLunge' }, idleEvery: [4, 9],
  },
  [MobKind.Hushwalker]: {
    ...HOSTILE, kind: MobKind.Hushwalker, key: 'hushwalker', name: 'Hushwalker', brain: 'melee' as const,
    maxHealth: 24, armor: 1, halfWidth: 0.3, height: 2.1, eyeHeight: 1.85, wanderSpeed: 1.5, runSpeed: 3.5,
    attack: { type: 'melee' as const, damage: 4, reach: 1.9, windup: 0.5, cooldown: 1.3, knockback: 4, lift: 3 },
    aggroRange: 18, loseRange: 30,
    drops: [{ item: 'murk_pelt', min: 1, max: 2, chance: 0.8 }, { item: 'wisp_dust', min: 1, max: 1, chance: 0.3 }, { item: 'iron_ingot', min: 1, max: 1, chance: 0.04 }],
    sounds: { idle: 'hushwalkerIdle', hurt: 'hushwalkerHurt', death: 'hushwalkerDeath', attack: 'hushwalkerSwing' }, idleEvery: [6, 13],
  },
  [MobKind.Glintcaster]: {
    ...HOSTILE, kind: MobKind.Glintcaster, key: 'glintcaster', name: 'Glintcaster', brain: 'ranged' as const,
    maxHealth: 15, halfWidth: 0.3, height: 1.9, eyeHeight: 1.65, wanderSpeed: 1.5, runSpeed: 3.3,
    attack: { type: 'ranged' as const, damage: 3, reach: 15, windup: 0.9, cooldown: 2.4, knockback: 2, lift: 1.5, projectile: ProjectileKind.GlintBolt, speed: 20, range: [8, 15] as [number, number] },
    aggroRange: 24, loseRange: 36,
    drops: [{ item: 'prism_shard', min: 1, max: 2, chance: 0.8 }, { item: 'wisp_dust', min: 1, max: 1, chance: 0.4 }, { item: 'starfall_shard', min: 1, max: 1, chance: 0.04 }],
    sounds: { idle: 'glintcasterIdle', hurt: 'glintcasterHurt', death: 'glintcasterDeath', attack: 'glintcasterCast' }, idleEvery: [5, 11],
  },
  [MobKind.Murkpuff]: {
    ...HOSTILE, kind: MobKind.Murkpuff, key: 'murkpuff', name: 'Murkpuff', brain: 'burster' as const,
    maxHealth: 12, halfWidth: 0.38, height: 1.25, eyeHeight: 0.9, wanderSpeed: 1.0, runSpeed: 2.8,
    attack: { type: 'burst' as const, damage: 6, reach: 2.5, windup: 1.4, cooldown: 2, knockback: 8, lift: 5, radius: 3.5, range: [2.5, 4] as [number, number], effects: [{ kind: StatusKind.Slow, strength: 0.4, seconds: 3 }] },
    aggroRange: 16, loseRange: 24,
    drops: [{ item: 'wisp_dust', min: 1, max: 2, chance: 0.7 }, { item: 'block:GlimmerCluster', min: 1, max: 1, chance: 0.35 }],
    sounds: { idle: 'murkpuffIdle', hurt: 'murkpuffHurt', death: 'murkpuffDeath', attack: 'murkpuffSwell' }, idleEvery: [5, 12],
  },
  [MobKind.EclipseColossus]: {
    ...BOSS, kind: MobKind.EclipseColossus, key: 'eclipse-colossus', name: 'Eclipse Colossus',
    maxHealth: 420, armor: 5, knockbackResist: 0.92, halfWidth: 1.0, height: 3.9, eyeHeight: 3.2, wanderSpeed: 2.2, runSpeed: 2.2,
    fireImmune: true,
    sounds: { idle: 'bossStep', hurt: 'colossusHurt', death: 'colossusDefeat' },
  },
} satisfies Partial<Record<MobKind, MobDef>>;

export const GLOAM_BOSS_DROPS = {
  [MobKind.EclipseColossus]: {
    unique: 'eclipse_glaive',
    fallback: 'starfall_sword',
    rest: [{ item: 'starfall_ingot', min: 3, max: 5, chance: 1 }, { item: 'cobalt_gem', min: 2, max: 3, chance: 1 }, { item: 'prism_shard', min: 4, max: 8, chance: 1 }],
  },
};

// ---- spawn tables -----------------------------------------------------------------------------

const fg = (kind: MobKind, weight: number, min: number, max: number): SpawnEntry => ({ kind, weight, min, max });

/** Friendly spawns per Gloamreach biome (they graze on moss, soil and shardsand at any hour: there is no day). */
export const GLOAM_FRIENDLY_SPAWNS: Partial<Record<Biome, SpawnEntry[]>> = {
  [Biome.LumenShelves]: [fg(MobKind.Lanternhorn, 35, 2, 4), fg(MobKind.Bobblesnout, 30, 2, 3), fg(MobKind.Glimmerhare, 25, 1, 3)],
  [Biome.PrismThicket]: [fg(MobKind.Glimmerhare, 35, 2, 3), fg(MobKind.Bobblesnout, 25, 1, 3), fg(MobKind.Lanternhorn, 15, 1, 2)],
  [Biome.HushHollows]: [fg(MobKind.Bobblesnout, 15, 1, 2)],
  [Biome.MirrorFen]: [fg(MobKind.Lanternhorn, 35, 2, 4), fg(MobKind.Bobblesnout, 30, 2, 4)],
  [Biome.SpireFields]: [fg(MobKind.Glimmerhare, 15, 1, 2)],
};

const hs = (kind: MobKind, weight: number, min: number, max: number): SpawnEntry => ({ kind, weight, min, max });

/** Hostile spawns in the Gloamreach by biome (surface and caves alike: it is always dusk). */
export function gloamHostileTable(biome: Biome, cave: boolean): SpawnEntry[] {
  const fen = biome === Biome.MirrorFen;
  const thicket = biome === Biome.PrismThicket;
  const spires = biome === Biome.SpireFields;
  return [
    hs(MobKind.Hushwalker, spires ? 38 : 30, 1, 2),
    hs(MobKind.Glintcaster, thicket ? 28 : spires ? 20 : 16, 1, 2),
    hs(MobKind.Shardback, cave || thicket ? 32 : 18, 1, 2),
    hs(MobKind.Murkpuff, fen ? 30 : 12, 1, 1),
    ...(cave ? [] : [hs(MobKind.Wispling, fen ? 26 : 16, 1, 2)]),
  ];
}

/** Sky light the realm counts as for spawning (dusk: dark enough everywhere, still lit near lamps). */
export const GLOAM_SKY_LEVEL = 3;
