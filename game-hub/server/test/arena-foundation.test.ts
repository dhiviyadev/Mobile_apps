/** Arcfire Arena upgrade foundation on the server: new messages, schema fields and the flat test map. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArenaMsg, Buttons, PoseFlags, WeaponId } from '@hub/shared';
import { join, sendPaced, serverRoom, useFlatMap } from './arenaHelpers';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

type SchemaPlayer = { primary: number; secondary: number; autoShoot: boolean; vote: number };
const me = (p: Awaited<ReturnType<typeof join>>) => p.room.state.players.get(p.room.sessionId) as SchemaPlayer;

describe('Arcfire Arena room, protocol 2', () => {
  it('takes primary and secondary picks and shows them in snapshots and the schema', async () => {
    const a = await join(ts, 'Picker');
    a.room.send(ArenaMsg.Loadout, { weapon: WeaponId.Sniper, secondary: WeaponId.Pistol });
    await until(() => me(a).primary === WeaponId.Sniper);
    expect(me(a).secondary).toBe(WeaponId.Pistol);
    await until(() => a.snaps.at(-1)?.self?.weapons[0].id === WeaponId.Sniper);
    expect(a.snaps.at(-1)!.self!.weapons.map((w) => w.id)).toEqual([WeaponId.Sniper, WeaponId.Pistol, WeaponId.Blade]);
    // A secondary in the primary slot is ignored, and garbage does not throw.
    a.room.send(ArenaMsg.Loadout, { weapon: WeaponId.Pistol });
    a.room.send(ArenaMsg.Loadout, { weapon: 'rifle', secondary: { x: 1 } });
    await wait(150);
    expect(me(a).primary).toBe(WeaponId.Sniper);
    await a.room.leave();
  });

  it('records the auto-shoot preference for the scoreboard and ignores garbage', async () => {
    const a = await join(ts, 'Auto');
    a.room.send(ArenaMsg.Prefs, { autoShoot: true });
    await until(() => me(a).autoShoot === true);
    a.room.send(ArenaMsg.Prefs, { autoShoot: 'yes' });
    await until(() => me(a).autoShoot === false);
    a.room.send(ArenaMsg.Prefs, null);
    await wait(100);
    expect(me(a).autoShoot).toBe(false);
    await a.room.leave();
  });

  it('uses the creator bot difficulty and lets only the host change it in warmup', async () => {
    const host = await join(ts, 'Host', undefined, '2v2', { botDifficulty: 'easy' });
    expect(host.room.state.botDifficulty).toBe(0);
    expect(serverRoom(host.room.roomId).sim.botDifficulty).toBe('easy');
    host.room.send(ArenaMsg.BotSkill, { level: 'hard' });
    await until(() => host.room.state.botDifficulty === 2);
    const guest = await join(ts, 'Guest', host.room.roomId, '2v2', { botDifficulty: 'easy' });
    guest.room.send(ArenaMsg.BotSkill, { level: 'normal' });
    host.room.send(ArenaMsg.BotSkill, { level: 'impossible' });
    await wait(200);
    expect(host.room.state.botDifficulty).toBe(2);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('accepts no map votes until the vote exists', async () => {
    const a = await join(ts, 'Voter');
    a.room.send(ArenaMsg.Vote, { map: 1 });
    await wait(150);
    expect(me(a).vote).toBe(-1);
    expect(a.room.state.voteMaps.length).toBe(0);
    expect(a.room.state.voteWinner).toBe(-1);
    await a.room.leave();
  });

  it('runs on the flat fixture map and reports a slide in the pose flags', async () => {
    const a = await join(ts, 'Slider');
    const room = serverRoom(a.room.roomId);
    useFlatMap(room);
    expect(room.sim.mapIndex).toBe(-1);
    const start = room.sim.players.get(a.room.sessionId)!.sim;
    expect(Math.abs(start.x)).toBeCloseTo(30, 5); // a fixture team spawn
    // Run toward the centre, then press crouch (the client sends Slide with the press).
    const yaw = start.x < 0 ? -Math.PI / 2 : Math.PI / 2;
    await sendPaced(a, 20, () => ({ moveY: 1, yaw }));
    await sendPaced(a, 2, () => ({ moveY: 1, yaw, buttons: Buttons.Crouch | Buttons.Slide }));
    await sendPaced(a, 10, () => ({ moveY: 1, yaw }));
    await until(() => a.snaps.some((s) => s.self?.sliding && s.poses.some((p) => (p.flags & PoseFlags.Slide) !== 0)), 3000);
    expect(room.sim.players.get(a.room.sessionId)!.sim.slideCooldown).toBeGreaterThan(0);
    await a.room.leave();
  });
});
