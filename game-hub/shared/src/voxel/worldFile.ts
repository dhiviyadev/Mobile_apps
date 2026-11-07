/**
 * Voxelvale world files ("CVW", `.voxelvale` when exported): one byte format for
 * the server's saved worlds, the on-device world library and hosted worlds
 * travelling between a host's device and the server. DataView only (no Node
 * APIs), so the browser and the server share it byte for byte.
 */
import { VOXEL_MODES, type VoxelMode } from '../constants';
import { type GenVersion, isGenVersion } from './generator';

/**
 * CVW2 section tags (4 ASCII chars). EDIT is required; the others belong to one
 * package each and start with their own u8 version. Unknown tags are kept and
 * written back unchanged.
 */
export const SECTION_TAGS = {
  edits: 'EDIT',
  /** Survival players by hashed playerKey (WP-B). */
  players: 'PLYR',
  /** Chest contents (WP-B). */
  chests: 'CHST',
  /** Lost Satchels (WP-B). */
  satchels: 'SATC',
  /** Survival room rules and day counter (WP-B). */
  survival: 'SURV',
  /** Tamed creatures (WP-C). */
  mobs: 'MOBS',
  /** Reserved. */
  inventory: 'INVT',
  /** World library details (name, dates, play time, host code; worldFile.ts WorldMeta). */
  meta: 'META',
  /** Saved teleport places per player (voxel/teleport.ts). */
  waypoints: 'WAYP',
} as const;
const MAX_SECTIONS = 32;

export interface SavedWorld {
  id: string;
  seed: number;
  mode: VoxelMode;
  private: boolean;
  /** Day/night cycle position, 0..1. */
  timeOfDay: number;
  /** When the world was saved (ms since the epoch); drives pruning. */
  savedAt: number;
  /** Edit list as encoded by encodeEdits(list, true): u32 count, then 6-byte edits. */
  edits: Uint8Array;
  /** Terrain generator version (format-1 files: 1). Optional when saving: defaults to 1. */
  genVersion?: GenVersion;
  /** Extra sections by tag (never 'EDIT'); kept and re-saved even when this server does not understand them. */
  sections?: ReadonlyMap<string, Uint8Array>;
}

// ---- binary format ----------------------------------------------------------------

const MAGIC = [0x43, 0x56, 0x57, 0x31]; // "CVW1" (kept for format 2: the magic names the family)
/** Written by this build. Format 1 (no genVersion, no sections) is still read. */
const FORMAT_VERSION = 2;
/** Format 1 and 2 share these first bytes (magic .. savedAt), so readSavedAt() works on both. */
const HEADER_BYTES = 23;
/** Format 2 header: + u8 genVersion, u8 flags, u16 sectionCount. */
const HEADER2_BYTES = 27;
const EDIT_BYTES = 6;

const tagBytes = (tag: string): number[] => Array.from(tag, (c) => c.charCodeAt(0) & 0x7f);
const tagOf = (data: Uint8Array, at: number): string => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
const isTag = (tag: string): boolean => /^[A-Z0-9]{4}$/.test(tag);

/** Extra sections encodeWorld() writes (valid tags other than EDIT). */
const extraSections = (world: SavedWorld): [string, Uint8Array][] =>
  [...(world.sections ?? [])].filter(([tag]) => tag !== SECTION_TAGS.edits && isTag(tag));

/** Format 1 still holds every world on generator 1 without extra sections (old servers can read it). */
const needsFormat2 = (world: SavedWorld): boolean => (world.genVersion ?? 1) !== 1 || extraSections(world).length > 0;

/** Size of a world as encodeWorld() writes it. */
export const encodedWorldSize = (world: SavedWorld): number => {
  if (!needsFormat2(world)) return HEADER_BYTES + world.edits.byteLength;
  let n = HEADER2_BYTES + 8 + world.edits.byteLength;
  for (const [, bytes] of extraSections(world)) n += 8 + bytes.byteLength;
  return n;
};

/**
 * Format 1 (unchanged): the 23-byte header, then the edit list. Written while a
 * world needs nothing more (generator 1, no sections).
 * Format 2, little-endian:
 *   0 "CVW1" | 4 u8 formatVersion = 2 | 5 u8 mode (index in VOXEL_MODES) | 6 u8 private
 *   7 u32 seed | 11 f32 timeOfDay | 15 f64 savedAt | 23 u8 genVersion | 24 u8 flags (0)
 *   25 u16 sectionCount | 27.. sections: 4 ASCII tag, u32 byteLength, payload
 * EDIT (required, first) = encodeEdits(list, true).
 */
