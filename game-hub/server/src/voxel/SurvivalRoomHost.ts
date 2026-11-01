/**
 * Players' survival side on the server (WP-B): runs the shared SurvivalSim
 * (creative in sandbox), decodes the survival messages (hd k s g i x r rules),
 * flushes events once per tick (S, filtered per client) and each player's
 * private state (I, vt, C, dead), keeps the schema fields (eid, hp, held,
 * offhand, act, swing, rules, day) and persists PLYR / CHST / SATC / SURV.
 * It is also the creature sim's PlayerHooks (entities.setPlayerHooks).
 */
import type { Client } from '@colyseus/core';
import {
  type BlockEdit,
  type ChatMessage,
  type ClientEvent,
  DAWN_TIME,
  decodeAttack,
  decodeCell,
  decodeHand,
  decodeInteract,
  decodeInvOp,
  decodeShoot,
  encodeContainer,
  encodeInvSync,
  encodeRecord,
  encodeVitals,
  type DeadMessage,
  itemFromKey,
  type JoinOptions,
  MoveFlags,
  type MoveUpdate,
  mulberry32,
  OFFHAND,
  packRecords,
  RefType,
  RuleFlags,
  rulesToFlags,
  SURVIVAL,
  type SurvivalEvent,
  SurvivalSim,
  TokenBucket,
  VoxelMsg,
} from '@hub/shared';
import { config } from '../config';
import type { ServerEntities } from './ServerEntities';
import { SECTION_TAGS } from './WorldStore';
import type { VoxelRoomApi, VoxelSubsystem } from './subsystem';
import {
  decodeChests,
  decodePlayers,
  decodeSatchels,
  decodeSurv,
  encodeChests,
  encodePlayers,
  encodeSatchels,
  encodeSurv,
  type PlayerRecord,
} from './survivalSections';

const MAX_RECORDS = 64;
const MAX_EID = 999;

/** Per-message rate limits (burst, per second). */
const LIMITS: Record<string, [number, number]> = {
  [VoxelMsg.Hand]: [30, 15],
  [VoxelMsg.Attack]: [12, 8],
  [VoxelMsg.Shoot]: [6, 3],
  [VoxelMsg.DigStart]: [30, 15],
  [VoxelMsg.InvOp]: [40, 20],
  [VoxelMsg.Interact]: [10, 4],
  [VoxelMsg.Respawn]: [2, 0.5],
  [VoxelMsg.Rules]: [4, 0.5],
};

interface Encoded {
  bytes: Uint8Array;
  /** Bytes for the satchel owner (Yours flag), if different. */
  ownerBytes?: Uint8Array;
  owner?: string;
  /** Always sent (drops, deaths); else within interestRadius of x/z. */
  always: boolean;
  x: number;
  z: number;
  /** Damage: target and source eids always get it. */
  eids?: [number, number];
  except?: string;
}

export class SurvivalRoomHost implements VoxelSubsystem {
  readonly sim: SurvivalSim;
  private readonly creative: boolean;
  private readonly eids = new Map<string, number>();
  private readonly keys = new Map<string, string | null>();
  private readonly buckets = new Map<string, Map<string, TokenBucket>>();
  private readonly records = new Map<string, PlayerRecord>();
  /** Sections this server could not decode: their bytes stay as restored. */
  private readonly broken = new Set<string>();
  private readonly sentDead = new Set<string>();
  private readonly rng: () => number;
  private dirtyPending = false;

