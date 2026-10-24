import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArenaMsg, Buttons, type Command, encodeCommands } from '@hub/shared';
import { join as joinArena, sendPaced, serverRoom } from './arenaHelpers';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

const join = (nickname: string, roomId?: string, mode = '1v1') => joinArena(ts, nickname, roomId, mode);

describe('Arcfire Arena room', () => {
  it('streams 30 Hz binary snapshots and acknowledges commands', async () => {
    const a = await join('Alpha');
    const b = await join('Bravo', a.room.roomId);
    a.snaps.length = 0;
    await wait(1000);
    expect(a.snaps.length).toBeGreaterThan(24);
    expect(a.snaps.length).toBeLessThan(36);
    const ticks = a.snaps.map((s) => s.tick);
    expect(ticks.every((t, i) => i === 0 || t === ticks[i - 1] + 1)).toBe(true);

    // Walking forward (warmup allows movement) changes our authoritative position.
    const start = a.snaps.at(-1)!.self!;
    // Head toward the middle of the map (always open ground).
    const yaw = Math.atan2(start.x, start.z);
    await sendPaced(a, 40, () => ({ moveY: 1, yaw }));
    await until(() => a.snaps.at(-1)!.ack === a.seq, 3000);
    const end = a.snaps.at(-1)!.self!;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(1.5);
    // Everyone sees both players in the pose block.
    expect(b.snaps.at(-1)!.poses).toHaveLength(2);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('does not let a client run faster than real time', async () => {
    const a = await join('Speedy');
    const room = serverRoom(a.room.roomId);
    const cmds: Command[] = [];
    for (let i = 0; i < 60; i++) cmds.push({ seq: ++a.seq, moveX: 0, moveY: 1, yaw: 0, pitch: 0, buttons: 0, slot: 255, viewTick: 0 });
    // 300 commands (5 s worth) delivered instantly.
    for (let k = 0; k < 5; k++) {
      a.room.sendBytes(ArenaMsg.Input, encodeCommands(cmds.map((c) => ({ ...c, seq: c.seq + k * 60 }))));
    }
    a.seq += 240;
    const clock0 = room.sim.players.get(a.room.sessionId)!.sim.clock;
    await wait(1000);
    const simulated = room.sim.players.get(a.room.sessionId)!.sim.clock - clock0;
    expect(simulated).toBeLessThan(1.5);
    await a.room.leave();
  });

  it('validates fire rate server-side and hits with lag compensation', async () => {
    const a = await join('Shooter');
    const b = await join('Target', a.room.roomId);
    const room = serverRoom(a.room.roomId);
    // Fast-forward into a live round and line the two players up in the open.
    room.sim.startMatch();
    room.sim.phaseTimer = 0;
    await until(() => room.sim.phase === 'live');
    const pa = room.sim.players.get(a.room.sessionId)!;
    const pb = room.sim.players.get(b.room.sessionId)!;
    Object.assign(pa.sim, { x: -14, y: 0, z: 7, vx: 0, vz: 0 });
    Object.assign(pb.sim, { x: -6, y: 0, z: 7, vx: 0, vz: 0 });
    pa.sim.lastSeq = a.seq;
    await wait(150);
    const yaw = Math.atan2(-(pb.sim.x - pa.sim.x), -(pb.sim.z - pa.sim.z));
    const viewTick = room.sim.tick - 3; // what the shooter saw ~100 ms ago
    a.events.length = 0;
    // Hold fire for 0.5 s: the rifle allows at most 5-6 shots in that time.
    await sendPaced(a, 30, () => ({ yaw, pitch: -0.08, buttons: Buttons.Fire, viewTick }));
    await until(() => a.events.filter((e) => e.type === 'shot').length >= 4, 3000);
    await wait(200);
    const shots = a.events.filter((e) => e.type === 'shot' && e.shooter === a.room.sessionId);
    const hits = a.events.filter((e) => e.type === 'hit' && e.shooter === a.room.sessionId);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    expect(shots.length).toBeLessThanOrEqual(6);
    expect(hits.length).toBeGreaterThan(0);
    expect(pb.sim.hp).toBeLessThan(100);
    // Ammo is tracked by the server.
    expect(pa.sim.weapons[0].mag).toBe(30 - shots.length);
    await Promise.all([a.room.leave(), b.room.leave()]);
  });

  it('lets the host start with bots, and rematch rotates the map', async () => {
    const host = await join('Host', undefined, '2v2');
    host.room.send(ArenaMsg.Start, { bots: true });
    await until(() => host.room.state.phase === 'loadout', 3000);
    const players = [...host.room.state.players.values()] as { bot: boolean; team: number }[];
    expect(players).toHaveLength(4);
    expect(players.filter((p) => p.bot)).toHaveLength(3);
    expect(players.filter((p) => p.team === 0)).toHaveLength(2);

    const room = serverRoom(host.room.roomId);
    const map0 = host.room.state.mapIndex;
    room.sim.teamWins = [4, 0];
    room.sim.phaseTimer = 0;
    await until(() => room.sim.phase === 'live');
    for (const p of room.sim.players.values()) if (p.team === 1) room.sim.eliminate(p.id);
    await until(() => host.room.state.phase === 'roundEnd', 3000);
    await until(() => host.room.state.phase === 'matchEnd', 6000);
    expect(host.room.state.matchWinnerTeam).toBe(0);
    host.room.send(ArenaMsg.Rematch);
    await until(() => host.room.state.phase === 'loadout', 3000);
    expect(host.room.state.mapIndex).toBe((map0 + 1) % 3);
    expect(host.room.state.round).toBe(1);
    await host.room.leave();
  }, 20_000);

  it('kicks clients that flood garbage input', async () => {
    const a = await join('Garbage');
    const live = serverRoom(a.room.roomId);
    let closed = 0;
    a.room.onLeave((code) => (closed = code));
    for (let i = 0; i < 60; i++) a.room.sendBytes(ArenaMsg.Input, new Uint8Array([200, 1, 2]));
    await until(() => closed !== 0, 3000);
    expect(closed).toBe(4100);
    // No seat is held for a kicked player: they are gone at once and cannot reconnect.
    await until(() => !live.state.players.has(a.room.sessionId), 1000);
    await expect(ts.client().reconnect(a.room.reconnectionToken)).rejects.toThrow();
  });
});
