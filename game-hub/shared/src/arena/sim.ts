/**
 * ArenaSimulation: the authoritative game logic for one Arcfire Arena match.
 *
 * Runs at TICK_RATE (30 Hz). Each tick it:
 *  1. lets bots produce input commands (same format as human players),
 *  2. applies queued commands per player (each command = 1/60 s), bounded
 *     by a time budget so a client cannot run faster than real time,
 *  3. resolves shots with lag compensation: other players' hitboxes are
 *     rewound to the tick the shooter was looking at (capped at 220 ms),
 *  4. steps projectiles and pickups, advances the round state machine
 *     (map vote → loadout → live ⇄ round end → match end) and records hitbox history.
 *
 * Features with their own rules live in small systems the simulation drives:
 * ProjectileSystem (projectiles.ts), PickupSystem (pickups.ts) and
 * MapVoteSystem (vote.ts). They read and change the match through the public
 * methods marked "for the systems" below.
 *
 * Used by the Colyseus room on the server and directly by offline practice.
 */
import { ARENA_MODE_INFO, type ArenaMode } from '../constants';
import { clamp } from '../util/math';
import { mulberry32 } from '../util/rng';
import { applyBotProfile, type BotBrain, type BotDifficulty, botCommand, botHurt, createBotBrain, hearNoise, NavGraph, resetBotForMap } from './bots';
import {
  CMD_RATE,
  HISTORY_TICKS,
  LOADOUT_TIME,
  MATCH_END_TIME,
  MAX_HP,
  MAX_REWIND_MS,
  ROUND_END_TIME,
  ROUND_TIME,
  ROUNDS_TO_WIN,
  TICK_DT,
  TICK_RATE,
} from './constants';
import { type BoxWorld, createArenaWorld } from './geometry';
import { type HitTarget, hitboxesFor, type PoseLike, resolveShot } from './hitscan';
import { ARENA_MAPS, type ArenaMap, type PickupKind, type SpawnPoint } from './maps';
import { PickupSystem } from './pickups';
import { applyCommand, type Command, createPlayerSim, freshWeapon, type PlayerSim, respawnPlayer, type Shot } from './player';
import { ProjectileSystem } from './projectiles';
import { type MapVote, MapVoteSystem } from './vote';
import { DEFAULT_PRIMARY, DEFAULT_SECONDARY, isPrimary, isSecondary, pickBotLoadout, type WeaponId, weaponDef } from './weapons';

export type Phase = 'warmup' | 'vote' | 'loadout' | 'live' | 'roundEnd' | 'matchEnd';

export interface PlayerStats {
  kills: number;
  deaths: number;
  damage: number;
  shots: number;
  hits: number;
  headshots: number;
  roundWins: number;
}

export interface SimPlayer {
  id: string;
  name: string;
  color: number;
  team: number;
  bot: boolean;
  /** Small stable integer (spread seeds, snapshot slots). */
  index: number;
  sim: PlayerSim;
  /** Primary weapon used from the next spawn on. */
  primary: WeaponId;
  /** Secondary weapon used from the next spawn on. */
  secondary: WeaponId;
  /** Auto-shoot is on (scoreboard disclosure; never trusted). */
  autoShoot: boolean;
  /** Pad that launched this player last (-1 = none), and when (sim.time). Bots use it to pass pad nodes. */
  launchPad: number;
  launchedAt: number;
  stats: PlayerStats;
  queue: Command[];
  budget: number;
  connected: boolean;
  diedAt: number;
}

export type Tuple3 = [number, number, number];

