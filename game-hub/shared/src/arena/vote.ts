/**
 * Map vote before every match (design-arena-maps §5).
 *
 * Owned by the maps, vote & bots package. The foundation wires the system into
 * the simulation (phase 'vote', sim.startVote / castVote, the room state and
 * the client backends); until it is implemented, open() refuses and every
 * match starts straight away, as before.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
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
    return false;
  }

  /** Records or changes a vote. Returns true if accepted. */
  cast(sim: ArenaSimulation, id: string, mapIndex: number): boolean {
    return false;
  }

  /**
   * advancePhase() for phase 'vote'. Owns sim.phaseTimer while voting. Casts due bot votes, resolves
   * (stage 'reveal', emits 'mapVote'), and at the end of the reveal calls sim.changeMap(ARENA_MAPS[winner])
   * then sim.startMatch() or sim.resetToWarmup().
   */
  step(sim: ArenaSimulation): void {}

  onPlayerAdded(sim: ArenaSimulation, p: SimPlayer): void {}

  onPlayerRemoved(sim: ArenaSimulation, id: string): void {}
}
