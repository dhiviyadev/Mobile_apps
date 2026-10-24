/**
 * Arena map data model (design-arena-maps §2.1). Re-exported by maps.ts.
 *
 * Layout conventions: X runs west→east (team 0 spawns west, team 1 east),
 * Z runs north→south, Y is up, the floor top is at y = 0.
 */
import type { Box, LaunchPad } from './geometry';

export type BoxKind = 'floor' | 'wall' | 'cover' | 'platform' | 'stairs' | 'accent' | 'pillar' | 'trim' | 'pad';

export interface MapBox extends Box {
  kind: BoxKind;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export type PickupKind = 'health' | 'ammo';

/** A respawning pickup. (x, y, z) is the floor point under it (standable). */
export interface MapPickup {
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
}

/** How a bot traverses a nav link. 'drop' and 'pad' are always one-way (a → b). */
export type NavLinkKind = 'walk' | 'jump' | 'drop' | 'pad';

export interface NavLink {
  a: number;
  b: number;
  kind: NavLinkKind;
  oneWay?: boolean;
}

export interface MapTheme {
  sky: number;
  horizon: number;
  fog: number;
  floor: number;
  wall: number;
  cover: number;
  platform: number;
  accent: number;
  trim: number;
  /** Glow colour of pad caps, pickup rings and launcher landing marks. */
  pad: number;
  /** Fog distances (m) for this map's size. */
  fogNear: number;
  fogFar: number;
}

export interface ArenaMap {
  id: string;
  name: string;
  description: string;
  /** 2–3 short labels for the vote card, e.g. ['Large', 'Trampolines']. */
  tags: string[];
  boxes: MapBox[];
  /** Launch surfaces. A pad's solid base is a 'pad' box in `boxes` whose maxY = pad.top. */
  pads: LaunchPad[];
  pickups: MapPickup[];
  spawns: { team: [SpawnPoint[], SpawnPoint[]]; ffa: SpawnPoint[] };
  /** Bot navigation graph. A waypoint standing on a pad top is a "pad node" (transit only). */
  waypoints: { x: number; y: number; z: number }[];
  links: NavLink[];
  theme: MapTheme;
  /** Playable bounds (inside the outer walls). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}