export type ArenaEvent =
  | { type: 'shot'; shooter: string; weapon: WeaponId; origin: Tuple3; ends: Tuple3[]; hits: boolean[]; normals: (Tuple3 | null)[]; seq: number }
  | { type: 'hit'; shooter: string; victim: string; damage: number; headshot: boolean; killed: boolean }
  | { type: 'kill'; killer: string; victim: string; weapon: WeaponId; headshot: boolean }
  | { type: 'phase'; phase: Phase; round: number }
  | { type: 'roundEnd'; winnerTeam: number; winnerId: string | null; reason: 'elimination' | 'time' | 'draw' }
  | { type: 'matchEnd'; winnerTeam: number; winnerId: string | null }
  | { type: 'reload'; id: string }
  | { type: 'spawn'; id: string }
  /** A pad launched this player. */
  | { type: 'launch'; id: string; pad: number }
  /** A projectile weapon fired (instead of 'shot'). Projectiles are never in snapshots. */
  | { type: 'proj'; id: number; shooter: string; weapon: WeaponId; origin: Tuple3; vel: Tuple3; tick: number; seq: number }
  | { type: 'projEnd'; id: number; pos: Tuple3; normal: Tuple3 | null; hitId: string | null; headshot: boolean; tick: number }
  | { type: 'pickup'; id: string; index: number; kind: PickupKind; amount: number }
  | { type: 'mapVote'; winner: number; tie: boolean };

export interface SimOptions {
  /** Start rounds automatically once enough players are present. */
  autoStart?: boolean;
  /** After the match-end screen, return to warmup with stats reset. */
  loopMatches?: boolean;
  seed?: number;
  /** Bot difficulty (default 'normal'). */
  botDifficulty?: BotDifficulty;
}

const MAX_BUDGET = 24;
const MAX_REWIND_TICKS = (MAX_REWIND_MS / 1000) * TICK_RATE;
const WARMUP_RESPAWN = 2;

interface HistoryEntry {
  tick: number;
  poses: Map<string, PoseLike & { alive: boolean }>;
}

export class ArenaSimulation {
  world: BoxWorld;
  nav: NavGraph;
  /** Index of `map` in ARENA_MAPS; -1 for a custom (test/fixture) map. */
  mapIndex: number;
  botDifficulty: BotDifficulty;
  readonly projectiles = new ProjectileSystem();
  readonly pickups = new PickupSystem();
  readonly voting = new MapVoteSystem();
  readonly teams: number;
  tick = 0;
  /** Simulation time in seconds. */
  time = 0;
  phase: Phase = 'warmup';
  /** Seconds left in the current phase (warmup: unused). */
  phaseTimer = 0;
  round = 0;
  teamWins = [0, 0];
  lastRoundWinner: { team: number; id: string | null } | null = null;
  matchWinner: { team: number; id: string | null } | null = null;
  readonly players = new Map<string, SimPlayer>();
  private readonly history: HistoryEntry[] = [];
  private events: ArenaEvent[] = [];
  private readonly brains = new Map<string, BotBrain>();
  private readonly rnd: () => number;
  private nextIndex = 0;
  private freeIndices: number[] = [];

  constructor(
    public map: ArenaMap,
    readonly mode: ArenaMode,
    private readonly opts: SimOptions = {},
  ) {
    this.world = createArenaWorld(map);
    this.nav = new NavGraph(map, this.world);
    this.mapIndex = ARENA_MAPS.indexOf(map);
    this.teams = ARENA_MODE_INFO[mode].teams;
    this.rnd = mulberry32(opts.seed ?? 1234);
    this.botDifficulty = opts.botDifficulty ?? 'normal';
    this.pickups.reset(map);
  }

  /** The current map vote, or null. */
  get vote(): MapVote | null {
    return this.voting.current;
  }

  /** Deterministic sim RNG (authority only), for the systems. */
  random(): number {
    return this.rnd();
  }

  /** Queues an event in this tick's batch (for the systems). */
  emit(e: ArenaEvent): void {
    this.events.push(e);
  }

