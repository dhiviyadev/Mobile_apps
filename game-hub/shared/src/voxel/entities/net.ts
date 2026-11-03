/**
 * Creature sync (design-voxel-mobs §9, INTEGRATION §1.5): the 'N' snapshot
 * (10 Hz per client, interest-managed), the 'V' event batches and the
 * 'mi' / 'mr' interaction codecs. Offline, LocalEntities hands the same
 * EntitySnapshot objects to the client without encoding.
 */
import { DamageKind, StatusKind } from '../combat';
import { BinaryReader } from '../../util/binary';
import { insideBox } from './ai/common';
import {
  EntityEventType,
  INTERACT_RESULTS,
  MobFlag,
  type BurstKind,
  type EntityEvent,
  type InteractResult,
  type MobAction,
  type MobKind,
  type MobVariant,
  type TelegraphShape,
} from './types';
import type { EntityWorld } from './world';

export const MOB_RECORD_BYTES = 16;
export const PROJECTILE_RECORD_BYTES = 16;
export const HAZARD_RECORD_BYTES = 12;
export const ITEM_RECORD_BYTES = 12;
export const BOSS_RECORD_BYTES = 12;

export const SnapFlag = { Hurt: 1, Aggro: 2, OnGround: 4, InWater: 8, Burning: 16, Tamed: 32, Baby: 64, Dying: 128 } as const;
export const ProjFlag = { Stuck: 1, Crit: 2, Yours: 4 } as const;
export const BossFlag = { Awake: 16, Invulnerable: 32, Stunned: 64, Enraged: 128 } as const;

export interface MobSnap {
  id: number;
  kind: MobKind;
  /** SnapFlag bits. */
  flags: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Absolute head yaw. */
  headYaw: number;
  headPitch: number;
  /** 0..1. */
  health: number;
  action: MobAction;
  variant: MobVariant;
  actionSeq: number;
  /** 0..1 through the current action. */
  progress: number;
}

