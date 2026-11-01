/**
 * Creatures on the server (WP-C, design-voxel-mobs §9.4-9.5): runs the shared
 * EntityWorld inside VoxelRoom's 20 Hz tick, sends each client its 'N'
 * snapshot at 10 Hz and its 'V' events every tick, handles feeding/naming
 * ('mi' / 'mn'), keeps tamed creatures in the MOBS save section, and keeps
 * CPU in check on small servers with a governor (caps, path budget, chunk
 * generation budget).
 */
import type { Client } from '@colyseus/core';
import {
  type BlockEdit,
  buildSnapshot,
  decodeMobInteract,
  decodeMobsSection,
  defaultPlayerHooks,
  encodeEntitySnapshot,
  encodeEvents,
  encodeMobInteractResult,
  encodeMobsSection,
  EntityEventType,
  type EntityCaps,
  type EntityEvent,
  EntityWorld,
  type EntityWorldApi,
  eventsFor,
  INTERACT_REACH,
  IS_SOLID,
  MobCategory,
  MobFlag,
  type MoveUpdate,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type PlayerHooks,
  type PlayerTarget,
  rulesForMode,
  SERVER_CAPS,
  type StructureInfo,
  TokenBucket,
  VoxelMsg,
} from '@hub/shared';
import type { VoxelPlayer } from '../rooms/schema/VoxelState';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';
import { SECTION_TAGS } from './WorldStore';

const MOBS_TAG = SECTION_TAGS.mobs;
const GOVERNOR_WINDOW = 40;
const GOVERNOR_HIGH_MS = 2.0;
const GOVERNOR_LOW_MS = 1.0;
const MAX_LEVEL = 3;
const LOG_EVERY_MS = 60_000;

interface Track {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  at: number;
  /** Mob ids whose name/owner this client has been sent. */
  infoSent: Set<number>;
  mi: TokenBucket;
  renameAt: number;
  lastMoveAt: number;
}

/** Caps lowered `level` times by the governor (× 0.75 each, with floors). */
export function governedCaps(level: number): EntityCaps {
  const k = Math.pow(0.75, level);
  const p = Math.pow(0.7, level);
  return {
    ...SERVER_CAPS,
    maxNatural: Math.max(20, Math.round(SERVER_CAPS.maxNatural * k)),
    friendlyPerPlayer: Math.max(4, Math.round(SERVER_CAPS.friendlyPerPlayer * k)),
    hostilePerPlayer: Math.max(6, Math.round(SERVER_CAPS.hostilePerPlayer * k)),
    pathBudget: Math.max(200, Math.round(SERVER_CAPS.pathBudget * p)),
    losBudget: Math.max(24, Math.round(SERVER_CAPS.losBudget * k)),
  };
}

export class ServerEntities implements VoxelSubsystem {
  /** The creature sim, or null when none runs (parkour). */
  readonly api: EntityWorldApi | null;
  readonly sim: EntityWorld;
  private hooks: PlayerHooks | null = null;
  private readonly defaults: PlayerHooks;
  private readonly tracks = new Map<string, Track>();
  private targets: PlayerTarget[] = [];
  /** MOBS section bytes from the save we could not decode: kept, never overwritten. */
  private mobsUnreadable = false;
  private hadMobsSection = false;
  private readonly stepTimes: number[] = [];
  private level = 0;
  private levelChangedAt = 0;
  private calmTicks = 0;
  private lastLog = Date.now();
  private stepMsSum = 0;
  private stepCount = 0;

  constructor(
    protected readonly room: VoxelRoomApi,
    protected readonly saved: ReadonlyMap<string, Uint8Array> | null,
  ) {
    const world = room.world;
    this.sim = new EntityWorld(
      {
        getBlock: world.reader(),
        isAvailable: (x, z) => world.hasChunkView(x, z),
        warm: (cx, cz) => world.warm(cx, cz),
        generator: world.generator,
        timeOfDay: () => room.state.timeOfDay,
        setBlock: (x, y, z, id) => void room.applyServerEdit(x, y, z, id),
        announce: (text) => room.systemChat(text),
      },
      { seed: room.state.seed ^ 0x5eed, rules: rulesForMode(room.mode), caps: SERVER_CAPS },
    );
    this.defaults = defaultPlayerHooks(() => this.targets);
    this.sim.setPlayerHooks(this.wrap(this.defaults));
    this.api = this.sim;
  }

