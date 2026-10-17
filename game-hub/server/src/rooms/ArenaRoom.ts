/**
 * Arcfire Arena room: authoritative, round-based shooter (1v1, 2v2, FFA).
 *
 * Runs the shared ArenaSimulation at 30 Hz. Clients send 60 Hz input
 * commands (binary); the server applies them (movement, fire rate, ammo,
 * line of sight are all validated by simulating them, never trusting client
 * state), resolves hits with lag compensation, and sends every client a
 * compact binary snapshot per tick containing:
 *  - the last command it applied for that client (for reconciliation),
 *  - that client's full predicted-state fields,
 *  - everyone's quantised pose.
 * Discrete events (shots, hits, kills, round results) are batched per tick.
 */
import type { Client } from '@colyseus/core';
import {
  ARENA_MAPS,
  ARENA_MODE_INFO,
  type ArenaEvent,
  type ArenaMode,
  ArenaMsg,
  ArenaSimulation,
  arenaMap,
  asBytes,
  CLOSE_KICKED,
  decodeCommands,
  encodePoses,
  encodeSnapshot,
  isArenaMode,
  type JoinOptions,
  type NetPose,
  PoseFlags,
  type SimPlayer,
  TICK_RATE,
} from '@hub/shared';
import { HubRoom } from './HubRoom';
import { ArenaPlayer, ArenaState } from './schema/ArenaState';

const TICK_MS = 1000 / TICK_RATE;
const AUTO_START_DELAY = 5; // seconds of countdown once enough humans are in
const LONELY_FILL_AFTER = 40; // public rooms: start with bots after this long in warmup
const MAX_CMDS_PER_SECOND = 150;
const MAX_VIOLATIONS = 40;

export const BOT_NAMES = ['Nova', 'Pike', 'Juno', 'Rook', 'Vex', 'Tala', 'Ember', 'Quill', 'Sable', 'Orin'];
export const BOT_COLORS = [0x9fd8ff, 0xff9fbf, 0xb7f59a, 0xffd28a, 0xc7a8ff, 0x8af2e2, 0xffb08a, 0xe6e6e6];

interface ClientRuntime {
  cmdWindowStart: number;
  cmdCount: number;
  violations: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Rounds coordinates so event batches stay small on the wire. */
function compactEvents(events: ArenaEvent[]): ArenaEvent[] {
  return events.map((e) => {
    if (e.type !== 'shot') return e;
    return {
      ...e,
      origin: e.origin.map(r2) as [number, number, number],
      ends: e.ends.map((p) => p.map(r2) as [number, number, number]),
      normals: e.normals.map((n) => (n ? (n.map(Math.round) as [number, number, number]) : null)),
    };
  });
}

export class ArenaRoom extends HubRoom<ArenaState, ArenaPlayer> {
  protected readonly gameId = 'arena' as const;
  sim!: ArenaSimulation;
  private readonly runtime = new Map<string, ClientRuntime>();
  private lastTime = 0;
  private acc = 0;
  private lastPhase = '';
  private warmupSince = 0;
  private readonly rematchVoters = new Set<string>();

  protected resolveMode(requested: unknown): string {
    return isArenaMode(requested) ? requested : '1v1';
  }

  protected setup(): void {
    const mode = this.mode as ArenaMode;
    this.maxClients = ARENA_MODE_INFO[mode].maxPlayers;
    this.state = new ArenaState();
    this.chatEnabled = true;
    this.state.mapIndex = Math.floor(Math.random() * ARENA_MAPS.length);
    this.state.minHumans = ARENA_MODE_INFO[mode].minHumansToStart;
    this.sim = new ArenaSimulation(arenaMap(this.state.mapIndex), mode, { seed: (Math.random() * 1e9) | 0 });

    // Binary messages have their own handlers (sent with sendBytes on the client).
    this.onMessageBytes(ArenaMsg.Input, (client, data) => this.handleInput(client, data));
    this.onMessage(ArenaMsg.Loadout, (client, data: { weapon?: unknown }) => {
      if (typeof data?.weapon === 'number') this.sim.setLoadout(client.sessionId, data.weapon);
      this.syncState();
    });
    this.onMessage(ArenaMsg.Start, (client, data: { bots?: unknown }) => this.handleStart(client, data?.bots === true));
    this.onMessage(ArenaMsg.Rematch, (client) => this.handleRematch(client));

    // Schema patches (roster, score, phase) don't need 30 Hz.
    this.patchRate = 100;
    this.lastTime = performance.now();
    this.warmupSince = Date.now();
    this.setTimestep(() => this.update(), TICK_MS);
  }

