/**
 * World file <-> offline game. A library world is a CVW file (shared
 * worldFile.ts), the same bytes the server saves and hosted worlds travel in.
 * Offline survival and creatures keep their in-game JSON forms
 * (LocalSurvivalSave, the `mobs` JSON), so this module converts:
 *
 *   PLYR  the owner's record (inventory, vitals, spawn, position) <-> survival.inv / vitals / spawn
 *   CHST  chests                                                  <-> survival.chests
 *   SATC  Lost Satchels                                           <-> survival.satchels
 *   SURV  rules and day                                           <-> survival.rules / day
 *   MOBS  tamed creatures                                         <-> mobs JSON
 *   WAYP  saved teleport places                                   <-> places
 *   META  name, dates, play time, host code, sandbox position     (library only)
 *
 * Records of other players (from hosting) and sections this build does not
 * know are kept unchanged. The owner's records follow the device: opening a
 * world whose owner record has another key (exported from another app) takes
 * that record over, so moving a world between apps keeps its inventory.
 */
import {
  type BlockEdit,
  decodeChests,
  decodeEdits,
  decodeMobsSection,
  decodePlayers,
  decodeSatchels,
  decodeSurv,
  decodeWaypoints,
  decodeWorldMeta,
  encodeChests,
  encodeEdits,
  encodeMobsSection,
  encodePlayers,
  encodeSatchels,
  encodeSurv,
  encodeWaypoints,
  encodeWorldMeta,
  type GenVersion,
  isGenVersion,
  mobsFromJson,
  mobsToJson,
  packPos,
  PLAYER_SLOTS,
  RuleFlags,
  type SavedWorld,
  SECTION_TAGS,
  type SurvivalPlayerRecord,
  unpackPos,
  type VoxelMode,
  type Waypoint,
  type WaypointRecord,
  type WorldMeta,
} from '@hub/shared';
import type { LocalSurvivalSave } from '../survival/LocalSurvival';

/** Most edits kept in a world (the server's limit too). */
export const MAX_WORLD_EDITS = 200_000;

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** What VoxelGame needs to start an offline world. */
export interface OfflineWorld {
  seed: number;
  mode: VoxelMode;
  genVersion: GenVersion;
  edits: [number, number, number, number][];
  player: Pose | null;
  time: number;
  survival?: LocalSurvivalSave;
  mobs?: unknown;
  places: Waypoint[];
  autoDecline: boolean;
}

/** What the running game hands back for a save. */
export interface CapturedWorld {
  seed: number;
  mode: VoxelMode;
  genVersion: GenVersion;
  edits: Iterable<[number, number, number, number]>;
  player: Pose;
  time: number;
  /** LocalSurvivalSave (survival), undefined in sandbox. */
  survival?: unknown;
  /** mobs JSON (undefined: no tamed creatures), or null when the world has no creature sim (keeps the section). */
  mobs: unknown | null;
  places?: readonly Waypoint[];
  autoDecline?: boolean;
}

const tryDecode = <T>(bytes: Uint8Array | undefined, fn: (b: Uint8Array) => T): T | null => {
  if (!bytes) return null;
  try {
    return fn(bytes);
  } catch {
    return null;
  }
};

/** META of a world, or one made up from its header. */
export function worldMeta(world: SavedWorld): WorldMeta {
  const meta = decodeWorldMeta(world.sections?.get(SECTION_TAGS.meta));
  if (meta) return { ...meta, name: meta.name || 'Imported World' };
  return { name: 'Imported World', createdAt: world.savedAt, lastPlayed: world.savedAt, playtimeMs: 0 };
}

/** Survival rules (RuleFlags) of a world: SURV, or none. */
export function worldRules(world: Pick<SavedWorld, 'sections'>): number {
  return tryDecode(world.sections?.get(SECTION_TAGS.survival), decodeSurv)?.rules ?? 0;
}

/** Day counter of a survival world (1 when it has none). */
export function worldDay(world: SavedWorld): number {
  return tryDecode(world.sections?.get(SECTION_TAGS.survival), decodeSurv)?.day ?? 1;
}

/** The owner's record: this device's key first, then the one META names. */
function ownerRecord<T extends { key: string }>(list: readonly T[] | null, myKey: string, meta: WorldMeta): T | undefined {
  return list?.find((r) => r.key === myKey) ?? (meta.ownerKey ? list?.find((r) => r.key === meta.ownerKey) : undefined);
}

