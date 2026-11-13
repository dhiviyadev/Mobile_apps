/**
 * Where the rare boss structures go. The 1024x1024 world is cut into 16 regions
 * of 256x256; each region rolls once (75%) for at most one structure, whose type
 * follows the biome at its anchor. A second pass tops a world up to 6. Every
 * world gets 6..16, at least 96 blocks from spawn and never overlapping
 * (design-voxel-world §7.2). Computed once per generator.
 *
 * Endless worlds (generator 3) use LazyStructures: denser rules (V3_RULES)
 * per region, rolled when a region is first needed, landmarks so ruins can be
 * seen from afar, and one structure guaranteed near spawn.
 */
import { hash4, hashFloat, mulberry32 } from '../../util/rng';
import { SEA_LEVEL } from '../constants';
import { Biome } from '../worldgen/biomes';
import { citadel } from './citadel';
import { crypt, cryptShaft } from './crypt';
import { buildLandmark, cryptGateFits, landmarkBox, unionBox } from './landmarks';
import { shrine } from './shrine';
import { temple } from './temple';
import type { Built, Template } from './template';
import { SET2_TEMPLATES, set2Floor, set2Region, set2Type, V4_RULES } from './set2';
import { STRUCTURE_NAMES, type StructureInfo, StructureType } from './types';

/** What placement needs from a generator. */
export interface SiteSource {
  column(x: number, z: number): { height: number; biome: Biome };
  findSpawn(): { x: number; y: number; z: number };
}

export interface PlacedStructure {
  info: StructureInfo;
  /** Floor (plaza / surface) height F. */
  floor: number;
  /** Generator 3: a landmark spire / crypt gatehouse is built too (landmarks.ts). */
  landmark?: boolean;
  /** Template set: 1 (generators 2 and 3, frozen) or 2 (generator 4: reworked ruins and four new bosses, set2.ts). Default 1. */
  set?: StructureSet;
}

/** Which family of structure templates a world uses (generator 4 = 2). */
export type StructureSet = 1 | 2;

/** How a LazyStructures world is configured (the generator picks; generator 3 = {}). */
export interface LazyOptions {
  /** Template set (default 1: generator 3's ruins, byte-identical). */
  structureSet?: StructureSet;
  /** Anchors stay west of this x (generator 4: the overworld ends before the veil wall). */
  maxX?: number;
}

/** How structures are spread over a world. */
export interface PlacementRules {
  /** Region side in blocks: at most one structure per region. */
  region: number;
  /** Anchors stay this far inside their region. */
  margin: number;
  /** Chance a region rolls for a structure at all. */
  chance: number;
  /** Anchors at least this far from the spawn point. */
  minFromSpawn: number;
  /** Landmarks and crypt gatehouses (generator 3). */
  landmarks: boolean;
}

/** Generator 2 (frozen). */
const V2_RULES: PlacementRules = { region: 256, margin: 40, chance: 0.75, minFromSpawn: 96, landmarks: false };
/**
 * Generator 3: smaller regions and a higher chance (about 2.3x as many per
 * area), closer to spawn allowed, plus landmarks so ruins show from afar.
 */
export const V3_RULES: PlacementRules = { region: 176, margin: 30, chance: 0.9, minFromSpawn: 64, landmarks: true };
/** Generator 3 always has a structure within this distance of spawn. */
export const SPAWN_GUARANTEE = 250;

const MIN_COUNT = 6;

export const TEMPLATES: Partial<Record<StructureType, Template>> = {
  [StructureType.SunscorchTemple]: temple,
  [StructureType.FrostCitadel]: citadel,
  [StructureType.OvergrownShrine]: shrine,
  [StructureType.AshenCrypt]: crypt,
};

/** Footprint size, height spread allowed, lowest height and highest floor per type. */
const SITE: Partial<Record<StructureType, { size: number; spread: number; minAbove: number; maxF: number }>> = {
  [StructureType.SunscorchTemple]: { size: 35, spread: 8, minAbove: SEA_LEVEL + 2, maxF: 46 },
  [StructureType.FrostCitadel]: { size: 35, spread: 10, minAbove: SEA_LEVEL + 2, maxF: 49 },
  [StructureType.OvergrownShrine]: { size: 33, spread: 8, minAbove: SEA_LEVEL, maxF: 45 },
  [StructureType.AshenCrypt]: { size: 9, spread: 4, minAbove: SEA_LEVEL + 2, maxF: 48 },
};

