/** Arcfire Arena maps, map vote and bot difficulty on the server. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARENA_MAPS, ArenaMsg, type BotBrain } from '@hub/shared';
import { join, serverRoom } from './arenaHelpers';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

type SchemaPlayer = { vote: number; bot: boolean };
const me = (p: Awaited<ReturnType<typeof join>>) => p.room.state.players.get(p.room.sessionId) as SchemaPlayer;
const brains = (room: ReturnType<typeof serverRoom>) => [...(room.sim as unknown as { brains: Map<string, BotBrain> }).brains.values()];

describe('Arcfire Arena map vote online', () => {
  it('auto-starts two humans into a vote and closes it once both voted', async () => {
    const a = await join(ts, 'Ann');
    const b = await join(ts, 'Ben', a.room.roomId);
    const room = serverRoom(a.room.roomId);
    await until(() => a.room.state.startTick > 0); // the 5 s countdown
    expect(a.room.state.phase).toBe('warmup');
    await until(() => a.room.state.phase === 'vote', 8000);
    expect(room.metadata?.status).toBe('Voting for the next map');
    await until(() => a.room.state.voteMaps.length === 3);
    const cand = [...a.room.state.voteMaps] as number[];
    const ticksLeft = () => a.room.state.phaseEndTick - room.sim.tick;
    expect(ticksLeft()).toBeGreaterThan(10 * 30);
    a.room.send(ArenaMsg.Vote, { map: cand[0] });
    await until(() => me(a).vote === cand[0]);
    expect(ticksLeft()).toBeGreaterThan(10 * 30); // one human has not voted yet
    // Changing your mind is fine.
    b.room.send(ArenaMsg.Vote, { map: cand[0] });
    b.room.send(ArenaMsg.Vote, { map: cand[2] });
    await until(() => me(b).vote === cand[2]);
    await until(() => ticksLeft() <= 3 * 30 + 2, 1000);
    // A tie between two humans is broken at random and shown as such.
    await until(() => a.room.state.voteWinner >= 0, 4000);
    expect([cand[0], cand[2]]).toContain(a.room.state.voteWinner);
    expect(a.room.state.voteTie).toBe(true);
    const winner = a.room.state.voteWinner;
    expect(a.events.some((e) => e.type === 'mapVote' && e.winner === winner && e.tie)).toBe(true);
    await until(() => a.room.state.phase === 'loadout', 5000);
    expect(a.room.state.mapIndex).toBe(winner);
    expect(room.metadata?.status).toContain(ARENA_MAPS[winner].name);
    await Promise.all([a.room.leave(), b.room.leave()]);
  }, 25_000);

  it('ignores invalid votes and votes outside the vote', async () => {
    const host = await join(ts, 'Host', undefined, '2v2');
    host.room.send(ArenaMsg.Vote, { map: 0 });
    await wait(150);
    expect(me(host).vote).toBe(-1);
    host.room.send(ArenaMsg.Start, { bots: true });
    await until(() => host.room.state.phase === 'vote' && host.room.state.voteMaps.length === 3, 3000);
    const cand = [...host.room.state.voteMaps] as number[];
    const outside = ARENA_MAPS.map((_, i) => i).find((i) => !cand.includes(i))!;
    for (const bad of [{ map: 99 }, { map: 'x' }, { map: outside }, { map: -1 }, { map: 0.5 }, null, 'map']) host.room.send(ArenaMsg.Vote, bad);
    await wait(200);
    expect(me(host).vote).toBe(-1);
    expect(host.room.state.phase).toBe('vote');
    await host.room.leave();
  });

  it('lets the host set the bot difficulty in warmup and during the vote, but not mid-match', async () => {
    const host = await join(ts, 'Boss', undefined, '2v2', { botDifficulty: 'hard' });
    const room = serverRoom(host.room.roomId);
    expect(host.room.state.botDifficulty).toBe(2);
    host.room.send(ArenaMsg.Start, { bots: true });
    await until(() => host.room.state.phase === 'vote', 3000);
    expect(brains(room).map((b) => b.difficulty)).toEqual(['hard', 'hard', 'hard']);
    host.room.send(ArenaMsg.BotSkill, { level: 'easy' });
    await until(() => host.room.state.botDifficulty === 0);
    expect(brains(room).map((b) => b.difficulty)).toEqual(['easy', 'easy', 'easy']);
    // Guest votes do not change it, and nobody changes it once the match runs.
    const guest = await join(ts, 'Guest', host.room.roomId, '2v2');
    guest.room.send(ArenaMsg.BotSkill, { level: 'hard' });
    await wait(150);
    expect(host.room.state.botDifficulty).toBe(0);
    room.sim.castVote(host.room.sessionId, room.sim.vote!.candidates[0]);
    room.sim.castVote(guest.room.sessionId, room.sim.vote!.candidates[0]);
    room.sim.phaseTimer = 0;
    await until(() => room.sim.phase === 'vote' && room.sim.vote?.stage === 'reveal');
    room.sim.phaseTimer = 0;
    await until(() => host.room.state.phase === 'loadout', 3000);
    host.room.send(ArenaMsg.BotSkill, { level: 'normal' });
    await wait(150);
    expect(host.room.state.botDifficulty).toBe(0);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('goes back to warmup on the same map when nobody asks for a rematch', async () => {
    const host = await join(ts, 'Solo', undefined, '1v1');
    const room = serverRoom(host.room.roomId);
    host.room.send(ArenaMsg.Start, { bots: true });
    await until(() => room.sim.phase === 'vote');
    room.sim.phaseTimer = 0;
    await until(() => room.sim.vote?.stage === 'reveal');
    room.sim.phaseTimer = 0;
    await until(() => room.sim.phase === 'loadout');
    const map = host.room.state.mapIndex;
    room.sim.phase = 'matchEnd';
    room.sim.phaseTimer = 0.05;
    await until(() => host.room.state.phase === 'warmup', 3000);
    await wait(100);
    expect(host.room.state.mapIndex).toBe(map);
    expect(room.sim.mapIndex).toBe(map);
    await host.room.leave();
  });
});
