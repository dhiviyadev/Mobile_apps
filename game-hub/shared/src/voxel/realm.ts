/**
 * Realms: Voxelvale's two places inside one coordinate space (generator 4).
 *
 * The overworld ends at x = OVERWORLD_MAX_X in a sea; an impassable bedrock
 * Veil Wall fills [VEIL_X0, DIM_X0); the Gloamreach lies at x in
 * [DIM_X0, DIM_X1). Only portals move you between them (portal.ts). Worlds on
 * generators 1-3 are overworld everywhere. realmAt is the single source of
 * truth for the generator, the sky, ambience, spawn tables, music, the
 * teleport menu and banners.
 */
import type { GenVersion } from './generator';

/** The overworld's last column is OVERWORLD_MAX_X - 1 (its coast fades into sea before it). */
export const OVERWORLD_MAX_X = 12000;
export const VEIL_X0 = OVERWORLD_MAX_X;
/** First column of the Gloamreach. */
export const DIM_X0 = 14000;
/** One past the last column of the Gloamreach (the i16 edit limit). */
export const DIM_X1 = 32000;
/** First generator version that has a dimension. */
export const DIMENSION_GEN = 4;

export enum Realm {
  Overworld = 0,
  Gloamreach = 1,
  /** The bedrock wall between them: nothing lives there. */
  Veil = 2,
}

export const REALM_NAMES: Readonly<Record<Realm, string>> = {
  [Realm.Overworld]: 'Overworld',
  [Realm.Gloamreach]: 'The Gloamreach',
  [Realm.Veil]: 'The Veil Wall',
};

export function realmAt(genVersion: GenVersion | number, x: number): Realm {
  if (genVersion < DIMENSION_GEN) return Realm.Overworld;
  if (x < VEIL_X0) return Realm.Overworld;
  return x < DIM_X0 ? Realm.Veil : Realm.Gloamreach;
}

/** True when this world has a dimension (generator 4 and later). */
export const hasDimension = (genVersion: number): boolean => genVersion >= DIMENSION_GEN;

/** Portal travel mapping: overworld (x, z) -> the Gloamreach, 1 : 4 (x in [14500, 25000)). */
export function overworldToGloam(x: number, z: number): { x: number; z: number } {
  return { x: Math.floor(DIM_X0 + 500 + (x + 32000) / 4), z: Math.floor(z / 4) };
}

/** Inverse: Gloamreach (x, z) -> the overworld, clamped inside the playable overworld. */
export function gloamToOverworld(x: number, z: number): { x: number; z: number } {
  const ox = Math.round((x - DIM_X0 - 500) * 4 - 32000);
  return { x: Math.max(-31000, Math.min(OVERWORLD_MAX_X - 400, ox)), z: Math.max(-31000, Math.min(31000, z * 4)) };
}
