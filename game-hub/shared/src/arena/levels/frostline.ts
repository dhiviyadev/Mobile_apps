// ARENA_MAPS[5]: Frostline Depot (mirror symmetry across x = 0, 88 × 60 m). Snowy rail yard: raised rail cars you can
// slide under or bounce on top of, a signal box on stilts, warehouses with roof stairs, and snow drifts.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder, YAW_EAST } from '../mapkit';

export function frostline(): ArenaMap {
  const b = new MapBuilder({ halfX: 44, halfZ: 30, wallH: 9, symmetry: 'mirrorX' });
  const CAR = 4.0; // rail car roof
  const SIG = 4.4; // signal box deck
  const car = (x0: number, x1: number, z: number) => {
    b.rect(x0, z - 1.5, x1, z + 1.5, CAR - 1.5, 'cover', 1.5); // body on bogies: 1.5 m slide-under clearance
    b.rect(x0 + 0.6, z - 1.3, x0 + 1.8, z + 1.3, 1.5, 'pillar');
    b.rect(x1 - 1.8, z - 1.3, x1 - 0.6, z + 1.3, 1.5, 'pillar');
    b.rect(x0, z - 1.6, x1, z - 1.5, 0.3, 'trim', CAR - 0.3);
  };
  // ---- rails and cars ----------------------------------------------------------------------------------------
  for (const z of [-16, 0, 16]) for (const o of [-0.8, 0.65]) b.midRect(-36, z + o, 36, z + o + 0.15, 0.12, 'trim');
  car(-33, -22, -16);
  car(-18.5, -6, -16);
  car(-26, -15, 0);
  car(-30, -19, 16);
  car(-12, -1.2, 16);
  b.midRect(-8, -1.5, 8, 1.5, 1.4, 'platform'); // flatcar (solid, 1.4 m: jump onto it)
  b.box(-5, 0, 2.4, 2.4, 1.4, 'wall', 1.4);
  b.trampoline(-27.5, -11.5, 2, 5.0);
  b.trampoline(-20.5, 4.5, 2, 5.0);
  // ---- signal box on stilts ------------------------------------------------------------------------------------------
  b.midRect(-7, -30, 7, -19.5, 0.4, 'platform', SIG - 0.4); // deck: 4 m clear in front of the cabin for launcher landings
  for (const [x, z] of [[-6.4, -20], [-6.4, -29.4]]) b.box(x, z, 0.8, 0.8, SIG - 0.4, 'pillar');
  b.stairs(-7, 'x', -1, -24, -21.5, SIG);
  b.room(-4, -30, 4, -24, 2.4, [{ side: 's', at: 0, width: 3 }, { side: 'w', at: -27, width: 2 }, { side: 'e', at: -27, width: 2 }], { mid: true, y: SIG, roof: 0.4 });
  b.launcher(-28, -25, 2, { x: -5.5, y: SIG, z: -22.4 }, 7);
  // ---- warehouse (west spawn) with roof stairs ------------------------------------------------------------------------
  b.room(-44, -10, -34, 10, 4.8, [{ side: 'e', at: -5, width: 3 }, { side: 'e', at: 5, width: 3 }, { side: 's', at: -39, width: 3 }], { roof: 0.4 });
  b.box(-40, 0, 2.4, 2.4, 1.4, 'wall');
  b.rect(-44, -12.5, -41.5, -10, 5.2, 'platform'); // landing at the west end
  b.stairs(-41.5, 'x', 1, -12.5, -10, 5.2); // climbs west along the north wall
  b.rect(-44, 9.6, -40, 10, 0.9, 'trim', 5.2);
  // ---- yard: drifts, crates, strip ------------------------------------------------------------------------------------------
  b.mound(-28, 24, 10, 6, 3, 1.0, 'accent'); // snow drifts
  b.mound(-10, 25, 8, 6, 2, 1.0, 'accent');
  b.mound(-36, -24, 6, 6, 2, 1.0, 'accent');
  b.box(-14, 8, 2.4, 2.4, 1.4, 'wall');
  b.box(-31, 8, 3, 1.2, 1.3, 'cover');
  b.box(-9, -8, 1.2, 3, 1.3, 'cover');
  b.box(-20, -25, 1.2, 3, 1.3, 'cover');
  b.box(-3, 8.5, 1.2, 1.2, 2.2, 'wall');
  b.boost(-26, 28, 6, 2, YAW_EAST, 9);
  // ---- spawns & pickups -------------------------------------------------------------------------------------------------------
  for (const [x, z] of [[-42, -6], [-42, 6], [-42, -2.5], [-42, 2.5], [-37, -7], [-37, 7]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-41.5, 0, -24.5).ffaSpawn(-27, CAR, -16).ffaSpawn(-10, 0, 8).ffaSpawn(-17, 0, 27);
  b.pickup('ammo', -37, 0, 0).pickup('health', -20.5, CAR, 0).pickup('ammo', -12, 0, 21).pickup('health', 0, SIG, -27, true);
  // ---- nav ------------------------------------------------------------------------------------------------------------------------
  b.wp('wIn', -42, 0, 0).wp('wInN', -37.5, 0, -5).wp('wInS', -37.5, 0, 5).wp('wInSW', -39, 0, 8)
    .wp('wDoorE1', -31.8, 0, -5).wp('wDoorE2', -31.8, 0, 5).wp('wDoorS', -39, 0, 12.5)
    .wp('roofBot', -33.4, 0, -11.25).wp('roofLanding', -42.75, 5.2, -11.25).wp('roof', -38, 5.2, -6).wp('roofDrop', -31.5, 0, -2)
    .wp('n1', -41, 0, -19.5).wp('nw', -41, 0, -28.5).wp('n2', -26, 0, -21).wp('n3', -15, 0, -21).wp('sigBot', -13.8, 0, -22.75).wp('sigW', -6, SIG, -22.5)
    .wp('launch', -28, 0.3, -25).wp('launchApproach', -32, 0, -27.5)
    .wp('t1', -27.5, 0.3, -11.5).wp('carA', -27.5, CAR, -16).wp('carB', -11.5, CAR, -16).wp('carDropN', -11.5, 0, -11.5)
    .wp('m1', -30, 0, -8).wp('m2', -20, 0, -8).wp('m3', -8, 0, -11).wp('m4', -30, 0, 5).wp('m5', -12, 0, 5).wp('m6', -20, 0, 8.5)
    .wp('t2', -20.5, 0.3, 4.5).wp('carC', -20.5, CAR, 0).wp('carCDrop', -20.5, 0, -4.5)
    .wp('flat', -2.5, 1.4, 0).wp('flatW', -10, 0, 0)
    .wp('s1', -36, 0, 12).wp('s2', -24, 0, 11.5).wp('s3', -14, 0, 11.5).wp('s4', -34, 0, 21).wp('s5', -20, 0, 21.5).wp('s6', -4, 0, 21)
    .wp('s9', -12, 0, 20.5).wp('s7', -36, 0, 27.5).wp('s8', -16, 0, 27.5).wp('drift', -28, 1.2, 24);
  b.midWp('sigS', 0, SIG, -22).midWp('cabin', 0, SIG, -27).midWp('flatC', 0, 1.4, -0.9);
  b.link('wIn', 'wInN').link('wIn', 'wInS').link('wInN', 'wDoorE1').link('wInS', 'wDoorE2').link('wInSW', 'wDoorS').link('wInS', 'wInSW')
    .link('roofBot', 'roofLanding').link('roofLanding', 'roof').link('roof', 'roofDrop', 'drop')
    .link('sigBot', 'sigW').link('sigW', 'sigS').link('sigS', 'cabin')
    .link('n1', 'nw').link('nw', 'launchApproach').link('launchApproach', 'launch').link('n2', 'launch').link('launch', 'sigW', 'pad')
    .link('m1', 't1').link('m2', 't1').link('t1', 'carA', 'pad').link('carA', 'carB', 'jump').link('carB', 'carDropN', 'drop')
    .link('m6', 't2').link('s2', 't2').link('t2', 'carC', 'pad').link('carC', 'carCDrop', 'drop')
    .link('flatW', 'flat', 'jump').link('flat', 'flatC').link('drift', 's4').link('drift', 's5');
  return b.build({
    id: 'frostline',
    name: 'Frostline Depot',
    description: 'A snowy rail yard: slide under raised cars or bounce onto their roofs; a signal box watches the tracks.',
    tags: ['Large', 'Slide routes', 'Trampolines'],
    theme: { sky: 0xa9c6e8, horizon: 0xe8f0f8, fog: 0xdfe8f2, floor: 0xe9eef3, wall: 0x7d8a99, cover: 0xb8423a, platform: 0x6f7c8c, accent: 0xd3dfeb, trim: 0x2b2f36, pad: 0xffb02e, fogNear: 45, fogFar: 140 },
  });
}
