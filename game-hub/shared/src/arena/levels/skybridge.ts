// ARENA_MAPS[2]: Skybridge (point symmetry, 92 × 48 m). Night district: two towers joined by a 56 m bridge with
// mid-span balconies; underneath, close-quarters cover, raised platforms and a slide-under duct wall.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder, YAW_EAST } from '../mapkit';

export function skybridge(): ArenaMap {
  const b = new MapBuilder({ halfX: 46, halfZ: 24, wallH: 12, symmetry: 'point' });
  const TOP = 6.0;
  // ---- west tower: ground room + roof deck ---------------------------------------------------------------
  b.room(-38, -7, -28, 7, 5.6, [
    { side: 'w', at: 0, width: 3 }, { side: 'e', at: -4, width: 3 }, { side: 's', at: -35, width: 3 },
  ], { roof: 0.4 });
  b.box(-33, 1.5, 3, 1.2, 1.3, 'cover');
  b.rect(-38, -7, -30.5, -6.6, 1.0, 'trim', TOP);
  b.rect(-38, 6.6, -33, 7, 1.0, 'trim', TOP);
  b.rect(-38, -6.6, -37.6, 6.6, 1.0, 'trim', TOP);
  b.rect(-28.4, -6.6, -28, -1.5, 1.0, 'trim', TOP);
  b.rect(-28.4, 1.5, -28, 6.6, 1.0, 'trim', TOP);
  b.rect(-30.5, -10, -28, -7, TOP, 'platform'); // stair landing
  b.stairs(-30.5, 'x', -1, -10, -7.6, TOP);
  b.trampoline(-30.5, 10.5, 2, 7.2);
  // ---- bridge ------------------------------------------------------------------------------------------------
  b.midRect(-28, -1.5, 28, 1.5, 0.4, 'platform', TOP - 0.4);
  b.box(-14, 0, 6, 6, 0.4, 'platform', TOP - 0.4); // balcony
  b.rect(-28, -1.5, -17, -1.3, 0.5, 'trim', TOP);
  b.rect(-28, 1.3, -17, 1.5, 0.5, 'trim', TOP);
  b.rect(-11, -1.5, 0, -1.3, 0.5, 'trim', TOP);
  b.rect(-11, 1.3, 0, 1.5, 0.5, 'trim', TOP);
  b.box(-7, 0.6, 1.0, 1.4, 1.2, 'cover', TOP);
  b.box(-14, 0, 1, 1, TOP - 0.4, 'pillar');
  b.box(-24, 0, 0.8, 0.8, TOP - 0.4, 'pillar');
  b.midBox(0, 0, 1.4, 1.4, TOP - 0.4, 'pillar');
  b.trampoline(-14, 6.8, 2, 6.8);
  // ---- ground floor -------------------------------------------------------------------------------------------
  b.rect(-22, -17, -14, -11, 2.8, 'platform'); // north platform
  b.stairs(-22, 'x', -1, -17, -14, 2.8);
  b.rect(-10, -24, -9, -13, 3.0, 'wall', 1.5); // slide-under duct wall (1.5 m clearance)
  b.box(-6, 8, 3, 1, 1.4, 'cover');
  b.box(-4, -6, 1, 4, 1.4, 'cover');
  b.box(-19, 4, 1.6, 1.6, 1.6, 'accent');
  b.box(-24, 13, 4, 1, 2.4, 'wall');
  b.box(-9, 14, 1.2, 1.2, 1.2, 'accent');
  b.box(-20, -4.5, 1.2, 3, 1.3, 'cover');
  b.box(-36.5, 17, 3, 3, 2.0, 'accent');
  b.box(-17, 20, 1.2, 4, 1.3, 'cover');
  b.box(-2.5, -15, 3, 3, 2.0, 'accent');
  b.boost(-30, 19, 5, 2, YAW_EAST, 8);
  // ---- spawns & pickups ------------------------------------------------------------------------------------------
  for (const [x, z] of [[-43, -3], [-43, 3], [-42, -8], [-42, 8], [-44, -12], [-44, 12]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-33, TOP, -3).ffaSpawn(-20, 0, -21).ffaSpawn(-6, 0, 12).ffaSpawn(-42, 0, 20);
  b.pickup('ammo', -33, 0, 4).pickup('health', -18, 2.8, -14).pickup('ammo', -8, 0, 18).pickup('health', 0, TOP, 0, true);
  // ---- nav -------------------------------------------------------------------------------------------------------------
  b.wp('spawn', -41, 0, 0).wp('spawnN', -41, 0, -14).wp('spawnS', -41, 0, 14)
    .wp('tIn', -34, 0, -2).wp('tInE', -30, 0, -4).wp('tDoorE', -26, 0, -4).wp('tInS', -35, 0, 4.5).wp('tDoorS', -35, 0, 9.5)
    .wp('stairsBot', -39.8, 0, -8.8).wp('landing', -29.25, TOP, -8.5)
    .wp('deckN', -33, TOP, -4.5).wp('deckS', -33, TOP, 4).wp('deckE', -29.5, TOP, 0).wp('deckS2', -30.5, TOP, 5.2)
    .wp('trampT', -30.5, 0.3, 10.5)
    .wp('br1', -21, TOP, 0).wp('br2', -14, TOP, 1.8).wp('br3', -9, TOP, -0.6).wp('br4', -4, TOP, 0)
    .wp('trampB', -14, 0.3, 6.8).wp('balcDrop', -14, 0, -5.5)
    .wp('npBot', -27, 0, -15.5).wp('np', -18, 2.8, -14).wp('npDrop', -12.5, 0, -14)
    .wp('g1', -24, 0, -6).wp('g2', -12, 0, -8).wp('g3', -11, 0, 9).wp('g4', -24, 0, 7.5).wp('g5', -30, 0, 16).wp('g6', -16, 0, 16.5)
    .wp('g8', -30, 0, -19).wp('g9', -14, 0, -20.5).wp('g10', -5, 0, -20.5).wp('g11', -3, 0, 13).wp('g12', -22, 0, 21.5).wp('g13', -25, 0, 16.5).wp('g14', -34, 0, 22.5).wp('ductEnd', -8, 0, -11.5)
    .wp('deckNE', -29.25, TOP, -5);
  b.midWp('brC', 0, TOP, 0);
  b.link('stairsBot', 'landing').link('landing', 'deckNE').link('tInE', 'tDoorE').link('tInS', 'tDoorS').link('spawn', 'tIn')
    .link('deckE', 'br1').link('br1', 'br2').link('br2', 'br3').link('br3', 'br4').link('br4', 'brC')
    .link('g4', 'trampT').link('tDoorS', 'trampT').link('trampT', 'deckS2', 'pad')
    .link('g4', 'trampB').link('g3', 'trampB').link('trampB', 'br2', 'pad').link('br2', 'balcDrop', 'drop')
    .link('npBot', 'np').link('np', 'npDrop', 'drop');
  return b.build({
    id: 'skybridge',
    name: 'Skybridge',
    description: 'Two towers and a long exposed bridge over tight ground-floor cover and a slide-under duct.',
    tags: ['Large', 'Long sightline', 'Trampolines'],
    theme: { sky: 0x2a2f5c, horizon: 0x8f6fc4, fog: 0x5b4a8a, floor: 0x343a52, wall: 0x4a4f72, cover: 0xb07cff, platform: 0x5d6488, accent: 0x2fd3c8, trim: 0xff7ac0, pad: 0x6dff9a, fogNear: 55, fogFar: 160 },
  });
}
