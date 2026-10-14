/**
 * The arena game talks to a backend that owns the authoritative simulation:
 *  - LocalBackend runs ArenaSimulation in the browser (practice vs bots)
 *  - NetBackend talks to the Colyseus ArenaRoom (online)
 *
 * Either way the client predicts its own player, reconciles against snapshots
 * and interpolates everyone else, so offline play exercises the same code
 * path as online play.
 */
import type { ArenaEvent, ArenaMode, Command, Phase, PlayerSim, WeaponId } from '@hub/shared';

export interface PoseData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouching: boolean;
  alive: boolean;
  aiming: boolean;
  reloading: boolean;
  hp: number;
  weapon: WeaponId;
}

export interface SnapshotFrame {
  tick: number;
  /** Last local command the authority has applied. */
  ack: number;
  self: PlayerSim | null;
  poses: Map<string, PoseData>;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
  team: number;
  bot: boolean;
  connected: boolean;
  kills: number;
  deaths: number;
  damage: number;
  shots: number;
  hits: number;
  headshots: number;
  roundWins: number;
  primary: WeaponId;
}

export interface MatchInfo {
  phase: Phase;
  /** Seconds left in the phase (0 in warmup). */
  timeLeft: number;
  round: number;
  teamWins: [number, number];
  mode: ArenaMode;
  mapIndex: number;
  players: PlayerInfo[];
  hostId: string;
  lastRoundWinner: { team: number; id: string | null } | null;
  matchWinner: { team: number; id: string | null } | null;
}

export interface ArenaBackend {
  readonly localId: string;
  readonly online: boolean;
  /** Small integer used for deterministic spread seeds (must match the server's). */
  localIndex(): number;
  sendCommands(cmds: Command[]): void;
  /** Advances local simulation (offline) — no-op online. */
  update(dt: number): void;
  takeSnapshots(): SnapshotFrame[];
  takeEvents(): ArenaEvent[];
  match(): MatchInfo;
  /** Estimated current authoritative tick, fractional. */
  serverTick(): number;
  /** How far behind serverTick() remote players should be drawn, in ticks. */
  interpDelayTicks(): number;
  chooseLoadout(weapon: WeaponId): void;
  /** Host / offline: start the match now (optionally filling empty slots with bots). */
  startMatch(withBots: boolean): void;
  rematch(): void;
  ping(): number | null;
  roomCode(): string | null;
  dispose(): void;
}
