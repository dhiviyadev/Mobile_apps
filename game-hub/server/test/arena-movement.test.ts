/** Arcfire Arena movement and items over the network: slide input, the slide pose flag and pickups. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Buttons, PoseFlags } from '@hub/shared';
import { join, sendPaced, serverRoom, useFlatMap } from './arenaHelpers';
import { startTestServer, type TestServer, until } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

describe('Arcfire Arena movement online', () => {
  it('slide input reaches the server, the snapshot and the other players', async () => {
    // 2v2 with two humans: no auto-start, so the warmup keeps everyone free to move.
    const a = await join(ts, 'Slider', undefined, '2v2');
    const b = await join(ts, 'Watcher', a.room.roomId, '2v2');
    const room = serverRoom(a.room.roomId);
    useFlatMap(room);
    const pa = room.sim.players.get(a.room.sessionId)!;
    expect(room.sim.phase).toBe('warmup');
    await sendPaced(a, 20, () => ({ moveY: 1 }));
    await sendPaced(a, 1, () => ({ moveY: 1, buttons: Buttons.Slide | Buttons.Crouch }));
    await sendPaced(a, 10, () => ({ moveY: 1 }));
    await until(() => pa.sim.slideCooldown > 0, 3000);
    // Our own snapshot carries the slide state (exact timers for replays).
    await until(() => (a.snaps.at(-1)?.self?.slideCooldown ?? 0) > 0, 3000);
    expect(a.snaps.some((s) => s.self?.sliding === true)).toBe(true);
    // Everyone else sees the pose flag (sliding implies crouched).
    const idx = pa.index;
    const seen = b.snaps.flatMap((s) => s.poses.filter((p) => p.index === idx).map((p) => p.flags));
    expect(seen.some((f) => (f & PoseFlags.Slide) !== 0 && (f & PoseFlags.Crouch) !== 0)).toBe(true);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });
});

describe('Arcfire Arena pickups online', () => {
  it('a health pack heals over the network, then the schema reports its respawn tick', async () => {
    const a = await join(ts, 'Medic', undefined, '2v2');
    const b = await join(ts, 'Other', a.room.roomId, '2v2');
    const room = serverRoom(a.room.roomId);
    useFlatMap(room, { pickups: [{ kind: 'health', x: 0, y: 0, z: 0 }] });
    await until(() => a.room.state.pickupReady?.length === 1, 3000);
    room.sim.startMatch();
    room.sim.phaseTimer = 0;
    await until(() => room.sim.phase === 'live', 3000);
    const pa = room.sim.players.get(a.room.sessionId)!;
    Object.assign(pa.sim, { x: 0.4, y: 0, z: 0, vx: 0, vz: 0, hp: 40 });
    await until(() => a.events.some((e) => e.type === 'pickup' && e.id === a.room.sessionId), 3000);
    const ev = a.events.find((e) => e.type === 'pickup')!;
    expect(ev).toEqual({ type: 'pickup', id: a.room.sessionId, index: 0, kind: 'health', amount: 50 });
    await until(() => a.snaps.at(-1)?.self?.hp === 90, 3000);
    await until(() => (a.room.state.pickupReady[0] ?? 0) > 0, 3000);
    const ready = a.room.state.pickupReady[0] as number;
    expect(ready).toBe(room.sim.pickups.ready[0]);
    expect(ready - (a.snaps.at(-1)?.tick ?? 0)).toBeGreaterThan(500);
    // The other player saw the same event (for the sound and the hidden model).
    expect(b.events.some((e) => e.type === 'pickup' && e.id === a.room.sessionId)).toBe(true);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });
});
