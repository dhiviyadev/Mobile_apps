/**
 * Tamed creatures in saves (design-voxel-mobs §8.4): the CVW2 'MOBS' section
 * (version 1) online and the `mobs` JSON field of offline saves.
 */
import { cleanText } from '../../util/text';
import { CHUNK_HEIGHT, ENDLESS_LIMIT } from '../constants';
import { isFriendlyKind, isMobKind, MOB_DEFS } from './defs';
import { MobFlag, MobVariant, type SavedMob } from './types';

export const MOBS_SECTION_VERSION = 1;
export const MAX_SAVED_MOBS = 64;
const KEEP_FLAGS = MobFlag.Baby | MobFlag.Tamed | MobFlag.Named;
/** Section flag bits: bit0 baby, bit1 tamed, bit2 named. */
const toBits = (f: number) => (f & MobFlag.Baby ? 1 : 0) | (f & MobFlag.Tamed ? 2 : 0) | (f & MobFlag.Named ? 4 : 0);
const fromBits = (b: number) => (b & 1 ? MobFlag.Baby : 0) | (b & 2 ? MobFlag.Tamed : 0) | (b & 4 ? MobFlag.Named : 0);

const enc = new TextEncoder();
const dec = new TextDecoder();

function validPos(x: number, y: number, z: number): boolean {
  return [x, y, z].every(Number.isFinite) && y > 0 && y < CHUNK_HEIGHT && x >= -ENDLESS_LIMIT && x < ENDLESS_LIMIT && z >= -ENDLESS_LIMIT && z < ENDLESS_LIMIT;
}

const isVariant = (v: unknown): v is MobVariant => typeof v === 'number' && MobVariant[v] !== undefined;

export function encodeMobsSection(list: readonly SavedMob[]): Uint8Array {
  const recs = list.filter((m) => isFriendlyKind(m.kind)).slice(0, MAX_SAVED_MOBS);
  const parts: number[] = [MOBS_SECTION_VERSION, recs.length & 255, recs.length >> 8];
  const f32 = new DataView(new ArrayBuffer(4));
  const pushF = (v: number) => {
    f32.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) parts.push(f32.getUint8(i));
  };
  for (const m of recs) {
    parts.push(m.kind, m.variant & 255, toBits(m.flags));
    pushF(m.x);
    pushF(m.y);
    pushF(m.z);
    parts.push(Math.round((m.yaw / (Math.PI * 2)) * 256) & 255);
    parts.push(Math.max(1, Math.min(255, Math.ceil(m.health))));
    const g = Math.max(0, Math.min(65535, Math.round(m.growLeft)));
    parts.push(g & 255, g >> 8);
    const owner = enc.encode(m.owner).slice(0, 32);
    parts.push(owner.length, ...owner);
    const name = enc.encode(m.name).slice(0, 48);
    parts.push(name.length, ...name);
  }
  return Uint8Array.from(parts);
}

/** Decoded list, or null when the version is unknown or the payload is malformed (the caller keeps the bytes). */
export function decodeMobsSection(bytes: Uint8Array): SavedMob[] | null {
  if (bytes.byteLength < 3 || bytes[0] !== MOBS_SECTION_VERSION) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint16(1, true);
  if (count > MAX_SAVED_MOBS) return null;
  const out: SavedMob[] = [];
  let o = 3;
  for (let i = 0; i < count; i++) {
    if (o + 20 > bytes.byteLength) return null;
    const kind = bytes[o];
    const variant = bytes[o + 1];
    const flags = fromBits(bytes[o + 2]);
    const x = v.getFloat32(o + 3, true);
    const y = v.getFloat32(o + 7, true);
    const z = v.getFloat32(o + 11, true);
    const yawB = bytes[o + 15];
    const health = bytes[o + 16];
    const growLeft = v.getUint16(o + 17, true);
    o += 19;
    const ol = bytes[o++];
    if (ol > 32 || o + ol + 1 > bytes.byteLength) return null;
    const owner = dec.decode(bytes.subarray(o, o + ol));
    o += ol;
    const nl = bytes[o++];
    if (nl > 48 || o + nl > bytes.byteLength) return null;
    const name = cleanText(dec.decode(bytes.subarray(o, o + nl)), 16);
    o += nl;
    if (!isMobKind(kind) || !isFriendlyKind(kind) || !validPos(x, y, z)) continue;
    out.push({
      kind,
      variant: isVariant(variant) ? variant : MobVariant.Default,
      flags,
      x, y, z,
      yaw: ((yawB > 127 ? yawB - 256 : yawB) / 256) * Math.PI * 2,
      health: Math.min(health, MOB_DEFS[kind].maxHealth),
      growLeft,
      owner,
      name,
    });
  }
  return out;
}

export interface SavedMobJson {
  k: number;
  var: number;
  f: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  grow: number;
  owner: string;
  name: string;
}

const round = (v: number) => Math.round(v * 100) / 100;

export function mobsToJson(list: readonly SavedMob[]): { v: 1; list: SavedMobJson[] } {
  return {
    v: 1,
    list: list.slice(0, MAX_SAVED_MOBS).map((m) => ({
      k: m.kind, var: m.variant, f: m.flags & KEEP_FLAGS, x: round(m.x), y: round(m.y), z: round(m.z),
      yaw: round(m.yaw), hp: round(m.health), grow: Math.round(m.growLeft), owner: m.owner, name: m.name,
    })),
  };
}

/** Tolerant: bad entries are skipped; anything unexpected gives an empty list. */
export function mobsFromJson(v: unknown): SavedMob[] {
  if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1 || !Array.isArray((v as { list?: unknown }).list)) return [];
  const out: SavedMob[] = [];
  for (const e of (v as { list: unknown[] }).list) {
    if (!e || typeof e !== 'object') continue;
    const j = e as Partial<SavedMobJson>;
    if (!isMobKind(j.k) || !isFriendlyKind(j.k)) continue;
    const x = Number(j.x);
    const y = Number(j.y);
    const z = Number(j.z);
    if (!validPos(x, y, z)) continue;
    const max = MOB_DEFS[j.k].maxHealth;
    out.push({
      kind: j.k,
      variant: isVariant(j.var) ? j.var : MobVariant.Default,
      flags: (Number(j.f) | 0) & KEEP_FLAGS,
      x, y, z,
      yaw: Number.isFinite(j.yaw) ? Number(j.yaw) : 0,
      health: Math.max(1, Math.min(max, Number(j.hp) || max)),
      growLeft: Math.max(0, Number(j.grow) || 0),
      owner: typeof j.owner === 'string' ? j.owner.slice(0, 32) : '',
      name: cleanText(typeof j.name === 'string' ? j.name : '', 16),
    });
    if (out.length >= MAX_SAVED_MOBS) break;
  }
  return out;
}
