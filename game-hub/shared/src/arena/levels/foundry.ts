// ARENA_MAPS[0]: Foundry Yard (point symmetry, 84 × 56 m). Industrial yard: smelter halls with walkable roofs,
// a raised central casting deck, a north gantry, a container stack and a long warehouse corridor.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder } from '../mapkit';

export function foundry(): ArenaMap {
  const b = new MapBuilder({ halfX: 42, halfZ: 28, wallH: 10, symmetry: 'point' });
  const DECK = 3.2;
  const ROOF = 5.2; // hall walls 4.8 + 0.4 slab
  // ---- smelter hall (west) ----------------------------------------------------------------------------
  b.room(-32, -9, -20, 9, 4.8, [
    { side: 'w', at: -5, width: 3 }, { side: 'w', at: 5, width: 3 },
    { side: 'e', at: 0, width: 4 },
    { side: 'n', at: -26, width: 4 },
  ], { roof: 0.4 });
  b.box(-29.5, 0, 2.4, 3, 2.2, 'accent'); // furnace
  b.box(-23.5, -5.5, 1.6, 1.6, 1.2, 'cover');
  b.box(-23.5, 5.5, 1.6, 1.6, 1.2, 'cover');
  // roof stairs on the south side: landing block + 12 steps climbing east
  b.rect(-22.5, 9, -20, 11.5, ROOF, 'platform');
  b.stairs(-22.5, 'x', -1, 9, 11.5, ROOF);
  b.rect(-32, -9.4, -26, -9, 0.9, 'trim', ROOF); // roof parapet (north-west)
  // trampoline beside the east wall up to the roof
  b.trampoline(-18.2, -6, 2, 6);
  // ---- central casting deck ---------------------------------------------------------------------------
  b.midRect(-7, -6, 7, 6, DECK, 'platform');
  b.stairs(-7, 'x', -1, -2, 2, DECK);
  b.rect(-7, -6, -2.5, -5.6, 0.9, 'trim', DECK);
  b.rect(-7, 5.6, -2.5, 6, 0.9, 'trim', DECK);
  b.midBox(0, 0, 2.2, 2.2, 1.3, 'accent', DECK); // crucible
  b.launcher(-16, -4.5, 2, { x: -3.5, y: DECK, z: -3.5 }, 6.5);
  // mid-yard cover
  b.box(-13, 6.5, 1.2, 3.2, 1.3, 'cover');
  b.box(-13.5, -10, 3, 1.2, 1.3, 'cover');
  b.box(-4, -9, 2.4, 1.2, 1.1, 'cover');
  b.box(-4, 9.5, 1.2, 1.2, 2.2, 'accent');
  // ---- north yard: gantry, containers, stack ---------------------------------------------------------------
  b.rect(-30, -28, -12, -24.5, 4.4, 'platform');
  b.stairs(-30, 'x', -1, -28, -25.4, 4.4);
  b.rect(-28, -24.9, -15, -24.5, 0.9, 'trim', 4.4);
  b.box(-22, -18, 6.5, 2.6, 2.7, 'cover'); // container A
  b.box(-32.5, -16.5, 2.6, 6.5, 2.7, 'cover'); // container B (spawn side)
  b.box(-6, -20, 6.5, 2.6, 2.7, 'cover'); // stack: two containers side by side, a third on top
  b.box(-6, -17.4, 6.5, 2.6, 2.7, 'cover');
  b.box(-6, -18.7, 6.5, 5.2, 2.7, 'accent', 2.7);
  b.trampoline(-6, -13.4, 2, 6.6);
  b.box(-12, -19, 1.2, 3, 1.3, 'cover');
  b.box(-15, 4.5, 2.4, 1.2, 1.1, 'cover');
  b.boost(-21, -12.5, 5, 2, -Math.PI / 2, 8); // north lane speed strip, pushes east
  // ---- south yard: warehouse corridor ------------------------------------------------------------------------
  b.room(-27, 15, -9, 22, 3.6, [
    { side: 'w', at: 18.5, width: 3 }, { side: 'e', at: 18.5, width: 3 }, { side: 'n', at: -18, width: 3 },
  ], { roof: 0.4 });
  b.box(-22.5, 18.5, 0.8, 0.8, 3.6, 'pillar');
  b.box(-13.5, 18.5, 0.8, 0.8, 3.6, 'pillar');
  b.box(-13, 12, 2, 2, 1.4, 'accent'); // crates up to the warehouse roof
  b.box(-13, 14, 2, 2, 2.8, 'accent');
  b.box(-34, 20, 2.6, 6.5, 2.7, 'cover'); // container C
  b.box(-30, 25.5, 1.4, 1.4, 1.4, 'accent');
  // ---- spawn yard ---------------------------------------------------------------------------------------
  b.box(-36, 0, 0.8, 3, 1.4, 'cover');
  for (const [z, x] of [[-2, -39], [2, -39], [-5.5, -37.5], [5.5, -37.5], [-9, -40], [9, -40]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-38, 0, -22).ffaSpawn(-20, 0, 25).ffaSpawn(-25.5, 0, -3).ffaSpawn(-10, 0, -14);
  // ---- pickups ------------------------------------------------------------------------------------------------
  b.pickup('ammo', -25.5, 0, 0).pickup('health', -4, DECK, 3.8).pickup('health', -18, 0, 18.5).pickup('ammo', -21, 4.4, -26.2);
  // ---- nav ---------------------------------------------------------------------------------------------------
  b.wp('spawn', -38, 0, 0).wp('spawnN', -38, 0, -11).wp('spawnS', -38, 0, 12)
    .wp('doorWN', -34, 0, -5).wp('doorWS', -34, 0, 5)
    .wp('hallW', -27, 0, -4).wp('hallWS', -27, 0, 4).wp('hallE', -22.5, 0, 0).wp('hallN', -26, 0, -6.5)
    .wp('eastDoor', -17.5, 0, 0).wp('northDoor', -26, 0, -11.5)
    .wp('stairsBot', -12.5, 0, 0).wp('deckW', -4.5, DECK, 0).wp('deckN', -4, DECK, -3.8).wp('deckS', -4, DECK, 3.8)
    .wp('launch', -16, 0.3, -4.5).wp('deckNW', -3.5, DECK, -3.5)
    .wp('tramp', -18.2, 0.3, -6).wp('roofE', -22.5, ROOF, -5).wp('roofW', -30, ROOF, 0).wp('roofS', -24, ROOF, 7)
    .wp('landing', -21.25, ROOF, 10.25).wp('roofStairsBot', -30.6, 0, 10.25)
    .wp('laneW', -30, 0, -12.5).wp('laneE', -15, 0, -13.5).wp('midN', -8, 0, -8).wp('midS', -8.5, 0, 8.5)
    .wp('nCentre', -1, 0, -10).wp('sCentre', -1, 0, 12.5)
    .wp('gantryBot', -36.8, 0, -26.5).wp('gantryW', -28, 4.4, -26.2).wp('gantryE', -13.5, 4.4, -26.2).wp('gantryDrop', -9.5, 0, -26)
    .wp('containers', -22, 0, -22).wp('containersE', -14, 0, -22.5).wp('containersW', -29.5, 0, -21.5).wp('stackTramp', -6, 0.3, -13.4).wp('stackTop', -6, 5.4, -18.5).wp('stackDrop', -6, 0, -24.5)
    .wp('stackApproach', -9.5, 0, -11.5)
    .wp('crate1', -13, 1.4, 12).wp('crate2', -13, 2.8, 14).wp('wRoof', -13, 4.0, 18.5).wp('wRoofW', -24, 4.0, 18.5)
    .wp('wDoorW', -29.5, 0, 18.5).wp('wIn1', -23.5, 0, 17).wp('wIn2', -13.5, 0, 20.5).wp('wDoorE', -6.5, 0, 18.5).wp('wDoorN', -18, 0, 12.8)
    .wp('alleyW', -27, 0, 25).wp('alleyMid', -19, 0, 25.3).wp('alleyE', -11, 0, 25.5).wp('wSE', -7.5, 0, 24).wp('crateBase', -15.5, 0, 10);
  b.link('stairsBot', 'deckW').link('roofStairsBot', 'landing').link('landing', 'roofS')
    .link('gantryBot', 'gantryW').link('gantryE', 'gantryDrop', 'drop')
    .link('eastDoor', 'launch').link('stairsBot', 'launch').link('launch', 'deckNW', 'pad')
    .link('eastDoor', 'tramp').link('tramp', 'roofE', 'pad')
    .link('stackApproach', 'stackTramp').link('stackTramp', 'stackTop', 'pad').link('stackTop', 'stackDrop', 'drop')
    .link('crateBase', 'crate1', 'jump').link('crate1', 'crate2', 'jump').link('crate2', 'wRoof', 'jump')
    .link('wRoofW', 'alleyW', 'drop').link('roofW', 'spawn', 'drop').link('deckN', 'midN', 'drop').link('deckS', 'midS', 'drop')
    .link('hallN', 'northDoor').link('hallE', 'eastDoor').link('doorWN', 'hallW').link('doorWS', 'hallWS');
  return b.build({
    id: 'foundry',
    name: 'Foundry Yard',
    description: 'Smelter halls with walkable roofs, a raised casting deck, a gantry and a long warehouse corridor.',
    tags: ['Large', '5 levels', 'Mixed range'],
    theme: { sky: 0x7fb2e0, horizon: 0xf0d2b0, fog: 0xe2c6a6, floor: 0x5d6472, wall: 0x9aa3b2, cover: 0xe0773a, platform: 0x7c8899, accent: 0x2fb3a6, trim: 0xf2c14e, pad: 0x45d7ff, fogNear: 50, fogFar: 150 },
  });
}
