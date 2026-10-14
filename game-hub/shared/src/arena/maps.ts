/**
 * Three original compact arena maps, built from axis-aligned boxes so that
 * collision, line-of-sight and hit detection stay exact and cheap.
 *
 * Layout conventions: X runs west→east (team 0 spawns west, team 1 east),
 * Z runs north→south, Y is up, the floor top is at y = 0. Cover pieces are
 * declared once and mirrored through the origin, so both sides are identical.
 */
import type { Box } from './geometry';

export type BoxKind = 'floor' | 'wall' | 'cover' | 'platform' | 'stairs' | 'accent' | 'pillar' | 'trim';

export interface MapBox extends Box {
  kind: BoxKind;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
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
}

export interface ArenaMap {
  id: string;
  name: string;
  description: string;
  boxes: MapBox[];
  spawns: { team: [SpawnPoint[], SpawnPoint[]]; ffa: SpawnPoint[] };
  /** Bot navigation graph. */
  waypoints: { x: number; y: number; z: number }[];
  links: [number, number][];
  theme: MapTheme;
  /** Playable bounds (inside the outer walls). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

// ---- builders ----------------------------------------------------------------------

type Piece = MapBox;

/** Box from centre (x, z), size (w along X, d along Z), height h, base y. */
function box(x: number, z: number, w: number, d: number, h: number, kind: BoxKind = 'cover', y = 0): Piece {
  return { minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2, kind };
}

/**
 * Solid stairs climbing to `height`, running away from an edge.
 * axis 'x' | 'z': direction of travel; dir +1/-1 = which way the stairs extend from the edge.
 */
function stairs(edge: number, axis: 'x' | 'z', dir: 1 | -1, from: number, to: number, height: number, rise = 0.4, run = 0.6): Piece[] {
  const n = Math.round(height / rise);
  const out: Piece[] = [];
  for (let k = 0; k < n - 1; k++) {
    const top = height - rise * (k + 1);
    const a = edge + dir * k * run;
    const b = edge + dir * (k + 1) * run;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    out.push(
      axis === 'x'
        ? { minX: lo, maxX: hi, minY: 0, maxY: top, minZ: from, maxZ: to, kind: 'stairs' }
        : { minX: from, maxX: to, minY: 0, maxY: top, minZ: lo, maxZ: hi, kind: 'stairs' },
    );
  }
  return out;
}

/** Point mirror through the origin (x, z) → (-x, -z). */
function mirror(p: Piece): Piece {
  return { ...p, minX: -p.maxX, maxX: -p.minX, minZ: -p.maxZ, maxZ: -p.minZ };
}

function withMirror(pieces: Piece[]): Piece[] {
  return [...pieces, ...pieces.map(mirror)];
}

function shell(halfX: number, halfZ: number, wallH: number): Piece[] {
  return [
    { minX: -halfX - 1, maxX: halfX + 1, minY: -1, maxY: 0, minZ: -halfZ - 1, maxZ: halfZ + 1, kind: 'floor' },
    { minX: -halfX - 1, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: -halfZ - 1, maxZ: -halfZ, kind: 'wall' },
    { minX: -halfX - 1, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: halfZ, maxZ: halfZ + 1, kind: 'wall' },
    { minX: -halfX - 1, maxX: -halfX, minY: 0, maxY: wallH, minZ: -halfZ, maxZ: halfZ, kind: 'wall' },
    { minX: halfX, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: -halfZ, maxZ: halfZ, kind: 'wall' },
  ];
}

const EAST = -Math.PI / 2; // yaw that looks toward +X
const WEST = Math.PI / 2;

function mirrorSpawns(points: SpawnPoint[]): SpawnPoint[] {
  return points.map((p) => ({ x: -p.x, y: p.y, z: -p.z, yaw: p.yaw + Math.PI }));
}

function mirrorWaypoints(points: { x: number; y: number; z: number }[]) {
  return [...points, ...points.map((p) => ({ x: -p.x, y: p.y, z: -p.z }))];
}

/** Links for mirrored waypoint lists: each [a, b] also links the mirrored pair. */
function mirrorLinks(links: [number, number][], half: number): [number, number][] {
  return [...links, ...links.map(([a, b]) => [a + half, b + half] as [number, number])];
}

// ---- Map 1: Foundry Yard --------------------------------------------------------------
// Industrial yard: a raised central deck reached by stairs, shipping containers
// along both lanes, and corner gantries for height.

function foundry(): ArenaMap {
  const H = 2.4;
  const half: Piece[] = [
    // West half of the central deck + its stairs (east half comes from the mirror).
    box(-2.5, 0, 5, 8, H, 'platform'),
    ...stairs(-5, 'x', -1, -2.5, 2.5, H),
    box(-3.2, 3.8, 3.6, 0.4, 0.7, 'trim', H), // parapets
    box(-3.2, -3.8, 3.6, 0.4, 0.7, 'trim', H),
    // North lane containers and crates.
    box(-7, 11.5, 6, 2.5, 2.6, 'cover'),
    box(-1, 13.5, 1.2, 1.2, 1.2, 'accent'),
    box(-2.2, 13.5, 1.2, 1.2, 1.2, 'accent'),
    box(-1.6, 13.5, 1.2, 1.2, 2.4, 'accent'),
    // Mid-west cover.
    box(-11, 4, 1.2, 3, 1.3, 'cover'),
    box(-11, -6, 2.4, 1.2, 1.3, 'cover'),
    // Spawn shelter (west).
    box(-17, 5, 0.6, 5, 2.2, 'wall'),
    box(-15, -4, 3, 0.6, 2.2, 'wall'),
    // North-west gantry with stairs.
    box(-18, 14.5, 6, 4, 3, 'platform'),
    ...stairs(-15, 'x', 1, 13, 16.4, 3),
    box(-18, 12.6, 6, 0.3, 0.8, 'trim', 3),
  ];
  const boxes = [...shell(24, 18, 6), ...withMirror(half)];
  const westSpawns: SpawnPoint[] = [
    { x: -21, y: 0, z: 0, yaw: EAST },
    { x: -21, y: 0, z: -3, yaw: EAST },
    { x: -21, y: 0, z: 3, yaw: EAST },
    { x: -20, y: 0, z: 7, yaw: EAST },
  ];
  const wp = [
    { x: -20, y: 0, z: 0 }, // 0 spawn
    { x: -13, y: 0, z: 0 }, // 1 west mid
    { x: -8.5, y: 0, z: 0 }, // 2 stairs bottom
    { x: -3, y: H, z: 0 }, // 3 deck west
    { x: -13, y: 0, z: 9 }, // 4 north-west lane
    { x: -3, y: 0, z: 9 }, // 5 north mid lane
    { x: -12, y: 0, z: -9 }, // 6 south-west lane
    { x: -4, y: 0, z: -9 }, // 7 south mid lane
    { x: -10, y: 0, z: 15 }, // 8 gantry stairs bottom
    { x: -18, y: 3, z: 14.5 }, // 9 gantry top
    { x: -7, y: 0, z: 15.8 }, // 10 behind container
  ];
  const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [1, 6], [6, 7], [4, 8], [8, 9], [8, 10], [10, 5]];
  const n = wp.length;
  const allLinks = mirrorLinks(links, n);
  // Connect the halves across the middle.
  allLinks.push([3, 3 + n], [5, 7 + n], [7, 5 + n], [10, 10 + n]);
  return {
    id: 'foundry',
    name: 'Foundry Yard',
    description: 'Raised central deck, container lanes and corner gantries.',
    boxes,
    spawns: { team: [westSpawns, mirrorSpawns(westSpawns)], ffa: faceCentre([[-21, 0, -12], [21, 0, 12], [-8, 0, -15.5], [8, 0, 15.5], [-13, 0, 2], [13, 0, -2], [-3, 0, -7], [3, 0, 7]]) },
    waypoints: mirrorWaypoints(wp),
    links: allLinks,
    theme: { sky: 0x7fb2e0, horizon: 0xf0d2b0, fog: 0xe2c6a6, floor: 0x5d6472, wall: 0x9aa3b2, cover: 0xe0773a, platform: 0x7c8899, accent: 0x2fb3a6, trim: 0xf2c14e },
    bounds: { minX: -24, maxX: 24, minZ: -18, maxZ: 18 },
  };
}

