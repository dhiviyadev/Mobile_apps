/**
 * Test and dev fixtures (tree-shaken from production bundles): a flat open map
 * for tests that should not depend on real map geometry, a deck with stairs,
 * and a command builder. Shared and server tests import them; dev builds
 * expose flatArenaMap as window.__arenaFixtures for the browser tests.
 */
import type { LaunchPad } from './geometry';
import type { ArenaMap, MapBox, MapPickup, SpawnPoint } from './mapTypes';
import type { Command } from './player';

export interface FlatMapOptions {
  /** Half size of the square floor (m). Default 50. */
  half?: number;
  boxes?: MapBox[];
  pads?: LaunchPad[];
  pickups?: MapPickup[];
}

/**
 * Open flat map (mapIndex -1): team spawns at x = ±0.6·half facing each other, 8 FFA spawns facing the centre,
 * a 3×3 waypoint grid at x, z ∈ {-10, 0, 10}, empty links, neutral theme (fog 30/85).
 */
export function flatArenaMap(o: FlatMapOptions = {}): ArenaMap {
  const h = o.half ?? 50;
  const s = h * 0.6;
  const team0: SpawnPoint[] = [-3, 0, 3].map((z) => ({ x: -s, y: 0, z, yaw: -Math.PI / 2 }));
  const ffa: SpawnPoint[] = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * s;
    const z = Math.sin(a) * s;
    return { x, y: 0, z, yaw: Math.atan2(x, z) };
  });
  const grid = [-10, 0, 10].flatMap((x) => [-10, 0, 10].map((z) => ({ x, y: 0, z })));
  return {
    id: 'fixture-flat',
    name: 'Fixture',
    description: '',
    tags: [],
    boxes: [{ minX: -h - 1, maxX: h + 1, minY: -1, maxY: 0, minZ: -h - 1, maxZ: h + 1, kind: 'floor' }, ...(o.boxes ?? [])],
    pads: o.pads ?? [],
    pickups: o.pickups ?? [],
    spawns: { team: [team0, team0.map((p) => ({ x: -p.x, y: 0, z: -p.z, yaw: Math.PI / 2 }))], ffa },
    waypoints: grid,
    links: [],
    theme: {
      sky: 0x9fc4e8, horizon: 0xe8e0d0, fog: 0xdcd6cc, floor: 0x6b7280, wall: 0x9aa3b2, cover: 0xe0773a,
      platform: 0x7c8899, accent: 0x2fb3a6, trim: 0xf2c14e, pad: 0x45d7ff, fogNear: 30, fogFar: 85,
    },
    bounds: { minX: -h, maxX: h, minZ: -h, maxZ: h },
  };
}

/**
 * A deck (x, z ∈ [-4, 4], top 2.4) with stairs down its west side (5 steps, rise 0.4, run 0.6,
 * z ∈ [-2, 2]) on a flat floor: the shape of the old Foundry centre, for movement tests.
 */
export function deckWithStairs(): MapBox[] {
  const deck = 2.4;
  const rise = 0.4;
  const run = 0.6;
  const boxes: MapBox[] = [
    { minX: -50, maxX: 50, minY: -1, maxY: 0, minZ: -50, maxZ: 50, kind: 'platform' },
    { minX: -4, maxX: 4, minY: 0, maxY: deck, minZ: -4, maxZ: 4, kind: 'platform' },
  ];
  const steps = Math.round(deck / rise) - 1;
  for (let k = 0; k < steps; k++) {
    boxes.push({ minX: -4 - (k + 1) * run, maxX: -4 - k * run, minY: 0, maxY: deck - rise * (k + 1), minZ: -2, maxZ: 2, kind: 'stairs' });
  }
  return boxes;
}

export const makeCommand = (seq: number, over: Partial<Command> = {}): Command => ({
  seq, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, slot: 255, viewTick: 0, ...over,
});
