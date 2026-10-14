/**
 * Multiplayer layer for Voxelvale.
 *
 * - Edits are applied locally right away (optimistic) and sent to the server;
 *   the server echoes accepted edits to everyone and bounces rejected ones
 *   back with the authoritative block, which we then restore.
 * - Our position is sent ~15 times a second as a compact binary message.
 * - Other players are rendered 120 ms in the past, interpolating between
 *   the two schema snapshots that bracket the render time.
 */
import * as THREE from 'three';
import {
  type ChatMessage,
  DAY_LENGTH_SECONDS,
  decodeEdit,
  decodeEdits,
  decodeTeleport,
  encodeEdit,
  encodeMove,
  lerpAngle,
  MoveFlags,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  VoxelMsg,
} from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { NetSession } from '../../../net/session';
import { AvatarRenderer, type AvatarPose } from '../../common/Avatars';
import { ChatBox } from '../../common/ChatBox';
import type { VoxelGame, VoxelNetHooks } from '../VoxelGame';

const SEND_INTERVAL = 1 / 15;
const INTERP_DELAY_MS = 120;
const BUFFER_MS = 1000;

interface Snapshot {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
}

interface Remote {
  name: string;
  color: number;
  snapshots: Snapshot[];
  /** Interpolated render position (also used for occupancy checks). */
  x: number;
  y: number;
  z: number;
  speed: number;
}

interface PlayerState {
  name: string;
  color: number;
  connected: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  bestMs: number;
  checkpoint: number;
}