// ---- Map 2: Sunken Courts ---------------------------------------------------------------
// Stone courtyard: raised terraces on the north and south edges overlook a
// pillared central court; stairs connect the levels.

function courts(): ArenaMap {
  const T = 2;
  const half: Piece[] = [
    // North terrace (west half) with stairs down into the court.
    box(-10, 13.5, 20, 7, T, 'platform'),
    ...stairs(10, 'z', -1, -16, -12, T),
    ...stairs(10, 'z', -1, -5, -1, T),
    box(-8.5, 10.2, 5, 0.4, 0.9, 'trim', T),
    box(-18, 10.2, 3.6, 0.4, 0.9, 'trim', T),
    // Court pillars and low walls.
    box(-5, 4, 1.2, 1.2, 4, 'pillar'),
    box(-12, 4, 1.2, 1.2, 4, 'pillar'),
    box(-8.5, 0, 3.5, 0.8, 1.2, 'cover'),
    box(-2, -1.5, 0.8, 3, 1.2, 'cover'),
    box(-15, -2, 2, 2, 1.6, 'accent'),
    // Spawn alcove walls.
    box(-18, 4, 4, 0.6, 3, 'wall'),
    box(-18, -4, 4, 0.6, 3, 'wall'),
  ];
  const boxes = [...shell(21, 17, 5), ...withMirror(half)];
  const westSpawns: SpawnPoint[] = [
    { x: -19, y: 0, z: 0, yaw: EAST },
    { x: -19, y: 0, z: -2, yaw: EAST },
    { x: -19, y: 0, z: 2, yaw: EAST },
    { x: -17, y: 0, z: 1, yaw: EAST },
  ];
  const wp = [
    { x: -18, y: 0, z: 0 }, // 0 spawn
    { x: -13, y: 0, z: 0 }, // 1
    { x: -8.5, y: 0, z: 2 }, // 2 court west
    { x: -4, y: 0, z: 1.5 }, // 3 court centre-west
    { x: -14, y: 0, z: 7 }, // 4 below north-west stairs
    { x: -14, y: T, z: 13 }, // 5 terrace west
    { x: -3, y: 0, z: 7 }, // 6 below north-centre stairs
    { x: -3, y: T, z: 13 }, // 7 terrace centre
    { x: -12, y: 0, z: -7 }, // 8 south-west court
    { x: -4, y: 0, z: -6 }, // 9 south centre
  ];
  const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 7], [6, 7], [3, 6], [2, 4], [1, 8], [8, 9], [9, 3]];
  const n = wp.length;
  const allLinks = mirrorLinks(links, n);
  allLinks.push([3, 3 + n], [7, 7 + n], [9, 6 + n], [6, 9 + n]);
  return {
    id: 'courts',
    name: 'Sunken Courts',
    description: 'Terraces overlook a pillared court. Control the high ground.',
    boxes,
    spawns: { team: [westSpawns, mirrorSpawns(westSpawns)], ffa: faceCentre([[-19, 0, 7], [19, 0, -7], [-10, 0, -8], [10, 0, 8], [-14, 2, 13], [14, 2, -13], [-3, 0, -12], [3, 0, 12]]) },
    waypoints: mirrorWaypoints(wp),
    links: allLinks,
    theme: { sky: 0x9fd0e6, horizon: 0xf3e2c0, fog: 0xead6b2, floor: 0xcbb38a, wall: 0xb39a74, cover: 0x8a7457, platform: 0xd8c39a, accent: 0x2fb3a6, trim: 0xe8dcc0 },
    bounds: { minX: -21, maxX: 21, minZ: -17, maxZ: 17 },
  };
}