  /** Switches to another map (between matches). Everyone respawns there. */
  changeMap(map: ArenaMap): void {
    this.map = map;
    this.mapIndex = ARENA_MAPS.indexOf(map);
    this.world = createArenaWorld(map);
    this.nav = new NavGraph(map, this.world);
    this.history.length = 0;
    this.projectiles.clear();
    this.pickups.reset(map);
    for (const b of this.brains.values()) resetBotForMap(b);
    if (this.phase === 'warmup') for (const p of this.players.values()) this.spawn(p);
  }

  /** Back to warmup (players stay, stats reset at the next startMatch). */
  resetToWarmup(): void {
    this.matchWinner = null;
    this.lastRoundWinner = null;
    this.teamWins = [0, 0];
    this.round = 0;
    this.setPhase('warmup', 0);
    for (const p of this.players.values()) this.spawn(p);
    this.projectiles.clear();
    this.pickups.reset(this.map);
  }

  get maxPlayers(): number {
    return ARENA_MODE_INFO[this.mode].maxPlayers;
  }

  /** Damage only counts in live rounds and warmup. */
  get damageEnabled(): boolean {
    return this.phase === 'live' || this.phase === 'warmup';
  }

  // ---- roster ----------------------------------------------------------------------------

  addPlayer(meta: { id: string; name: string; color: number; bot?: boolean; primary?: WeaponId; secondary?: WeaponId }): SimPlayer {
    const existing = this.players.get(meta.id);
    if (existing) return existing;
    const index = this.freeIndices.length ? this.freeIndices.shift()! : this.nextIndex++;
    const primary = isPrimary(meta.primary) ? meta.primary : DEFAULT_PRIMARY;
    const secondary = isSecondary(meta.secondary) ? meta.secondary : DEFAULT_SECONDARY;
    const p: SimPlayer = {
      id: meta.id,
      name: meta.name,
      color: meta.color,
      team: this.pickTeam(index),
      bot: !!meta.bot,
      index,
      sim: createPlayerSim(primary, secondary),
      primary,
      secondary,
      autoShoot: false,
      launchPad: -1,
      launchedAt: -1e9,
      stats: { kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, headshots: 0, roundWins: 0 },
      queue: [],
      budget: 4,
      connected: true,
      diedAt: 0,
    };
    // Joining mid-round: wait for the next round as a spectator (warmup spawns immediately).
    p.sim.alive = false;
    p.sim.hp = 0;
    this.players.set(p.id, p);
    if (p.bot) {
      this.brains.set(p.id, createBotBrain(this.rnd, this.botDifficulty));
      const lo = pickBotLoadout(this.rnd);
      p.primary = lo.primary;
      p.secondary = lo.secondary;
    }
    this.voting.onPlayerAdded(this, p);
    if (this.phase === 'warmup') this.spawn(p);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.brains.delete(id);
    this.freeIndices.push(p.index);
    this.freeIndices.sort((a, b) => a - b);
    this.voting.onPlayerRemoved(this, id);
  }

  /** Loadout picks. Invalid ids are ignored per slot. Applies at once in loadout/warmup, otherwise at the next spawn. */
  setLoadout(id: string, primary: unknown, secondary?: unknown): void {
    const p = this.players.get(id);
    if (!p) return;
    const prim = isPrimary(primary) ? primary : null;
    const sec = isSecondary(secondary) ? secondary : null;
    if (prim !== null) p.primary = prim;
    if (sec !== null) p.secondary = sec;
    if (this.phase !== 'loadout' && this.phase !== 'warmup') return;
    const s = p.sim;
    if (prim !== null) {
      s.weapons[0] = freshWeapon(prim);
      if (s.slot === 0) {
        s.reload = 0;
        s.burstLeft = 0;
        s.ads = 0;
      }
    }
    if (sec !== null) {
      s.weapons[1] = freshWeapon(sec);
      if (s.slot === 1) {
        s.reload = 0;
        s.burstLeft = 0;
        s.ads = 0;
      }
    }
  }