export interface ProjSnap {
  id: number;
  kind: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface HazardSnap {
  id: number;
  kind: number;
  radius: number;
  x: number;
  y: number;
  z: number;
  secondsLeft: number;
  param: number;
}

export interface BossSnap {
  mobId: number;
  kind: MobKind;
  phase: number;
  /** BossFlag bits (awake, invulnerable, stunned, enraged). */
  flags: number;
  health: number;
  maxHealth: number;
  structureId: number;
  minions: number;
}

export interface EntitySnapshot {
  tick: number;
  mobs: MobSnap[];
  projectiles: ProjSnap[];
  hazards: HazardSnap[];
  bosses: BossSnap[];
}

export interface Viewer {
  /** Player id (sessionId / 'local'): the 'yours' projectile flag. */
  id: string;
  x: number;
  y: number;
  z: number;
}

const MOB_RADIUS = 64;
const BOSS_RADIUS = 96;
const PROJ_RADIUS = 48;
const HAZARD_RADIUS = 48;
const MAX_MOBS = 64;
const MAX_PROJ = 48;
const MAX_HAZARDS = 24;

const TAU = Math.PI * 2;
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** The world as one viewer should see it (nearest first, capped). */
export function buildSnapshot(w: EntityWorld, viewer: Viewer): EntitySnapshot {
  const mobs: { d: number; s: MobSnap }[] = [];
  for (const m of w.mobs.values()) {
    const d = Math.hypot(m.x - viewer.x, m.z - viewer.z);
    if (d > (m.boss ? BOSS_RADIUS : MOB_RADIUS)) continue;
    let flags = 0;
    if (w.time - m.lastHitAt < 0.25) flags |= SnapFlag.Hurt;
    if (m.targetId && m.team !== 2) flags |= SnapFlag.Aggro;
    if (m.onGround) flags |= SnapFlag.OnGround;
    if (m.inWater) flags |= SnapFlag.InWater;
    if (m.drying || m.effects.some((e) => e.kind === StatusKind.Burn)) flags |= SnapFlag.Burning;
    if (m.has(MobFlag.Tamed)) flags |= SnapFlag.Tamed;
    if (m.has(MobFlag.Baby)) flags |= SnapFlag.Baby;
    if (!m.alive) flags |= SnapFlag.Dying;
    mobs.push({
      d: m.boss ? -1 : d,
      s: {
        id: m.id, kind: m.kind, flags, x: m.x, y: m.y, z: m.z, yaw: m.yaw, headYaw: m.headYaw, headPitch: m.headPitch,
        health: m.alive ? Math.max(1 / 255, m.health / m.maxHealth) : 0, action: m.action, variant: m.variant,
        actionSeq: m.actionSeq & 15, progress: Math.min(1, m.actionTime / m.actionDur),
      },
    });
  }
  mobs.sort((a, b) => a.d - b.d);
  const projectiles: ProjSnap[] = [];
  for (const p of w.projectiles.list) {
    if (projectiles.length >= MAX_PROJ) break;
    if (Math.hypot(p.x - viewer.x, p.z - viewer.z) > PROJ_RADIUS) continue;
    let flags = 0;
    if (p.stuck) flags |= ProjFlag.Stuck;
    if (p.crit) flags |= ProjFlag.Crit;
    if (p.owner.type === 'player' && p.owner.id === viewer.id) flags |= ProjFlag.Yours;
    projectiles.push({ id: p.id, kind: p.kind, flags, x: p.x, y: p.y, z: p.z, vx: p.stuck ? 0 : p.vx, vy: p.stuck ? 0 : p.vy, vz: p.stuck ? 0 : p.vz });
  }
  const hazards: HazardSnap[] = [];
  for (const h of w.hazards.list) {
    if (hazards.length >= MAX_HAZARDS) break;
    if (Math.hypot(h.x - viewer.x, h.z - viewer.z) > HAZARD_RADIUS + h.radius) continue;
    hazards.push({ id: h.id, kind: h.kind, radius: h.radius, x: h.x, y: h.y, z: h.z, secondsLeft: h.left, param: h.kind === 5 ? 0.6 : 0 });
  }
  const bosses: BossSnap[] = [];
  for (const m of w.mobs.values()) {
    const b = m.boss;
    if (!b) continue;
    if (!insideBox(b.structure.arena, viewer.x, viewer.y, viewer.z, 8) && Math.hypot(m.x - viewer.x, m.z - viewer.z) > 40) continue;
    let flags = 0;
    if (b.mode !== 'awakening') flags |= BossFlag.Awake;
    if (!b.vulnerable()) flags |= BossFlag.Invulnerable;
    if (b.stunned > 0) flags |= BossFlag.Stunned;
    if (b.phase === 3) flags |= BossFlag.Enraged;
    bosses.push({ mobId: m.id, kind: m.kind, phase: b.phase, flags, health: Math.max(0, m.health), maxHealth: m.maxHealth, structureId: b.structure.id, minions: b.minionCount() });
  }
  return { tick: w.tick, mobs: mobs.slice(0, MAX_MOBS).map((e) => e.s), projectiles, hazards, bosses };
}

// ---- encoding ---------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(2048);
  view = new DataView(this.buf.buffer);
  pos = 0;
  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos++, v & 255);
  }
  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.pos++, Math.max(-128, Math.min(127, Math.round(v))));
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, Math.max(0, Math.min(65535, Math.round(v))), true);
    this.pos += 2;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, Math.max(-32768, Math.min(32767, Math.round(v))), true);
    this.pos += 2;
  }
  /**
   * A horizontal position (x or z times POS) as i16 that wraps instead of
   * clamping: the same bytes as i16() within +-1024 blocks, and readers
   * unwrap it near their own position (unwrapNear), so endless worlds work.
   */
  p16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, ((Math.round(v) % 65536) + 65536 + 32768) % 65536 - 32768, true);
    this.pos += 2;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

const angleU8 = (a: number) => Math.round((wrap(a) / TAU) * 256) & 255;
const u8Angle = (v: number) => ((v > 127 ? v - 256 : v) / 256) * TAU;
const POS = 32;
const VEL = 100;
/** Horizontal positions wrap every this many blocks on the wire (65536 / POS). */
const WRAP = 65536 / POS;

/**
 * Unwraps a decoded horizontal coordinate to the copy nearest `ref` (the
 * viewer's own position); without one, values are taken as they are (worlds
 * within +-1024 blocks need none).
 */
function unwrapNear(ref: number | undefined): (v: number) => number {
  if (ref === undefined || !Number.isFinite(ref)) return (v) => v;
  return (v) => ref + ((((v - ref + WRAP / 2) % WRAP) + WRAP) % WRAP) - WRAP / 2;
}

/** Where the decoding client is (horizontal), to unwrap positions far from the origin. */
export interface NearPoint {
  x: number;
  z: number;
}

