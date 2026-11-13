/**
 * Structure set 2 (generator 4, package S "More ruins and bosses"): the four
 * original ruins rebuilt much larger (temple2, citadel2, shrine2, crypt2) and
 * four new boss structures (lighthouse, aerie, grove, forge). Placement
 * rules, the biome table and the site checks live here; the templates are in
 * ruins/. Generators 1-3 never touch this file (their structures are set 1).
 */
import { SEA_LEVEL } from '../constants';
import { Biome } from '../worldgen/biomes';
import { aerie } from './ruins/aerie';
import { citadel2 } from './ruins/citadel2';
import { crypt2 } from './ruins/crypt2';
import { forge } from './ruins/forge';
import { grove } from './ruins/grove';
import { lighthouse } from './ruins/lighthouse';
import { shrine2 } from './ruins/shrine2';
import { temple2 } from './ruins/temple2';
import { cryptShaft } from './crypt';
import type { PlacementRules, SiteSource } from './place';
import type { Template } from './template';
import { StructureType } from './types';

/** Generator 4: a little denser than generator 3 (region 160, 8 types). Landmarks are only used for the crypt's gatehouse. */
export const V4_RULES: PlacementRules = { region: 160, margin: 30, chance: 0.9, minFromSpawn: 64, landmarks: true };

export const SET2_TEMPLATES: Partial<Record<StructureType, Template>> = {
  [StructureType.SunscorchTemple]: temple2,
  [StructureType.FrostCitadel]: citadel2,
  [StructureType.OvergrownShrine]: shrine2,
  [StructureType.AshenCrypt]: crypt2,
  [StructureType.SaltwornLighthouse]: lighthouse,
  [StructureType.StormcrownAerie]: aerie,
  [StructureType.HollowheartGrove]: grove,
  [StructureType.CinderdeepForge]: forge,
};

/** Footprint side, height spread allowed, lowest height and highest floor per type (the lighthouse has its own rule). */
export const SET2_SITE: Partial<Record<StructureType, { size: number; spread: number; minAbove: number; maxF: number }>> = {
  [StructureType.SunscorchTemple]: { size: 45, spread: 7, minAbove: SEA_LEVEL + 2, maxF: 38 },
  [StructureType.FrostCitadel]: { size: 41, spread: 9, minAbove: SEA_LEVEL + 2, maxF: 38 },
  [StructureType.OvergrownShrine]: { size: 41, spread: 8, minAbove: SEA_LEVEL, maxF: 38 },
  [StructureType.AshenCrypt]: { size: 9, spread: 4, minAbove: SEA_LEVEL + 2, maxF: 48 },
  [StructureType.StormcrownAerie]: { size: 33, spread: 12, minAbove: SEA_LEVEL + 12, maxF: 46 },
  [StructureType.HollowheartGrove]: { size: 41, spread: 6, minAbove: SEA_LEVEL + 1, maxF: 40 },
  [StructureType.CinderdeepForge]: { size: 41, spread: 9, minAbove: SEA_LEVEL + 2, maxF: 40 },
};

/** Floor height of the lighthouse (its rocky island is built up to it). */
export const LIGHTHOUSE_FLOOR = SEA_LEVEL + 4;

/** The type of a biome (generator 4), or null. `u` in [0,1) picks between two types where a biome has two. */
export function set2Type(biome: Biome, u: number): StructureType | null {
  switch (biome) {
    case Biome.Desert:
      return StructureType.SunscorchTemple;
    case Biome.Savanna:
      return u < 0.5 ? StructureType.SunscorchTemple : StructureType.CinderdeepForge;
    case Biome.Redrock:
      return u < 0.7 ? StructureType.CinderdeepForge : StructureType.SunscorchTemple;
    case Biome.Snow:
    case Biome.Frostpine:
      return StructureType.FrostCitadel;
    case Biome.GlacierPeaks:
      return u < 0.7 ? StructureType.StormcrownAerie : StructureType.FrostCitadel;
    case Biome.Mountains:
      return u < 0.75 ? StructureType.StormcrownAerie : StructureType.AshenCrypt;
    case Biome.Rainforest:
    case Biome.Marshland:
      return StructureType.OvergrownShrine;
    case Biome.Forest:
    case Biome.AspenGrove:
      return u < 0.65 ? StructureType.HollowheartGrove : StructureType.AshenCrypt;
    case Biome.Duskwood:
    case Biome.Pinewood:
      return u < 0.5 ? StructureType.HollowheartGrove : StructureType.AshenCrypt;
    case Biome.Plains:
      return StructureType.AshenCrypt;
    case Biome.Beach:
    case Biome.FrozenShore:
    case Biome.Ocean:
    case Biome.IcySea:
      return StructureType.SaltwornLighthouse;
    default:
      return null;
  }
}