  protected createPlayer(_client: Client, options: JoinOptions): ArenaPlayer {
    const p = new ArenaPlayer();
    p.color = typeof options.color === 'number' ? options.color & 0xffffff : 0xff7a45;
    return p;
  }

  protected override onPlayerJoined(client: Client, player: ArenaPlayer): void {
    // Make room by retiring a bot if the match is full.
    if (this.sim.players.size >= this.sim.maxPlayers) {
      const bot = [...this.sim.players.values()].reverse().find((p) => p.bot);
      if (bot) this.removeBot(bot.id);
    }
    this.sim.addPlayer({ id: client.sessionId, name: player.name, color: player.color });
    this.runtime.set(client.sessionId, { cmdWindowStart: Date.now(), cmdCount: 0, violations: 0 });
    this.syncState();
  }

  protected override onPlayerDropped(sessionId: string): void {
    const p = this.sim.players.get(sessionId);
    if (p) p.connected = false;
  }

  protected override onPlayerReconnected(client: Client): void {
    const p = this.sim.players.get(client.sessionId);
    if (!p) return;
    p.connected = true;
    // A reloaded page restarts its command sequence numbers.
    p.sim.lastSeq = 0;
    p.queue.length = 0;
  }

  protected override onPlayerRemoved(sessionId: string): void {
    this.runtime.delete(sessionId);
    this.rematchVoters.delete(sessionId);
    this.sim.removePlayer(sessionId);
    // Keep team matches even by back-filling with a bot mid-match.
    if (this.sim.phase !== 'warmup' && this.mode !== 'ffa' && this.humanCount() > 0 && this.sim.players.size < this.sim.maxPlayers) {
      this.addBot();
    }
    if (this.humanCount() === 0) this.sim.removeBots();
    this.syncState();
  }

  protected override describeStatus(): string {
    const s = this.state;
    if (!s) return '';
    if (s.phase === 'warmup') return `Waiting for players · ${arenaMap(s.mapIndex).name}`;
    if (this.mode === 'ffa') return `Round ${s.round} · ${arenaMap(s.mapIndex).name}`;
    return `Round ${s.round} · ${s.teamWins0}–${s.teamWins1} · ${arenaMap(s.mapIndex).name}`;
  }

  // ---- tick -------------------------------------------------------------------------------

  private update(): void {
    const now = performance.now();
    this.acc += now - this.lastTime;
    this.lastTime = now;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 4) {
      this.acc -= TICK_MS;
      steps++;
      this.stepOnce();
    }
    if (this.acc > TICK_MS * 4) this.acc = 0; // event-loop stall: don't try to catch up forever
  }

  private stepOnce(): void {
    const sim = this.sim;
    this.warmupLogic();
    sim.step();
    const events = sim.drainEvents();

    // Match finished and its end screen has run: rotate the map and go back to warmup.
    if (sim.phase === 'matchEnd' && sim.phaseTimer <= 0) this.nextMatch(false);

    this.syncState();

    // Per-client snapshots share one encoded pose block.
    const poses: NetPose[] = [];
    for (const p of sim.players.values()) poses.push(poseOf(p));
    const block = encodePoses(poses);
    for (const client of this.clients) {
      const p = sim.players.get(client.sessionId);
      client.sendBytes(ArenaMsg.Snapshot, encodeSnapshot(sim.tick, p?.sim.lastSeq ?? 0, p ? p.sim : null, block));
    }
    if (events.length) this.broadcast(ArenaMsg.Events, compactEvents(events));
  }

