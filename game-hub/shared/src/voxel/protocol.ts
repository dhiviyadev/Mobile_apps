/**
 * Voxelvale wire protocol.
 *
 * Block edits and movement use compact binary messages; low-frequency data
 * (names, colours, positions for interpolation, time of day) rides on the
 * Colyseus schema state. Chat and parkour events are small JSON messages.
 */
import { BinaryReader, BinaryWriter } from '../util/binary';

export const VoxelMsg = {
  /** C→S single edit request: i16 x, u8 y, i16 z, u8 id */
  Edit: 'e',
  /** S→C applied edits batch: u16 n, n × edit */
  Edits: 'E',
  /** S→C full edit list for late joiners: u32 n, n × edit */
  World: 'W',
  /** S→C an edit of yours was rejected: one edit with the authoritative block */
  Reject: 'R',
  /** C→S movement: f32 x, f32 y, f32 z, angle yaw, angle pitch, u8 flags */
  Move: 'm',
  /** S→C forced position (anti-cheat correction / parkour respawn): f32 x, y, z */
  Teleport: 't',
  /** JSON chat both ways */
  Chat: 'chat',
  /** C→S parkour progress event (JSON) */
  Parkour: 'pk',
} as const;

export const MoveFlags = {
  Crouch: 1,
  InWater: 2,
} as const;

export interface BlockEdit {
  x: number;
  y: number;
  z: number;
  id: number;
}

export interface MoveUpdate {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
}

export interface ChatMessage {
  /** Session id of the sender ('' for system messages). */
  id: string;
  name: string;
  color: number;
  text: string;
  system?: boolean;
}

export interface ParkourEventMsg {
  kind: 'start' | 'checkpoint' | 'respawn' | 'restart' | 'finish';
  index?: number;
}

const writeEdit = (w: BinaryWriter, e: BlockEdit) => w.i16(e.x).u8(e.y).i16(e.z).u8(e.id);
const readEdit = (r: BinaryReader): BlockEdit => ({ x: r.i16(), y: r.u8(), z: r.i16(), id: r.u8() });

export function encodeEdit(e: BlockEdit): Uint8Array {
  return writeEdit(new BinaryWriter(6), e).bytes();
}

export function decodeEdit(data: Uint8Array): BlockEdit {
  return readEdit(new BinaryReader(data));
}

export function encodeEdits(edits: BlockEdit[], wide = false): Uint8Array {
  const w = new BinaryWriter(4 + edits.length * 6);
  if (wide) w.u32(edits.length);
  else w.u16(edits.length);
  for (const e of edits) writeEdit(w, e);
  return w.bytes();
}

export function decodeEdits(data: Uint8Array, wide = false): BlockEdit[] {
  const r = new BinaryReader(data);
  const n = wide ? r.u32() : r.u16();
  const out: BlockEdit[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readEdit(r);
  return out;
}

export function encodeMove(m: MoveUpdate): Uint8Array {
  return new BinaryWriter(17).f32(m.x).f32(m.y).f32(m.z).angle(m.yaw).angle(m.pitch).u8(m.flags).bytes();
}

export function decodeMove(data: Uint8Array): MoveUpdate {
  const r = new BinaryReader(data);
  return { x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.angle(), pitch: r.angle(), flags: r.u8() };
}

export function encodeTeleport(x: number, y: number, z: number): Uint8Array {
  return new BinaryWriter(12).f32(x).f32(y).f32(z).bytes();
}

export function decodeTeleport(data: Uint8Array): { x: number; y: number; z: number } {
  const r = new BinaryReader(data);
  return { x: r.f32(), y: r.f32(), z: r.f32() };
}