function samples(gen: SiteSource, cx: number, cz: number, size: number): number[] {
  const h = Math.floor(size / 2);
  const out: number[] = [];
  for (const dz of [-h, 0, h]) for (const dx of [-h, 0, h]) out.push(gen.column(cx + dx, cz + dz).height);
  return out.sort((a, b) => a - b);
}

/** The lighthouse floor if a rocky island fits at (ax, az): shallow water or beach with land within reach and no tall hills around. */
function lighthouseFloor(gen: SiteSource, ax: number, az: number): number | null {
  const c = gen.column(ax, az);
  if (c.height > SEA_LEVEL + 2 || c.height < SEA_LEVEL - 7) return null;
  let land = 0;
  for (const r of [9, 16]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + (r === 16 ? Math.PI / 8 : 0);
      const h = gen.column(Math.round(ax + Math.cos(a) * r), Math.round(az + Math.sin(a) * r)).height;
      if (h > SEA_LEVEL + 7) return null;
      if (h >= SEA_LEVEL + 1) land++;
      if (r === 9 && h < SEA_LEVEL - 9) return null;
    }
  }
  return land >= 1 ? LIGHTHOUSE_FLOOR : null;
}

/** The floor F if the site suits the type in set 2, else null. */
export function set2Floor(gen: SiteSource, type: StructureType, ax: number, az: number, relaxed = false): number | null {
  if (type === StructureType.SaltwornLighthouse) return lighthouseFloor(gen, ax, az);
  const site = SET2_SITE[type]!;
  const c = type === StructureType.AshenCrypt ? cryptShaft(ax, az) : { x: ax, z: az };
  const hs = samples(gen, c.x, c.z, site.size);
  if (hs[8] - hs[0] > site.spread * (relaxed ? 2 : 1) || hs[0] < site.minAbove) return null;
  const F = type === StructureType.AshenCrypt ? gen.column(c.x, c.z).height : hs[4];
  if (F > site.maxF) return null;
  // The catacomb (y 8..19) must stay under ground everywhere over it.
  if (type === StructureType.AshenCrypt && samples(gen, ax, az, 37)[0] < 23) return null;
  return F;
}

/**
 * Coast probe: a few extra anchors for a region that no ordinary anchor suited,
 * looking only for a lighthouse site. Returns the site or null.
 */
export function set2Region(
  gen: SiteSource,
  rng: () => number,
  rx: number,
  rz: number,
  rules: PlacementRules,
  spawn: { x: number; z: number },
  maxFromSpawn: number,
  relaxed: boolean,
): { type: StructureType; ax: number; az: number; F: number; biome: Biome } | null {
  const span = rules.region - rules.margin * 2;
  for (let i = 0; i < 10; i++) {
    const ax = rx * rules.region + rules.margin + Math.floor(rng() * span);
    const az = rz * rules.region + rules.margin + Math.floor(rng() * span);
    const d = Math.hypot(ax - spawn.x, az - spawn.z);
    if (d < rules.minFromSpawn || d > maxFromSpawn) continue;
    const col = gen.column(ax, az);
    if (col.height > SEA_LEVEL + 2 || col.height < SEA_LEVEL - 7) continue;
    const F = set2Floor(gen, StructureType.SaltwornLighthouse, ax, az, relaxed);
    if (F !== null) return { type: StructureType.SaltwornLighthouse, ax, az, F, biome: col.biome };
  }
  return null;
}
