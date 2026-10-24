/**
 * Arcfire Arena wire protocol (binary).
 *
 *  C→S "i": input commands (batched)   u8 n, n × command
 *  S→C "s": snapshot (30 Hz, per client) — tick, ack, own full state,
 *           and every player's compact pose
 *  S→C "x": events batch (shots, hits, kills, reloads) as JSON (low rate)
 *
 * Positions are quantised to centimetres (i16 → ±327 m), angles to 16 bits.
 * Layout changes need a PROTOCOL_VERSION bump (shared/src/constants.ts).
 */
import { BinaryReader, BinaryWriter } from '../util/binary';
import type { Command, PlayerSim } from './player';
import { WeaponId } from './weapons';

export const ArenaMsg = {
  Input: 'i',
  Snapshot: 's',
  Events: 'x',
  /** LoadoutMsg */
  Loadout: 'loadout',
  Start: 'start',
  Rematch: 'rematch',
  Chat: 'chat',
  /** PrefsMsg */
  Prefs: 'prefs',
  /** VoteMsg */
  Vote: 'vote',
  /** BotSkillMsg (host only; warmup or vote) */
  BotSkill: 'botSkill',
} as const;

export interface LoadoutMsg {
  weapon: number;
  secondary?: number;
}
export interface PrefsMsg {
  autoShoot: boolean;
}
export interface VoteMsg {
  map: number;
}
export interface BotSkillMsg {
  level: 'easy' | 'normal' | 'hard';
}

const POS = 100;
const VEL = 100;

const SEQ_MASK = 0xffff;

/** Restores a full sequence number from its low 16 bits, closest to `reference`. */
export function unwrapSeq(low: number, reference: number): number {
  const base = reference & ~SEQ_MASK;
  let v = base | low;
  if (v - reference > 0x8000) v -= 0x10000;
  else if (reference - v > 0x8000) v += 0x10000;
  return v;
}

export function encodeCommands(cmds: Command[]): Uint8Array {
  const w = new BinaryWriter(2 + cmds.length * 16);
  w.u8(cmds.length);
  for (const c of cmds) {
    w.u16(c.seq & SEQ_MASK)
      .i8(Math.round(Math.max(-1, Math.min(1, c.moveX)) * 127))
      .i8(Math.round(Math.max(-1, Math.min(1, c.moveY)) * 127))
      .angle(c.yaw)
      .angle(c.pitch)
      .u8(c.buttons)
      .u8(c.slot)
      .f32(c.viewTick);
  }
  return w.bytes();
}

export function decodeCommands(data: Uint8Array, lastSeq: number): Command[] {
  const r = new BinaryReader(data);
  const n = Math.min(r.u8(), 64);
  const out: Command[] = [];
  let ref = lastSeq;
  for (let i = 0; i < n; i++) {
    const seq = unwrapSeq(r.u16(), ref);
    ref = seq;
    out.push({
      seq,
      moveX: r.i8() / 127,
      moveY: r.i8() / 127,
      yaw: r.angle(),
      pitch: r.angle(),
      buttons: r.u8(),
      slot: r.u8(),
      viewTick: r.f32(),
    });
  }
  return out;
}

/** Compact pose of any player, as seen by everyone. */
export interface NetPose {
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** PoseFlags: bit0 alive, bit1 crouching, bit2 aiming, bit3 reloading, bit4 onGround, bit5 sliding */
  flags: number;
  hp: number;
  weapon: WeaponId;
}

/** A sliding player also has Crouch set. Bits 64 and 128 are free. */
export const PoseFlags = { Alive: 1, Crouch: 2, Aim: 4, Reload: 8, Ground: 16, Slide: 32 } as const;
/** Self-state flags byte (snapshot self block, offset 18). Bits 64 and 128 are free. */
export const SelfFlags = { Ground: 1, Crouch: 2, Alive: 4, Aim: 8, FireHeld: 16, Slide: 32 } as const;

export interface SnapshotMsg {
  tick: number;
  /** Last command seq the server applied for the receiving client. */
  ack: number;
  /** Full predicted-state fields of the receiving player (null if spectating / not in sim). */
  self: PlayerSim | null;
  poses: NetPose[];
}

/**
 * Own full state, 70 bytes:
 *   0 f32×3 x y z · 12 i16×3 vx vy vz (cm/s) · 18 u8 SelfFlags · 19 u8 hp · 20 u8 slot
 *   21 3×(u8 id, u8 mag, u16 reserve) · 33 f32 cooldown · 37 reload · 41 switching · 45 bloom · 49 clock
 *   protocol 2: 53 f32 slideTime · 57 slideCooldown · 61 slideBuffer (movement), 65 f32 ads · 69 u8 burstLeft (weapons)
 * Timers are exact f32 so replays reproduce the server.
 */