export class VoxelNet implements VoxelNetHooks {
  readonly roomCode: string;
  readonly chat: ChatBox;
  private readonly avatars = new AvatarRenderer(16);
  private readonly lights: THREE.Object3D[];
  private readonly remotes = new Map<string, Remote>();
  private readonly offs: (() => void)[] = [];
  private sendTimer = 0;
  private last = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, flags: -1 };
  private idleResend = 0;
  private time = { value: 0.3, at: 0 };

  constructor(
    private readonly session: NetSession,
    private readonly game: VoxelGame,
    container: HTMLElement,
  ) {
    this.roomCode = session.roomId;
    game.scene.add(this.avatars.group);
    // three.js uses physical light units (divided by PI), hence the large intensities.
    const hemi = new THREE.HemisphereLight(0xeaf4ff, 0x8a7a6a, 2.6);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.4, 1, 0.3);
    this.lights = [hemi, sun];
    game.scene.add(hemi, sun);

    this.chat = new ChatBox(
      container,
      (text) => session.send(VoxelMsg.Chat, { text }),
      () => undefined,
    );

    this.offs.push(
      session.onMessage(VoxelMsg.World, (bytes: Uint8Array) => {
        for (const e of decodeEdits(bytes, true)) game.applyEdit(e.x, e.y, e.z, e.id);
      }),
      session.onMessage(VoxelMsg.Edits, (bytes: Uint8Array) => {
        for (const e of decodeEdits(bytes)) game.applyEdit(e.x, e.y, e.z, e.id);
      }),
      session.onMessage(VoxelMsg.Reject, (bytes: Uint8Array) => {
        const e = decodeEdit(bytes);
        game.applyEdit(e.x, e.y, e.z, e.id);
        audio.play('empty');
      }),
      session.onMessage(VoxelMsg.Teleport, (bytes: Uint8Array) => {
        const p = decodeTeleport(bytes);
        game.player.teleport(p.x, p.y, p.z);
      }),
      session.onMessage(VoxelMsg.Chat, (m: ChatMessage) => this.chat.add(m)),
      session.onStateChange((state) => this.onState(state)),
      session.onStatus((status) => {
        if (status === 'connected') this.last.flags = -1; // force a fresh position send
      }),
    );
    if (session.state) this.onState(session.state);
  }

  ping(): number {
    return this.session.ping;
  }

  isChatOpen(): boolean {
    return this.chat.isOpen;
  }

  openChat(): void {
    this.chat.toggle();
  }

  requestEdit(x: number, y: number, z: number, id: number): boolean {
    this.session.sendBytes(VoxelMsg.Edit, encodeEdit({ x, y, z, id }));
    return true; // optimistic: apply now, the server corrects us if needed
  }

  sendState(x: number, y: number, z: number, yaw: number, pitch: number, flags: number): void {
    // Called every frame; throttled here.
    const now = performance.now() / 1000;
    if (now - this.sendTimer < SEND_INTERVAL) return;
    const l = this.last;
    const moved = Math.abs(x - l.x) > 0.01 || Math.abs(y - l.y) > 0.01 || Math.abs(z - l.z) > 0.01 || Math.abs(yaw - l.yaw) > 0.01 || Math.abs(pitch - l.pitch) > 0.01 || flags !== l.flags;
    if (!moved && now - this.idleResend < 1) return;
    this.sendTimer = now;
    this.idleResend = now;
    this.session.sendBytes(VoxelMsg.Move, encodeMove({ x, y, z, yaw, pitch, flags }));
    Object.assign(this.last, { x, y, z, yaw, pitch, flags });
  }

  parkourEvent(e: { kind: string; index?: number }): void {
    this.session.send(VoxelMsg.Parkour, { kind: e.kind, index: e.index });
  }

  serverTime(): number {
    const elapsed = (performance.now() - this.time.at) / 1000;
    return (this.time.value + elapsed / DAY_LENGTH_SECONDS) % 1;
  }

  /** Best parkour time in the room, for the HUD. */
  roomBest(): { name: string; ms: number } | null {
    let best: { name: string; ms: number } | null = null;
    this.session.state?.players?.forEach((p: PlayerState) => {
      if (p.bestMs > 0 && (!best || p.bestMs < best.ms)) best = { name: p.name, ms: p.bestMs };
    });
    return best;
  }

  /** Names and colours for the pause menu player list. */
  players(): { name: string; color: number; you: boolean; connected: boolean }[] {
    const out: { name: string; color: number; you: boolean; connected: boolean }[] = [];
    this.session.state?.players?.forEach((p: PlayerState, id: string) => {
      out.push({ name: p.name, color: p.color, you: id === this.session.sessionId, connected: p.connected });
    });
    return out;
  }

  isOccupied(x: number, y: number, z: number): boolean {
    const half = PLAYER_WIDTH / 2;
    for (const r of this.remotes.values()) {
      if (x + 1 > r.x - half && x < r.x + half && z + 1 > r.z - half && z < r.z + half && y + 1 > r.y && y < r.y + PLAYER_HEIGHT) return true;
    }
    return false;
  }

  update(dt: number, camera: THREE.Camera): void {
    const renderT = performance.now() - INTERP_DELAY_MS;
    const poses: AvatarPose[] = [];
    for (const [id, r] of this.remotes) {
      const s = r.snapshots;
      if (s.length === 0) continue;
      // Find the pair of snapshots around renderT.
      let a = s[0];
      let b = s[s.length - 1];
      for (let i = s.length - 1; i > 0; i--) {
        if (s[i - 1].t <= renderT) {
          a = s[i - 1];
          b = s[i];
          break;
        }
      }
      const span = b.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
      const nx = a.x + (b.x - a.x) * k;
      const ny = a.y + (b.y - a.y) * k;
      const nz = a.z + (b.z - a.z) * k;
      const speed = dt > 0 ? Math.hypot(nx - r.x, nz - r.z) / dt : 0;
      r.speed += (Math.min(8, speed) - r.speed) * Math.min(1, dt * 10);
      r.x = nx;
      r.y = ny;
      r.z = nz;
      poses.push({
        id,
        x: nx,
        y: ny,
        z: nz,
        yaw: lerpAngle(a.yaw, b.yaw, k),
        pitch: a.pitch + (b.pitch - a.pitch) * k,
        color: r.color,
        speed: r.speed,
        crouch: (b.flags & MoveFlags.Crouch) !== 0,
        name: r.name,
      });
    }
    this.avatars.setBrightness(0.35 + this.game.sky.daylight * 0.65);
    this.avatars.update(poses, dt, camera);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.chat.dispose();
    this.avatars.dispose();
    this.game.scene.remove(this.avatars.group, ...this.lights);
  }

  private onState(state: { players?: Map<string, PlayerState> & { forEach: Map<string, PlayerState>['forEach'] }; timeOfDay?: number }): void {
    if (typeof state.timeOfDay === 'number' && Math.abs(state.timeOfDay - this.time.value) > 1e-6) {
      this.time = { value: state.timeOfDay, at: performance.now() };
    }
    const now = performance.now();
    const seen = new Set<string>();
    state.players?.forEach((p, id) => {
      if (id === this.session.sessionId) return;
      seen.add(id);
      let r = this.remotes.get(id);
      if (!r) {
        r = { name: p.name, color: p.color, snapshots: [], x: p.x, y: p.y, z: p.z, speed: 0 };
        this.remotes.set(id, r);
      }
      r.name = p.connected ? p.name : `${p.name} (reconnecting)`;
      r.color = p.color;
      const last = r.snapshots[r.snapshots.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z || last.yaw !== p.yaw || last.pitch !== p.pitch || last.flags !== p.flags || now - last.t > 200) {
        r.snapshots.push({ t: now, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flags: p.flags });
      }
      while (r.snapshots.length > 2 && r.snapshots[1].t < now - BUFFER_MS) r.snapshots.shift();
    });
    for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
  }
}