export function encodeWorld(world: SavedWorld): Uint8Array {
  const format2 = needsFormat2(world);
  const sections: [string, Uint8Array][] = [[SECTION_TAGS.edits, world.edits], ...extraSections(world)];
  if (sections.length > MAX_SECTIONS) throw new Error(`too many sections (${sections.length})`);
  const out = new Uint8Array(encodedWorldSize(world));
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, format2 ? FORMAT_VERSION : 1);
  view.setUint8(5, Math.max(0, VOXEL_MODES.indexOf(world.mode)));
  view.setUint8(6, world.private ? 1 : 0);
  view.setUint32(7, world.seed >>> 0, true);
  view.setFloat32(11, world.timeOfDay, true);
  view.setFloat64(15, world.savedAt, true);
  if (!format2) {
    out.set(world.edits, HEADER_BYTES);
    return out;
  }
  view.setUint8(23, world.genVersion ?? 1);
  view.setUint8(24, 0);
  view.setUint16(25, sections.length, true);
  let o = HEADER2_BYTES;
  for (const [tag, bytes] of sections) {
    out.set(tagBytes(tag), o);
    view.setUint32(o + 4, bytes.byteLength, true);
    out.set(bytes, o + 8);
    o += 8 + bytes.byteLength;
  }
  return out;
}

function checkEdits(edits: Uint8Array): void {
  if (edits.byteLength < 4) throw new Error('edit section too short');
  const count = new DataView(edits.buffer, edits.byteOffset, edits.byteLength).getUint32(0, true);
  if (edits.byteLength !== 4 + count * EDIT_BYTES) throw new Error(`expected ${count} edits, file is truncated or padded`);
}

/** Parses a world file (format 1 or 2). Throws on anything malformed, including truncation. */
export function decodeWorld(id: string, data: Uint8Array): SavedWorld {
  if (data.byteLength < HEADER_BYTES + 4) throw new Error('file too short');
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) throw new Error('bad magic');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(4);
  if (version !== 1 && version !== FORMAT_VERSION) throw new Error(`unsupported version ${version}`);
  const mode = VOXEL_MODES[view.getUint8(5)];
  if (!mode) throw new Error('bad mode');
  const flag = view.getUint8(6);
  if (flag > 1) throw new Error('bad private flag');
  const timeOfDay = view.getFloat32(11, true);
  const savedAt = view.getFloat64(15, true);
  if (!Number.isFinite(timeOfDay) || !Number.isFinite(savedAt)) throw new Error('bad header values');
  const base = { id, seed: view.getUint32(7, true), mode, private: flag === 1, timeOfDay: ((timeOfDay % 1) + 1) % 1, savedAt };
  if (version === 1) {
    const edits = data.subarray(HEADER_BYTES);
    checkEdits(edits);
    return { ...base, edits }; // no genVersion (= 1), no sections
  }
  if (data.byteLength < HEADER2_BYTES) throw new Error('file too short');
  const genVersion = view.getUint8(23);
  if (!isGenVersion(genVersion)) throw new Error(`bad generator version ${genVersion}`);
  const count = view.getUint16(25, true);
  if (count < 1 || count > MAX_SECTIONS) throw new Error(`bad section count ${count}`);
  const sections = new Map<string, Uint8Array>();
  let edits: Uint8Array | null = null;
  let o = HEADER2_BYTES;
  for (let i = 0; i < count; i++) {
    if (o + 8 > data.byteLength) throw new Error('section header overruns the file');
    const tag = tagOf(data, o);
    const len = view.getUint32(o + 4, true);
    if (o + 8 + len > data.byteLength) throw new Error(`section ${tag} overruns the file`);
    const payload = data.subarray(o + 8, o + 8 + len);
    if (tag === SECTION_TAGS.edits) {
      if (edits) throw new Error('duplicate EDIT section');
      edits = payload;
    } else {
      if (!isTag(tag) || sections.has(tag)) throw new Error(`bad or duplicate section ${JSON.stringify(tag)}`);
      sections.set(tag, payload);
    }
    o += 8 + len;
  }
  if (o !== data.byteLength) throw new Error('trailing bytes after the last section');
  if (!edits) throw new Error('missing EDIT section');
  checkEdits(edits);
  return { ...base, edits, genVersion, sections };
}


/** Bytes that hold everything peekWorldHeader() reads (the format-2 header). */
export const WORLD_HEADER_BYTES = HEADER2_BYTES;

/**
 * savedAt and genVersion from the first bytes of a world file (format 1:
 * generator 1), or null when they are not a world header. Lets a store list
 * worlds without decoding their edits.
 */