/** The template of a type in a set. */
function templateOf(set: StructureSet, type: StructureType): Template {
  return (set === 2 ? SET2_TEMPLATES[type] : TEMPLATES[type])!;
}

function typeFor(biome: Biome): StructureType | null {
  switch (biome) {
    case Biome.Desert:
    case Biome.Redrock:
    case Biome.Savanna:
      return StructureType.SunscorchTemple;
    case Biome.Snow:
    case Biome.Frostpine:
    case Biome.GlacierPeaks:
      return StructureType.FrostCitadel;
    case Biome.Rainforest:
    case Biome.Marshland:
      return StructureType.OvergrownShrine;
    case Biome.Plains:
    case Biome.Forest:
    case Biome.AspenGrove:
    case Biome.Duskwood:
    case Biome.Pinewood:
    case Biome.Mountains:
      return StructureType.AshenCrypt;
    default:
      return null;
  }
}

/** Heights at the 9 sample points (corners, edge midpoints, centre) of a square footprint. */
function samples(gen: SiteSource, cx: number, cz: number, size: number): number[] {
  const h = Math.floor(size / 2);
  const out: number[] = [];
  for (const dz of [-h, 0, h]) for (const dx of [-h, 0, h]) out.push(gen.column(cx + dx, cz + dz).height);
  return out.sort((a, b) => a - b);
}

/** The floor F if the site suits the type, else null. */
function siteFloor(gen: SiteSource, type: StructureType, ax: number, az: number, relaxed = false, set: StructureSet = 1): number | null {
  if (set === 2) return set2Floor(gen, type, ax, az, relaxed);
  const site = SITE[type]!;
  const c = type === StructureType.AshenCrypt ? cryptShaft(ax, az) : { x: ax, z: az };
  const hs = samples(gen, c.x, c.z, site.size);
  if (hs[8] - hs[0] > site.spread * (relaxed ? 2 : 1) || hs[0] < site.minAbove) return null;
  const F = type === StructureType.AshenCrypt ? gen.column(c.x, c.z).height : hs[4];
  if (F > site.maxF) return null;
  // The catacomb (y 8..19) must stay under ground everywhere over it.
  if (type === StructureType.AshenCrypt && samples(gen, ax, az, 37)[0] < 23) return null;
  return F;
}

function describe(seed: number, rx: number, rz: number, type: StructureType, ax: number, az: number, F: number, biome: Biome, landmark = false, set: StructureSet = 1): PlacedStructure {
  const id = ((rx & 0xff) << 8) | (rz & 0xff);
  const l = templateOf(set, type).layout(ax, az, F);
  return {
    floor: F,
    ...(landmark ? { landmark } : {}),
    ...(set === 2 ? { set } : {}),
    info: {
      id,
      type,
      name: STRUCTURE_NAMES[type] ?? 'Ruin',
      biome,
      anchor: { x: ax, z: az },
      bounds: landmark ? unionBox(l.bounds, landmarkBox({ type, anchor: { x: ax, z: az }, bounds: l.bounds, floor: F })) : l.bounds,
      entrance: l.entrance,
      arena: l.arena,
      bossSpawn: l.bossSpawn,
      altar: l.altar,
      doorways: l.doorways,
      chests: l.chests.map((c) => ({ ...c, lootSeed: hash4(seed, id, c.index, 0x100c) })),
      guardSpawns: l.guardSpawns,
    },
  };
}

/**
 * One region's roll: up to `candidates` anchors, the first whose biome and
 * site suit a type wins. `strict` is the normal 75% roll (crypts a further
 * 75%); the top-up pass is not strict.
 */
