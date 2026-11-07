/**
 * Teleporting in Voxelvale (sandbox and survival): saved places (waypoints)
 * and asking another player to teleport to them.
 *
 * TeleportCore holds the rules and runs on the server (one per room, players by
 * sessionId) and offline in the browser (one local player). It never touches
 * the world itself: the host gives it hooks (positions, health, blocks, a way
 * to move a player) and passes on the events it sends.
 *
 * Survival is fair: a 3 s countdown that a hit or a step away cancels, a 30 s
 * cooldown, and no teleporting while a boss is close. Sandbox is instant.
 *
 * Places persist per player in the WAYP world section, keyed like PLYR records
 * (hashed playerKey), so they travel in every save: offline world files, the
 * server's saved worlds and hosted worlds.
 */
import { BinaryReader, BinaryWriter } from '../util/binary';
import { IS_LIQUID, IS_SOLID } from './blocks';
import { CHUNK_HEIGHT } from './constants';

export const TELEPORT = {
  /** Saved places per player per world. */
  maxPlaces: 20,
  /** Characters in a place name. */
  nameMax: 20,
  /** Marker colours (PLACE_COLORS). */
  colors: 8,
  /** Survival countdown before the jump. */
  warmupMs: 3000,
  /** Survival wait between teleports. */
  cooldownMs: 30_000,
  /** An unanswered request expires after this. */
  requestTtlMs: 60_000,
  /** Wait before asking the same player again. */
  requestGapMs: 10_000,
  /** Moving this far (blocks) during the countdown cancels it. */
  cancelMove: 2,
  /** No survival teleport with a live boss this close (blocks, horizontal), at either end. */
  bossRadius: 48,
} as const;

/** Marker colours of saved places, by index (original palette). */
export const PLACE_COLORS = [0x5fd17a, 0xffd166, 0xff7a45, 0x4fa3ff, 0xc77dff, 0xff5d8f, 0x2fb3a6, 0xeef2ff] as const;

export interface Waypoint {
  name: string;
  x: number;
  y: number;
  z: number;
  /** Index into PLACE_COLORS. */
  color: number;
}

/** C→S (VoxelMsg.TeleportOp), and what the offline menu hands TeleportCore. */
export type TeleportOp =
  | { op: 'save'; name: string; color: number }
  | { op: 'rename'; index: number; name: string }
  | { op: 'recolor'; index: number; color: number }
  | { op: 'delete'; index: number }
  | { op: 'go'; index: number }
  | { op: 'ask'; to: string }
  | { op: 'answer'; from: string; accept: boolean }
  | { op: 'cancel' }
  | { op: 'autoDecline'; on: boolean };

/** S→C (VoxelMsg.TeleportEvent). */
export type TeleportEvent =
  /** Your saved places (after every change, and on joining). */
  | { kind: 'places'; list: Waypoint[]; autoDecline: boolean }
  /** Someone asks to teleport to you. */
  | { kind: 'request'; from: string; name: string; expiresInMs: number }
  /** A request to you is no longer open (expired, withdrawn, they left). */
  | { kind: 'requestGone'; from: string }
  /** Countdown started (survival). */
  | { kind: 'warmup'; ms: number; to: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'arrived'; to: string; cooldownMs: number }
  | { kind: 'notice'; text: string; error?: boolean };

export interface TeleportHooks {
  now(): number;
  /** Survival rules (countdown, cooldown, bosses); sandbox teleports at once. */
  survival(): boolean;
  pos(id: string): { x: number; y: number; z: number } | null;
  /** Current health, to cancel the countdown on a hit (null: unknown / sandbox). */
  health(id: string): number | null;
  name(id: string): string | null;
  /** A live boss within TELEPORT.bossRadius of the point. */
  bossNear(x: number, y: number, z: number): boolean;
  getBlock(x: number, y: number, z: number): number;
  /** Moves the player (server: Teleport message + movement grace). */
  move(id: string, x: number, y: number, z: number): void;
  send(id: string, e: TeleportEvent): void;
}