  /** Survival plugs in its player side here (sandbox: null = defaults). */
  setPlayerHooks(hooks: PlayerHooks | null): void {
    this.hooks = hooks;
    this.sim.setPlayerHooks(this.wrap(hooks ?? this.defaults));
  }

  /** Our own targets unless survival builds them. */
  private wrap(h: PlayerHooks): PlayerHooks {
    if (h !== this.defaults) return h;
    return { ...h, playerTargets: () => this.targets };
  }

  bind(): void {
    this.room.onBytes(VoxelMsg.MobInteract, (client, bytes) => this.handleInteract(client, bytes));
    this.room.onJson(VoxelMsg.MobName, (client, data) => this.handleName(client, data));
  }

  join(client: Client, player: VoxelPlayer): void {
    this.tracks.set(client.sessionId, this.newTrack(player));
  }

  reconnect(client: Client, player: VoxelPlayer): void {
    this.tracks.set(client.sessionId, this.newTrack(player));
  }

  leave(sessionId: string): void {
    this.tracks.delete(sessionId);
  }

  private newTrack(p: VoxelPlayer): Track {
    return { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, at: Date.now(), infoSent: new Set(), mi: new TokenBucket(4, 4), renameAt: 0, lastMoveAt: Date.now() };
  }

  move(sessionId: string, _m: MoveUpdate, accepted: boolean): void {
    const t = this.tracks.get(sessionId);
    if (t && accepted) t.lastMoveAt = Date.now();
  }

  /** Placement check: a solid block may not be placed into a creature. */
  validateEdit(_sessionId: string, e: BlockEdit, _current: number): string | null {
    if (e.id !== 0 && IS_SOLID[e.id] && this.sim.overlapsCell(e.x, e.y, e.z)) return 'occupied by a creature';
    return null;
  }

  afterEdit(_sessionId: string | null, e: BlockEdit): void {
    this.sim.onBlockChanged(e.x, e.y, e.z);
  }

  /** Dev/test: a synthetic structure (testArena) the sim treats like a generated one. */
  addStructure(info: StructureInfo): void {
    this.sim.extraStructures.push(info);
  }

  // ---- tick ---------------------------------------------------------------------------

  preTick(): void {
    // Chunk generation budget: 0 when nobody moved for 10 s, else 1 ms + 0.5 per player (max 3).
    const now = Date.now();
    let players = 0;
    let moving = false;
    for (const t of this.tracks.values()) {
      players++;
      if (now - t.lastMoveAt < 10_000) moving = true;
    }
    const w = this.room.world;
    w.warmBudgetMs = moving ? Math.min(3, 1 + 0.5 * players) / (1 + this.level * 0.5) : 0;
    w.setCacheBudget(Math.max(384, Math.min(768, 64 + 48 * players)));
  }

  tick(): void {
    this.updateTargets();
    const t0 = performance.now();
    this.sim.step();
    const ms = performance.now() - t0;
    this.governor(ms);
    if (this.sim.persistDirty) {
      this.sim.markPersistClean();
      this.room.markDirty();
    }
    this.flush();
    this.maybeLog();
  }