  constructor(
    protected readonly room: VoxelRoomApi,
    protected readonly entities: ServerEntities,
    /** SHA-256 prefix (32 hex chars) of a joiner's playerKey, or null. */
    protected readonly keyHash: (options: JoinOptions) => string | null,
    protected readonly saved: ReadonlyMap<string, Uint8Array> | null,
  ) {
    this.creative = room.mode !== 'survival';
    this.rng = mulberry32((room.state.seed ^ 0x5eed5eed) >>> 0);
    this.sim = new SurvivalSim(
      {
        // Survival reads only near players, so it may generate the chunk it needs; the creature
        // sim's reader() never generates and reads a missing chunk as Bedrock (walls in LOS, false ground).
        getBlock: () => (x, y, z) => room.world.getBlock(x, y, z),
        generator: room.world.generator,
        now: () => Date.now(),
        random: () => this.rng(),
        timeOfDay: () => room.state.timeOfDay,
        skipNight: () => {
          room.state.timeOfDay = DAWN_TIME;
          room.state.day = Math.min(65535, room.state.day + 1);
          room.systemChat(`The night passes. Day ${room.state.day}.`);
        },
        teleport: (id, x, y, z) => {
          room.teleport(id, x, y, z);
          const p = room.state.players.get(id);
          if (p) {
            p.x = x;
            p.y = y;
            p.z = z;
          }
        },
        announce: (text) => room.systemChat(text),
        entities: () => this.entities.api,
        dirty: () => {
          this.dirtyPending = true;
        },
      },
      { pvp: false, keepInventory: false, creative: this.creative },
      { satchelsExpire: true },
    );
  }

  /** Registers the survival message handlers and plugs into the creature sim. */
  bind(): void {
    this.entities.setPlayerHooks(this.sim);
    const on = (type: string, fn: (id: string, b: Uint8Array) => void) =>
      this.room.onBytes(type, (client, bytes) => {
        if (!this.allow(client.sessionId, type)) return;
        try {
          fn(client.sessionId, bytes);
        } catch {
          /* malformed message */
        }
      });
    on(VoxelMsg.Hand, (id, b) => {
      const h = decodeHand(b);
      this.sim.setHand(id, h.slot, h.flags, h.creativeItem);
    });
    on(VoxelMsg.Attack, (id, b) => this.sim.attack(id, decodeAttack(b)));
    on(VoxelMsg.Shoot, (id, b) => this.sim.shoot(id, decodeShoot(b)));
    on(VoxelMsg.DigStart, (id, b) => {
      const c = decodeCell(b);
      this.sim.digStart(id, c.x, c.y, c.z);
    });
    on(VoxelMsg.InvOp, (id, b) => {
      const m = decodeInvOp(b);
      if (m) this.sim.invOp(id, m.seq, m.op);
    });
    on(VoxelMsg.Interact, (id, b) => {
      const m = decodeInteract(b);
      this.sim.interact(id, m.kind, m.x, m.y, m.z);
    });
    on(VoxelMsg.Respawn, (id) => this.sim.respawn(id));
    this.room.onJson(VoxelMsg.Rules, (client, data) => {
      if (!this.allow(client.sessionId, VoxelMsg.Rules)) return;
      this.setRules(client.sessionId, data);
    });
    if (process.env.NODE_ENV === 'test') {
      // Test-only cheats (server/test/survival.test.ts).
      this.room.onJson('dbg', (client, data) => {
        const d = data as { give?: [string, number]; damage?: number; time?: number };
        const p = this.sim.players.get(client.sessionId);
        if (!p) return;
        if (d.give) {
          const item = itemFromKey(d.give[0]);
          if (item !== null) p.inv.add(item, d.give[1]);
        }
        if (typeof d.damage === 'number') this.sim.debugDamage(client.sessionId, d.damage);
        if (typeof d.time === 'number') this.room.state.timeOfDay = d.time;
      });
    }
  }

  private allow(id: string, type: string): boolean {
    let m = this.buckets.get(id);
    if (!m) this.buckets.set(id, (m = new Map()));
    let b = m.get(type);
    if (!b) {
      const [burst, rate] = LIMITS[type] ?? [10, 5];
      m.set(type, (b = new TokenBucket(burst, rate)));
    }
    return b.take();
  }