export function encodeEntitySnapshot(s: EntitySnapshot): Uint8Array {
  const w = new Writer();
  w.u16(s.tick & 0xffff);
  w.u8(1);
  w.u8(s.mobs.length);
  for (const m of s.mobs) {
    w.u16(m.id);
    w.u8(m.kind);
    w.u8(m.flags);
    w.p16(m.x * POS);
    w.i16(m.y * POS);
    w.p16(m.z * POS);
    w.u8(angleU8(m.yaw));
    w.u8(angleU8(m.headYaw - m.yaw));
    w.i8(m.headPitch * 100);
    w.u8(m.health <= 0 ? 0 : Math.max(1, Math.ceil(m.health * 255)));
    w.u8((m.action & 15) | ((m.variant & 15) << 4));
    w.u8((m.actionSeq & 15) | (Math.min(15, Math.floor(m.progress * 16)) << 4));
  }
  w.u8(s.projectiles.length);
  for (const p of s.projectiles) {
    w.u16(p.id);
    w.u8(p.kind);
    w.u8(p.flags);
    w.p16(p.x * POS);
    w.i16(p.y * POS);
    w.p16(p.z * POS);
    w.i16(p.vx * VEL);
    w.i16(p.vy * VEL);
    w.i16(p.vz * VEL);
  }
  w.u8(s.hazards.length);
  for (const h of s.hazards) {
    w.u16(h.id);
    w.u8(h.kind);
    w.u8(Math.min(255, h.radius * 8));
    w.p16(h.x * POS);
    w.i16(h.y * POS);
    w.p16(h.z * POS);
    w.u8(Math.min(255, h.secondsLeft * 10));
    w.u8(Math.min(255, h.param * 32));
  }
  w.u8(0); // items: drops travel in survival's 'S' messages
  w.u8(s.bosses.length);
  for (const b of s.bosses) {
    w.u16(b.mobId);
    w.u8(b.kind);
    w.u8((b.phase & 3) | b.flags);
    w.u16(Math.ceil(b.health));
    w.u16(b.maxHealth);
    w.u16(b.structureId);
    w.u8(b.minions);
    w.u8(0);
  }
  return w.bytes();
}

export function decodeEntitySnapshot(bytes: Uint8Array, near?: NearPoint): EntitySnapshot {
  const ux = unwrapNear(near?.x);
  const uz = unwrapNear(near?.z);
  const r = new BinaryReader(bytes);
  const tick = r.u16();
  r.u8();
  const mobs: MobSnap[] = [];
  for (let n = r.u8(), i = 0; i < n; i++) {
    const id = r.u16();
    const kind = r.u8() as MobKind;
    const flags = r.u8();
    const x = ux(r.i16() / POS);
    const y = r.i16() / POS;
    const z = uz(r.i16() / POS);
    const yaw = u8Angle(r.u8());
    const headYaw = yaw + u8Angle(r.u8());
    const headPitch = r.i8() / 100;
    const health = r.u8() / 255;
    const av = r.u8();
    const info = r.u8();
    mobs.push({ id, kind, flags, x, y, z, yaw, headYaw, headPitch, health, action: (av & 15) as MobAction, variant: (av >> 4) as MobVariant, actionSeq: info & 15, progress: (info >> 4) / 16 });
  }
  const projectiles: ProjSnap[] = [];
  for (let n = r.u8(), i = 0; i < n; i++) {
    projectiles.push({ id: r.u16(), kind: r.u8(), flags: r.u8(), x: ux(r.i16() / POS), y: r.i16() / POS, z: uz(r.i16() / POS), vx: r.i16() / VEL, vy: r.i16() / VEL, vz: r.i16() / VEL });
  }
  const hazards: HazardSnap[] = [];
  for (let n = r.u8(), i = 0; i < n; i++) {
    hazards.push({ id: r.u16(), kind: r.u8(), radius: r.u8() / 8, x: ux(r.i16() / POS), y: r.i16() / POS, z: uz(r.i16() / POS), secondsLeft: r.u8() / 10, param: r.u8() / 32 });
  }
  for (let n = r.u8(), i = 0; i < n; i++) for (let k = 0; k < ITEM_RECORD_BYTES; k++) r.u8();
  const bosses: BossSnap[] = [];
  for (let n = r.u8(), i = 0; i < n; i++) {
    const mobId = r.u16();
    const kind = r.u8() as MobKind;
    const pf = r.u8();
    const health = r.u16();
    const maxHealth = r.u16();
    const structureId = r.u16();
    const minions = r.u8();
    r.u8();
    bosses.push({ mobId, kind, phase: pf & 3, flags: pf & 0xf0, health, maxHealth, structureId, minions });
  }
  return { tick, mobs, projectiles, hazards, bosses };
}