  private warmupLogic(): void {
    const sim = this.sim;
    if (sim.phase !== 'warmup') {
      this.state.startTick = 0;
      this.warmupSince = Date.now();
      return;
    }
    const humans = this.humanCount();
    const enoughHumans = humans >= this.state.minHumans;
    if (enoughHumans && this.state.startTick === 0) this.state.startTick = sim.tick + AUTO_START_DELAY * TICK_RATE;
    if (!enoughHumans && this.state.startTick !== 0 && ![...sim.players.values()].some((p) => p.bot)) this.state.startTick = 0;
    // Lonely public room: bring in bots so nobody waits forever.
    if (!this.isPrivate && humans > 0 && !enoughHumans && this.state.startTick === 0 && Date.now() - this.warmupSince > LONELY_FILL_AFTER * 1000) {
      this.fillBots();
      this.state.startTick = sim.tick + AUTO_START_DELAY * TICK_RATE;
    }
    if (this.state.startTick !== 0 && sim.tick >= this.state.startTick) {
      this.state.startTick = 0;
      if (this.sim.players.size >= 2) sim.startMatch();
    }
  }

  // ---- messages ------------------------------------------------------------------------------

  private handleInput(client: Client, raw: unknown): void {
    const bytes = asBytes(raw);
    const p = this.sim.players.get(client.sessionId);
    const rt = this.runtime.get(client.sessionId);
    if (!bytes || !p || !rt) return;
    const now = Date.now();
    if (now - rt.cmdWindowStart > 1000) {
      rt.cmdWindowStart = now;
      rt.cmdCount = 0;
    }
    let cmds;
    try {
      const ref = p.queue.length ? p.queue[p.queue.length - 1].seq : p.sim.lastSeq;
      cmds = decodeCommands(bytes, ref);
    } catch {
      this.violation(client, rt, 'malformed input');
      return;
    }
    for (const c of cmds) {
      if (++rt.cmdCount > MAX_CMDS_PER_SECOND) {
        this.violation(client, rt, 'input flood');
        return;
      }
      // Only the six defined buttons; anything else is ignored.
      c.buttons &= 0x3f;
      this.sim.queueCommand(client.sessionId, c);
    }
  }

  private violation(client: Client, rt: ClientRuntime, reason: string): void {
    rt.violations++;
    if (rt.violations > MAX_VIOLATIONS) {
      this.log.warn(`kicking ${client.sessionId}: ${reason}`);
      client.leave(CLOSE_KICKED);
    }
  }

  private handleStart(client: Client, withBots: boolean): void {
    if (client.sessionId !== this.state.hostId || this.sim.phase !== 'warmup') return;
    if (withBots) this.fillBots();
    if (this.sim.players.size < 2) {
      client.send('chat', { id: '', name: '', color: 0, text: 'Need at least one opponent: invite a friend or start with bots.', system: true });
      return;
    }
    this.state.startTick = 0;
    this.sim.startMatch();
    this.syncState();
  }

  private handleRematch(client: Client): void {
    if (this.sim.phase !== 'matchEnd') return;
    this.rematchVoters.add(client.sessionId);
    this.state.rematchVotes = this.rematchVoters.size;
    const connectedHumans = [...this.sim.players.values()].filter((p) => !p.bot && p.connected).length;
    if (client.sessionId === this.state.hostId || this.rematchVoters.size >= connectedHumans) this.nextMatch(true);
  }