  private setRules(sessionId: string, data: unknown): void {
    const st = this.room.state;
    if (this.room.mode !== 'survival' || !this.room.isPrivate || st.hostId !== sessionId || typeof data !== 'object' || !data) return;
    const d = data as { pvp?: unknown; keepInventory?: unknown };
    const before = { ...this.sim.rules };
    if (typeof d.pvp === 'boolean') this.sim.setRules({ pvp: d.pvp });
    if (typeof d.keepInventory === 'boolean') this.sim.setRules({ keepInventory: d.keepInventory });
    st.rules = rulesToFlags(this.sim.rules);
    if (before.pvp !== this.sim.rules.pvp) this.room.systemChat(`PvP is now ${this.sim.rules.pvp ? 'on' : 'off'}`);
    if (before.keepInventory !== this.sim.rules.keepInventory) this.room.systemChat(`Items are now ${this.sim.rules.keepInventory ? 'kept' : 'dropped'} on death`);
    this.room.markDirty();
  }

  // ---- players ----

  /** A returning survival player starts where they left (dead records at the world spawn). */
  spawnFor(options: JoinOptions): { x: number; y: number; z: number } | null {
    if (this.creative) return null;
    const key = this.keyHash(options);
    const rec = key ? this.records.get(key) : undefined;
    if (!rec || rec.saved.dead || [...this.keys.values()].includes(key)) return null;
    return { x: rec.saved.x, y: rec.saved.y, z: rec.saved.z };
  }

  join(client: Client, player: { eid: number; name: string; x: number; y: number; z: number }, options: JoinOptions): void {
    const id = client.sessionId;
    let eid = 1;
    const used = new Set(this.eids.values());
    while (used.has(eid) && eid < MAX_EID) eid++;
    let key = this.creative ? null : this.keyHash(options);
    // A second session with the same key gets a fresh, unsaved identity.
    if (key && [...this.keys.values()].includes(key)) key = null;
    this.eids.set(id, eid);
    this.keys.set(id, key);
    const rec = key ? this.records.get(key) : undefined;
    const p = this.sim.addPlayer(id, eid, player.name, key, rec?.saved ?? null, { x: player.x, y: player.y, z: player.z });
    if (rec?.saved.dead) {
      // Died last time: back at the spawn (their satchel waits where they fell).
      p.health = SURVIVAL.maxHealth;
    }
    player.eid = eid;
    this.sendSnapshot(client);
  }

  reconnect(client: Client): void {
    const p = this.sim.players.get(client.sessionId);
    if (p) p.needFullSync = true;
    this.sentDead.delete(client.sessionId);
    this.sendSnapshot(client);
  }

  leave(sessionId: string): void {
    const key = this.keys.get(sessionId) ?? null;
    const saved = this.sim.removePlayer(sessionId);
    if (key && saved) {
      this.records.set(key, { key, saved, lastSeen: Date.now() });
      this.room.markDirty();
    }
    this.eids.delete(sessionId);
    this.keys.delete(sessionId);
    this.buckets.delete(sessionId);
    this.sentDead.delete(sessionId);
  }

  /** Every drop (and satchel) for a joiner, then their full inventory and vitals. */
  private sendSnapshot(client: Client): void {
    const p = this.sim.players.get(client.sessionId);
    const recs: Uint8Array[] = [];
    for (const d of this.sim.drops.list.values()) recs.push(encodeRecord(this.clientDrop(d, p?.owner ?? null)));
    for (let i = 0; i < recs.length; i += 255) client.sendBytes(VoxelMsg.SurvivalEvents, packRecords(recs.slice(i, i + 255)));
    if (p && !this.creative) {
      p.needFullSync = true;
      const v = p.takeVitals(Date.now(), true);
      if (v) client.sendBytes(VoxelMsg.Vitals, encodeVitals(v));
    }
  }

  private clientDrop(d: { id: number; item: number; count: number; meta: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; satchel?: { owner: string } }, owner: string | null): ClientEvent {
    return { type: 'dropSpawn', id: d.id, item: d.item, count: d.count, meta: d.meta, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, satchel: !!d.satchel, yours: !!d.satchel && d.satchel.owner === owner };
  }

  // ---- edits and movement ----

  validateEdit(sessionId: string, e: BlockEdit, current: number): string | null {
    return e.id === 0 ? this.sim.validateBreak(sessionId, e.x, e.y, e.z, current) : this.sim.validatePlace(sessionId, e.id, current);
  }