interface Warmup {
  until: number;
  from: { x: number; y: number; z: number };
  hp: number | null;
  label: string;
  dest: () => { x: number; y: number; z: number } | null;
}

interface TpPlayer {
  places: Waypoint[];
  autoDecline: boolean;
  cooldownUntil: number;
  warm: Warmup | null;
  /** Last time this player asked each target. */
  asked: Map<string, number>;
}

interface Request {
  from: string;
  to: string;
  expires: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A place name as kept: no control characters, collapsed spaces, at most TELEPORT.nameMax characters. */
export function cleanPlaceName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, TELEPORT.nameMax).join('').trim();
}

/** Shape check of a TeleportOp from the network; null when malformed. */
export function parseTeleportOp(raw: unknown): TeleportOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const idx = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < TELEPORT.maxPlaces;
  const color = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < TELEPORT.colors;
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64;
  switch (o.op) {
    case 'save':
      return typeof o.name === 'string' && color(o.color) ? { op: 'save', name: o.name, color: o.color as number } : null;
    case 'rename':
      return idx(o.index) && typeof o.name === 'string' ? { op: 'rename', index: o.index as number, name: o.name } : null;
    case 'recolor':
      return idx(o.index) && color(o.color) ? { op: 'recolor', index: o.index as number, color: o.color as number } : null;
    case 'delete':
    case 'go':
      return idx(o.index) ? { op: o.op, index: o.index as number } : null;
    case 'ask':
      return id(o.to) ? { op: 'ask', to: o.to as string } : null;
    case 'answer':
      return id(o.from) && typeof o.accept === 'boolean' ? { op: 'answer', from: o.from as string, accept: o.accept } : null;
    case 'cancel':
      return { op: 'cancel' };
    case 'autoDecline':
      return typeof o.on === 'boolean' ? { op: 'autoDecline', on: o.on } : null;
  }
  return null;
}

/**
 * A spot a player can stand on near (x, y, z): feet and head free (no solid
 * block, no liquid), solid ground below. Searches rings out to 3 blocks and a
 * few blocks up and down; `apart` skips the centre column (next to a player,
 * not inside them). Null when there is none.
 */
export function safeSpotNear(
  get: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  apart = false,
): { x: number; y: number; z: number } | null {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  const fy = Math.floor(y + 0.01);
  const free = (bx: number, by: number, bz: number) => {
    const b = get(bx, by, bz);
    return !IS_SOLID[b] && !IS_LIQUID[b];
  };
  for (let r = apart ? 1 : 0; r <= 3; r++) {
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4]) {
      const by = fy + dy;
      if (by < 1 || by >= CHUNK_HEIGHT - 2) continue;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const bx = cx + dx;
          const bz = cz + dz;
          if (free(bx, by, bz) && free(bx, by + 1, bz) && IS_SOLID[get(bx, by - 1, bz)]) return { x: bx + 0.5, y: by, z: bz + 0.5 };
        }
      }
    }
  }
  return null;
}

export class TeleportCore {
  private readonly players = new Map<string, TpPlayer>();
  private readonly requests = new Map<string, Request>();

  constructor(private readonly h: TeleportHooks) {}

  addPlayer(id: string, places: readonly Waypoint[] = [], autoDecline = false): void {
    this.players.set(id, { places: places.slice(0, TELEPORT.maxPlaces).map((p) => ({ ...p })), autoDecline, cooldownUntil: 0, warm: null, asked: new Map() });
    this.sendPlaces(id);
  }

  /** Forgets a player (their open requests go too); returns their places and setting to keep. */
  removePlayer(id: string): { places: Waypoint[]; autoDecline: boolean } | null {
    const p = this.players.get(id);
    if (!p) return null;
    for (const [k, r] of this.requests) {
      if (r.from !== id && r.to !== id) continue;
      this.requests.delete(k);
      if (r.from === id) this.h.send(r.to, { kind: 'requestGone', from: id });
      else this.h.send(r.from, { kind: 'notice', text: `${this.h.name(id) ?? 'That player'} left before answering.` });
    }
    this.players.delete(id);
    return { places: p.places, autoDecline: p.autoDecline };
  }

