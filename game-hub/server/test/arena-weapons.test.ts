/** Arcfire Arena weapons over the network: secondary picks, crossbow bolts and burst fire, server-validated. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArenaMsg, ballisticAim, Buttons, eyePosition, type SimPlayer, WeaponId, weaponDef } from '@hub/shared';
import { join, type Peer, sendPaced, serverRoom, useFlatMap } from './arenaHelpers';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

type SchemaPlayer = { primary: number; secondary: number };
const me = (p: Peer) => p.room.state.players.get(p.room.sessionId) as SchemaPlayer;

/** Two players in a live round on the open flat map, `a` holding `weapon`, 15 m apart. */
async function duel(weapon: WeaponId): Promise<{ a: Peer; b: Peer; pa: SimPlayer; pb: SimPlayer; room: ReturnType<typeof serverRoom> }> {
  const a = await join(ts, 'Shooter');
  const b = await join(ts, 'Target', a.room.roomId);
  const room = serverRoom(a.room.roomId);
  useFlatMap(room);
  room.sim.setLoadout(a.room.sessionId, weapon);
  room.sim.startMatch();
  room.sim.phaseTimer = 0;
  await until(() => room.sim.phase === 'live');
  const pa = room.sim.players.get(a.room.sessionId)!;
  const pb = room.sim.players.get(b.room.sessionId)!;
  Object.assign(pa.sim, { x: 0, y: 0, z: 0, vx: 0, vz: 0, onGround: true });
  Object.assign(pb.sim, { x: 0, y: 0, z: -15, vx: 0, vz: 0, onGround: true });
  pa.sim.lastSeq = a.seq;
  await wait(150);
  a.events.length = 0;
  return { a, b, pa, pb, room };
}

describe('Arcfire Arena room, weapons', () => {
  it('takes a primary and a secondary pick', async () => {
    const a = await join(ts, 'Picker');
    a.room.send(ArenaMsg.Loadout, { weapon: WeaponId.Crossbow, secondary: WeaponId.HandCannon });
    await until(() => me(a).secondary === WeaponId.HandCannon);
    expect(me(a).primary).toBe(WeaponId.Crossbow);
    await until(() => a.snaps.at(-1)?.self?.weapons[1].id === WeaponId.HandCannon);
    expect(a.snaps.at(-1)!.self!.weapons.map((w) => w.id)).toEqual([WeaponId.Crossbow, WeaponId.HandCannon, WeaponId.Blade]);
    await a.room.leave();
  });

  it('flies crossbow bolts on the server and sends proj / projEnd', async () => {
    const { a, b, pa, pb, room } = await duel(WeaponId.Crossbow);
    const spec = weaponDef(WeaponId.Crossbow).projectile!;
    const [ex, ey, ez] = eyePosition(pa.sim);
    const yaw = Math.atan2(-(pb.sim.x - ex), -(pb.sim.z - ez));
    const pitch = ballisticAim(pb.sim.x - ex, 1.0 - ey, pb.sim.z - ez, spec.speed, spec.gravity)!.pitch;
    const viewTick = room.sim.tick - 3;
    await sendPaced(a, 1, () => ({ yaw, pitch, buttons: Buttons.Fire, viewTick }));
    await until(() => a.events.some((e) => e.type === 'projEnd'), 3000);
    const proj = a.events.find((e) => e.type === 'proj');
    const end = a.events.find((e) => e.type === 'projEnd');
    if (proj?.type !== 'proj' || end?.type !== 'projEnd') throw new Error('missing bolt events');
    expect(proj.shooter).toBe(a.room.sessionId);
    expect(proj.weapon).toBe(WeaponId.Crossbow);
    // Compacted on the wire: centimetres.
    for (const v of [...proj.origin, ...proj.vel]) expect(Math.round(v * 100) / 100).toBe(v);
    expect(Math.hypot(...proj.vel)).toBeCloseTo(spec.speed, 1);
    expect(end).toMatchObject({ id: proj.id, hitId: b.room.sessionId, headshot: false });
    await until(() => pb.sim.hp === 25);
    // A projectile weapon never emits a hitscan 'shot'.
    expect(a.events.some((e) => e.type === 'shot')).toBe(false);
    expect(pa.sim.weapons[0].mag).toBe(0);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('validates burst fire: at most two bursts in half a second', async () => {
    const { a, b, pa, pb } = await duel(WeaponId.BurstRifle);
    const yaw = Math.atan2(-(pb.sim.x - pa.sim.x), -(pb.sim.z - pa.sim.z));
    await sendPaced(a, 30, () => ({ yaw, pitch: -0.03, buttons: Buttons.Fire }));
    await until(() => a.events.filter((e) => e.type === 'shot').length >= 3, 3000);
    await wait(300);
    const shots = a.events.filter((e) => e.type === 'shot' && e.shooter === a.room.sessionId).length;
    expect(shots).toBeGreaterThanOrEqual(3);
    expect(shots).toBeLessThanOrEqual(6);
    expect(pa.sim.weapons[0].mag).toBe(24 - shots);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });
});