  afterEdit(sessionId: string | null, e: BlockEdit, before: number): void {
    this.sim.onEdit(sessionId, e.x, e.y, e.z, before, e.id);
  }

  /**
   * Cascaded cells already reached afterEdit(null, …) through applyServerEdit
   * (hand-harvest drops there), so nothing more to do here.
   */
  blocksRemoved(_cells: readonly BlockEdit[], _before: readonly number[]): void {}

  move(sessionId: string, m: MoveUpdate, accepted: boolean): void {
    if (!accepted) {
      this.sim.resetFall(sessionId);
      return;
    }
    this.sim.setPose(sessionId, m.x, m.y, m.z, m.yaw, m.pitch, (m.flags & MoveFlags.Crouch) !== 0, (m.flags & MoveFlags.Sprint) !== 0);
  }

  moveAllowance(sessionId: string, now: number): number {
    const p = this.sim.players.get(sessionId);
    return p && now < p.knockUntil ? SURVIVAL.knockGraceSpeed : 0;
  }

  preTick(): void {
    this.sim.preTick();
  }

  tick(dtMs: number): void {
    this.sim.tick(dtMs / 1000);
    this.syncSchema();
    this.flush();
    if (this.dirtyPending) {
      this.dirtyPending = false;
      this.room.markDirty();
    }
  }

  private syncSchema(): void {
    const now = Date.now();
    const st = this.room.state;
    for (const p of this.sim.players.values()) {
      const s = st.players.get(p.id);
      if (!s) continue;
      const hp = this.creative ? 20 : Math.max(0, Math.ceil(p.health));
      if (s.hp !== hp) s.hp = hp;
      const held = p.heldItem();
      if (s.held !== held) s.held = held;
      const off = this.creative ? 0 : p.inv.counts[OFFHAND] ? p.inv.items[OFFHAND] : 0;
      if (s.offhand !== off) s.offhand = off;
      const act = p.actFlags(now);
      if (s.act !== act) s.act = act;
      if (s.swing !== p.swingSeq) s.swing = p.swingSeq;
      if (s.eid !== p.eid) s.eid = p.eid;
    }
    const rules = rulesToFlags(this.sim.rules);
    if (st.rules !== rules) st.rules = rules;
  }

  /** Sends this tick's events (filtered per client) and every player's private state. */
  private flush(): void {
    const events = this.sim.takeEvents();
    const encoded: Encoded[] = [];
    for (const e of events) encoded.push(this.encode(e));
    const radius2 = SURVIVAL.interestRadius * SURVIVAL.interestRadius;
    this.room.forEachClient((client) => {
      const id = client.sessionId;
      const p = this.sim.players.get(id);
      if (!p) return;
      if (encoded.length) {
        const recs: Uint8Array[] = [];
        for (const e of encoded) {
          if (e.except === id) continue;
          const mine = e.eids && (e.eids[0] === p.eid || e.eids[1] === p.eid);
          if (!e.always && !mine && (e.x - p.x) ** 2 + (e.z - p.z) ** 2 > radius2) continue;
          recs.push(e.ownerBytes && e.owner === p.owner ? e.ownerBytes : e.bytes);
        }
        for (let i = 0; i < recs.length; i += 255) client.sendBytes(VoxelMsg.SurvivalEvents, packRecords(recs.slice(i, i + 255)));
      }
      if (this.creative) return;
      const sync = p.takeInvSync(this.sim.openContainer(p));
      if (sync) client.sendBytes(VoxelMsg.InvSync, encodeInvSync(sync));
      const v = p.takeVitals(Date.now());
      if (v) client.sendBytes(VoxelMsg.Vitals, encodeVitals(v));
      for (const c of p.containerEvents.splice(0)) client.sendBytes(VoxelMsg.Container, encodeContainer(c.open, c.x, c.y, c.z, c.sealed));
      for (const text of p.notices.splice(0)) client.send(VoxelMsg.Chat, { id: '', name: '', color: 0, text, system: true } satisfies ChatMessage);
      if (p.dead && !this.sentDead.has(id)) {
        this.sentDead.add(id);
        client.send(VoxelMsg.Dead, p.dead satisfies DeadMessage);
      } else if (!p.dead) this.sentDead.delete(id);
    });
  }

