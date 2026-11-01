/**
 * Survival wire codecs (INTEGRATION-voxel.md §1.5): hd k s g i x r (C→S) and
 * S I vt C (S→C), little-endian. `S` batches length-prefixed records so old
 * clients skip types they do not know.
 */
import { BinaryReader, BinaryWriter } from '../../util/binary';
import type { DamageKind } from '../combat';
import { InvOpCode, type InvOp } from './inventory';
import type { InteractKind, SurvivalSfx } from './constants';
import type { AttackIntent, DamageEvent, InvSyncData, ShootIntent, VitalsData, WireRef } from './sim';

// ---- client -> server --------------------------------------------------------------------

export function encodeHand(slot: number, flags: number, creativeItem: number): Uint8Array {
  return new BinaryWriter(4).u8(slot).u8(flags).u16(creativeItem).bytes();
}
export function decodeHand(b: Uint8Array): { slot: number; flags: number; creativeItem: number } {
  const r = new BinaryReader(b);
  return { slot: r.u8(), flags: r.u8(), creativeItem: r.u16() };
}

export const AttackFlags = { Crit: 1, Sprint: 2 } as const;

export function encodeAttack(a: AttackIntent): Uint8Array {
  return new BinaryWriter(22)
    .u16(a.seq).u8(a.target.refType).u16(a.target.id).f32(a.ex).f32(a.ey).f32(a.ez).angle(a.yaw).angle(a.pitch)
    .u8((a.crit ? AttackFlags.Crit : 0) | (a.sprint ? AttackFlags.Sprint : 0))
    .bytes();
}
export function decodeAttack(b: Uint8Array): AttackIntent {
  const r = new BinaryReader(b);
  const seq = r.u16();
  const target = { refType: r.u8(), id: r.u16() };
  const ex = r.f32();
  const ey = r.f32();
  const ez = r.f32();
  const yaw = r.angle();
  const pitch = r.angle();
  const f = r.u8();
  return { seq, target, ex, ey, ez, yaw, pitch, crit: (f & AttackFlags.Crit) !== 0, sprint: (f & AttackFlags.Sprint) !== 0 };
}

export function encodeShoot(s: ShootIntent): Uint8Array {
  return new BinaryWriter(19).u16(s.seq).f32(s.ox).f32(s.oy).f32(s.oz).angle(s.yaw).angle(s.pitch).u8(Math.round(Math.max(0, Math.min(1, s.charge)) * 255)).bytes();
}
export function decodeShoot(b: Uint8Array): ShootIntent {
  const r = new BinaryReader(b);
  return { seq: r.u16(), ox: r.f32(), oy: r.f32(), oz: r.f32(), yaw: r.angle(), pitch: r.angle(), charge: r.u8() / 255 };
}

export function encodeCell(x: number, y: number, z: number): Uint8Array {
  return new BinaryWriter(5).i16(x).u8(y).i16(z).bytes();
}
export function decodeCell(b: Uint8Array): { x: number; y: number; z: number } {
  const r = new BinaryReader(b);
  return { x: r.i16(), y: r.u8(), z: r.i16() };
}

export function encodeInvOp(seq: number, op: InvOp): Uint8Array {
  const w = new BinaryWriter(8).u16(seq).u8(InvOpCode[op.op]);
  switch (op.op) {
    case 'move': w.u8(op.from).u8(op.to).u8(op.count); break;
    case 'quick': w.u8(op.from); break;
    case 'split': w.u8(op.from).u8(op.to); break;
    case 'drop': w.u8(op.from).u8(op.count); break;
    case 'craft': w.u16(op.recipe).u8(op.times); break;
  }
  return w.bytes();
}
export function decodeInvOp(b: Uint8Array): { seq: number; op: InvOp } | null {
  const r = new BinaryReader(b);
  const seq = r.u16();
  switch (r.u8()) {
    case InvOpCode.move: return { seq, op: { op: 'move', from: r.u8(), to: r.u8(), count: r.u8() } };
    case InvOpCode.quick: return { seq, op: { op: 'quick', from: r.u8() } };
    case InvOpCode.split: return { seq, op: { op: 'split', from: r.u8(), to: r.u8() } };
    case InvOpCode.drop: return { seq, op: { op: 'drop', from: r.u8(), count: r.u8() } };
    case InvOpCode.craft: return { seq, op: { op: 'craft', recipe: r.u16(), times: r.u8() } };
    case InvOpCode.sort: return { seq, op: { op: 'sort' } };
    case InvOpCode.swapHands: return { seq, op: { op: 'swapHands' } };
  }
  return null;
}

