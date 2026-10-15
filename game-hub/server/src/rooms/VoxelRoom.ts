/**
 * Voxelvale room: a shared, seeded voxel world for up to 16 players.
 *
 * Authority model:
 *  - Terrain is generated from the seed (identical on every client), so only
 *    edits travel over the network.
 *  - The server validates every block edit (rate, reach, block type,
 *    breakability, player overlap) against its own copy of the world, applies
 *    it, and broadcasts accepted edits in batches. Rejected edits are bounced
 *    back to the sender with the authoritative block so they can roll back.
 *  - Late joiners (and reconnecting players) receive the full edit list.
 *  - Water flows on the server only (VoxelFluids, 5 Hz); each change is an
 *    ordinary edit in the same broadcast batches.
 *  - Movement is client-simulated (it's a co-op sandbox) but sanity-checked
 *    for speed; offenders are snapped back, persistent offenders kicked.
 *  - Parkour times are measured on the server clock.
 *
 * Persistence (sandbox only, see WorldStore):
 *  - Private rooms save under their room code. create('voxel', { reviveCode })
 *    reopens a saved world with the same code once its room has closed.
 *  - Public rooms save into one of the public-1..public-8 slots; a new public
 *    room takes the free slot saved most recently (all busy: temporary world).
 *  - Dirty worlds autosave every 30 s; every saved world is written once more
 *    on dispose (which also covers graceful shutdown) before its code or slot
 *    is released. A world nobody built in is never written.
 *  - Reopening by code is rate limited (per address and overall), so saved
 *    private worlds cannot be found by guessing codes at speed.
 */
import { type AuthContext, type Client, matchMaker } from '@colyseus/core';
import {
  Block,
  type BlockEdit,
  blockDef,
  blockInWorld,
  type ChatMessage,
  CLOSE_KICKED,
  DAY_LENGTH_SECONDS,
  decodeEdit,
  decodeEdits,
  decodeMove,
  encodeEdit,
  encodeEdits,
  encodeTeleport,
  IS_LIQUID,
  isPlaceable,
  isValidRoomCode,
  isVoxelMode,
  type JoinOptions,
  MAX_HORIZONTAL_SPEED,
  type ParkourEventMsg,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  REACH,
  REVIVE_ERRORS,
  TokenBucket,
  VOXEL_MAX_PLAYERS,
  VoxelMsg,
  type VoxelMode,
  WORLD_LIMIT,
  asBytes,
} from '@hub/shared';
import { config } from '../config';
import { ServerVoxelWorld } from '../voxel/ServerVoxelWorld';
import { VoxelFluids } from '../voxel/VoxelFluids';
import { getWorldStore, PUBLIC_WORLD_SLOTS, publicWorldId, type SavedWorld } from '../voxel/WorldStore';
import { HubRoom, ROOM_CODE_SET } from './HubRoom';
import { VoxelPlayer, VoxelState } from './schema/VoxelState';

const TICK_MS = 50;
/** Water steps every 4th tick (5 Hz). */
const FLUID_TICKS = 4;
const EDIT_BURST = 24;
const EDIT_REFILL = 12;
const MOVE_SLACK = 1.5;
const MAX_FALL_SPEED = 55;
const VIOLATION_KICK = 25;
/** Presence set of public world slots held by open rooms. */
const PUBLIC_SLOT_SET = 'voxel:public-worlds';
/** Reopen attempts allowed per client address (burst, then per second)... */
const REVIVE_BURST_PER_IP = 20;
const REVIVE_REFILL_PER_IP = 0.2;
/** ...and from everyone together, since forwarded addresses can be spoofed. */
const REVIVE_BURST_TOTAL = 120;
const REVIVE_REFILL_TOTAL = 2;
/** Addresses tracked before the per-address buckets start over (bounds memory). */
const MAX_REVIVE_ADDRESSES = 10_000;

const reviveBuckets = new Map<string, TokenBucket>();
const reviveTotal = new TokenBucket(REVIVE_BURST_TOTAL, REVIVE_REFILL_TOTAL);

