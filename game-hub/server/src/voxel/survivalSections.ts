/**
 * Survival sections of a saved world (CVW2; design-voxel-survival §14.4):
 * PLYR (players by hashed playerKey), CHST (chest contents), SATC (Lost
 * Satchels) and SURV (rules, day). Each starts with a version byte; decoders
 * throw on anything malformed so the caller can keep the bytes untouched.
 */
import {
  BinaryReader,
  BinaryWriter,
  type ItemStack,
  itemDef,
  maxStack,
  PLAYER_SLOTS,
  type SavedChest,
  type SavedSatchel,
  type SavedSurvivalPlayer,
} from '@hub/shared';

const VERSION = 1;
const MAX_PLAYERS = 256;
const MAX_CHESTS = 4096;
const MAX_SATCHELS = 512;

export interface PlayerRecord {
  /** 32 hex chars (16 bytes of SHA-256 of the playerKey). */
  key: string;
  saved: SavedSurvivalPlayer;
  /** ms since epoch. */
  lastSeen: number;
}

const writeKey = (w: BinaryWriter, hex: string | null) => {
  for (let i = 0; i < 16; i++) w.u8(hex ? parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0 : 0);
};
const readKey = (r: BinaryReader): string => {
  let s = '';
  for (let i = 0; i < 16; i++) s += r.u8().toString(16).padStart(2, '0');
  return s;
};
const ZERO_KEY = '0'.repeat(32);

/** Unknown items are skipped and counts clamped. */
const okStack = (item: number, count: number): boolean => count > 0 && !!itemDef(item) && !itemDef(item)!.special;
const clampCount = (item: number, count: number) => Math.min(count, maxStack(item));

function end(r: BinaryReader): void {
  if (r.remaining !== 0) throw new Error('trailing bytes');
}

export function encodePlayers(list: readonly PlayerRecord[]): Uint8Array {
  const w = new BinaryWriter(256).u8(VERSION).u16(list.length);
  for (const { key, saved: s, lastSeen } of list) {
    writeKey(w, key);
    w.f32(s.x).f32(s.y).f32(s.z).angle(s.yaw).angle(s.pitch);
    w.u8(Math.ceil(Math.max(0, s.health) * 2)).u8(Math.ceil(Math.max(0, s.food) * 2)).u8((s.spawn ? 1 : 0) | (s.dead ? 2 : 0));
    w.i16(s.spawn?.x ?? 0).u8(s.spawn?.y ?? 0).i16(s.spawn?.z ?? 0);
    w.u32(Math.floor(lastSeen / 60000));
    const slots = s.slots.filter(([slot]) => slot >= 0 && slot < PLAYER_SLOTS).slice(0, PLAYER_SLOTS);
    w.u8(slots.length);
    for (const [slot, item, count, meta] of slots) w.u8(slot).u16(item).u8(count).u16(meta);
  }
  return w.bytes();
}

export function decodePlayers(bytes: Uint8Array): PlayerRecord[] {
  const r = new BinaryReader(bytes);
  if (r.u8() !== VERSION) throw new Error('unknown PLYR version');
  const n = r.u16();
  if (n > MAX_PLAYERS) throw new Error('too many players');
  const out: PlayerRecord[] = [];
  for (let i = 0; i < n; i++) {
    const key = readKey(r);
    const x = r.f32(), y = r.f32(), z = r.f32(), yaw = r.angle(), pitch = r.angle();
    const health = r.u8() / 2, food = r.u8() / 2, flags = r.u8();
    const sx = r.i16(), sy = r.u8(), sz = r.i16();
    const lastSeen = r.u32() * 60000;
    const k = r.u8();
    const slots: SavedSurvivalPlayer['slots'] = [];
    for (let j = 0; j < k; j++) {
      const slot = r.u8(), item = r.u16(), count = r.u8(), meta = r.u16();
      if (slot < PLAYER_SLOTS && okStack(item, count)) slots.push([slot, item, clampCount(item, count), meta]);
    }
    if (![x, y, z].every(Number.isFinite)) throw new Error('bad position');
    out.push({ key, lastSeen, saved: { x, y, z, yaw, pitch, health: Math.min(20, health), food: Math.min(20, food), dead: (flags & 2) !== 0, spawn: flags & 1 ? { x: sx, y: sy, z: sz } : null, slots } });
  }
  end(r);
  return out;
}

