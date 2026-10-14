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
 *  - Movement is client-simulated (it's a co-op sandbox) but sanity-checked
 *    for speed; offenders are snapped back, persistent offenders kicked.
 *  - Parkour times are measured on the server clock.
 */
import type { Client } from '@colyseus/core';
import {
  Block,
  type BlockEdit,
  blockDef,
  blockInWorld,
  CLOSE_KICKED,
  DAY_LENGTH_SECONDS,
  decodeEdit,
  decodeMove,
  encodeEdit,
  encodeEdits,
  encodeTeleport,
  IS_LIQUID,
  isPlaceable,
  isVoxelMode,
  type JoinOptions,
  MAX_HORIZONTAL_SPEED,
  type ParkourEventMsg,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  REACH,
  TokenBucket,
  VOXEL_MAX_PLAYERS,
  VoxelMsg,
  type VoxelMode,
  WORLD_LIMIT,
  asBytes,
} from '@hub/shared';
import { ServerVoxelWorld } from '../voxel/ServerVoxelWorld';
import { HubRoom } from './HubRoom';
import { VoxelPlayer, VoxelState } from './schema/VoxelState';

const TICK_MS = 50;
const EDIT_BURST = 24;
const EDIT_REFILL = 12;
const MOVE_SLACK = 1.5;
const MAX_FALL_SPEED = 55;
const VIOLATION_KICK = 25;

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
  protected readonly gameId = 'voxel' as const;
  override maxClients = VOXEL_MAX_PLAYERS;
  world!: ServerVoxelWorld;
  private readonly runtime = new Map<string, PlayerRuntime>();
  private pendingEdits: BlockEdit[] = [];
  private timeAccumulator = 0;

  protected resolveMode(requested: unknown): string {
    return isVoxelMode(requested) ? requested : 'sandbox';
  }

  protected setup(options: JoinOptions & { seed?: number }): void {
    this.state = new VoxelState();
    this.chatEnabled = true;
    // Tests may pin the seed; real clients never send one.
    const seed = typeof options.seed === 'number' && process.env.NODE_ENV === 'test' ? options.seed >>> 0 : (Math.random() * 0xffffffff) >>> 0;
    this.state.seed = this.mode === 'parkour' ? 20251 + Math.floor(Math.random() * 1000) : seed;
    this.world = new ServerVoxelWorld(this.state.seed, this.mode as VoxelMode);
    this.patchRate = TICK_MS;
    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);

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

  // ---- simulation tick ------------------------------------------------------------

  private tick(dtMs: number): void {
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
    client.sendBytes(VoxelMsg.World, encodeEdits(this.world.allEdits(), true));
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