/** Takes one reopen attempt from the address's bucket and from the overall one. */
function allowRevive(context: AuthContext | undefined): boolean {
  const fly = context?.headers?.['fly-client-ip'];
  const raw = (typeof fly === 'string' && fly) || context?.ip || '';
  const address = (Array.isArray(raw) ? (raw[0] ?? '') : raw).split(',')[0].trim() || 'unknown';
  let bucket = reviveBuckets.get(address);
  if (!bucket) {
    if (reviveBuckets.size >= MAX_REVIVE_ADDRESSES) reviveBuckets.clear();
    reviveBuckets.set(address, (bucket = new TokenBucket(REVIVE_BURST_PER_IP, REVIVE_REFILL_PER_IP)));
  }
  return bucket.take() && reviveTotal.take();
}

/**
 * True while an open room holds the world saved under id (its room code or
 * public slot). prune() keeps those; the room saves them again when it closes.
 */
export async function isWorldOpen(id: string): Promise<boolean> {
  const presence = matchMaker.presence;
  if (!presence) return false; // no server yet, so no open rooms
  return !!(await presence.sismember(id.startsWith('public-') ? PUBLIC_SLOT_SET : ROOM_CODE_SET, id));
}

interface PlayerRuntime {
  editBucket: TokenBucket;
  lastMoveAt: number;
  hasPosition: boolean;
  violations: number;
  /** Ignore speed checks until this time (spawn, respawn, reconnect). */
  graceUntil: number;
  // parkour
  runStartedAt: number;
  runCheckpoint: number;
}

export class VoxelRoom extends HubRoom<VoxelState, VoxelPlayer> {
  /** How often a changed world is saved (tests shorten it). */
  static autosaveMs = 30_000;
  protected readonly gameId = 'voxel' as const;
  override maxClients = VOXEL_MAX_PLAYERS;
  world!: ServerVoxelWorld;
  private readonly runtime = new Map<string, PlayerRuntime>();
  private pendingEdits: BlockEdit[] = [];
  private timeAccumulator = 0;
  /** Flowing water (sandbox only); its changes are broadcast like player edits. */
  private fluids: VoxelFluids | null = null;
  private fluidTicks = 0;
  /** Id the world is saved under (room code or public-N); null for temporary worlds. */
  private saveId: string | null = null;
  /** Public slot this room holds in PUBLIC_SLOT_SET. */
  private publicSlot: string | null = null;
  /** savedAt of the save this world was restored from (0 = new world). */
  private restoredAt = 0;
  /** True once the store holds a copy of this world (restored from it, or saved since). */
  private hasSave = false;
  /** Edit section (encodeEdits(list, true)) of the save this world was restored from. */
  private restoredBytes: Uint8Array | null = null;
  /** The decoded list, only kept while onWorldRestored() runs. */
  private restoredList: readonly BlockEdit[] | null = null;

  /**
   * Gate for every matchmaking request (Colyseus calls it before a room is
   * created or joined): limits how fast one address, and everyone together,
   * may try codes to reopen saved worlds. Server code calling
   * matchMaker.create()/joinOrCreate() for voxel must pass an auth context.
   */
  static override async onAuth(_token: string, options: Partial<JoinOptions> | undefined, context: AuthContext): Promise<unknown> {
    if (options?.reviveCode !== undefined && !allowRevive(context)) {
      throw new Error(`${REVIVE_ERRORS.tooManyAttempts}: too many attempts to reopen saved worlds`);
    }
    return true;
  }

  protected resolveMode(requested: unknown): string {
    return isVoxelMode(requested) ? requested : 'sandbox';
  }

  /** Reopening a saved world claims its code; everything else gets a fresh code. */
  protected override async chooseRoomCode(options: JoinOptions): Promise<string> {
    if (options.reviveCode === undefined) return super.chooseRoomCode(options);
    const code = typeof options.reviveCode === 'string' ? options.reviveCode.trim().toUpperCase() : '';
    if (!isValidRoomCode(code) || !(await getWorldStore().exists(code))) {
      throw new Error(`${REVIVE_ERRORS.noSavedWorld}: no saved world with that code`);
    }
    if (!(await this.claimRoomCode(code))) throw new Error(`${REVIVE_ERRORS.alreadyOpen}: room ${code} is already open`);
    return code;
  }