export function encodeChests(list: readonly SavedChest[]): Uint8Array {
  const w = new BinaryWriter(256).u8(VERSION).u16(list.length);
  for (const c of list) {
    w.i16(c.x).u8(c.y).i16(c.z).u8(c.flags).u8(c.slots.length);
    for (const [slot, item, count, meta] of c.slots) w.u8(slot).u16(item).u8(count).u16(meta);
  }
  return w.bytes();
}

export function decodeChests(bytes: Uint8Array): SavedChest[] {
  const r = new BinaryReader(bytes);
  if (r.u8() !== VERSION) throw new Error('unknown CHST version');
  const n = r.u16();
  if (n > MAX_CHESTS) throw new Error('too many chests');
  const out: SavedChest[] = [];
  for (let i = 0; i < n; i++) {
    const x = r.i16(), y = r.u8(), z = r.i16(), flags = r.u8(), k = r.u8();
    const slots: SavedChest['slots'] = [];
    for (let j = 0; j < k; j++) {
      const slot = r.u8(), item = r.u16(), count = r.u8(), meta = r.u16();
      if (slot < 27 && okStack(item, count)) slots.push([slot, item, clampCount(item, count), meta]);
    }
    out.push({ x, y, z, flags, slots });
  }
  end(r);
  return out;
}

export function encodeSatchels(list: readonly SavedSatchel[]): Uint8Array {
  const w = new BinaryWriter(256).u8(VERSION).u16(list.length);
  for (const s of list) {
    writeKey(w, /^[0-9a-f]{32}$/.test(s.owner) ? s.owner : null);
    w.f32(s.x).f32(s.y).f32(s.z).u32(Math.floor(s.createdMs / 60000));
    const items = s.items.slice(0, 64);
    w.u8(items.length);
    for (const it of items) w.u16(it.item).u8(it.count).u16(it.meta);
  }
  return w.bytes();
}

export function decodeSatchels(bytes: Uint8Array): SavedSatchel[] {
  const r = new BinaryReader(bytes);
  if (r.u8() !== VERSION) throw new Error('unknown SATC version');
  const n = r.u16();
  if (n > MAX_SATCHELS) throw new Error('too many satchels');
  const out: SavedSatchel[] = [];
  for (let i = 0; i < n; i++) {
    const owner = readKey(r);
    const x = r.f32(), y = r.f32(), z = r.f32(), createdMs = r.u32() * 60000, k = r.u8();
    const items: ItemStack[] = [];
    for (let j = 0; j < k; j++) {
      const item = r.u16(), count = r.u8(), meta = r.u16();
      if (okStack(item, count)) items.push({ item, count: clampCount(item, count), meta });
    }
    if (![x, y, z].every(Number.isFinite)) throw new Error('bad position');
    // A satchel without an owner key is anyone's (the owner-only time counts from the save).
    out.push({ owner: owner === ZERO_KEY ? '' : owner, x, y, z, createdMs, items });
  }
  end(r);
  return out;
}

export function encodeSurv(rules: number, day: number): Uint8Array {
  return new BinaryWriter(4).u8(VERSION).u8(rules).u16(day).bytes();
}

export function decodeSurv(bytes: Uint8Array): { rules: number; day: number } {
  const r = new BinaryReader(bytes);
  if (r.u8() !== VERSION) throw new Error('unknown SURV version');
  const out = { rules: r.u8() & 3, day: Math.max(1, r.u16()) };
  end(r);
  return out;
}