  places(id: string): readonly Waypoint[] {
    return this.players.get(id)?.places ?? [];
  }

  autoDecline(id: string): boolean {
    return this.players.get(id)?.autoDecline ?? false;
  }

  /** Requests to this player still open (for a menu opened later). */
  pendingFor(id: string): { from: string; name: string; expiresInMs: number }[] {
    const now = this.h.now();
    return [...this.requests.values()].filter((r) => r.to === id).map((r) => ({ from: r.from, name: this.h.name(r.from) ?? 'Someone', expiresInMs: r.expires - now }));
  }

  /** Remaining survival cooldown in ms (0: ready). */
  cooldownLeft(id: string): number {
    const p = this.players.get(id);
    return p && this.h.survival() ? Math.max(0, p.cooldownUntil - this.h.now()) : 0;
  }

  /** True while this player's countdown runs. */
  warming(id: string): boolean {
    return !!this.players.get(id)?.warm;
  }

  handle(id: string, op: TeleportOp): void {
    const p = this.players.get(id);
    if (!p) return;
    switch (op.op) {
      case 'save': {
        const at = this.h.pos(id);
        if (!at) return;
        if (p.places.length >= TELEPORT.maxPlaces) return this.notice(id, `You can keep ${TELEPORT.maxPlaces} places. Delete one first.`, true);
        const name = cleanPlaceName(op.name) || `Place ${p.places.length + 1}`;
        p.places.push({ name, x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100, z: Math.round(at.z * 100) / 100, color: op.color % TELEPORT.colors });
        this.sendPlaces(id);
        return this.notice(id, `Saved "${name}".`);
      }
      case 'rename': {
        const place = p.places[op.index];
        const name = cleanPlaceName(op.name);
        if (!place || !name) return;
        place.name = name;
        return this.sendPlaces(id);
      }
      case 'recolor': {
        const place = p.places[op.index];
        if (!place) return;
        place.color = op.color % TELEPORT.colors;
        return this.sendPlaces(id);
      }
      case 'delete':
        if (!p.places[op.index]) return;
        p.places.splice(op.index, 1);
        return this.sendPlaces(id);
      case 'go': {
        const place = p.places[op.index];
        if (!place) return;
        const dest = () => safeSpotNear(this.h.getBlock, place.x, place.y, place.z);
        return this.begin(id, p, place.name, dest, place);
      }
      case 'ask':
        return this.ask(id, p, op.to);
      case 'answer':
        return this.answer(id, op.from, op.accept);
      case 'cancel':
        if (p.warm) this.cancel(id, p, 'Teleport cancelled.');
        for (const [k, r] of this.requests) {
          if (r.from !== id) continue;
          this.requests.delete(k);
          this.h.send(r.to, { kind: 'requestGone', from: id });
        }
        return;
      case 'autoDecline':
        p.autoDecline = op.on;
        if (op.on) {
          for (const [k, r] of this.requests) {
            if (r.to !== id) continue;
            this.requests.delete(k);
            this.h.send(r.from, { kind: 'notice', text: `${this.h.name(id) ?? 'They'} declined.` });
          }
        }
        return this.sendPlaces(id);
    }
  }

