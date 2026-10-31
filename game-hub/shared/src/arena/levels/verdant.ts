// ARENA_MAPS[3]: Verdant Hall (mirror symmetry across x = 0, 72 × 72 m). A greenhouse hall: a stepped central mound
// under a giant tree whose canopy is reached by trampolines, a ring catwalk, and seed-vault spawn rooms.
import type { ArenaMap } from '../mapTypes';
import { MapBuilder } from '../mapkit';

export function verdant(): ArenaMap {
  const b = new MapBuilder({ halfX: 36, halfZ: 36, wallH: 14, symmetry: 'mirrorX' });
  const CW = 4.4; // catwalk top (multiple of the 0.4 m stair rise)
  // ---- central mound and tree ------------------------------------------------------------------------------
  b.midRect(-12, -12, 12, 12, 1.2, 'platform');
  b.midRect(-8, -8, 8, 8, 2.4, 'platform');
  b.midRect(-4.5, -4.5, 4.5, 4.5, 3.6, 'platform');
  for (const [edge, dir] of [[-12, -1], [12, 1]] as const) b.stairs(edge, 'z', dir, -1.5, 1.5, 1.2, 0, true);
  for (const [edge, dir] of [[-8, -1], [8, 1]] as const) b.stairs(edge, 'z', dir, -1.5, 1.5, 1.2, 1.2, true);
  for (const [edge, dir] of [[-4.5, -1], [4.5, 1]] as const) b.stairs(edge, 'z', dir, -1.5, 1.5, 1.2, 2.4, true);
  b.midBox(0, -1.5, 2, 2, 7.0, 'pillar', 3.6); // trunk, north of centre: the launcher lands on a clear 4 × 4 m patch south of it
  b.midRect(-4, -4, 4, 4, 0.6, 'cover', 9.0); // canopy
  b.box(-3.2, -3.2, 1.2, 1.2, 1.0, 'cover', 9.6); // leaf clumps (cover on the canopy)
  b.trampoline(-6.3, 0, 1.6, 7.6, 2.4); // on tier 2, up to the canopy
  b.launcher(-20, 0, 2, { x: -3.2, y: 3.6, z: 2.6 }, 6); // floor up to tier 3
  // ---- ring catwalk ---------------------------------------------------------------------------------------------
  b.midRect(-36, -36, 36, -32, 0.4, 'platform', CW - 0.4);
  b.midRect(-36, 32, 36, 36, 0.4, 'platform', CW - 0.4);
  b.rect(-36, -32, -32, 32, 0.4, 'platform', CW - 0.4);
  b.stairs(-32, 'z', 1, -1.5, 1.5, CW, 0, true);
  b.stairs(32, 'z', -1, -1.5, 1.5, CW, 0, true);
  b.stairs(-32, 'x', 1, -20, -17, CW);
  b.stairs(-32, 'x', 1, 17, 20, CW);
  b.rect(-32.4, -32, -32, -20.5, 0.8, 'trim', CW);
  b.rect(-32.4, -16.5, -32, -8, 0.8, 'trim', CW);
  b.rect(-32.4, 8, -32, 16.5, 0.8, 'trim', CW);
  b.rect(-32.4, 20.5, -32, 32, 0.8, 'trim', CW);
  b.rect(-32, -32.4, -2, -32, 0.8, 'trim', CW);
  b.rect(-32, 32, -2, 32.4, 0.8, 'trim', CW);
  for (const z of [-24, 24]) b.box(-32.4, z, 0.8, 0.8, CW - 0.4, 'pillar');
  for (const x of [-24, -12]) { b.box(x, -32.4, 0.8, 0.8, CW - 0.4, 'pillar'); b.box(x, 32.4, 0.8, 0.8, CW - 0.4, 'pillar'); }
  // ---- seed vault (west spawn room) under a balcony ------------------------------------------------------------------
  b.room(-36, -8, -26, 8, CW - 0.4, [
    { side: 'e', at: -4, width: 3 }, { side: 'e', at: 4, width: 3 }, { side: 'n', at: -30, width: 3 }, { side: 's', at: -30, width: 3 },
  ]);
  b.rect(-32, -8, -26, 8, 0.4, 'platform', CW - 0.4);
  b.rect(-26.4, -8, -26, -2, 0.8, 'trim', CW);
  b.rect(-26.4, 2, -26, 8, 0.8, 'trim', CW);
  // ---- floor: planters, benches, hedges, tanks ------------------------------------------------------------------------
  b.box(-20, -20, 6, 2, 1.0, 'cover');
  b.box(-20, 20, 6, 2, 1.0, 'cover');
  b.box(-16, -26, 8, 1.4, 1.1, 'accent');
  b.box(-16, 26, 8, 1.4, 1.1, 'accent');
  b.box(-22, -14, 1.2, 6, 2.2, 'cover');
  b.box(-22, 14, 1.2, 6, 2.2, 'cover');
  b.box(-28, -26, 3, 3, 3.0, 'accent');
  b.box(-28, 26, 3, 3, 3.0, 'accent');
  b.box(-6, -20, 1.4, 1.4, 1.6, 'cover');
  b.box(-6, 20, 1.4, 1.4, 1.6, 'cover');
  b.box(-15, -4, 1.2, 1.2, 1.3, 'accent');
  b.box(-15, 4.5, 1.2, 1.2, 1.3, 'accent');
  // ---- spawns & pickups --------------------------------------------------------------------------------------------------
  for (const [x, z] of [[-34, -5], [-34, 5], [-30, -6], [-30, 6], [-33.5, 0], [-28.5, 0]]) b.teamSpawn(x, 0, z);
  b.ffaSpawn(-24, 0, -30).ffaSpawn(-24, 0, 30).ffaSpawn(-10, 1.2, 9.5).ffaSpawn(-33.5, CW, -26);
  b.pickup('ammo', -28.5, 0, -3.5).pickup('health', -24.5, 0, -23).pickup('ammo', -34, CW, 26).pickup('health', 0, 9.6, 2.6, true);
  // ---- nav ------------------------------------------------------------------------------------------------------------------
  b.wp('rInN', -31, 0, -5.5).wp('rInS', -31, 0, 5.5).wp('rIn', -33, 0, 2.5)
    .wp('rDoorE1', -23.8, 0, -4).wp('rDoorE2', -23.8, 0, 4).wp('rDoorN', -30, 0, -10.5).wp('rDoorS', -30, 0, 10.5)
    .wp('stNBot', -25.4, 0, -18.5).wp('stNTop', -33.5, CW, -18.5).wp('stSBot', -25.4, 0, 18.5).wp('stSTop', -33.5, CW, 18.5)
    .wp('cwW1', -34, CW, -28).wp('cwW2', -34, CW, -10).wp('cwW3', -28.5, CW, 0).wp('cwW4', -34, CW, 10).wp('cwW5', -34, CW, 28)
    .wp('cwN1', -24, CW, -34).wp('cwN2', -8, CW, -34).wp('cwS1', -24, CW, 34).wp('cwS2', -8, CW, 34).wp('extDrop', -23.5, 0, -1.2)
    .wp('f1', -24, 0, -27).wp('f2', -10, 0, -22).wp('f3', -17, 0, -9).wp('f4', -17, 0, 9).wp('f5', -10, 0, 22).wp('f6', -24, 0, 29.5)
    .wp('f7', -14, 0, 0).wp('f8', -26, 0, -13).wp('f9', -26, 0, 13).wp('f10', -12, 0, -15).wp('f11', -12, 0, 15)
    .wp('lp', -20, 0.3, 0).wp('t1W', -10, 1.2, 0).wp('t2W', -6.3, 2.4, -3.5).wp('tr', -6.3, 2.7, 0).wp('cp', -2.6, 9.6, 0).wp('t3W', -3.2, 3.6, 2.6);
  b.midWp('cwNC', 0, CW, -34).midWp('cwNBot', 0, 0, -25.5).midWp('cwSC', 0, CW, 34).midWp('cwSBot', 0, 0, 25.5)
    .midWp('t1Nbot', 0, 0, -14).midWp('t1N', 0, 1.2, -10).midWp('t2N', 0, 2.4, -6.5).midWp('t3N', 0, 3.6, -3.4)
    .midWp('t1Sbot', 0, 0, 14).midWp('t1S', 0, 1.2, 10).midWp('t2S', 0, 2.4, 6.5).midWp('t3S', 0, 3.6, 3.4);
  b.link('rInN', 'rIn').link('rInS', 'rIn').link('rInN', 'rDoorE1').link('rInS', 'rDoorE2').link('rInN', 'rDoorN').link('rInS', 'rDoorS')
    .link('stNBot', 'stNTop').link('stSBot', 'stSTop').link('cwNC', 'cwNBot').link('cwSC', 'cwSBot')
    .link('cwW3', 'extDrop', 'drop')
    .link('t1Nbot', 't1N').link('t1N', 't2N').link('t2N', 't3N').link('t1Sbot', 't1S').link('t1S', 't2S').link('t2S', 't3S')
    .link('f7', 't1W', 'jump').link('t1W', 't2W', 'jump').link('t2W', 'tr').link('tr', 'cp', 'pad').link('cp', 't2W', 'drop')
    .link('rDoorE1', 'lp').link('rDoorE2', 'lp').link('lp', 't3W', 'pad').link('t3W', 't3S').link('t3W', 't3N');
  return b.build({
    id: 'verdant',
    name: 'Verdant Hall',
    description: 'A greenhouse hall: climb the stepped mound, bounce into the great tree, hold the ring catwalk.',
    tags: ['Square', 'King of the hill', 'Trampolines'],
    theme: { sky: 0xbfe8d8, horizon: 0xeef6e6, fog: 0xd8ecd8, floor: 0x7a8f6a, wall: 0x9cc7c0, cover: 0x4f9a52, platform: 0xa79a7c, accent: 0xe3b04b, trim: 0xe9f2ec, pad: 0xff6fa8, fogNear: 45, fogFar: 140 },
  });
}