  protected async setup(options: JoinOptions & { seed?: number }): Promise<void> {
    this.state = new VoxelState();
    this.chatEnabled = true;
    const saved = await this.openSave(options);
    if (saved) {
      this.mode = saved.mode;
      if (saved.private !== this.isPrivate) {
        this.isPrivate = saved.private;
        await this.setPrivate(saved.private);
      }
    }
    if (this.mode !== 'sandbox') this.saveId = null; // parkour is never saved
    // Tests may pin the seed; real clients never send one.
    const seed = typeof options.seed === 'number' && process.env.NODE_ENV === 'test' ? options.seed >>> 0 : (Math.random() * 0xffffffff) >>> 0;
    this.state.seed = saved ? saved.seed : this.mode === 'parkour' ? 20251 + Math.floor(Math.random() * 1000) : seed;
    this.world = new ServerVoxelWorld(this.state.seed, this.mode as VoxelMode);
    this.startFluids();
    if (saved) {
      try {
        this.restore(saved);
      } catch (err) {
        // One public world that fails to restore must not block public play.
        if (!this.publicSlot) throw err;
        await this.replaceBrokenSave(saved.id, seed, err);
      }
    }
    this.state.worldKind = this.saveId ? 'saved' : 'temporary';
    // 0 days on a saved world: kept only until the server restarts (in-memory store).
    this.state.saveDays = this.saveId && getWorldStore().durable ? Math.min(65535, Math.floor(config.worldTtlDays)) : 0;
    this.state.privateRoom = this.isPrivate;
    this.patchRate = TICK_MS;
    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);
    if (this.saveId) this.clock.setInterval(() => void this.saveWorld(false), VoxelRoom.autosaveMs);

