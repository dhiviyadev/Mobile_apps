/**
 * Online backend: talks to the Colyseus ArenaRoom.
 *
 *  - Commands go out as compact binary batches every frame.
 *  - 30 Hz binary snapshots come in; pose indices are mapped to player ids
 *    through the replicated roster.
 *  - Clock sync: we track the relation between the local clock and server
 *    ticks from snapshot arrival times, biased toward the fastest arrivals
 *    (the low-latency envelope), so serverTick() advances smoothly.
 *  - Interpolation delay adapts to measured jitter: 2 ticks (66 ms) on a
 *    clean connection, up to 6 ticks on a bumpy one.
 */
import {
  type ArenaEvent,
  type ArenaMode,
  ArenaMsg,
  type Command,
  decodeSnapshot,
  encodeCommands,
  type Phase,
  PoseFlags,
  TICK_RATE,
  type WeaponId,
} from '@hub/shared';
import type { NetSession } from '../../../net/session';
import type { ArenaBackend, MatchInfo, PlayerInfo, PoseData, SnapshotFrame } from '../backend';

const TICK_MS = 1000 / TICK_RATE;

interface SchemaPlayer {
  name: string;
  color: number;
  connected: boolean;
  bot: boolean;
  team: number;
  index: number;
  kills: number;
  deaths: number;
  damage: number;
  shots: number;
  hits: number;
  headshots: number;
  roundWins: number;
  primary: number;
}

export interface NetMatchInfo extends MatchInfo {
  /** Seconds until an automatic start, or null. */
  startsIn: number | null;
  minHumans: number;
  rematchVotes: number;
}

export class NetBackend implements ArenaBackend {
  readonly online = true;
  readonly localId: string;
  private snapshots: SnapshotFrame[] = [];
  private events: ArenaEvent[] = [];
  private lastAck = 0;
  private offset: number | null = null;
  private lastArrival = 0;
  private jitter = 0;
  private delay = 2.5;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly session: NetSession) {
    this.localId = session.sessionId;
    this.offs.push(
      session.onMessage(ArenaMsg.Snapshot, (bytes: Uint8Array) => this.onSnapshot(bytes)),
      session.onMessage(ArenaMsg.Events, (events: ArenaEvent[]) => this.events.push(...events)),
    );
  }

  private onSnapshot(bytes: Uint8Array): void {
    let msg;
    try {
      msg = decodeSnapshot(bytes, this.lastAck);
    } catch {
      return;
    }
    this.lastAck = msg.ack;
    const now = performance.now();

    // ---- clock sync & jitter ----------------------------------------------------------------
    const sample = msg.tick - now / TICK_MS;
    if (this.offset === null || Math.abs(sample - this.offset) > 8) this.offset = sample;
    else this.offset += (sample - this.offset) * (sample > this.offset ? 0.25 : 0.02);
    if (this.lastArrival) {
      const dev = Math.abs(now - this.lastArrival - TICK_MS);
      this.jitter += (dev - this.jitter) * 0.1;
    }
    this.lastArrival = now;
    const target = Math.max(2, Math.min(6, 1.5 + (this.jitter * 2.5) / TICK_MS));
    this.delay += (target - this.delay) * 0.05;

    // ---- poses by player id ------------------------------------------------------------------
    const idByIndex = new Map<number, string>();
    this.session.state?.players?.forEach((p: SchemaPlayer, id: string) => idByIndex.set(p.index, id));
    const poses = new Map<string, PoseData>();
    let mine: PoseData | undefined;
    for (const p of msg.poses) {
      const id = idByIndex.get(p.index);
      if (!id) continue;
      const pose: PoseData = {
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
        crouching: (p.flags & PoseFlags.Crouch) !== 0,
        alive: (p.flags & PoseFlags.Alive) !== 0,
        aiming: (p.flags & PoseFlags.Aim) !== 0,
        reloading: (p.flags & PoseFlags.Reload) !== 0,
        hp: p.hp,
        weapon: p.weapon,
      };
      poses.set(id, pose);
      if (id === this.localId) mine = pose;
    }
    if (msg.self && mine) {
      msg.self.yaw = mine.yaw;
      msg.self.pitch = mine.pitch;
    }
    this.snapshots.push({ tick: msg.tick, ack: msg.ack, self: msg.self, poses });
    if (this.snapshots.length > 60) this.snapshots.splice(0, this.snapshots.length - 60);
  }

  localIndex(): number {
    return (this.session.state?.players?.get(this.localId) as SchemaPlayer | undefined)?.index ?? 0;
  }

  sendCommands(cmds: Command[]): void {
    for (let i = 0; i < cmds.length; i += 32) this.session.sendBytes(ArenaMsg.Input, encodeCommands(cmds.slice(i, i + 32)));
  }

  update(): void {}

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

  serverTick(): number {
    return this.offset === null ? 0 : performance.now() / TICK_MS + this.offset;
  }

  interpDelayTicks(): number {
    return this.delay;
  }

  match(): NetMatchInfo {
    const s = this.session.state;
    const tick = this.serverTick();
    const players: PlayerInfo[] = [];
    s?.players?.forEach((p: SchemaPlayer, id: string) => {
      players.push({
        id, name: p.name, color: p.color, team: p.team, bot: p.bot, connected: p.connected,
        kills: p.kills, deaths: p.deaths, damage: p.damage, shots: p.shots, hits: p.hits,
        headshots: p.headshots, roundWins: p.roundWins, primary: p.primary as WeaponId,
      });
    });
    return {
      phase: ((s?.phase as Phase) || 'warmup'),
      timeLeft: s?.phaseEndTick ? Math.max(0, (s.phaseEndTick - tick) / TICK_RATE) : 0,
      round: s?.round ?? 0,
      teamWins: [s?.teamWins0 ?? 0, s?.teamWins1 ?? 0],
      mode: (s?.mode as ArenaMode) || '1v1',
      mapIndex: s?.mapIndex ?? 0,
      hostId: s?.hostId ?? '',
      lastRoundWinner: s && s.roundWinnerTeam !== -2 ? { team: s.roundWinnerTeam, id: s.roundWinnerId || null } : null,
      matchWinner: s && s.matchWinnerTeam !== -2 ? { team: s.matchWinnerTeam, id: s.matchWinnerId || null } : null,
      players,
      startsIn: s?.startTick ? Math.max(0, (s.startTick - tick) / TICK_RATE) : null,
      minHumans: s?.minHumans ?? 2,
      rematchVotes: s?.rematchVotes ?? 0,
    };
  }

  chooseLoadout(weapon: WeaponId): void {
    this.session.send(ArenaMsg.Loadout, { weapon });
  }

  startMatch(withBots: boolean): void {
    this.session.send(ArenaMsg.Start, { bots: withBots });
  }

  rematch(): void {
    this.session.send(ArenaMsg.Rematch);
  }

  ping(): number | null {
    return this.session.ping;
  }

  roomCode(): string | null {
    return this.session.roomId;
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}