  /** Player targets from the schema plus a velocity estimate (EMA 0.5). */
  private updateTargets(): void {
    const out: PlayerTarget[] = [];
    const now = Date.now();
    this.room.state.players.forEach((p, id) => {
      if (!p.connected) return;
      let t = this.tracks.get(id);
      if (!t) this.tracks.set(id, (t = this.newTrack(p)));
      const dt = Math.max(0.05, (now - t.at) / 1000);
      if (p.x !== t.x || p.y !== t.y || p.z !== t.z || now - t.at > 200) {
        t.vx = t.vx * 0.5 + ((p.x - t.x) / dt) * 0.5;
        t.vy = t.vy * 0.5 + ((p.y - t.y) / dt) * 0.5;
        t.vz = t.vz * 0.5 + ((p.z - t.z) / dt) * 0.5;
        t.x = p.x;
        t.y = p.y;
        t.z = p.z;
        t.at = now;
      }
      out.push({
        id, eid: p.eid, name: p.name, x: p.x, y: p.y, z: p.z, vx: t.vx, vy: t.vy, vz: t.vz, yaw: p.yaw,
        crouching: (p.flags & 1) !== 0, sprinting: Math.hypot(t.vx, t.vz) > 5.5,
        // Survival's hooks decide; until then survival players are noticed (but never hurt).
        targetable: this.room.mode === 'survival', alive: true, halfWidth: PLAYER_WIDTH / 2, height: PLAYER_HEIGHT, blockingYaw: null,
      });
    });
    this.targets = out;
  }

  /** Events every tick, snapshots on even ticks (10 Hz), names of tamed creatures as they come into view. */
  private flush(): void {
    const sim = this.sim;
    const events = sim.events;
    const snapshotTick = sim.tick % 2 === 0;
    this.room.forEachClient((client) => {
      const p = this.room.state.players.get(client.sessionId);
      const track = this.tracks.get(client.sessionId);
      if (!p || !track) return;
      const viewer = { id: client.sessionId, x: p.x, y: p.y, z: p.z };
      const mine: EntityEvent[] = events.length ? eventsFor(events, viewer) : [];
      for (const e of mine) if (e.type === EntityEventType.MobInfo) track.infoSent.add(e.id);
      if (snapshotTick) {
        const snap = buildSnapshot(sim, viewer);
        client.sendBytes(VoxelMsg.Entities, encodeEntitySnapshot(snap));
        const seen = new Set<number>();
        for (const m of snap.mobs) {
          seen.add(m.id);
          if (track.infoSent.has(m.id)) continue;
          const mob = sim.mobs.get(m.id);
          if (!mob || !(mob.name || mob.owner)) continue;
          track.infoSent.add(m.id);
          mine.push({ type: EntityEventType.MobInfo, id: mob.id, name: mob.name, owner: mob.owner, x: mob.x, y: mob.y, z: mob.z });
        }
        for (const id of track.infoSent) if (!seen.has(id)) track.infoSent.delete(id);
      }
      if (mine.length) for (const bytes of encodeEvents(sim.tick, mine, client.sessionId)) client.sendBytes(VoxelMsg.EntityEvents, bytes);
    });
  }

  /** Rolling mean of step time: above 2 ms lower caps one level (at most every 2 s); below 1 ms for 200 ticks raise one. */
  private governor(ms: number): void {
    this.stepMsSum += ms;
    this.stepCount++;
    this.stepTimes.push(ms);
    if (this.stepTimes.length > GOVERNOR_WINDOW) this.stepTimes.shift();
    const mean = this.stepTimes.reduce((a, b) => a + b, 0) / this.stepTimes.length;
    const now = Date.now();
    if (mean > GOVERNOR_HIGH_MS && this.level < MAX_LEVEL && now - this.levelChangedAt > 2000 && this.stepTimes.length >= GOVERNOR_WINDOW) {
      this.setLevel(this.level + 1);
      this.room.log.warn(`creatures: step ${mean.toFixed(2)} ms, lowering caps (level ${this.level})`);
    }
    this.calmTicks = mean < GOVERNOR_LOW_MS ? this.calmTicks + 1 : 0;
    if (this.calmTicks >= 200 && this.level > 0) this.setLevel(this.level - 1);
  }

  private setLevel(level: number): void {
    this.level = level;
    this.levelChangedAt = Date.now();
    this.calmTicks = 0;
    this.sim.setCaps(governedCaps(level));
  }

  get governorLevel(): number {
    return this.level;
  }