// ---- Map 3: Skybridge ------------------------------------------------------------------
// Two towers joined by an exposed bridge; the ground floor below is a maze of
// low cover. Long sightlines on the bridge, close quarters underneath.

function skybridge(): ArenaMap {
  const T = 4;
  const half: Piece[] = [
    // West tower with stairs climbing along its north side.
    box(-16, 0, 8, 10, T, 'platform'),
    ...stairs(-12, 'x', 1, 2, 4.5, T, 0.4, 0.55),
    box(-16, 5.2, 8, 0.4, 1, 'trim', T),
    // Bridge (west half) with a mid cover block.
    box(-6, 0, 12, 3, 0.4, 'platform', T - 0.4),
    box(-6, -1.25, 12, 0.3, 0.9, 'trim', T),
    box(-3, 0.6, 1, 1.2, 1.1, 'cover', T),
    // Ground cover under and around the bridge.
    box(-7, 6, 3, 1, 1.4, 'cover'),
    box(-4, -6.5, 1, 4, 1.4, 'cover'),
    box(-9, -3, 1.6, 1.6, 1.6, 'accent'),
    box(-10, 10, 4, 1, 2.4, 'wall'),
    box(-2, 10.5, 1.2, 1.2, 1.2, 'accent'),
    // Bridge supports.
    box(-6, 1, 0.8, 0.8, T - 0.4, 'pillar'),
    box(-6, -1, 0.8, 0.8, T - 0.4, 'pillar'),
  ];
  const boxes = [...shell(22, 14, 7), ...withMirror(half)];
  const westSpawns: SpawnPoint[] = [
    { x: -21, y: 0, z: -8, yaw: EAST },
    { x: -21, y: 0, z: -11, yaw: EAST },
    { x: -18, y: 0, z: -11, yaw: EAST },
    { x: -21, y: 0, z: 9, yaw: EAST },
  ];
  const wp = [
    { x: -20, y: 0, z: -9 }, // 0 spawn
    { x: -11, y: 0, z: -8 }, // 1 south of tower
    { x: -14, y: 0, z: 8.5 }, // 2 north of tower
    { x: -6, y: 0, z: 8 }, // 3 north ground
    { x: -6, y: 0, z: -3 }, // 4 under bridge
    { x: -2, y: 0, z: -9 }, // 5 south mid
    { x: -6.5, y: 0, z: 3.2 }, // 6 stairs bottom
    { x: -15, y: T, z: 2.5 }, // 7 tower top
    { x: -6, y: T, z: 0 }, // 8 bridge west
  ];
  const links: [number, number][] = [[0, 1], [0, 2], [1, 4], [1, 5], [2, 3], [2, 6], [6, 7], [7, 8], [3, 4], [4, 5], [3, 6]];
  const n = wp.length;
  const allLinks = mirrorLinks(links, n);
  allLinks.push([8, 8 + n], [4, 4 + n], [5, 3 + n], [3, 5 + n]);
  return {
    id: 'skybridge',
    name: 'Skybridge',
    description: 'Two towers, one exposed bridge, and tight cover below.',
    boxes,
    spawns: { team: [westSpawns, mirrorSpawns(westSpawns)], ffa: faceCentre([[-21, 0, -11], [21, 0, 11], [-16, T, -3], [16, T, 3], [-3, 0, -11], [3, 0, 11], [-10, 0, 12], [10, 0, -12]]) },
    waypoints: mirrorWaypoints(wp),
    links: allLinks,
    theme: { sky: 0x2a2f5c, horizon: 0x8f6fc4, fog: 0x5b4a8a, floor: 0x343a52, wall: 0x4a4f72, cover: 0xb07cff, platform: 0x5d6488, accent: 0x2fd3c8, trim: 0xff7ac0 },
    bounds: { minX: -22, maxX: 22, minZ: -14, maxZ: 14 },
  };
}

/** Spawn points that look toward the middle of the map. */
function faceCentre(points: [number, number, number][]): SpawnPoint[] {
  return points.map(([x, y, z]) => ({ x, y, z, yaw: Math.atan2(x, z) }));
}

export const ARENA_MAPS: readonly ArenaMap[] = [foundry(), courts(), skybridge()];

export function arenaMap(index: number): ArenaMap {
  return ARENA_MAPS[((index % ARENA_MAPS.length) + ARENA_MAPS.length) % ARENA_MAPS.length];
}

export { EAST as YAW_EAST, WEST as YAW_WEST };
