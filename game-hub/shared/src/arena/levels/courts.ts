// ARENA_MAPS[1]: Sunken Courts (mirror symmetry across x = 0, 76 × 64 m). Sandstone courtyard: a colonnaded north
// terrace, gatehouses with roof balconies, a fountain launcher, and a hedge garden with a pavilion.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder, YAW_EAST } from '../mapkit';

export function courts(): ArenaMap {
  const b = new MapBuilder({ halfX: 38, halfZ: 32, wallH: 9, symmetry: 'mirrorX' });
  const T = 2.4;
  // ---- north terrace + colonnade -----------------------------------------------------------------------
  b.midRect(-30, -32, 30, -24, T, 'platform');
  b.rect(-38, -32, -30, -24, T, 'platform');
  b.rect(-38, -24, -33, -12, T, 'platform'); // west terrace down to the gatehouse
  b.stairs(-24, 'z', 1, -2.5, 2.5, T, 0, true); // centre flight
  b.stairs(-24, 'z', 1, -20, -16, T); // west flight
  b.stairs(-33, 'x', 1, -22, -19, T); // west terrace down into the court
  b.stairs(-12, 'z', -1, -38, -35, T, T); // west terrace up to the gatehouse roof
  for (const x of [-27, -21, -13, -7]) b.box(x, -24.6, 0.8, 0.8, 4.4, 'pillar', T);
  b.midRect(-30, -25, 30, -24.2, 0.6, 'trim', T + 4.4); // lintel
  // ---- gatehouse (west) with roof balcony -----------------------------------------------------------------
  b.room(-38, -12, -30, 12, 4.4, [
    { side: 'e', at: -6, width: 3 }, { side: 'e', at: 6, width: 3 },
    { side: 'n', at: -31.5, width: 2.4 }, { side: 's', at: -34, width: 3 },
  ], { roof: 0.4 });
  b.box(-34, 0, 1.2, 4, 4.4, 'pillar');
  b.rect(-30.4, -12, -30, -2, 0.9, 'trim', 4.8);
  b.rect(-30.4, 2, -30, 12, 0.9, 'trim', 4.8);
  // ---- court ---------------------------------------------------------------------------------------------
  b.rect(-5, -5, -1.5, -4.4, 0.9, 'trim'); // fountain basin rim (west half)
  b.rect(-5, 4.4, -1.5, 5, 0.9, 'trim');
  b.rect(-5, -4.4, -4.4, -1.5, 0.9, 'trim');
  b.rect(-5, 1.5, -4.4, 4.4, 0.9, 'trim');
  b.launcher(0, 0, 2, { x: 0, y: T, z: -28 }, 7, 0, true); // fountain launcher up to the terrace
  b.box(-12, -9, 4, 0.8, 1.2, 'cover');
  b.box(-20, 0, 0.8, 4, 1.2, 'cover');
  b.box(-10, 6, 2, 2, 1.0, 'accent');
  b.box(-16, -15, 1.2, 1.2, 4, 'pillar');
  b.box(-24, 6, 1.2, 1.2, 4, 'pillar');
  b.box(-25.5, -5, 0.8, 5, 2.2, 'wall');
  b.box(-8, -17, 1.6, 1.6, 1.3, 'accent');
  b.boost(-24, -17.5, 5, 2, YAW_EAST, 8);
  // ---- south garden + pavilion ----------------------------------------------------------------------------------
  b.midRect(-6, 20, 6, 30, 1.6, 'platform');
  b.stairs(20, 'z', -1, -2, 2, 1.6, 0, true);
  b.box(-5.4, 20.6, 0.8, 0.8, 4.0, 'pillar', 1.6);
  b.box(-5.4, 29.4, 0.8, 0.8, 4.0, 'pillar', 1.6);
  b.midRect(-6.5, 19.5, 6.5, 30.5, 0.4, 'platform', 5.6);
  b.trampoline(-10, 25, 2, 6.6);
  b.box(-14, 14, 8, 1.2, 1.9, 'cover');
  b.box(-22, 22, 1.2, 8, 1.9, 'cover');
  b.box(-27, 13, 6, 1.2, 1.0, 'cover');
  b.box(-14, 27.5, 6, 1.2, 1.9, 'cover');
  b.box(-31, 26, 1.2, 1.2, 1.2, 'accent');
  b.box(-16, 21, 1.4, 1.4, 2.6, 'accent');
  // ---- spawns & pickups -------------------------------------------------------------------------------------------
  for (const [x, z] of [[-36.5, -8], [-36.5, 8], [-36.5, -3.5], [-36.5, 3.5], [-31.5, -9], [-31.5, 9]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-24, T, -28).ffaSpawn(-27, 0, 19).ffaSpawn(-12, 0, -19).ffaSpawn(-19, 0, 29.5);
  b.pickup('ammo', -32, 0, 0).pickup('health', -20, 0, -8).pickup('ammo', -35.5, T, -18).pickup('health', 0, 1.6, 25, true);
  // ---- nav --------------------------------------------------------------------------------------------------------
  b.wp('gInN', -35.5, 0, -7).wp('gInS', -35.5, 0, 7).wp('gInE1', -31.8, 0, -6).wp('gInE2', -31.8, 0, 6)
    .wp('gDoorE1', -28, 0, -6).wp('gDoorE2', -28, 0, 6).wp('gDoorN', -31.5, 0, -14).wp('gDoorS', -34, 0, 14)
    .wp('gInNE', -31.8, 0, -10).wp('gInSW', -35.5, 0, 10.5)
    .wp('wtS', -36.5, T, -16.5).wp('wtN', -35.5, T, -22).wp('wtE', -34, T, -20.5).wp('downBot', -29.4, 0, -20.5)
    .wp('roofN', -36.5, 4.8, -10).wp('roofE', -31.5, 4.8, 0).wp('roofDrop', -27.5, 0, 0)
    .wp('tNW', -34, T, -28).wp('tW', -24, T, -28).wp('tWS', -18, T, -26.5).wp('stairBotW', -18, 0, -20.4)
    .wp('c1', -24, 0, -12).wp('c2', -12, 0, -12.5).wp('c3', -7.5, 0, 0).wp('c4', -16, 0, 4).wp('c5', -28.5, 0, 8)
    .wp('c6', -8, 0, 11).wp('c7', -20, 0, 10).wp('c8', -9, 0, -6).wp('basinW', -3, 0, 0)
    .wp('g1', -26, 0, 18).wp('g2', -18, 0, 17.5).wp('g3', -9.5, 0, 17).wp('g4', -8.5, 0, 22).wp('g5', -27, 0, 28.5).wp('g6', -18, 0, 30.5)
    .wp('pav', -2.5, 1.6, 24).wp('tramp', -10, 0.3, 25).wp('roof', -3, 6.0, 25);
  b.midWp('tC', 0, T, -28).midWp('tCS', 0, T, -25.3).midWp('stairBotC', 0, 0, -20.4).midWp('launch', 0, 0.3, 0)
    .midWp('pavStairBot', 0, 0, 17.4).midWp('pavC', 0, 1.6, 22);
  b.link('wtS', 'roofN').link('wtE', 'downBot').link('tWS', 'stairBotW').link('tCS', 'stairBotC')
    .link('roofE', 'roofDrop', 'drop').link('gInE1', 'gDoorE1').link('gInE2', 'gDoorE2').link('gInNE', 'gDoorN').link('gInSW', 'gDoorS')
    .link('basinW', 'launch').link('launch', 'tC', 'pad').link('pavStairBot', 'pavC').link('pavC', 'pav')
    .link('g4', 'tramp').link('g3', 'tramp').link('tramp', 'roof', 'pad').link('roof', 'g4', 'drop');
  return b.build({
    id: 'courts',
    name: 'Sunken Courts',
    description: 'A colonnaded terrace over a fountain court, gatehouse balconies and a hedge garden pavilion.',
    tags: ['Large', 'High ground', 'Launch pad'],
    theme: { sky: 0x9fd0e6, horizon: 0xf3e2c0, fog: 0xead6b2, floor: 0xcbb38a, wall: 0xb39a74, cover: 0x6f8f4e, platform: 0xd8c39a, accent: 0x2fb3a6, trim: 0xe8dcc0, pad: 0xff9d2e, fogNear: 50, fogFar: 150 },
  });
}
