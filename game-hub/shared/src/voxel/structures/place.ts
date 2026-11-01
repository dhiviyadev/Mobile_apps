/**
 * Where the rare boss structures go. The 1024x1024 world is cut into 16 regions
 * of 256x256; each region rolls once (75%) for at most one structure, whose type
 * follows the biome at its anchor. A second pass tops a world up to 6. Every
 * world gets 6..16, at least 96 blocks from spawn and never overlapping
 * (design-voxel-world §7.2). Computed once per generator.
 */
import { hash4, mulberry32 } from '../../util/rng';
import { SEA_LEVEL } from '../constants';
import { Biome } from '../worldgen/biomes';
import { citadel } from './citadel';
import { crypt, cryptShaft } from './crypt';
import { shrine } from './shrine';
import { temple } from './temple';
import type { Built, Template } from './template';
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
}

const REGION = 256;
const MIN_FROM_SPAWN = 96;
const MIN_COUNT = 6;

export const TEMPLATES: Record<StructureType, Template> = {
  [StructureType.SunscorchTemple]: temple,
  [StructureType.FrostCitadel]: citadel,
  [StructureType.OvergrownShrine]: shrine,
  [StructureType.AshenCrypt]: crypt,
};

/** Footprint size, height spread allowed, lowest height and highest floor per type. */
const SITE: Record<StructureType, { size: number; spread: number; minAbove: number; maxF: number }> = {
  [StructureType.SunscorchTemple]: { size: 35, spread: 8, minAbove: SEA_LEVEL + 2, maxF: 46 },
  [StructureType.FrostCitadel]: { size: 35, spread: 10, minAbove: SEA_LEVEL + 2, maxF: 49 },
  [StructureType.OvergrownShrine]: { size: 33, spread: 8, minAbove: SEA_LEVEL, maxF: 45 },
  [StructureType.AshenCrypt]: { size: 9, spread: 4, minAbove: SEA_LEVEL + 2, maxF: 48 },
};

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
function siteFloor(gen: SiteSource, type: StructureType, ax: number, az: number): number | null {
  const site = SITE[type];
  const c = type === StructureType.AshenCrypt ? cryptShaft(ax, az) : { x: ax, z: az };
  const hs = samples(gen, c.x, c.z, site.size);
  if (hs[8] - hs[0] > site.spread || hs[0] < site.minAbove) return null;
  const F = type === StructureType.AshenCrypt ? gen.column(c.x, c.z).height : hs[4];
  if (F > site.maxF) return null;
  // The catacomb (y 8..19) must stay under ground everywhere over it.
  if (type === StructureType.AshenCrypt && samples(gen, ax, az, 37)[0] < 23) return null;
  return F;
}

function describe(seed: number, rx: number, rz: number, type: StructureType, ax: number, az: number, F: number, biome: Biome): PlacedStructure {
  const id = ((rx & 0xff) << 8) | (rz & 0xff);
  const l = TEMPLATES[type].layout(ax, az, F);
  return {
    floor: F,
    info: {
      id,
      type,
      name: STRUCTURE_NAMES[type],
      biome,
      anchor: { x: ax, z: az },
      bounds: l.bounds,
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

/** Every structure of a world, in region order. Deterministic. */
export function computeStructures(gen: SiteSource, seed: number): PlacedStructure[] {
  const spawn = gen.findSpawn();
  const regions: [number, number][] = [];
  for (let rx = -2; rx <= 1; rx++) for (let rz = -2; rz <= 1; rz++) regions.push([rx, rz]);
  const found = new Map<string, PlacedStructure>();
  const tryRegion = (rx: number, rz: number, salt: number, candidates: number, strict: boolean) => {
    const rng = mulberry32(hash4(rx, rz, seed, salt));
    if (strict && rng() >= 0.75) return;
    for (let i = 0; i < candidates; i++) {
      const ax = rx * REGION + 40 + Math.floor(rng() * 176);
      const az = rz * REGION + 40 + Math.floor(rng() * 176);
      const crypRoll = rng();
      if (Math.hypot(ax - spawn.x, az - spawn.z) < MIN_FROM_SPAWN) continue;
      const biome = gen.column(ax, az).biome;
      const type = typeFor(biome);
      if (type === null) continue;
      if (strict && type === StructureType.AshenCrypt && crypRoll >= 0.75) continue;
      const F = siteFloor(gen, type, ax, az);
      if (F === null) continue;
      found.set(`${rx},${rz}`, describe(seed, rx, rz, type, ax, az, F, biome));
      return;
    }
  };
  for (const [rx, rz] of regions) tryRegion(rx, rz, 0x57c7, 4, true);
  for (const [rx, rz] of regions) {
    if (found.size >= MIN_COUNT) break;
    if (!found.has(`${rx},${rz}`)) tryRegion(rx, rz, 0x57c8, 8, false);
  }
  return regions.map(([rx, rz]) => found.get(`${rx},${rz}`)).filter((p): p is PlacedStructure => !!p);
}

/** Builds the blocks of a placed structure (decoration seeded per structure). */
export function buildStructure(p: PlacedStructure, seed: number): Built {
  const rng = mulberry32(hash4(seed, p.info.id, p.info.type, 0x5eed));
  return TEMPLATES[p.info.type].build(p.info.anchor.x, p.info.anchor.z, p.floor, rng);
}