export function encodeInteract(kind: InteractKind, x: number, y: number, z: number): Uint8Array {
  return new BinaryWriter(6).u8(kind).i16(x).u8(y).i16(z).bytes();
}
export function decodeInteract(b: Uint8Array): { kind: InteractKind; x: number; y: number; z: number } {
  const r = new BinaryReader(b);
  return { kind: r.u8() as InteractKind, x: r.i16(), y: r.u8(), z: r.i16() };
}

// ---- server -> client: S records ------------------------------------------------------------

export const RecordType = { DropSpawn: 1, DropMove: 2, DropRemove: 3, Damage: 6, Sound: 7, Death: 8 } as const;
export const DropFlags = { Satchel: 1, /** The satchel belongs to the receiving player. */ Yours: 2 } as const;

/** A drop as clients see it. */
export interface ClientDrop {
  id: number;
  item: number;
  count: number;
  meta: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  satchel: boolean;
  yours: boolean;
}

export type ClientEvent =
  | ({ type: 'dropSpawn' } & ClientDrop)
  | { type: 'dropMove'; id: number; x: number; y: number; z: number }
  | { type: 'dropRemove'; id: number; picker: number }
  | DamageEvent
  | { type: 'sound'; sfx: SurvivalSfx; x: number; y: number; z: number }
  | { type: 'death'; target: WireRef; x: number; y: number; z: number };

const v8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 10)));
const v16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 100)));

/** One record: u8 type, u8 len, payload. */
export function encodeRecord(e: ClientEvent): Uint8Array {
  const w = new BinaryWriter(40);
  switch (e.type) {
    case 'dropSpawn':
      w.u8(RecordType.DropSpawn).u8(23).u16(e.id).u16(e.item).u8(e.count).u16(e.meta).f32(e.x).f32(e.y).f32(e.z).i8(v8(e.vx)).i8(v8(e.vy)).i8(v8(e.vz))
        .u8((e.satchel ? DropFlags.Satchel : 0) | (e.yours ? DropFlags.Yours : 0));
      break;
    case 'dropMove':
      w.u8(RecordType.DropMove).u8(14).u16(e.id).f32(e.x).f32(e.y).f32(e.z);
      break;
    case 'dropRemove':
      w.u8(RecordType.DropRemove).u8(4).u16(e.id).u16(e.picker);
      break;
    case 'damage':
      w.u8(RecordType.Damage).u8(32).u8(e.target.refType).u16(e.target.id).u8(e.source.refType).u16(e.source.id)
        .u16(Math.min(65535, Math.round(e.amount * 10))).u8(e.kind).u8(e.flags).i16(v16(e.dvx)).i16(v16(e.dvy)).i16(v16(e.dvz))
        .f32(e.x).f32(e.y).f32(e.z).u16(Math.max(0, Math.min(65535, Math.round(e.hpAfter * 10)))).u16(e.maxHp);
      break;
    case 'sound':
      w.u8(RecordType.Sound).u8(13).u8(e.sfx).f32(e.x).f32(e.y).f32(e.z);
      break;
    case 'death':
      w.u8(RecordType.Death).u8(15).u8(e.target.refType).u16(e.target.id).f32(e.x).f32(e.y).f32(e.z);
      break;
  }
  return w.bytes();
}

/** u8 count, then the records (at most 255; the caller splits). */
export function packRecords(records: readonly Uint8Array[]): Uint8Array {
  let len = 1;
  for (const r of records) len += r.length;
  const out = new Uint8Array(len);
  out[0] = records.length;
  let o = 1;
  for (const r of records) {
    out.set(r, o);
    o += r.length;
  }
  return out;
}