  /** Records the player's auto-shoot preference (shown on the scoreboard; it never changes what the server accepts). */
  setAutoShootFlag(id: string, on: boolean): void {
    const p = this.players.get(id);
    if (p) p.autoShoot = on === true;
  }

  setBotDifficulty(d: BotDifficulty): void {
    this.botDifficulty = d;
    for (const b of this.brains.values()) applyBotProfile(b, d);
  }

  /** Queues a client command. Old or duplicate sequence numbers are dropped. */
  queueCommand(id: string, cmd: Command): void {
    const p = this.players.get(id);
    if (!p) return;
    const last = p.queue.length ? p.queue[p.queue.length - 1].seq : p.sim.lastSeq;
    if (cmd.seq <= last) return;
    p.queue.push(cmd);
    if (p.queue.length > 120) p.queue.splice(0, p.queue.length - 60);
  }

  humans(): SimPlayer[] {
    return [...this.players.values()].filter((p) => !p.bot);
  }

  /** Fills empty slots with bots. */
  fillWithBots(namePool: string[], colors: number[]): void {
    let i = 0;
    while (this.players.size < this.maxPlayers) {
      const id = `bot-${this.nextIndex}-${Math.floor(this.rnd() * 1e6)}`;
      this.addPlayer({ id, name: namePool[i % namePool.length], color: colors[i % colors.length], bot: true });
      i++;
    }
  }

  removeBots(): void {
    for (const p of [...this.players.values()]) if (p.bot) this.removePlayer(p.id);
  }

  drainEvents(): ArenaEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---- match flow ------------------------------------------------------------------------

  /** warmup | matchEnd → map vote, or straight to the match when no vote is possible. */
  startVote(): void {
    if (!this.voting.open(this)) this.startMatch();
  }

  castVote(id: string, mapIndex: number): boolean {
    return this.voting.cast(this, id, mapIndex);
  }

  startMatch(): void {
    this.voting.current = null;
    this.voting.lastMatchMap = this.mapIndex;
    this.teamWins = [0, 0];
    this.matchWinner = null;
    this.round = 0;
    for (const p of this.players.values()) p.stats = { kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, headshots: 0, roundWins: 0 };
    this.rebalanceTeams();
    this.startRound();
  }

  private startRound(): void {
    this.round++;
    this.history.length = 0;
    this.projectiles.clear();
    this.pickups.reset(this.map);
    const spawns = this.spawnOrder();
    let i = 0;
    for (const p of this.players.values()) {
      if (p.bot) {
        const lo = pickBotLoadout(this.rnd);
        p.primary = lo.primary;
        p.secondary = lo.secondary;
      }
      this.spawn(p, spawns(p, i++));
      p.queue.length = 0;
    }
    this.setPhase('loadout', LOADOUT_TIME);
  }

  /** For the systems: enters a phase with its timer and announces it. */
  setPhase(phase: Phase, timer: number): void {
    this.phase = phase;
    this.phaseTimer = timer;
    this.events.push({ type: 'phase', phase, round: this.round });
  }

  /** For the systems: whether a match can be played with the current roster. */
  enoughPlayers(): boolean {
    const n = this.players.size;
    return this.teams === 0 ? n >= 2 : this.teamCount(0) > 0 && this.teamCount(1) > 0;
  }

  private teamCount(team: number): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  // ---- tick ------------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.time += TICK_DT;
    const frozen = this.phase === 'loadout' || this.phase === 'matchEnd' || this.phase === 'vote';

    // Bots produce two 60 Hz commands per 30 Hz tick, like real clients.
    for (const p of this.players.values()) {
      const brain = this.brains.get(p.id);
      if (!brain) continue;
      for (let k = 0; k < CMD_RATE / TICK_RATE; k++) this.queueCommand(p.id, botCommand(this, p, brain));
    }