  private maybeLog(): void {
    const now = Date.now();
    if (now - this.lastLog < LOG_EVERY_MS) return;
    const s = this.sim.stats();
    const w = this.room.world;
    const mean = this.stepCount ? this.stepMsSum / this.stepCount : 0;
    this.room.log.info(`creatures: ${s.mobs} mobs (${s.friendly} friendly, ${s.hostile} hostile, ${s.extra} extra), step ${mean.toFixed(3)} ms avg, pumpWarm ${(w.warmStats.ms / ((now - this.lastLog) / 1000)).toFixed(2)} ms/s for ${w.warmStats.chunks} chunks, ${w.cachedChunks} cached, governor ${this.level}`);
    this.lastLog = now;
    this.stepMsSum = 0;
    this.stepCount = 0;
    w.warmStats = { chunks: 0, ms: 0 };
  }

  // ---- messages --------------------------------------------------------------------------

  private handleInteract(client: Client, bytes: Uint8Array): void {
    const track = this.tracks.get(client.sessionId);
    const msg = decodeMobInteract(bytes);
    if (!track || !msg || !track.mi.take()) return;
    const mob = this.sim.mobs.get(msg.mobId);
    let target = this.sim.players.find((p) => p.id === client.sessionId);
    if (!target) {
      // Joined since the last tick.
      this.updateTargets();
      target = this.targets.find((p) => p.id === client.sessionId);
    }
    if (!mob || !mob.alive || mob.def.category !== MobCategory.Friendly || !target) {
      client.sendBytes(VoxelMsg.MobInteractResult, encodeMobInteractResult(msg.mobId, 'none'));
      return;
    }
    // Eye to box distance, with a block of slack for latency.
    const ey = target.y + 1.5;
    const dx = Math.max(0, Math.abs(mob.x - target.x) - mob.halfWidth);
    const dz = Math.max(0, Math.abs(mob.z - target.z) - mob.halfWidth);
    const dy = ey < mob.y ? mob.y - ey : ey > mob.y + mob.height ? ey - mob.y - mob.height : 0;
    if (Math.hypot(dx, dy, dz) > INTERACT_REACH + 1) return;
    // Survival knows the hand; without it (sandbox) the client's claim is trusted (creative).
    const held = this.hooks ? this.hooks.heldItem(client.sessionId) : msg.key;
    const result = this.sim.interact(mob.id, target, held);
    client.sendBytes(VoxelMsg.MobInteractResult, encodeMobInteractResult(mob.id, result));
    if (result === 'tamed') this.room.markDirty();
  }

  private handleName(client: Client, data: unknown): void {
    const track = this.tracks.get(client.sessionId);
    const p = this.room.state.players.get(client.sessionId);
    if (!track || !p || !data || typeof data !== 'object') return;
    const now = Date.now();
    if (now - track.renameAt < 2000) return;
    track.renameAt = now;
    const { id, name } = data as { id?: unknown; name?: unknown };
    if (typeof id !== 'number' || typeof name !== 'string') return;
    if (this.sim.rename(id, p.name, name)) this.room.markDirty();
  }

  // ---- persistence -------------------------------------------------------------------------

  restoreSections(sections: ReadonlyMap<string, Uint8Array>): void {
    const bytes = sections.get(MOBS_TAG);
    if (!bytes) return;
    this.hadMobsSection = true;
    const list = decodeMobsSection(bytes);
    if (!list) {
      this.mobsUnreadable = true;
      this.room.log.warn('creatures: MOBS section not readable; keeping its bytes');
      return;
    }
    this.sim.loadMobs(list);
  }

  saveSections(out: Map<string, Uint8Array>): void {
    if (this.mobsUnreadable) return;
    const list = this.sim.saveMobs();
    if (list.length || this.hadMobsSection) {
      out.set(MOBS_TAG, encodeMobsSection(list));
      this.hadMobsSection = true;
    }
  }

  hasProgress(): boolean {
    return this.sim.tamedCount() > 0;
  }

  dispose(): void {
    this.tracks.clear();
    void MobFlag;
  }
}