  private encode(e: SurvivalEvent): Encoded {
    switch (e.type) {
      case 'dropSpawn': {
        const d = e.drop;
        const bytes = encodeRecord(this.clientDrop(d, null));
        return d.satchel ? { bytes, ownerBytes: encodeRecord(this.clientDrop(d, d.satchel.owner)), owner: d.satchel.owner, always: true, x: d.x, z: d.z } : { bytes, always: true, x: d.x, z: d.z };
      }
      case 'dropMove':
        return { bytes: encodeRecord(e), always: true, x: e.x, z: e.z };
      case 'dropRemove':
        return { bytes: encodeRecord({ type: 'dropRemove', id: e.id, picker: e.picker ? (this.eids.get(e.picker) ?? 0) : 0 }), always: true, x: 0, z: 0 };
      case 'damage':
        return { bytes: encodeRecord(e), always: false, x: e.x, z: e.z, eids: [e.target.refType === RefType.Player ? e.target.id : -1, e.source.refType === RefType.Player ? e.source.id : -1] };
      case 'sound':
        return { bytes: encodeRecord({ type: 'sound', sfx: e.sfx, x: e.x, y: e.y, z: e.z }), always: false, x: e.x, z: e.z, except: e.except };
      case 'death':
        return { bytes: encodeRecord(e), always: true, x: e.x, z: e.z };
    }
  }

  // ---- persistence (survival rooms only) ----

  saveSections(out: Map<string, Uint8Array>): void {
    if (this.creative) return;
    const now = Date.now();
    const ttl = config.worldTtlDays * 86_400_000;
    const recs = new Map(this.records);
    for (const [id, p] of this.sim.players) {
      const key = this.keys.get(id);
      if (key) recs.set(key, { key, saved: this.sim.savePlayer(p), lastSeen: now });
    }
    const list = [...recs.values()].filter((r) => now - r.lastSeen < ttl).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_RECORDS);
    const put = (tag: string, bytes: () => Uint8Array) => {
      if (!this.broken.has(tag)) out.set(tag, bytes());
    };
    put(SECTION_TAGS.players, () => encodePlayers(list));
    put(SECTION_TAGS.chests, () => encodeChests(this.sim.saveChests()));
    put(SECTION_TAGS.satchels, () => encodeSatchels(this.sim.saveSatchels()));
    put(SECTION_TAGS.survival, () => encodeSurv(rulesToFlags(this.sim.rules), this.room.state.day));
  }

  restoreSections(sections: ReadonlyMap<string, Uint8Array>): void {
    if (this.creative) return;
    const T = SECTION_TAGS;
    const load = (tag: string, fn: (b: Uint8Array) => void) => {
      const b = sections.get(tag);
      if (!b) return;
      try {
        fn(b);
      } catch (err) {
        // Keep the bytes (the room writes restored sections back) and never overwrite them.
        this.broken.add(tag);
        this.room.log.warn(`could not read survival section ${tag}; keeping it unchanged`, err);
      }
    };
    load(T.players, (b) => {
      for (const r of decodePlayers(b)) this.records.set(r.key, r);
    });
    load(T.chests, (b) => this.sim.loadChests(decodeChests(b)));
    load(T.satchels, (b) => this.sim.loadSatchels(decodeSatchels(b)));
    load(T.survival, (b) => {
      const s = decodeSurv(b);
      this.sim.setRules({ pvp: (s.rules & RuleFlags.PvP) !== 0, keepInventory: (s.rules & RuleFlags.KeepInventory) !== 0 });
      this.room.state.rules = s.rules;
      this.room.state.day = s.day;
    });
  }

  hasProgress(): boolean {
    if (this.creative) return false;
    if (this.records.size > 0 || this.sim.hasProgress()) return true;
    for (const p of this.sim.players.values()) if (p.key && !p.inv.isEmpty()) return true;
    return false;
  }

  dispose(): void {
    this.entities.setPlayerHooks(null);
  }
}