export function peekWorldHeader(head: Uint8Array): { savedAt: number; genVersion: GenVersion } | null {
  if (head.byteLength < HEADER_BYTES || MAGIC.some((b, i) => head[i] !== b)) return null;
  const savedAt = new DataView(head.buffer, head.byteOffset, head.byteLength).getFloat64(15, true);
  if (!Number.isFinite(savedAt)) return null;
  const gen = head[4] === FORMAT_VERSION && head.byteLength >= HEADER2_BYTES ? head[23] : 1;
  return { savedAt, genVersion: isGenVersion(gen) ? gen : 1 };
}

// ---- META: the world library's details ------------------------------------------------

/**
 * META section (u8 version 1, then JSON as UTF-8): what the world library shows
 * and remembers about a world. The server never reads it; hosted worlds carry it
 * through unchanged, like any section it does not know.
 */
export interface WorldMeta {
  /** Shown in the library (1..WORLD_NAME_MAX characters). */
  name: string;
  /** ms since the epoch. */
  createdAt: number;
  lastPlayed: number;
  /** Total time played on this world, in ms. */
  playtimeMs: number;
  /** Room code the world was last hosted under; hosting again asks for the same one. */
  hostCode?: string;
  /** Last privacy chosen when hosting (true = Public). */
  hostPublic?: boolean;
  /** Where the owner stood when last playing (sandbox; survival keeps it in PLYR). */
  player?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /**
   * PLYR key (32 hex) of the world's owner record: when another device (with another
   * playerKey) opens the world, it takes over that record, so an exported world keeps
   * its inventory.
   */
  ownerKey?: string;
}

export const WORLD_META_VERSION = 1;
export const WORLD_NAME_MAX = 32;
const MAX_META_BYTES = 4096;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A world name as stored: control characters removed, spaces collapsed, at most WORLD_NAME_MAX characters ('' when nothing is left). */
export function cleanWorldName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, WORLD_NAME_MAX).join('').trim();
}

const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function encodeWorldMeta(meta: WorldMeta): Uint8Array {
  const json = utf8.encode(JSON.stringify(meta));
  const out = new Uint8Array(1 + json.byteLength);
  out[0] = WORLD_META_VERSION;
  out.set(json, 1);
  return out;
}

/** Tolerant: null when the section is missing, too big, of another version or not readable. */
export function decodeWorldMeta(bytes: Uint8Array | undefined): WorldMeta | null {
  if (!bytes || bytes.byteLength < 3 || bytes.byteLength > MAX_META_BYTES || bytes[0] !== WORLD_META_VERSION) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fromUtf8.decode(bytes.subarray(1)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const meta: WorldMeta = {
    name: cleanWorldName(raw.name),
    createdAt: finite(raw.createdAt, 0),
    lastPlayed: finite(raw.lastPlayed, 0),
    playtimeMs: Math.max(0, finite(raw.playtimeMs, 0)),
  };
  if (typeof raw.hostCode === 'string' && /^[A-Z0-9]{6}$/.test(raw.hostCode)) meta.hostCode = raw.hostCode;
  if (typeof raw.hostPublic === 'boolean') meta.hostPublic = raw.hostPublic;
  if (typeof raw.ownerKey === 'string' && /^[0-9a-f]{32}$/.test(raw.ownerKey)) meta.ownerKey = raw.ownerKey;
  const p = raw.player as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && [p.x, p.y, p.z, p.yaw, p.pitch].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    meta.player = { x: p.x as number, y: p.y as number, z: p.z as number, yaw: p.yaw as number, pitch: p.pitch as number };
  }
  return meta;
}

// ---- hosted worlds: upload in chunks ------------------------------------------------------

/** Most bytes in one upload chunk (the server's WebSocket accepts a little more per message). */
export const HOST_CHUNK_BYTES = 48 * 1024;
/** Largest world a host may upload (200,000 edits plus sections fit with room to spare). */
export const HOSTED_WORLD_MAX_BYTES = 4 * 1024 * 1024;

/** HostUpload chunk: u32 totalBytes, u32 offset, payload. */
export function encodeUploadChunk(total: number, offset: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, true);
  view.setUint32(4, offset, true);
  out.set(payload, 8);
  return out;
}

export function decodeUploadChunk(bytes: Uint8Array): { total: number; offset: number; payload: Uint8Array } | null {
  if (bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { total: view.getUint32(0, true), offset: view.getUint32(4, true), payload: bytes.subarray(8) };
}

/** Splits a world file into HostUpload messages. */
export function uploadChunks(file: Uint8Array, size = HOST_CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < file.byteLength; o += size) out.push(encodeUploadChunk(file.byteLength, o, file.subarray(o, o + size)));
  return out;
}