export function openWorld(world: SavedWorld, myKey: string): { world: OfflineWorld; meta: WorldMeta } {
  const meta = worldMeta(world);
  const s = world.sections ?? new Map<string, Uint8Array>();
  const edits = decodeEdits(world.edits, true).map((e) => [e.x, e.y, e.z, e.id] as [number, number, number, number]);
  const genVersion = isGenVersion(world.genVersion) ? world.genVersion : 1;
  let player: Pose | null = meta.player ?? null;
  let survival: LocalSurvivalSave | undefined;
  if (world.mode === 'survival') {
    const rec = ownerRecord(tryDecode(s.get(SECTION_TAGS.players), decodePlayers), myKey, meta);
    const surv = tryDecode(s.get(SECTION_TAGS.survival), decodeSurv);
    const chests = tryDecode(s.get(SECTION_TAGS.chests), decodeChests) ?? [];
    const satchels = tryDecode(s.get(SECTION_TAGS.satchels), decodeSatchels) ?? [];
    const inv: LocalSurvivalSave['inv'] = [];
    for (let i = 0; i < PLAYER_SLOTS; i++) inv.push(0);
    for (const [slot, item, count, meta2] of rec?.saved.slots ?? []) if (slot < PLAYER_SLOTS) inv[slot] = [item, count, meta2];
    const r = rec?.saved;
    if (r && !r.dead) player = { x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch };
    survival = {
      v: 1,
      day: surv?.day ?? 1,
      rules: { keepInventory: ((surv?.rules ?? 0) & RuleFlags.KeepInventory) !== 0 },
      vitals: { hp: r?.health ?? 20, food: r?.food ?? 20, air: 10, dead: r?.dead ?? false },
      spawn: r?.spawn ? [r.spawn.x, r.spawn.y, r.spawn.z] : null,
      inv,
      chests: chests.map((c) => [packPos(c.x, c.y, c.z), c.flags, c.slots]),
      satchels: satchels.map((x) => [x.x, x.y, x.z, x.items.map((i) => [i.item, i.count, i.meta] as [number, number, number])]),
    };
  }
  const mobs = tryDecode(s.get(SECTION_TAGS.mobs), decodeMobsSection);
  const wp = ownerRecord(tryDecode(s.get(SECTION_TAGS.waypoints), decodeWaypoints), myKey, meta);
  return {
    meta,
    world: {
      seed: world.seed,
      mode: world.mode,
      genVersion,
      edits,
      player,
      time: world.timeOfDay,
      survival,
      mobs: mobs && mobs.length ? mobsToJson(mobs) : undefined,
      places: wp?.places ?? [],
      autoDecline: wp?.autoDecline ?? false,
    },
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A world file from the running game (or a migrated save): `base` gives the
 * sections to keep (other players' records, unknown tags). The owner's records
 * are written under myKey; META gets ownerKey = myKey and the pose.
 */
export function captureWorld(base: SavedWorld | null, game: CapturedWorld, myKey: string, meta: WorldMeta, savedAt = Date.now()): SavedWorld {
  const sections = new Map(base?.sections ?? []);
  const oldOwner = meta.ownerKey;
  const isOwner = (k: string) => k === myKey || (!!oldOwner && k === oldOwner);
  const edits: BlockEdit[] = [];
  for (const [x, y, z, id] of game.edits) {
    if (edits.length >= MAX_WORLD_EDITS) break;
    edits.push({ x, y, z, id });
  }
  const T = SECTION_TAGS;
  const s = game.mode === 'survival' ? (game.survival as LocalSurvivalSave | undefined) : undefined;
  if (s && s.v === 1) {
    const players = sections.has(T.players) ? tryDecode(sections.get(T.players), decodePlayers) : [];
    if (players) {
      const slots: [number, number, number, number][] = [];
      (Array.isArray(s.inv) ? s.inv : []).forEach((e, slot) => {
        if (Array.isArray(e) && e[1] > 0 && slot < PLAYER_SLOTS) slots.push([slot, e[0], e[1], e[2] ?? 0]);
      });
      const mine: SurvivalPlayerRecord = {
        key: myKey,
        lastSeen: savedAt,
        saved: {
          x: game.player.x, y: game.player.y, z: game.player.z, yaw: game.player.yaw, pitch: game.player.pitch,
          health: num(s.vitals?.hp, 20), food: num(s.vitals?.food, 20), dead: !!s.vitals?.dead,
          spawn: Array.isArray(s.spawn) ? { x: s.spawn[0], y: s.spawn[1], z: s.spawn[2] } : null,
          slots,
        },
      };
      sections.set(T.players, encodePlayers([mine, ...players.filter((r) => !isOwner(r.key))]));
    }
    sections.set(T.chests, encodeChests((s.chests ?? []).map(([key, flags, slots]) => {
      const [x, y, z] = unpackPos(key);
      return { x, y, z, flags, slots };
    })));
    sections.set(T.satchels, encodeSatchels((s.satchels ?? []).map(([x, y, z, items]) => ({ owner: myKey, x, y, z, createdMs: savedAt, items: items.map(([item, count, m]) => ({ item, count, meta: m })) }))));
    const pvp = worldRules({ sections }) & RuleFlags.PvP;
    sections.set(T.survival, encodeSurv(pvp | (s.rules?.keepInventory ? RuleFlags.KeepInventory : 0), Math.max(1, Math.min(65535, num(s.day, 1)))));
  }
  if (game.mobs !== null) {
    const list = mobsFromJson(game.mobs);
    if (list.length || sections.has(T.mobs)) sections.set(T.mobs, encodeMobsSection(list));
  }
  if (game.places) {
    const recs = sections.has(T.waypoints) ? tryDecode(sections.get(T.waypoints), decodeWaypoints) : [];
    if (recs) {
      const mine: WaypointRecord = { key: myKey, autoDecline: !!game.autoDecline, places: [...game.places] };
      const others = recs.filter((r) => !isOwner(r.key));
      if (mine.places.length || mine.autoDecline || others.length || sections.has(T.waypoints)) sections.set(T.waypoints, encodeWaypoints([mine, ...others]));
    }
  }
  const p = game.player;
  sections.set(T.meta, encodeWorldMeta({ ...meta, ownerKey: myKey, player: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch } }));
  return {
    id: base?.id ?? 'local',
    seed: game.seed >>> 0,
    mode: game.mode,
    private: base?.private ?? true,
    timeOfDay: ((num(game.time, 0.3) % 1) + 1) % 1,
    savedAt,
    edits: encodeEdits(edits, true),
    genVersion: game.genVersion,
    sections,
  };
}

/** Replaces META in a world (rename, play time, host code). */
export function withMeta(world: SavedWorld, meta: WorldMeta): SavedWorld {
  const sections = new Map(world.sections ?? []);
  sections.set(SECTION_TAGS.meta, encodeWorldMeta(meta));
  return { ...world, sections };
}