    for (const p of this.players.values()) {
      p.budget = Math.min(MAX_BUDGET, p.budget + CMD_RATE * TICK_DT);
      while (p.queue.length && p.budget >= 1) {
        const cmd = p.queue.shift()!;
        p.budget -= 1;
        const ev = applyCommand(p.sim, cmd, this.world, frozen, p.index);
        if (ev.shot) this.fire(p, ev.shot);
        if (ev.reloadStarted) this.events.push({ type: 'reload', id: p.id });
        if (ev.launched >= 0) {
          p.launchPad = ev.launched;
          p.launchedAt = this.time;
          this.events.push({ type: 'launch', id: p.id, pad: ev.launched });
        }
      }
    }

    this.projectiles.step(this);
    if (this.phase === 'live' || this.phase === 'warmup') this.pickups.step(this);
    this.advancePhase();
    this.recordHistory();
  }

  private advancePhase(): void {
    switch (this.phase) {
      case 'warmup':
        for (const p of this.players.values()) {
          if (!p.sim.alive && this.time - p.diedAt > WARMUP_RESPAWN) this.spawn(p);
        }
        if (this.opts.autoStart && this.enoughPlayers()) this.startMatch();
        break;
      case 'vote':
        this.voting.step(this);
        break;
      case 'loadout':
        this.phaseTimer -= TICK_DT;
        if (this.phaseTimer <= 0) this.setPhase('live', ROUND_TIME);
        break;
      case 'live': {
        this.phaseTimer -= TICK_DT;
        const result = this.checkRoundOver();
        if (result) this.endRound(result.team, result.id, result.reason);
        else if (this.phaseTimer <= 0) {
          const t = this.timeoutWinner();
          this.endRound(t.team, t.id, t.team < 0 && !t.id ? 'draw' : 'time');
        }
        break;
      }
      case 'roundEnd':
        this.phaseTimer -= TICK_DT;
        if (this.phaseTimer <= 0) {
          if (this.matchWinner) this.setPhase('matchEnd', MATCH_END_TIME);
          else if (!this.enoughPlayers()) this.setPhase('warmup', 0);
          else this.startRound();
        }
        break;
      case 'matchEnd':
        this.phaseTimer -= TICK_DT;
        if (this.phaseTimer <= 0 && this.opts.loopMatches) this.resetToWarmup();
        break;
    }
  }

  /** Elimination check. Returns the winner, or null while the round continues. */
  private checkRoundOver(): { team: number; id: string | null; reason: 'elimination' | 'draw' } | null {
    const alive = [...this.players.values()].filter((p) => p.sim.alive);
    if (this.teams === 0) {
      if (alive.length > 1) return null;
      if (alive.length === 1) return { team: -1, id: alive[0].id, reason: 'elimination' };
      return { team: -1, id: null, reason: 'draw' };
    }
    const a = alive.filter((p) => p.team === 0).length;
    const b = alive.filter((p) => p.team === 1).length;
    if (a > 0 && b > 0) return null;
    if (a === 0 && b === 0) return { team: -1, id: null, reason: 'draw' };
    return { team: a > 0 ? 0 : 1, id: null, reason: 'elimination' };
  }

  private timeoutWinner(): { team: number; id: string | null } {
    const alive = [...this.players.values()].filter((p) => p.sim.alive);
    if (this.teams === 0) {
      alive.sort((x, y) => y.sim.hp - x.sim.hp);
      if (alive.length === 0 || (alive.length > 1 && alive[0].sim.hp === alive[1].sim.hp)) return { team: -1, id: null };
      return { team: -1, id: alive[0].id };
    }
    const score = (t: number) => {
      const members = alive.filter((p) => p.team === t);
      return members.length * 1000 + members.reduce((s, p) => s + p.sim.hp, 0);
    };
    const a = score(0);
    const b = score(1);
    return a === b ? { team: -1, id: null } : { team: a > b ? 0 : 1, id: null };
  }

  private endRound(team: number, id: string | null, reason: 'elimination' | 'time' | 'draw'): void {
    if (this.teams > 0 && team >= 0) this.teamWins[team]++;
    if (this.teams === 0 && id) {
      const w = this.players.get(id);
      if (w) w.stats.roundWins++;
    }
    this.lastRoundWinner = { team, id };
    this.events.push({ type: 'roundEnd', winnerTeam: team, winnerId: id, reason });
    // Match over?
    if (this.teams > 0) {
      const t = this.teamWins.findIndex((w) => w >= ROUNDS_TO_WIN);
      if (t >= 0) this.matchWinner = { team: t, id: null };
    } else {
      for (const p of this.players.values()) if (p.stats.roundWins >= ROUNDS_TO_WIN) this.matchWinner = { team: -1, id: p.id };
    }
    if (this.matchWinner) this.events.push({ type: 'matchEnd', winnerTeam: this.matchWinner.team, winnerId: this.matchWinner.id });
    this.setPhase('roundEnd', ROUND_END_TIME);
  }

  // ---- combat ---------------------------------------------------------------------------

  private fire(p: SimPlayer, shot: Shot): void {
    p.stats.shots++;
    const def = weaponDef(shot.weapon);
    // Bots see the present; humans hit what they saw (rewound, capped).
    const rewind = p.bot || !Number.isFinite(shot.viewTick) ? 0 : clamp(this.tick - shot.viewTick, 0, MAX_REWIND_TICKS);
    if (def.kind === 'projectile') {
      // Silent weapon: no alertBots.
      this.projectiles.spawn(this, p, shot, rewind);
      return;
    }
    const { pellets, damage } = resolveShot(shot, this.world, this.targetsFor(p, this.tick - rewind));
    this.events.push({
      type: 'shot',
      shooter: p.id,
      weapon: shot.weapon,
      origin: [shot.ox, shot.oy, shot.oz],
      ends: pellets.map((r) => r.end),
      hits: pellets.map((r) => r.hitId !== null),
      normals: pellets.map((r) => r.wallNormal),
      seq: shot.seq,
    });
    if (damage.length) p.stats.hits++;
    for (const d of damage) this.applyDamage(p, d.id, d.damage, d.headshot, shot.weapon);
    this.alertBots(p, shot.ox, shot.oy, shot.oz);
  }

  /** Enemy hitboxes as seen at a (fractional) tick: rewound history, else live. Excludes self, teammates, the dead. */
  targetsFor(shooter: SimPlayer, tick: number): HitTarget[] {
    const out: HitTarget[] = [];
    for (const o of this.players.values()) {
      if (o === shooter) continue;
      if (this.teams > 0 && o.team === shooter.team) continue; // no friendly fire; bullets pass teammates
      const pose = this.poseAt(o.id, tick) ?? { x: o.sim.x, y: o.sim.y, z: o.sim.z, crouching: o.sim.crouching, alive: o.sim.alive };
      if (!pose.alive || !o.sim.alive) continue;
      out.push({ id: o.id, boxes: hitboxesFor(pose) });
    }
    return out;
  }

  /** For the systems: deals damage (live and warmup only), with hit/kill events and stats. */
  applyDamage(attacker: SimPlayer, victimId: string, amount: number, headshot: boolean, weapon: WeaponId): void {
    const v = this.players.get(victimId);
    if (!v || !v.sim.alive || !this.damageEnabled) return;
    const dealt = Math.min(amount, v.sim.hp);
    v.sim.hp -= amount;
    attacker.stats.damage += dealt;
    const brain = this.brains.get(v.id);
    if (brain && dealt > 0) botHurt(brain, attacker.id, this.time);
    const killed = v.sim.hp <= 0;
    this.events.push({ type: 'hit', shooter: attacker.id, victim: v.id, damage: Math.round(dealt), headshot, killed });
    if (killed) {
      v.sim.hp = 0;
      v.sim.alive = false;
      v.diedAt = this.time;
      v.stats.deaths++;
      attacker.stats.kills++;
      if (headshot) attacker.stats.headshots++;
      this.events.push({ type: 'kill', killer: attacker.id, victim: v.id, weapon, headshot });
    }
  }

  /** Gunfire at (x, y, z): every enemy bot gets to hear it. */
  private alertBots(shooter: SimPlayer, x: number, y: number, z: number): void {
    for (const [id, brain] of this.brains) {
      const bot = this.players.get(id);
      if (!bot || bot === shooter || !bot.sim.alive || (this.teams > 0 && bot.team === shooter.team)) continue;
      hearNoise(brain, bot.sim, x, y, z, this.time);
    }
  }

  /** Kills a player outright (left the match, fell out of the world). */
  eliminate(id: string): void {
    const p = this.players.get(id);
    if (!p || !p.sim.alive) return;
    p.sim.alive = false;
    p.sim.hp = 0;
    p.diedAt = this.time;
    if (this.phase === 'live') p.stats.deaths++;
  }

  // ---- history (lag compensation) ------------------------------------------------------------

  private recordHistory(): void {
    const poses = new Map<string, PoseLike & { alive: boolean }>();
    for (const p of this.players.values()) poses.set(p.id, { x: p.sim.x, y: p.sim.y, z: p.sim.z, crouching: p.sim.crouching, alive: p.sim.alive });
    this.history.push({ tick: this.tick, poses });
    if (this.history.length > HISTORY_TICKS) this.history.shift();
  }

  /** Interpolated pose of a player at a (fractional) past tick. */
  poseAt(id: string, tick: number): (PoseLike & { alive: boolean }) | null {
    if (this.history.length === 0) return null;
    const t0 = Math.floor(tick);
    const a = this.history.find((h) => h.tick === t0)?.poses.get(id);
    const b = this.history.find((h) => h.tick === t0 + 1)?.poses.get(id);
    if (a && b) {
      const k = tick - t0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, crouching: k < 0.5 ? a.crouching : b.crouching, alive: a.alive && b.alive };
    }
    return a ?? b ?? null;
  }

  // ---- spawning & teams -----------------------------------------------------------------------

  private pickTeam(index: number): number {
    if (this.teams === 0) return index; // FFA: everyone is their own team
    return this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
  }

  private rebalanceTeams(): void {
    if (this.teams === 0) return;
    // Move bots first so humans keep their side.
    const list = [...this.players.values()].sort((a, b) => Number(a.bot) - Number(b.bot));
    let diff = this.teamCount(0) - this.teamCount(1);
    for (let i = list.length - 1; i >= 0 && Math.abs(diff) > 1; i--) {
      const p = list[i];
      if (diff > 1 && p.team === 0) {
        p.team = 1;
        diff -= 2;
      } else if (diff < -1 && p.team === 1) {
        p.team = 0;
        diff += 2;
      }
    }
  }

  private spawnOrder(): (p: SimPlayer, i: number) => SpawnPoint {
    const ffa = [...this.map.spawns.ffa].sort(() => this.rnd() - 0.5);
    const teamCounters = [0, 0];
    return (p) => {
      if (this.teams === 0) return ffa[p.index % ffa.length];
      const list = this.map.spawns.team[p.team];
      return list[teamCounters[p.team]++ % list.length];
    };
  }

  private spawn(p: SimPlayer, at?: SpawnPoint): void {
    const point = at ?? this.randomSpawn(p);
    respawnPlayer(p.sim, point.x, point.y, point.z, point.yaw, p.primary, p.secondary);
    p.sim.hp = MAX_HP;
    this.events.push({ type: 'spawn', id: p.id });
  }

  private randomSpawn(p: SimPlayer): SpawnPoint {
    const list = this.teams === 0 ? this.map.spawns.ffa : this.map.spawns.team[p.team];
    return list[Math.floor(this.rnd() * list.length)];
  }
}
