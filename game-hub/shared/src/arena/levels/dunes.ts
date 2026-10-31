// ARENA_MAPS[4]: Dune Relay (point symmetry, 96 × 64 m). Desert relay station: a 9 m relay tower in the middle reached only
// by launch pads, walkable stepped dunes, a ruined wall line, a rock spire, and slit-windowed spawn bunkers.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder, YAW_EAST } from '../mapkit';

export function dunes(): ArenaMap {
  const b = new MapBuilder({ halfX: 48, halfZ: 32, wallH: 8, symmetry: 'point' });
  const TOP = 9.2;
  // ---- relay tower ------------------------------------------------------------------------------------------
  b.midRect(-3, -3, 3, 3, TOP - 0.4, 'pillar');
  b.midRect(-5, -5, 5, 5, 0.4, 'platform', TOP - 0.4);
  b.rect(-5, -5, -1.4, -4.6, 1.0, 'trim', TOP);
  b.rect(-5, 4.6, -1.4, 5, 1.0, 'trim', TOP);
  b.rect(-5, -4.6, -4.6, -1.4, 1.0, 'trim', TOP);
  b.rect(-5, 1.4, -4.6, 4.6, 1.0, 'trim', TOP);
  b.box(-3, 0, 0.6, 1.6, 1.1, 'cover', TOP); // deck cover, clear of the launcher landing zones
  b.launcher(0, -13, 2, { x: 0, y: TOP, z: -2.4 }, 11);
  // ---- spawn bunker (west) ----------------------------------------------------------------------------------------
  b.room(-48, -6, -38, 6, 3.2, [
    { side: 'e', at: -3.5, width: 2.4 }, { side: 'e', at: 0, width: 4.6, height: 1.7 }, { side: 'e', at: 3.5, width: 2.4 },
    { side: 'n', at: -43, width: 2.4 }, { side: 's', at: -43, width: 2.4 },
  ], { roof: 0.4 });
  b.rect(-38.6, -2.3, -38, 2.3, 1.2, 'wall'); // sill under the firing slit (slit 1.2–1.7 m)
  b.box(-36.8, 8.4, 1.6, 1.6, 1.2, 'accent'); // sandbag steps to the bunker roof
  b.box(-36.8, 6.8, 1.6, 1.6, 2.4, 'accent');
  b.rect(-48, -6.4, -44, -6, 0.9, 'trim', 3.6);
  // ---- dunes, ruins, wreck, spire ------------------------------------------------------------------------------------
  b.mound(-24, -18, 16, 12, 5);
  b.mound(-21, 14, 12, 12, 4);
  b.mound(-11, -4, 8, 12, 3);
  b.mound(-38, 24, 9, 9, 3);
  b.rect(-30.4, -26, -29.6, -20, 2.6, 'wall');
  b.rect(-30.4, -12, -29.6, -6, 1.6, 'wall');
  b.rect(-30.4, 5, -29.6, 11, 2.6, 'wall');
  b.rect(-30.4, 22, -29.6, 28, 1.6, 'wall');
  b.box(-30, 0, 1.2, 1.2, 4.0, 'pillar');
  b.box(-14, 24, 7, 3, 1.4, 'cover'); // wrecked hauler
  b.box(-9.5, 24, 2, 3, 2.6, 'accent');
  b.box(-20, -28.5, 4, 4, 4.8, 'accent'); // rock spire
  b.trampoline(-14.5, -28.5, 2, 5.6);
  b.box(-6, -19, 1.6, 1.6, 1.3, 'accent');
  b.box(-6, 12, 2.4, 1.2, 1.3, 'cover');
  b.box(-34, -14, 1.2, 3, 1.3, 'cover');
  b.boost(-36, -29.5, 6, 2, YAW_EAST, 9);
  // ---- spawns & pickups ----------------------------------------------------------------------------------------------------
  for (const [x, z] of [[-46, -3], [-46, 3], [-43.5, -4.5], [-43.5, 4.5], [-40.5, -1.5], [-40.5, 1.5]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-41, 0, -26).ffaSpawn(-24, 2.0, -18).ffaSpawn(-12, 0, 18).ffaSpawn(-6, 0, -26);
  b.pickup('ammo', -45, 0, 0).pickup('health', -21, 1.6, 14).pickup('ammo', -20, 4.8, -29).pickup('health', 0, TOP, 0, true);
  // ---- nav ---------------------------------------------------------------------------------------------------------------------
  b.wp('bIn', -45, 0, -2).wp('bInE1', -40, 0, -3.5).wp('bInE2', -40, 0, 3.5).wp('bDoorE1', -35.8, 0, -3.5).wp('bDoorE2', -35.8, 0, 3.5)
    .wp('bInN', -43, 0, -4.5).wp('bInS', -43, 0, 4.5).wp('bDoorN', -43, 0, -8.5).wp('bDoorS', -43, 0, 8.5)
    .wp('crateBase', -34.5, 0, 9.5).wp('crate1', -36.8, 1.2, 8.4).wp('crate2', -36.8, 2.4, 6.8).wp('bRoof', -41, 3.6, 4).wp('bRoofDrop', -36.3, 0, -1.2)
    .wp('n1', -40, 0, -24).wp('n2', -26, 0, -29).wp('n3', -9, 0, -29.5).wp('n4', -3, 0, -24)
    .wp('duneA', -24, 2.0, -18).wp('duneAW', -33.5, 0, -18).wp('duneAE', -14.5, 0, -16)
    .wp('m1', -26, 0, -6).wp('m2', -18, 0, 2).wp('m3', -34, 0, 4).wp('m4', -26, 0, 22).wp('m5', -12, 0, 8).wp('m6', -6, 0, -10)
    .wp('duneB', -21, 1.6, 14).wp('duneC', -11, 1.2, -4).wp('duneD', -38, 1.2, 24)
    .wp('s1', -34, 0, 29).wp('s2', -16, 0, 29.5).wp('s3', -4, 0, 19)
    .wp('launch', 0, 0.3, -13).wp('launchApproach', -4.5, 0, -15).wp('top', 0, TOP, -2.4).wp('topW', -4, TOP, -1.2).wp('topDrop', 0, 0, -8)
    .wp('trampS', -14.5, 0.3, -28.5).wp('spire', -20, 4.8, -27.8).wp('spireDrop', -24.5, 0, -28.5).wp('m7', -34, 0, 17);
  b.link('bIn', 'bInE1').link('bIn', 'bInN').link('bIn', 'bInS').link('bInE1', 'bDoorE1').link('bInE2', 'bDoorE2').link('bInN', 'bDoorN').link('bInS', 'bDoorS')
    .link('crateBase', 'crate1', 'jump').link('crate1', 'crate2', 'jump').link('crate2', 'bRoof', 'jump', true).link('bRoof', 'bRoofDrop', 'drop')
    .link('launchApproach', 'launch').link('n4', 'launch').link('launch', 'top', 'pad').link('top', 'topW').link('top', 'topDrop', 'drop')
    .link('n3', 'trampS').link('duneAE', 'trampS').link('trampS', 'spire', 'pad').link('spire', 'spireDrop', 'drop')
    .link('duneA', 'duneAW').link('duneA', 'duneAE').link('duneB', 'm4').link('duneB', 'm2').link('duneC', 'm2').link('duneC', 'm6').link('duneD', 's1').link('duneD', 'm7');
  return b.build({
    id: 'dunes',
    name: 'Dune Relay',
    description: 'Open dunes around a relay tower you can only reach by launch pad. Long lines, little shade.',
    tags: ['Largest', 'Long range', 'Launch pads'],
    theme: { sky: 0x8ec9f0, horizon: 0xf7dcb0, fog: 0xf0d6a8, floor: 0xd9b77e, wall: 0xb58a5a, cover: 0xe6c992, platform: 0x9a8f86, accent: 0xc0603a, trim: 0xf3e5c8, pad: 0x3fe0ff, fogNear: 60, fogFar: 170 },
  });
}