    this.onMessage(VoxelMsg.Edit, (client, data) => this.handleEdit(client, data));
    this.onMessage(VoxelMsg.Move, (client, data) => this.handleMove(client, data));
    this.onMessage(VoxelMsg.Parkour, (client, data: ParkourEventMsg) => this.handleParkour(client, data));
  }

  protected createPlayer(_client: Client, options: JoinOptions): VoxelPlayer {
    const p = new VoxelPlayer();
    p.color = typeof options.color === 'number' ? options.color & 0xffffff : 0x4fa3ff;
    const spawn = this.world.generator.findSpawn();
    p.x = spawn.x;
    p.y = spawn.y;
    p.z = spawn.z;
    return p;
  }

  protected override onPlayerJoined(client: Client, player: VoxelPlayer): void {
    if (this.restoredAt) {
      client.send(VoxelMsg.Chat, { id: '', name: '', color: 0, text: 'This world was restored from its last save.', system: true } satisfies ChatMessage);
    }
    const now = Date.now();
    this.runtime.set(client.sessionId, {
      editBucket: new TokenBucket(EDIT_BURST, EDIT_REFILL, now),
      lastMoveAt: now,
      hasPosition: false,
      violations: 0,
      graceUntil: now + 3000,
      runStartedAt: 0,
      runCheckpoint: 0,
    });
    this.sendWorld(client);
    void player;
  }

  protected override onPlayerReconnected(client: Client, _player: VoxelPlayer): void {
    const rt = this.runtime.get(client.sessionId);
    if (rt) rt.graceUntil = Date.now() + 3000;
    this.sendWorld(client); // catch up on edits made while away
  }

  protected override onPlayerRemoved(sessionId: string): void {
    this.runtime.delete(sessionId);
  }

  protected override describeStatus(): string {
    return this.mode === 'parkour' ? 'Parkour course' : `Building · ${this.world?.editCount ?? 0} edits`;
  }

  override async onDispose(): Promise<void> {
    // Save before the code / slot is released, so nobody can reopen an older copy in between.
    if (this.created) await this.saveWorld(true);
    await super.onDispose();
  }

  protected override async releaseClaims(): Promise<void> {
    await this.releasePublicSlot();
    await super.releaseClaims();
  }

  /** Called once a saved world's edits are restored (restoredEdits holds them). */
  protected onWorldRestored(): void {
    // Water that was still moving when the world was saved carries on.
    this.fluids?.resumeFrom(this.restoredEdits);
  }

  private startFluids(): void {
    this.fluids =
      this.mode === 'sandbox'
        ? new VoxelFluids(this.world, (x, y, z, id) => this.pendingEdits.push({ x, y, z, id }), {
            // VoxelFluids calls this at most once a minute.
            onLimit: () => this.systemChat("Water has reached this world's limit; it will not spread further until some is removed."),
          })
        : null;
  }

  /**
   * Edits as read from the save this world was restored from (empty for new
   * worlds), so later systems can resume from them. Held as the compact save
   * bytes and decoded on each access (free inside onWorldRestored()).
   */
  protected get restoredEdits(): readonly BlockEdit[] {
    if (this.restoredList) return this.restoredList;
    return this.restoredBytes ? decodeEdits(this.restoredBytes, true) : [];
  }

  // ---- persistence ------------------------------------------------------------------

  /**
   * Decides where this world is saved (saveId) and loads the saved copy, if any.
   * Private sandbox rooms save under their code, public ones into a public slot.
   */
  private async openSave(options: JoinOptions): Promise<SavedWorld | null> {
    const store = getWorldStore();
    if (options.reviveCode !== undefined) {
      // chooseRoomCode() already checked the save exists and claimed the code.
      const saved = await store.load(this.roomId);
      if (!saved) throw new Error(`${REVIVE_ERRORS.noSavedWorld}: no saved world with that code`);
      this.saveId = this.roomId;
      return saved;
    }
    if (this.mode !== 'sandbox') return null;
    if (this.isPrivate) {
      this.saveId = this.roomId;
      return null;
    }
    const slot = await this.claimPublicSlot();
    if (!slot) {
      this.log.info(`all ${PUBLIC_WORLD_SLOTS} public world slots are in use; ${this.roomId} is temporary`);
      return null;
    }
    this.publicSlot = slot;
    this.saveId = slot;
    try {
      const saved = await store.load(slot);
      return saved && saved.mode === 'sandbox' && !saved.private ? saved : null;
    } catch (err) {
      this.log.error(`could not load ${slot}; ${this.roomId} gets a temporary world`, err);
      await this.releasePublicSlot();
      return null;
    }
  }

  /** Claims a free public slot: the one saved most recently, else the lowest. Null when all are busy. */
  private async claimPublicSlot(): Promise<string | null> {
    const store = getWorldStore();
    const busy = new Set(await this.presence.smembers(PUBLIC_SLOT_SET));
    const free = Array.from({ length: PUBLIC_WORLD_SLOTS }, (_, i) => publicWorldId(i + 1)).filter((id) => !busy.has(id));
    const savedAt = await Promise.all(free.map((id) => store.savedAt(id).catch(() => null)));
    const order = free
      .map((id, i) => ({ id, i, savedAt: savedAt[i] ?? -1 }))
      .sort((a, b) => b.savedAt - a.savedAt || a.i - b.i);
    for (const { id } of order) {
      if (await this.claimInSet(PUBLIC_SLOT_SET, id)) return id;
    }
    return null;
  }

  private async releasePublicSlot(): Promise<void> {
    const slot = this.publicSlot;
    if (!slot) return;
    this.publicSlot = null;
    if (this.saveId === slot) this.saveId = null;
    await this.releaseFromSet(PUBLIC_SLOT_SET, slot);
  }

  private restore(saved: SavedWorld): void {
    const edits = decodeEdits(saved.edits, true);
    const applied = this.world.loadEdits(edits);
    this.restoredBytes = saved.edits;
    this.restoredAt = saved.savedAt;
    this.hasSave = true;
    this.state.timeOfDay = saved.timeOfDay;
    this.log.info(`restored world ${saved.id}: ${applied} edits, saved ${new Date(saved.savedAt).toISOString()}`);
    // The hook sees the list decoded above; afterwards only the compact bytes are kept.
    this.restoredList = edits;
    try {
      this.onWorldRestored();
    } finally {
      this.restoredList = null;
    }
  }

  /**
   * A public slot's save could not be restored: move it aside (so later public
   * rooms do not keep picking it) and start a fresh world in the slot. If it
   * cannot be moved, give the slot back and run a temporary world.
   */
  private async replaceBrokenSave(id: string, seed: number, err: unknown): Promise<void> {
    this.restoredBytes = null;
    this.restoredAt = 0;
    this.hasSave = false;
    this.state.seed = seed;
    this.world = new ServerVoxelWorld(seed, 'sandbox');
    this.startFluids();
    try {
      await getWorldStore().quarantine(id);
      this.log.error(`could not restore ${id}; moved it aside, ${this.roomId} starts a fresh world there`, err);
    } catch (moveErr) {
      this.log.error(`could not restore ${id} or move it aside (${(moveErr as Error).message}); ${this.roomId} gets a temporary world`, err);
      await this.releasePublicSlot();
    }
  }

  /** Writes the world to the store; unless forced only when it changed. Never throws. */
  private async saveWorld(force: boolean): Promise<void> {
    const id = this.saveId;
    if (!id || !this.world || (!force && !this.world.dirty)) return;
    // Nothing built and never saved: write no file, so empty rooms cannot push real builds out of the store.
    if (!this.hasSave && this.world.editCount === 0) return;
    try {
      const world: SavedWorld = {
        id,
        seed: this.state.seed,
        mode: this.mode as VoxelMode,
        private: this.isPrivate,
        timeOfDay: this.state.timeOfDay,
        savedAt: Date.now(),
        edits: this.world.encodedEdits(),
      };
      this.world.markClean();
      await getWorldStore().save(world);
      this.hasSave = true;
      this.log.debug(`saved world ${id} (${this.world.editCount} edits)`);
    } catch (err) {
      this.world.markDirty();
      this.log.error(`could not save world ${id}`, err);
    }
  }

  // ---- simulation tick ------------------------------------------------------------

  private tick(dtMs: number): void {
    if (this.fluids && ++this.fluidTicks % FLUID_TICKS === 0) this.fluids.step();
    if (this.pendingEdits.length) {
      // Chunk big batches so one message never exceeds the u16 count.
      for (let i = 0; i < this.pendingEdits.length; i += 4000) {
        this.broadcastBytes(VoxelMsg.Edits, encodeEdits(this.pendingEdits.slice(i, i + 4000)), {});
      }
      this.pendingEdits = [];
    }
    this.timeAccumulator += dtMs;
    if (this.timeAccumulator >= 1000) {
      this.state.timeOfDay = (this.state.timeOfDay + this.timeAccumulator / 1000 / DAY_LENGTH_SECONDS) % 1;
      this.timeAccumulator = 0;
    }
  }

  // ---- edits ---------------------------------------------------------------------------

  private handleEdit(client: Client, raw: unknown): void {
    const bytes = asBytes(raw);
    const player = this.state.players.get(client.sessionId);
    const rt = this.runtime.get(client.sessionId);
    if (!bytes || bytes.byteLength < 6 || !player || !rt) return;
    let edit: BlockEdit;
    try {
      edit = decodeEdit(bytes);
    } catch {
      return;
    }
    const reason = this.validateEdit(player, rt, edit);
    if (reason) {
      const current = blockInWorld(edit.x, edit.y, edit.z) ? this.world.getBlock(edit.x, edit.y, edit.z) : Block.Air;
      client.sendBytes(VoxelMsg.Reject, encodeEdit({ ...edit, id: current }));
      this.log.debug(`rejected edit from ${player.name}: ${reason}`);
      return;
    }
    if (!this.world.setBlock(edit.x, edit.y, edit.z, edit.id)) {
      client.sendBytes(VoxelMsg.Reject, encodeEdit({ ...edit, id: this.world.getBlock(edit.x, edit.y, edit.z) }));
      return;
    }
    this.pendingEdits.push(edit);
    // Any change can start a flow: water placed, or a wall next to water removed.
    this.fluids?.notifyEdit(edit.x, edit.y, edit.z);
  }

  /** Returns a reason string if the edit is not allowed, or null. */
  validateEdit(player: VoxelPlayer, rt: PlayerRuntime, e: BlockEdit): string | null {
    if (this.mode !== 'sandbox') return 'editing disabled in this mode';
    if (!rt.editBucket.take()) return 'rate limited';
    if (!blockInWorld(e.x, e.y, e.z) || e.y < 1) return 'out of world';
    const current = this.world.getBlock(e.x, e.y, e.z);
    if (e.id === Block.Air) {
      if (!blockDef(current).breakable) return 'unbreakable';
    } else {
      if (!isPlaceable(e.id)) return 'not placeable';
      if (current !== Block.Air && !IS_LIQUID[current]) return 'occupied by a block';
      if (this.overlapsPlayer(e.x, e.y, e.z)) return 'occupied by a player';
    }
    // Reach check from the eye to the block centre, with slack for latency.
    const dx = e.x + 0.5 - player.x;
    const dy = e.y + 0.5 - (player.y + 1.5);
    const dz = e.z + 0.5 - player.z;
    if (Math.hypot(dx, dy, dz) > REACH + 2) return 'out of reach';
    return null;
  }

  private overlapsPlayer(x: number, y: number, z: number): boolean {
    const half = PLAYER_WIDTH / 2;
    let hit = false;
    this.state.players.forEach((p) => {
      if (hit || !p.connected) return;
      if (x + 1 > p.x - half && x < p.x + half && z + 1 > p.z - half && z < p.z + half && y + 1 > p.y && y < p.y + PLAYER_HEIGHT) hit = true;
    });
    return hit;
  }

  private sendWorld(client: Client): void {
    client.sendBytes(VoxelMsg.World, this.world.encodedEdits());
  }

  // ---- movement --------------------------------------------------------------------------

  private handleMove(client: Client, raw: unknown): void {
    const bytes = asBytes(raw);
    const player = this.state.players.get(client.sessionId);
    const rt = this.runtime.get(client.sessionId);
    if (!bytes || bytes.byteLength < 17 || !player || !rt) return;
    const m = decodeMove(bytes);
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.max(0.05, (now - rt.lastMoveAt) / 1000);
    rt.lastMoveAt = now;

    const inBounds = Math.abs(m.x) <= WORLD_LIMIT && Math.abs(m.z) <= WORLD_LIMIT && m.y > -64 && m.y < 128;
    const horizontal = Math.hypot(m.x - player.x, m.z - player.z);
    const vertical = Math.abs(m.y - player.y);
    const tooFast = horizontal > MAX_HORIZONTAL_SPEED * dt + MOVE_SLACK || vertical > MAX_FALL_SPEED * dt + MOVE_SLACK;
    if (!inBounds || (tooFast && now > rt.graceUntil && rt.hasPosition)) {
      rt.violations++;
      client.sendBytes(VoxelMsg.Teleport, encodeTeleport(player.x, player.y, player.z));
      if (rt.violations > VIOLATION_KICK) {
        this.log.warn(`kicking ${player.name}: repeated movement violations`);
        client.leave(CLOSE_KICKED);
      }
      return;
    }
    rt.violations = Math.max(0, rt.violations - 0.05);
    rt.hasPosition = true;
    player.x = m.x;
    player.y = m.y;
    player.z = m.z;
    player.yaw = m.yaw;
    player.pitch = m.pitch;
    player.flags = m.flags;
  }

  // ---- parkour ----------------------------------------------------------------------------

  private handleParkour(client: Client, msg: ParkourEventMsg): void {
    const course = this.world.generator.course;
    const player = this.state.players.get(client.sessionId);
    const rt = this.runtime.get(client.sessionId);
    if (!course || !player || !rt || typeof msg?.kind !== 'string') return;
    const now = Date.now();
    const near = (p: { x: number; y: number; z: number }, r: number) =>
      Math.hypot(player.x - (p.x + 0.5), player.z - (p.z + 0.5)) <= r && Math.abs(player.y - (p.y + 1)) <= 2.5;

    switch (msg.kind) {
      case 'start':
        rt.runStartedAt = now;
        rt.runCheckpoint = 0;
        player.checkpoint = 0;
        break;
      case 'restart':
      case 'respawn': {
        if (msg.kind === 'restart') {
          rt.runStartedAt = 0;
          rt.runCheckpoint = 0;
          player.checkpoint = 0;
        }
        rt.graceUntil = now + 2000;
        break;
      }
      case 'checkpoint': {
        const idx = Number(msg.index);
        const cp = course.checkpoints[idx];
        if (!cp || idx <= rt.runCheckpoint || !near(cp, 3)) return;
        rt.runCheckpoint = idx;
        player.checkpoint = idx;
        break;
      }
      case 'finish': {
        const total = course.checkpoints.length - 1;
        const atFinish = course.finish.some((f) => near(f, 1.5));
        if (!rt.runStartedAt || rt.runCheckpoint < total || !atFinish) return;
        const ms = now - rt.runStartedAt;
        if (ms < 8000) return; // physically impossible for this course length
        rt.runStartedAt = 0;
        const best = player.bestMs === 0 || ms < player.bestMs;
        if (best) player.bestMs = ms;
        this.systemChat(`${player.name} finished in ${(ms / 1000).toFixed(2)} s${best ? ' (personal best!)' : ''}`);
        break;
      }
    }
  }
}