export function decodeSurvivalEvents(b: Uint8Array): ClientEvent[] {
  const out: ClientEvent[] = [];
  let o = 1;
  const n = b[0] ?? 0;
  for (let i = 0; i < n && o + 2 <= b.length; i++) {
    const type = b[o];
    const len = b[o + 1];
    const r = new BinaryReader(b.subarray(o + 2, o + 2 + len));
    o += 2 + len;
    try {
      switch (type) {
        case RecordType.DropSpawn: {
          const id = r.u16(), item = r.u16(), count = r.u8(), meta = r.u16(), x = r.f32(), y = r.f32(), z = r.f32();
          const vx = r.i8() / 10, vy = r.i8() / 10, vz = r.i8() / 10, f = r.u8();
          out.push({ type: 'dropSpawn', id, item, count, meta, x, y, z, vx, vy, vz, satchel: (f & DropFlags.Satchel) !== 0, yours: (f & DropFlags.Yours) !== 0 });
          break;
        }
        case RecordType.DropMove:
          out.push({ type: 'dropMove', id: r.u16(), x: r.f32(), y: r.f32(), z: r.f32() });
          break;
        case RecordType.DropRemove:
          out.push({ type: 'dropRemove', id: r.u16(), picker: r.u16() });
          break;
        case RecordType.Damage: {
          const target = { refType: r.u8(), id: r.u16() };
          const source = { refType: r.u8(), id: r.u16() };
          const amount = r.u16() / 10, kind = r.u8() as DamageKind, flags = r.u8();
          const dvx = r.i16() / 100, dvy = r.i16() / 100, dvz = r.i16() / 100;
          const x = r.f32(), y = r.f32(), z = r.f32(), hpAfter = r.u16() / 10, maxHp = r.u16();
          out.push({ type: 'damage', target, source, amount, kind, flags, dvx, dvy, dvz, x, y, z, hpAfter, maxHp });
          break;
        }
        case RecordType.Sound:
          out.push({ type: 'sound', sfx: r.u8() as SurvivalSfx, x: r.f32(), y: r.f32(), z: r.f32() });
          break;
        case RecordType.Death:
          out.push({ type: 'death', target: { refType: r.u8(), id: r.u16() }, x: r.f32(), y: r.f32(), z: r.f32() });
          break;
        default:
          break; // unknown types are skipped by len
      }
    } catch {
      /* malformed record: skip */
    }
  }
  return out;
}

// ---- server -> client: owner messages ---------------------------------------------------------

export const InvSyncFlags = { Full: 1, ContainerFull: 2 } as const;

export function encodeInvSync(d: InvSyncData): Uint8Array {
  const w = new BinaryWriter(4 + d.slots.length * 6).u16(d.ack & 0xffff).u8((d.full ? InvSyncFlags.Full : 0) | (d.containerFull ? InvSyncFlags.ContainerFull : 0)).u8(d.slots.length);
  for (const [ref, item, count, meta] of d.slots) w.u8(ref).u16(item).u8(count).u16(meta);
  return w.bytes();
}
export function decodeInvSync(b: Uint8Array): InvSyncData {
  const r = new BinaryReader(b);
  const ack = r.u16();
  const f = r.u8();
  const n = r.u8();
  const slots: InvSyncData['slots'] = [];
  for (let i = 0; i < n; i++) slots.push([r.u8(), r.u16(), r.u8(), r.u16()]);
  return { ack, full: (f & InvSyncFlags.Full) !== 0, containerFull: (f & InvSyncFlags.ContainerFull) !== 0, slots };
}

export function encodeVitals(v: VitalsData): Uint8Array {
  return new BinaryWriter(7).u8(v.hpHalf).u8(v.foodHalf).u8(v.air).u8(v.flags).u8(v.slowPct).u8(v.slowTenths).u8(v.burnTenths).bytes();
}
export function decodeVitals(b: Uint8Array): VitalsData {
  const r = new BinaryReader(b);
  return { hpHalf: r.u8(), foodHalf: r.u8(), air: r.u8(), flags: r.u8(), slowPct: r.u8(), slowTenths: r.u8(), burnTenths: r.u8() };
}

export function encodeContainer(open: boolean, x: number, y: number, z: number, sealed: boolean): Uint8Array {
  return new BinaryWriter(9).u8(open ? 1 : 0).i16(x).u8(y).i16(z).u8(27).u8(sealed ? 1 : 0).bytes();
}
export function decodeContainer(b: Uint8Array): { open: boolean; x: number; y: number; z: number; sealed: boolean } {
  const r = new BinaryReader(b);
  const open = r.u8() === 1;
  const x = r.i16(), y = r.u8(), z = r.i16();
  r.u8();
  return { open, x, y, z, sealed: (r.u8() & 1) !== 0 };
}

/** `dead` JSON payload. */
export interface DeadMessage {
  cause: string;
  satchel: { x: number; y: number; z: number } | null;
}