  /** Countdowns and request expiry; call a few times a second or more. */
  tick(): void {
    const now = this.h.now();
    for (const [k, r] of this.requests) {
      if (now < r.expires) continue;
      this.requests.delete(k);
      this.h.send(r.to, { kind: 'requestGone', from: r.from });
      this.h.send(r.from, { kind: 'notice', text: `Your request to ${this.h.name(r.to) ?? 'them'} expired.` });
    }
    for (const [id, p] of this.players) {
      const w = p.warm;
      if (!w) continue;
      const at = this.h.pos(id);
      const hp = this.h.health(id);
      if (!at) {
        p.warm = null;
        continue;
      }
      if (Math.hypot(at.x - w.from.x, at.y - w.from.y, at.z - w.from.z) > TELEPORT.cancelMove) {
        this.cancel(id, p, 'Teleport cancelled: you moved.');
        continue;
      }
      if (w.hp !== null && hp !== null && hp < w.hp) {
        this.cancel(id, p, 'Teleport cancelled: you were hurt.');
        continue;
      }
      if (now >= w.until) {
        p.warm = null;
        this.jump(id, p, w.label, w.dest);
      }
    }
  }

  // ---- internals ----

  private ask(id: string, p: TpPlayer, to: string): void {
    const target = this.players.get(to);
    const name = this.h.name(to) ?? 'That player';
    if (!target || to === id) return this.notice(id, 'That player is not here.', true);
    if (target.autoDecline) return this.notice(id, `${name} is not taking teleport requests.`, true);
    const key = `${id}>${to}`;
    if (this.requests.has(key)) return this.notice(id, `You already asked ${name}. Wait for an answer.`, true);
    const now = this.h.now();
    const last = p.asked.get(to) ?? -Infinity;
    if (now - last < TELEPORT.requestGapMs) return this.notice(id, `Wait ${Math.ceil((TELEPORT.requestGapMs - (now - last)) / 1000)} s before asking ${name} again.`, true);
    const blocked = this.blocked(id, p);
    if (blocked) return this.notice(id, blocked, true);
    p.asked.set(to, now);
    this.requests.set(key, { from: id, to, expires: now + TELEPORT.requestTtlMs });
    this.h.send(to, { kind: 'request', from: id, name: this.h.name(id) ?? 'Someone', expiresInMs: TELEPORT.requestTtlMs });
    this.notice(id, `Asked ${name} to let you teleport to them.`);
  }

  private answer(id: string, from: string, accept: boolean): void {
    const key = `${from}>${id}`;
    const r = this.requests.get(key);
    if (!r) return;
    this.requests.delete(key);
    const asker = this.players.get(from);
    const me = this.h.name(id) ?? 'They';
    if (!asker) return;
    if (!accept) return this.notice(from, `${me} declined your teleport request.`);
    this.notice(id, `${this.h.name(from) ?? 'They'} is on the way.`);
    const dest = () => {
      const at = this.h.pos(id);
      return at ? safeSpotNear(this.h.getBlock, at.x, at.y, at.z, true) : null;
    };
    this.begin(from, asker, me, dest, null);
  }

  /** Why this player cannot start a teleport now, or null. */
  private blocked(id: string, p: TpPlayer, dest?: { x: number; y: number; z: number } | null): string | null {
    if (!this.h.survival()) return null;
    if (p.warm) return 'Already teleporting.';
    const left = p.cooldownUntil - this.h.now();
    if (left > 0) return `Teleport is recharging: ${Math.ceil(left / 1000)} s.`;
    const at = this.h.pos(id);
    if ((at && this.h.bossNear(at.x, at.y, at.z)) || (dest && this.h.bossNear(dest.x, dest.y, dest.z))) return 'Not during a boss fight.';
    return null;
  }

  private begin(id: string, p: TpPlayer, label: string, dest: Warmup['dest'], target: { x: number; y: number; z: number } | null): void {
    const why = this.blocked(id, p, target);
    if (why) return this.notice(id, why, true);
    if (!this.h.survival()) return this.jump(id, p, label, dest);
    const at = this.h.pos(id);
    if (!at) return;
    p.warm = { until: this.h.now() + TELEPORT.warmupMs, from: { ...at }, hp: this.h.health(id), label, dest };
    this.h.send(id, { kind: 'warmup', ms: TELEPORT.warmupMs, to: label });
  }