// ---- events -------------------------------------------------------------------------------

/** Events a viewer should get: within 64 blocks (boss events within 96). */
export function eventsFor(events: readonly EntityEvent[], viewer: Viewer): EntityEvent[] {
  return events.filter((e) => {
    const boss = e.type === EntityEventType.Telegraph || e.type === EntityEventType.BossAwake || e.type === EntityEventType.BossDefeated || e.type === EntityEventType.BossPhase;
    return !Number.isFinite(e.x) || Math.hypot(e.x - viewer.x, e.z - viewer.z) <= (boss ? BOSS_RADIUS : MOB_RADIUS);
  });
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function writeEvent(w: Writer, e: EntityEvent, viewerId: string | null): void {
  w.u8(e.type);
  switch (e.type) {
    case EntityEventType.MobHurt: {
      const byYou = e.byYou ?? (!!viewerId && e.attacker?.type === 'player' && e.attacker.id === viewerId);
      w.u16(e.id);
      w.u8(Math.min(255, e.amount * 2));
      w.u8((e.crit ? 1 : 0) | (byYou ? 2 : 0) | (e.killed ? 4 : 0));
      break;
    }
    case EntityEventType.MobDied:
      w.u16(e.id);
      w.u8(e.kind);
      w.u8(e.cause);
      break;
    case EntityEventType.MobAction:
      w.u16(e.id);
      w.u8(e.action);
      w.u8(e.param);
      break;
    case EntityEventType.Telegraph:
      w.u16(e.bossId);
      w.u8(e.shape);
      w.u8(Math.min(255, e.seconds * 10));
      w.p16(e.x * POS);
      w.i16(e.y * POS);
      w.p16(e.z * POS);
      w.u8(Math.min(255, e.radius * 8));
      w.u8(Math.min(255, e.width * 8));
      w.u8(angleU8(e.yaw));
      w.u8(Math.min(255, ((e.halfAngle * 180) / Math.PI) / 2));
      break;
    case EntityEventType.Burst:
      w.u8(e.kind);
      w.p16(e.x * POS);
      w.i16(e.y * POS);
      w.p16(e.z * POS);
      w.u8(Math.min(255, e.radius * 8));
      break;
    case EntityEventType.ProjHit:
      w.u16(e.projId);
      w.u8(e.projKind);
      w.p16(e.x * POS);
      w.i16(e.y * POS);
      w.p16(e.z * POS);
      w.u8(e.what);
      break;
    case EntityEventType.BossPhase:
      w.u16(e.id);
      w.u8(e.phase);
      break;
    case EntityEventType.BossAwake:
    case EntityEventType.BossDefeated:
      w.u16(e.id);
      w.u8(e.kind);
      w.u16(e.structureId);
      break;
    case EntityEventType.Tamed:
      w.u16(e.id);
      w.u8(e.how);
      break;
    case EntityEventType.MobInfo: {
      const name = utf8.encode(e.name).slice(0, 48);
      const owner = utf8.encode(e.owner).slice(0, 32);
      w.u16(e.id);
      w.u8(name.length);
      for (const b of name) w.u8(b);
      w.u8(owner.length);
      for (const b of owner) w.u8(b);
      break;
    }
  }
}

/** 'V' messages for a viewer (split so each holds at most 255 events). */
export function encodeEvents(tick: number, events: readonly EntityEvent[], viewerId: string | null): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < events.length; i += 255) {
    const chunk = events.slice(i, i + 255);
    const w = new Writer();
    w.u16(tick & 0xffff);
    w.u8(chunk.length);
    for (const e of chunk) writeEvent(w, e, viewerId);
    out.push(w.bytes());
  }
  return out;
}

