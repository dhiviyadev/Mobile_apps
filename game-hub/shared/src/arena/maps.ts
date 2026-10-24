/**
 * The arena map registry: six original maps built from axis-aligned boxes, so
 * collision, line-of-sight and hit detection stay exact and cheap.
 *
 * Layout conventions: X runs west→east (team 0 spawns west, team 1 east),
 * Z runs north→south, Y is up, the floor top is at y = 0. Each map is built
 * by a MapBuilder (mapkit.ts) in levels/, mirrored so both sides are equal.
 * The data model lives in mapTypes.ts; validateMap (mapcheck.ts) checks
 * every map (standability, pads, physical traversal of every nav edge).
 */
import { courts } from './levels/courts';
import { dunes } from './levels/dunes';
import { foundry } from './levels/foundry';
import { frostline } from './levels/frostline';
import { skybridge } from './levels/skybridge';
import { verdant } from './levels/verdant';
import type { ArenaMap } from './mapTypes';

export * from './mapTypes';

/** Order is part of the wire format (state.mapIndex): append only, never reorder. */
export const ARENA_MAPS: readonly ArenaMap[] = [foundry(), courts(), skybridge(), verdant(), dunes(), frostline()];

/** Map by index, wrapping around (state.mapIndex is always valid this way). */
export function arenaMap(index: number): ArenaMap {
  return ARENA_MAPS[((index % ARENA_MAPS.length) + ARENA_MAPS.length) % ARENA_MAPS.length];
}

/** ARENA_MAPS index of a map id, or -1. */
export function arenaMapIndex(id: string): number {
  return ARENA_MAPS.findIndex((m) => m.id === id);
}