  private jump(id: string, p: TpPlayer, label: string, dest: Warmup['dest']): void {
    const spot = dest();
    if (!spot) return this.notice(id, `There is no safe spot at ${label} right now.`, true);
    if (this.h.survival() && this.h.bossNear(spot.x, spot.y, spot.z)) return this.notice(id, 'Not during a boss fight.', true);
    this.h.move(id, spot.x, spot.y, spot.z);
    const cooldown = this.h.survival() ? TELEPORT.cooldownMs : 0;
    p.cooldownUntil = this.h.now() + cooldown;
    this.h.send(id, { kind: 'arrived', to: label, cooldownMs: cooldown });
  }

  private cancel(id: string, p: TpPlayer, reason: string): void {
    p.warm = null;
    this.h.send(id, { kind: 'cancelled', reason });
  }

  private notice(id: string, text: string, error = false): void {
    this.h.send(id, error ? { kind: 'notice', text, error } : { kind: 'notice', text });
  }

  private sendPlaces(id: string): void {
    const p = this.players.get(id);
    if (p) this.h.send(id, { kind: 'places', list: p.places.map((w) => ({ ...w })), autoDecline: p.autoDecline });
  }
}

// ---- WAYP section ------------------------------------------------------------------------

/** One player's saved places in a world (key: 32 hex, as in PLYR). */
export interface WaypointRecord {
  key: string;
  autoDecline: boolean;
  places: Waypoint[];
}

const WAYP_VERSION = 1;
const MAX_WAYP_PLAYERS = 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** WAYP: u8 version 1, u16 n, n × (16-byte key, u8 flags (1 autoDecline), u8 count, count × (f32 x, y, z, u8 color, u8 len, UTF-8 name)). */
export function encodeWaypoints(list: readonly WaypointRecord[]): Uint8Array {
  const recs = list.filter((r) => /^[0-9a-f]{32}$/.test(r.key)).slice(0, MAX_WAYP_PLAYERS);
  const w = new BinaryWriter(256).u8(WAYP_VERSION).u16(recs.length);
  for (const r of recs) {
    for (let i = 0; i < 16; i++) w.u8(parseInt(r.key.slice(i * 2, i * 2 + 2), 16));
    const places = r.places.slice(0, TELEPORT.maxPlaces);
    w.u8(r.autoDecline ? 1 : 0).u8(places.length);
    for (const p of places) {
      const name = enc.encode(cleanPlaceName(p.name)).slice(0, 80);
      w.f32(p.x).f32(p.y).f32(p.z).u8(p.color % TELEPORT.colors).u8(name.byteLength);
      for (const b of name) w.u8(b);
    }
  }
  return w.bytes();
}

/** Throws on anything malformed (the caller then keeps the bytes unchanged). */
export function decodeWaypoints(bytes: Uint8Array): WaypointRecord[] {
  const r = new BinaryReader(bytes);
  if (r.u8() !== WAYP_VERSION) throw new Error('unknown WAYP version');
  const n = r.u16();
  if (n > MAX_WAYP_PLAYERS) throw new Error('too many WAYP records');
  const out: WaypointRecord[] = [];
  for (let i = 0; i < n; i++) {
    let key = '';
    for (let j = 0; j < 16; j++) key += r.u8().toString(16).padStart(2, '0');
    const flags = r.u8();
    const count = r.u8();
    if (count > TELEPORT.maxPlaces) throw new Error('too many places');
    const places: Waypoint[] = [];
    for (let j = 0; j < count; j++) {
      const x = r.f32(), y = r.f32(), z = r.f32(), color = r.u8(), len = r.u8();
      const raw = new Uint8Array(len);
      for (let k = 0; k < len; k++) raw[k] = r.u8();
      if (![x, y, z].every(finite)) throw new Error('bad place position');
      places.push({ name: cleanPlaceName(dec.decode(raw)) || `Place ${j + 1}`, x, y, z, color: color % TELEPORT.colors });
    }
    out.push({ key, autoDecline: (flags & 1) !== 0, places });
  }
  if (r.remaining !== 0) throw new Error('trailing bytes');
  return out;
}