  /** Rotates to the next map; starts immediately (rematch) or returns to warmup. */
  private nextMatch(startNow: boolean): void {
    this.rematchVoters.clear();
    this.state.rematchVotes = 0;
    this.state.mapIndex = (this.state.mapIndex + 1) % ARENA_MAPS.length;
    this.sim.changeMap(arenaMap(this.state.mapIndex));
    if (startNow) this.sim.startMatch();
    else this.sim.resetToWarmup();
    this.syncState();
  }

  // ---- bots --------------------------------------------------------------------------------------

  private fillBots(): void {
    const used = new Set([...this.sim.players.values()].map((p) => p.name));
    const names = BOT_NAMES.filter((n) => !used.has(n));
    this.sim.fillWithBots(names.length ? names : BOT_NAMES, BOT_COLORS);
    this.syncState();
  }

  private addBot(): void {
    const used = new Set([...this.sim.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? 'Bot';
    this.sim.addPlayer({ id: `bot-${Math.floor(Math.random() * 1e9)}`, name, color: BOT_COLORS[0], bot: true });
  }

  private removeBot(id: string): void {
    this.sim.removePlayer(id);
    this.state.players.delete(id);
  }

  // ---- schema sync -------------------------------------------------------------------------------------

  /** Copies low-frequency match data from the simulation into the schema (only changed fields). */
  private syncState(): void {
    const s = this.state;
    const sim = this.sim;
    const set = <K extends keyof ArenaState>(key: K, value: ArenaState[K]) => {
      if (s[key] !== value) s[key] = value;
    };
    if (sim.phase !== this.lastPhase) {
      this.lastPhase = sim.phase;
      set('phase', sim.phase);
      set('phaseEndTick', sim.phase === 'warmup' ? 0 : sim.tick + Math.round(sim.phaseTimer * TICK_RATE));
      void this.refreshMetadata();
    }
    set('round', sim.round);
    set('teamWins0', sim.teamWins[0]);
    set('teamWins1', sim.teamWins[1]);
    set('roundWinnerTeam', sim.lastRoundWinner ? sim.lastRoundWinner.team : -2);
    set('roundWinnerId', sim.lastRoundWinner?.id ?? '');
    set('matchWinnerTeam', sim.matchWinner ? sim.matchWinner.team : -2);
    set('matchWinnerId', sim.matchWinner?.id ?? '');

    for (const p of sim.players.values()) {
      let sp = s.players.get(p.id);
      if (!sp) {
        if (!p.bot) continue; // humans are created by onJoin
        sp = new ArenaPlayer();
        sp.bot = true;
        sp.name = p.name;
        sp.color = p.color;
        s.players.set(p.id, sp);
      }
      const upd = <K extends keyof ArenaPlayer>(key: K, value: ArenaPlayer[K]) => {
        if (sp![key] !== value) sp![key] = value;
      };
      upd('team', Math.max(0, p.team));
      upd('index', p.index);
      upd('kills', p.stats.kills);
      upd('deaths', p.stats.deaths);
      upd('damage', Math.round(p.stats.damage));
      upd('shots', p.stats.shots);
      upd('hits', p.stats.hits);
      upd('headshots', p.stats.headshots);
      upd('roundWins', p.stats.roundWins);
      upd('primary', p.primary);
    }
    // Drop bots the simulation no longer has.
    s.players.forEach((sp, id) => {
      if (sp.bot && !sim.players.has(id)) s.players.delete(id);
    });
  }
}

function poseOf(p: SimPlayer): NetPose {
  const s = p.sim;
  return {
    index: p.index,
    x: s.x,
    y: s.y,
    z: s.z,
    yaw: s.yaw,
    pitch: s.pitch,
    flags:
      (s.alive ? PoseFlags.Alive : 0) |
      (s.crouching ? PoseFlags.Crouch : 0) |
      (s.aiming ? PoseFlags.Aim : 0) |
      (s.reload > 0 ? PoseFlags.Reload : 0) |
      (s.onGround ? PoseFlags.Ground : 0),
    hp: s.hp,
    weapon: s.weapons[s.slot].id,
  };
}
