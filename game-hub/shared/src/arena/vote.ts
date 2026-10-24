/**
 * Map vote before every match (design-arena-maps §5).
 *
 * The vote is a real phase of the shared simulation, so the server room and
 * offline practice run the same rules:
 *  - 3 random candidates (never the map of the previous match), 15 s to vote;
 *  - players may change their vote until the reveal; bots vote for a random
 *    candidate 1.5–6 s in;
 *  - once every connected human has voted, at most 3 s remain;
 *  - human votes outrank bot votes (bots break ties between humans), and a
 *    remaining tie is broken at random;
 *  - a 3 s reveal (still phase 'vote'), then the winner loads and the match
 *    starts (or the room returns to warmup on it when players are missing).
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import { TICK_DT, VOTE } from './constants';
import { ARENA_MAPS } from './maps';
import type { ArenaSimulation, SimPlayer } from './sim';

export interface MapVote {
  /** ARENA_MAPS indices in card order. */
  candidates: number[];
  /** player id → map index (humans and bots). */
  votes: Map<string, number>;
  /** bot id → sim.time at which it votes. */
  botVoteAt: Map<string, number>;
  stage: 'open' | 'reveal';
  /** -1 while open. */
  winner: number;
  tie: boolean;
}

export class MapVoteSystem {
  current: MapVote | null = null;
  /** ARENA_MAPS index of the previous match's map (never a candidate); -1 = none. Set by sim.startMatch(). */
  lastMatchMap = -1;

  /**
   * Opens a vote: candidates, bot schedule, sim.setPhase('vote', VOTE.time). Returns false when no vote is
   * possible (sim.mapIndex < 0 or fewer than 2 maps); the caller then starts the match directly.
   */
  open(sim: ArenaSimulation): boolean {
    if (this.current && sim.phase === 'vote') return true;
    this.current = null;
    if (sim.mapIndex < 0 || ARENA_MAPS.length < 2) return false;
    const pool = ARENA_MAPS.map((_, i) => i).filter((i) => i !== this.lastMatchMap);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(sim.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const candidates = pool.slice(0, VOTE.candidates);
    if (candidates.length < 2) return false;
    this.current = { candidates, votes: new Map(), botVoteAt: new Map(), stage: 'open', winner: -1, tie: false };
    for (const p of sim.players.values()) if (p.bot) this.scheduleBot(sim, p.id);
    sim.setPhase('vote', VOTE.time);
    return true;
  }

  /** Records or changes a vote. Returns true if accepted. */
  cast(sim: ArenaSimulation, id: string, mapIndex: number): boolean {
    const v = this.current;
    if (!v || v.stage !== 'open' || sim.phase !== 'vote' || !sim.players.has(id)) return false;
    if (!Number.isInteger(mapIndex) || !v.candidates.includes(mapIndex)) return false;
    v.votes.set(id, mapIndex);
    this.checkAllVoted(sim);
    return true;
  }

  /**
   * advancePhase() for phase 'vote'. Owns sim.phaseTimer while voting. Casts due bot votes, resolves
   * (stage 'reveal', emits 'mapVote'), and at the end of the reveal calls sim.changeMap(ARENA_MAPS[winner])
   * then sim.startMatch() or sim.resetToWarmup().
   */
  step(sim: ArenaSimulation): void {
    const v = this.current;
    if (!v) return; // phase set by hand (tests): players just stay frozen
    sim.phaseTimer -= TICK_DT;
    if (v.stage === 'open') {
      for (const [id, at] of v.botVoteAt) if (sim.time >= at && !v.votes.has(id)) this.botVote(sim, v, id);
      if (sim.phaseTimer <= 0) this.resolve(sim, v);
      return;
    }
    if (sim.phaseTimer > 0) return;
    const winner = ARENA_MAPS[v.winner];
    this.current = null;
    sim.changeMap(winner);
    if (sim.enoughPlayers()) sim.startMatch();
    else sim.resetToWarmup();
  }

  onPlayerAdded(sim: ArenaSimulation, p: SimPlayer): void {
    if (p.bot && this.current?.stage === 'open') this.scheduleBot(sim, p.id);
  }

  onPlayerRemoved(sim: ArenaSimulation, id: string): void {
    const v = this.current;
    if (!v) return;
    v.votes.delete(id);
    v.botVoteAt.delete(id);
    if (v.stage === 'open') this.checkAllVoted(sim);
  }

  private scheduleBot(sim: ArenaSimulation, id: string): void {
    this.current?.botVoteAt.set(id, sim.time + VOTE.botVoteMin + (VOTE.botVoteMax - VOTE.botVoteMin) * sim.random());
  }

  private botVote(sim: ArenaSimulation, v: MapVote, id: string): void {
    v.votes.set(id, v.candidates[Math.floor(sim.random() * v.candidates.length)]);
  }

  /** Every connected human has voted: at most VOTE.allVotedTime left, and the remaining bots vote now. */
  private checkAllVoted(sim: ArenaSimulation): void {
    const v = this.current;
    if (!v || v.stage !== 'open' || sim.phase !== 'vote') return;
    let humans = 0;
    for (const p of sim.players.values()) {
      if (p.bot || !p.connected) continue;
      humans++;
      if (!v.votes.has(p.id)) return;
    }
    if (humans === 0) return;
    sim.phaseTimer = Math.min(sim.phaseTimer, VOTE.allVotedTime);
    for (const id of v.botVoteAt.keys()) if (!v.votes.has(id)) this.botVote(sim, v, id);
  }

  /** score = human votes × humanWeight + bot votes; the best score wins, ties broken by the sim RNG. */
  private resolve(sim: ArenaSimulation, v: MapVote): void {
    const score = new Map<number, number>(v.candidates.map((c) => [c, 0]));
    for (const [id, m] of v.votes) {
      const p = sim.players.get(id);
      if (p && score.has(m)) score.set(m, score.get(m)! + (p.bot ? 1 : VOTE.humanWeight));
    }
    const top = Math.max(...score.values());
    const tied = v.candidates.filter((c) => score.get(c) === top);
    v.winner = tied.length > 1 ? tied[Math.floor(sim.random() * tied.length)] : tied[0];
    v.tie = tied.length > 1;
    v.stage = 'reveal';
    sim.phaseTimer = VOTE.revealTime;
    sim.emit({ type: 'mapVote', winner: v.winner, tie: v.tie });
  }
}