function rollRegion(
  gen: SiteSource,
  seed: number,
  spawn: { x: number; z: number },
  rx: number,
  rz: number,
  salt: number,
  candidates: number,
  strict: boolean,
  rules = V2_RULES,
  maxFromSpawn = Infinity,
  relaxed = false,
  set: StructureSet = 1,
): PlacedStructure | null {
  const rng = mulberry32(hash4(rx, rz, seed, salt));
  if (strict && rng() >= rules.chance) return null;
  const span = rules.region - rules.margin * 2;
  for (let i = 0; i < candidates; i++) {
    const ax = rx * rules.region + rules.margin + Math.floor(rng() * span);
    const az = rz * rules.region + rules.margin + Math.floor(rng() * span);
    const crypRoll = rng();
    const d = Math.hypot(ax - spawn.x, az - spawn.z);
    if (d < rules.minFromSpawn || d > maxFromSpawn) continue;
    const biome = gen.column(ax, az).biome;
    const type = set === 2 ? set2Type(biome, hashFloat(ax, az, seed, 0x5e72)) : typeFor(biome);
    if (type === null) continue;
    if (strict && type === StructureType.AshenCrypt && crypRoll >= 0.75) continue;
    const F = siteFloor(gen, type, ax, az, relaxed, set);
    if (F === null) continue;
    // Landmarks: generator 3 gives every ruin a spire or gatehouse; generator 4's ruins carry their own, so only the crypt keeps its gatehouse.
    const landmark = rules.landmarks && (set === 1 || type === StructureType.AshenCrypt);
    if (landmark && type === StructureType.AshenCrypt && !cryptGateFits((x, z) => gen.column(x, z), ax, az, F)) continue;
    return describe(seed, rx, rz, type, ax, az, F, biome, landmark, set);
  }
  // Generator 4: regions on a coast that no ordinary anchor suited get a lighthouse probe (coasts are thin, a random anchor seldom lands on one).
  if (set === 2 && strict) {
    const c = set2Region(gen, rng, rx, rz, rules, spawn, maxFromSpawn, relaxed);
    if (c) return describe(seed, rx, rz, c.type, c.ax, c.az, c.F, c.biome, false, set);
  }
  return null;
}

/** Every structure of a world, in region order. Deterministic. */
export function computeStructures(gen: SiteSource, seed: number): PlacedStructure[] {
  const spawn = gen.findSpawn();
  const regions: [number, number][] = [];
  for (let rx = -2; rx <= 1; rx++) for (let rz = -2; rz <= 1; rz++) regions.push([rx, rz]);
  const found = new Map<string, PlacedStructure>();
  const tryRegion = (rx: number, rz: number, salt: number, candidates: number, strict: boolean) => {
    const p = rollRegion(gen, seed, spawn, rx, rz, salt, candidates, strict);
    if (p) found.set(`${rx},${rz}`, p);
  };
  for (const [rx, rz] of regions) tryRegion(rx, rz, 0x57c7, 4, true);
  for (const [rx, rz] of regions) {
    if (found.size >= MIN_COUNT) break;
    if (!found.has(`${rx},${rz}`)) tryRegion(rx, rz, 0x57c8, 8, false);
  }
  return regions.map(([rx, rz]) => found.get(`${rx},${rz}`)).filter((p): p is PlacedStructure => !!p);
}

/** Regions remembered by LazyStructures (each holds at most one structure). */
const REGION_CACHE = 1024;
/** Structures stay inside their region (margin 30; footprints and gatehouses reach at most 22 from the anchor); queries look this much wider. */
const REGION_REACH = 48;

/**
 * Structures of an endless world (generator 3), placed per region
 * (V3_RULES) on demand: each region rolls on its own, so structures are
 * equally common everywhere. The regions around the spawn point are rolled
 * together: if none of them has a structure within SPAWN_GUARANTEE of spawn,
 * the nearest region that can host one gets one. Regions whose anchors could
 * come within `edgeMargin` of the world edge get none. Results are cached
 * (LRU of REGION_CACHE regions).
 */
export class LazyStructures {
  private spawnGroup: Map<number, PlacedStructure | null> | null = null;
  private readonly cache = new Map<number, PlacedStructure | null>();
  private readonly maxRegion: number;
  /** Highest region x (anchors stay west of options.maxX). */
  private readonly maxRegionX: number;
  private readonly rules: PlacementRules;
  private readonly set: StructureSet;

  constructor(
    private readonly gen: SiteSource,
    private readonly seed: number,
    limit: number,
    edgeMargin = 128,
    options: LazyOptions = {},
  ) {
    this.set = options.structureSet ?? 1;
    this.rules = this.set === 2 ? V4_RULES : V3_RULES;
    this.maxRegion = Math.floor((limit - edgeMargin) / this.rules.region) - 1;
    this.maxRegionX = options.maxX === undefined ? this.maxRegion : Math.min(this.maxRegion, Math.floor((options.maxX - edgeMargin) / this.rules.region) - 1);
  }

  private static key(rx: number, rz: number): number {
    return (rx + 4096) * 8192 + (rz + 4096);
  }