export function decodeEvents(bytes: Uint8Array, near?: NearPoint): { tick: number; events: EntityEvent[] } {
  const ux = unwrapNear(near?.x);
  const uz = unwrapNear(near?.z);
  const r = new BinaryReader(bytes);
  const tick = r.u16();
  const n = r.u8();
  const events: EntityEvent[] = [];
  const nan = { x: NaN, y: NaN, z: NaN };
  for (let i = 0; i < n; i++) {
    const type = r.u8() as EntityEventType;
    switch (type) {
      case EntityEventType.MobHurt: {
        const id = r.u16();
        const amount = r.u8() / 2;
        const f = r.u8();
        events.push({ type, id, amount, crit: !!(f & 1), byYou: !!(f & 2), killed: !!(f & 4), attacker: null, ...nan });
        break;
      }
      case EntityEventType.MobDied:
        events.push({ type, id: r.u16(), kind: r.u8() as MobKind, cause: r.u8() as DamageKind, ...nan });
        break;
      case EntityEventType.MobAction:
        events.push({ type, id: r.u16(), action: r.u8() as MobAction, param: r.u8(), ...nan });
        break;
      case EntityEventType.Telegraph: {
        const bossId = r.u16();
        const shape = r.u8() as TelegraphShape;
        const seconds = r.u8() / 10;
        const x = ux(r.i16() / POS);
        const y = r.i16() / POS;
        const z = uz(r.i16() / POS);
        const radius = r.u8() / 8;
        const width = r.u8() / 8;
        const yaw = u8Angle(r.u8());
        const halfAngle = ((r.u8() * 2) * Math.PI) / 180;
        events.push({ type, bossId, shape, seconds, x, y, z, radius, width, yaw, halfAngle });
        break;
      }
      case EntityEventType.Burst: {
        const kind = r.u8() as BurstKind;
        events.push({ type, kind, x: ux(r.i16() / POS), y: r.i16() / POS, z: uz(r.i16() / POS), radius: r.u8() / 8 });
        break;
      }
      case EntityEventType.ProjHit: {
        const projId = r.u16();
        const projKind = r.u8();
        const x = ux(r.i16() / POS);
        const y = r.i16() / POS;
        const z = uz(r.i16() / POS);
        events.push({ type, projId, projKind, x, y, z, what: r.u8() as 0 | 1 | 2 });
        break;
      }
      case EntityEventType.BossPhase:
        events.push({ type, id: r.u16(), phase: r.u8(), ...nan });
        break;
      case EntityEventType.BossAwake:
        events.push({ type, id: r.u16(), kind: r.u8() as MobKind, structureId: r.u16(), ...nan });
        break;
      case EntityEventType.BossDefeated:
        events.push({ type, id: r.u16(), kind: r.u8() as MobKind, structureId: r.u16(), ...nan });
        break;
      case EntityEventType.Tamed:
        events.push({ type, id: r.u16(), how: r.u8(), ...nan });
        break;
      case EntityEventType.MobInfo: {
        const id = r.u16();
        const nl = r.u8();
        const name = fromUtf8.decode(bytes.subarray(bytes.byteLength - r.remaining, bytes.byteLength - r.remaining + nl));
        for (let k = 0; k < nl; k++) r.u8();
        const ol = r.u8();
        const owner = fromUtf8.decode(bytes.subarray(bytes.byteLength - r.remaining, bytes.byteLength - r.remaining + ol));
        for (let k = 0; k < ol; k++) r.u8();
        events.push({ type, id, name, owner, ...nan });
        break;
      }
      default:
        return { tick, events }; // unknown type: stop (no length prefix)
    }
  }
  return { tick, events };
}

// ---- mi / mr ------------------------------------------------------------------------------------

export function encodeMobInteract(mobId: number, key: string | null): Uint8Array {
  const k = (key ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 40);
  const out = new Uint8Array(3 + k.length);
  new DataView(out.buffer).setUint16(0, mobId, true);
  out[2] = k.length;
  for (let i = 0; i < k.length; i++) out[3 + i] = k.charCodeAt(i);
  return out;
}

export function decodeMobInteract(bytes: Uint8Array): { mobId: number; key: string | null } | null {
  if (bytes.byteLength < 3) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes[2];
  if (len > 40 || bytes.byteLength < 3 + len) return null;
  let key = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[3 + i];
    if (c < 0x20 || c > 0x7e) return null;
    key += String.fromCharCode(c);
  }
  return { mobId: v.getUint16(0, true), key: key || null };
}

export function encodeMobInteractResult(mobId: number, result: InteractResult): Uint8Array {
  const out = new Uint8Array(3);
  new DataView(out.buffer).setUint16(0, mobId, true);
  out[2] = Math.max(0, INTERACT_RESULTS.indexOf(result));
  return out;
}

export function decodeMobInteractResult(bytes: Uint8Array): { mobId: number; result: InteractResult } | null {
  if (bytes.byteLength < 3) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { mobId: v.getUint16(0, true), result: INTERACT_RESULTS[bytes[2]] ?? 'none' };
}

