/**
 * Offline practice: runs the authoritative ArenaSimulation in the browser
 * with bots. Snapshots are produced every tick without serialisation.
 */
import {
  arenaMap,
  type ArenaEvent,
  type ArenaMode,
  ArenaSimulation,
  clonePlayerSim,
  type Command,
  type SimPlayer,
  TICK_DT,
  type WeaponId,
} from '@hub/shared';
import type { ArenaBackend, MatchInfo, PoseData, SnapshotFrame } from '../backend';

export const BOT_NAMES = ['Nova', 'Pike', 'Juno', 'Rook', 'Vex', 'Tala', 'Ember', 'Quill', 'Sable', 'Orin'];
export const BOT_COLORS = [0x9fd8ff, 0xff9fbf, 0xb7f59a, 0xffd28a, 0xc7a8ff, 0x8af2e2, 0xffb08a, 0xe6e6e6];
const MAX_STEPS_PER_FRAME = 4;

export function posesOf(players: Iterable<SimPlayer>): Map<string, PoseData> {
  const poses = new Map<string, PoseData>();
  for (const p of players) {
    const s = p.sim;
    poses.set(p.id, {
      x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch,
      crouching: s.crouching, alive: s.alive, aiming: s.aiming, reloading: s.reload > 0,
      hp: s.hp, weapon: s.weapons[s.slot].id,
    });
  }
  return poses;
}

export class LocalBackend implements ArenaBackend {
  readonly online = false;
  readonly localId = 'you';
  private sim: ArenaSimulation;
  private acc = 0;
  private snapshots: SnapshotFrame[] = [];
  private events: ArenaEvent[] = [];

  constructor(
    private readonly mode: ArenaMode,
    private mapIndex: number,
    private readonly name: string,
    private readonly color: number,
  ) {
    this.sim = this.createSim();
  }

  private createSim(): ArenaSimulation {
    const sim = new ArenaSimulation(arenaMap(this.mapIndex), this.mode, { seed: (Math.random() * 1e9) | 0 });
    sim.addPlayer({ id: this.localId, name: this.name, color: this.color });
    sim.fillWithBots(BOT_NAMES, BOT_COLORS);
    // FFA practice: 6 players feels busy without being chaotic on a tablet.
    if (this.mode === 'ffa') for (const p of [...sim.players.values()].filter((q) => q.bot).slice(5)) sim.removePlayer(p.id);
    sim.startMatch();
    return sim;
  }

  localIndex(): number {
    return this.sim.players.get(this.localId)?.index ?? 0;
  }

  sendCommands(cmds: Command[]): void {
    for (const c of cmds) this.sim.queueCommand(this.localId, c);
  }

  update(dt: number): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
      this.acc -= TICK_DT;
      steps++;
      this.sim.step();
      const me = this.sim.players.get(this.localId);
      this.snapshots.push({
        tick: this.sim.tick,
        ack: me?.sim.lastSeq ?? 0,
        self: me ? clonePlayerSim(me.sim) : null,
        poses: posesOf(this.sim.players.values()),
      });
      this.events.push(...this.sim.drainEvents());
    }
    if (this.acc > TICK_DT * MAX_STEPS_PER_FRAME) this.acc = 0; // after a long pause, don't fast-forward
  }

  takeSnapshots(): SnapshotFrame[] {
    const s = this.snapshots;
    this.snapshots = [];
    return s;
  }

  takeEvents(): ArenaEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  match(): MatchInfo {
    const sim = this.sim;
    return {
      phase: sim.phase,
      timeLeft: Math.max(0, sim.phaseTimer),
      round: sim.round,
      teamWins: [sim.teamWins[0], sim.teamWins[1]],
      mode: this.mode,
      mapIndex: this.mapIndex,
      hostId: this.localId,
      lastRoundWinner: sim.lastRoundWinner,
      matchWinner: sim.matchWinner,
      players: [...sim.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, team: p.team, bot: p.bot, connected: true,
        ...p.stats, primary: p.primary,
      })),
    };
  }

  serverTick(): number {
    return this.sim.tick + this.acc / TICK_DT;
  }

  interpDelayTicks(): number {
    return 1;
  }

  chooseLoadout(weapon: WeaponId): void {
    this.sim.setLoadout(this.localId, weapon);
  }

  startMatch(): void {
    this.sim.startMatch();
  }

  /** Offline rematch: next map in the rotation, fresh bots. */
  rematch(): void {
    this.mapIndex = (this.mapIndex + 1) % 3;
    this.sim = this.createSim();
    this.snapshots = [];
    this.events = [{ type: 'phase', phase: this.sim.phase, round: this.sim.round }];
  }

  ping(): number | null {
    return null;
  }

  roomCode(): string | null {
    return null;
  }

  dispose(): void {}
}