function writeSelf(w: BinaryWriter, p: PlayerSim): void {
  w.f32(p.x).f32(p.y).f32(p.z);
  w.i16(Math.round(p.vx * VEL)).i16(Math.round(p.vy * VEL)).i16(Math.round(p.vz * VEL));
  w.u8(
    (p.onGround ? SelfFlags.Ground : 0) |
      (p.crouching ? SelfFlags.Crouch : 0) |
      (p.alive ? SelfFlags.Alive : 0) |
      (p.aiming ? SelfFlags.Aim : 0) |
      (p.fireHeld ? SelfFlags.FireHeld : 0) |
      (p.sliding ? SelfFlags.Slide : 0),
  );
  w.u8(Math.max(0, Math.min(255, Math.round(p.hp))));
  w.u8(p.slot);
  for (const wpn of p.weapons) w.u8(wpn.id).u8(wpn.mag).u16(wpn.reserve);
  w.f32(p.cooldown).f32(p.reload).f32(p.switching).f32(p.bloom).f32(p.clock);
  // Protocol 2: movement timers, then weapon state.
  w.f32(p.slideTime).f32(p.slideCooldown).f32(p.slideBuffer);
  w.f32(p.ads).u8(Math.max(0, Math.min(255, p.burstLeft)));
}

function readSelf(r: BinaryReader, ack: number): PlayerSim {
  const x = r.f32();
  const y = r.f32();
  const z = r.f32();
  const vx = r.i16() / VEL;
  const vy = r.i16() / VEL;
  const vz = r.i16() / VEL;
  const f = r.u8();
  const hp = r.u8();
  const slot = r.u8();
  const weapons = [0, 1, 2].map(() => ({ id: r.u8() as WeaponId, mag: r.u8(), reserve: r.u16() })) as PlayerSim['weapons'];
  // Object literal order = read order.
  return {
    x, y, z, vx, vy, vz,
    onGround: (f & SelfFlags.Ground) !== 0,
    crouching: (f & SelfFlags.Crouch) !== 0,
    alive: (f & SelfFlags.Alive) !== 0,
    aiming: (f & SelfFlags.Aim) !== 0,
    fireHeld: (f & SelfFlags.FireHeld) !== 0,
    sliding: (f & SelfFlags.Slide) !== 0,
    hp,
    slot,
    weapons,
    cooldown: r.f32(),
    reload: r.f32(),
    switching: r.f32(),
    bloom: r.f32(),
    clock: r.f32(),
    slideTime: r.f32(),
    slideCooldown: r.f32(),
    slideBuffer: r.f32(),
    ads: r.f32(),
    burstLeft: r.u8(),
    yaw: 0,
    pitch: 0,
    lastSeq: ack,
  };
}

export function encodePoses(poses: NetPose[]): Uint8Array {
  const w = new BinaryWriter(1 + poses.length * 16);
  w.u8(poses.length);
  for (const p of poses) {
    w.u8(p.index)
      .i16(Math.round(p.x * POS))
      .i16(Math.round(p.y * POS))
      .i16(Math.round(p.z * POS))
      .angle(p.yaw)
      .angle(p.pitch)
      .u8(p.flags)
      .u8(Math.max(0, Math.min(255, Math.round(p.hp))))
      .u8(p.weapon);
  }
  return w.bytes();
}

/** Builds a per-client snapshot: header + own state + the shared pose block. */
export function encodeSnapshot(tick: number, ack: number, self: PlayerSim | null, posesBlock: Uint8Array): Uint8Array {
  const w = new BinaryWriter(96 + posesBlock.length);
  w.u32(tick).u16(ack & SEQ_MASK).u8(self ? 1 : 0);
  if (self) writeSelf(w, self);
  const head = w.bytes();
  const out = new Uint8Array(head.length + posesBlock.length);
  out.set(head, 0);
  out.set(posesBlock, head.length);
  return out;
}

export function decodeSnapshot(data: Uint8Array, lastAck: number): SnapshotMsg {
  const r = new BinaryReader(data);
  const tick = r.u32();
  const ack = unwrapSeq(r.u16(), lastAck);
  const hasSelf = r.u8() === 1;
  const self = hasSelf ? readSelf(r, ack) : null;
  const n = r.u8();
  const poses: NetPose[] = [];
  for (let i = 0; i < n; i++) {
    poses.push({
      index: r.u8(),
      x: r.i16() / POS,
      y: r.i16() / POS,
      z: r.i16() / POS,
      yaw: r.angle(),
      pitch: r.angle(),
      flags: r.u8(),
      hp: r.u8(),
      weapon: r.u8() as WeaponId,
    });
  }
  return { tick, ack, self, poses };
}