  /** The regions near spawn, with the guarantee applied. */
  private group(): Map<number, PlacedStructure | null> {
    if (this.spawnGroup) return this.spawnGroup;
    const R = this.rules.region;
    const spawn = this.gen.findSpawn();
    const regions: { rx: number; rz: number; d: number }[] = [];
    const reach = SPAWN_GUARANTEE;
    for (let rx = Math.floor((spawn.x - reach) / R); rx <= Math.floor((spawn.x + reach) / R); rx++) {
      for (let rz = Math.floor((spawn.z - reach) / R); rz <= Math.floor((spawn.z + reach) / R); rz++) {
        const dx = Math.max(rx * R - spawn.x, 0, spawn.x - (rx + 1) * R);
        const dz = Math.max(rz * R - spawn.z, 0, spawn.z - (rz + 1) * R);
        if (dx * dx + dz * dz > reach * reach) continue;
        regions.push({ rx, rz, d: Math.hypot((rx + 0.5) * R - spawn.x, (rz + 0.5) * R - spawn.z) });
      }
    }
    regions.sort((a, b) => a.d - b.d || a.rx - b.rx || a.rz - b.rz);
    const group = new Map<number, PlacedStructure | null>();
    let near = false;
    for (const { rx, rz } of regions) {
      const p = this.roll(rx, rz);
      group.set(LazyStructures.key(rx, rz), p);
      if (p && Math.hypot(p.info.anchor.x - spawn.x, p.info.anchor.z - spawn.z) <= SPAWN_GUARANTEE) near = true;
    }
    for (const relaxed of [false, true]) {
      if (near) break;
      for (const { rx, rz } of regions) {
        if (!this.inWorld(rx, rz)) continue;
        const p = rollRegion(this.gen, this.seed, spawn, rx, rz, 0x57c9, 24, false, this.rules, SPAWN_GUARANTEE, relaxed, this.set);
        if (p) {
          group.set(LazyStructures.key(rx, rz), p);
          near = true;
          break;
        }
      }
    }
    return (this.spawnGroup = group);
  }

  private inWorld(rx: number, rz: number): boolean {
    return rx >= -this.maxRegion - 1 && rx <= this.maxRegionX && rz >= -this.maxRegion - 1 && rz <= this.maxRegion;
  }

  private roll(rx: number, rz: number): PlacedStructure | null {
    if (!this.inWorld(rx, rz)) return null;
    return rollRegion(this.gen, this.seed, this.gen.findSpawn(), rx, rz, 0x57c7, 4, true, this.rules, Infinity, false, this.set);
  }

  /** The structure of region (rx, rz), or null. */
  region(rx: number, rz: number): PlacedStructure | null {
    const key = LazyStructures.key(rx, rz);
    const g = this.group();
    if (g.has(key)) return g.get(key)!;
    if (this.cache.has(key)) {
      const p = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, p);
      return p;
    }
    const p = this.roll(rx, rz);
    if (this.cache.size >= REGION_CACHE) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(key, p);
    return p;
  }

  /** Structures whose bounds overlap the box [x0, x1) x [z0, z1), in region order. */
  inBox(x0: number, z0: number, x1: number, z1: number, out: PlacedStructure[] = []): PlacedStructure[] {
    out.length = 0;
    const R = this.rules.region;
    const rx0 = Math.floor((x0 - REGION_REACH) / R), rx1 = Math.floor((x1 + REGION_REACH) / R);
    const rz0 = Math.floor((z0 - REGION_REACH) / R), rz1 = Math.floor((z1 + REGION_REACH) / R);
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        const p = this.region(rx, rz);
        if (p && p.info.bounds.x0 < x1 && p.info.bounds.x1 > x0 && p.info.bounds.z0 < z1 && p.info.bounds.z1 > z0) out.push(p);
      }
    }
    return out;
  }
}

/** Builds the blocks of a placed structure (decoration seeded per structure). */
export function buildStructure(p: PlacedStructure, seed: number): Built {
  const rng = mulberry32(hash4(seed, p.info.id, p.info.type, 0x5eed));
  const built = templateOf(p.set ?? 1, p.info.type).build(p.info.anchor.x, p.info.anchor.z, p.floor, rng);
  if (p.landmark) {
    const l = templateOf(p.set ?? 1, p.info.type).layout(p.info.anchor.x, p.info.anchor.z, p.floor);
    const site = { type: p.info.type, anchor: p.info.anchor, bounds: l.bounds, floor: p.floor };
    built.volumes.push(...buildLandmark(site, mulberry32(hash4(seed, p.info.id, p.info.type, 0x1a4d))));
  }
  return built;
}
