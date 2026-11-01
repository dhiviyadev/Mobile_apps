/**
 * Offline survival: the shared SurvivalSim running in the browser (like
 * Arena's LocalBackend), stepped at a fixed 20 Hz. The local player is
 * 'local' / eid 1. It is also the offline creature sim's PlayerHooks.
 */
import {
  type AttackIntent,
  type ClientEvent,
  DAWN_TIME,
  type InteractKind,
  type InvOp,
  itemDef,
  overlapsClimbable,
  packPos,
  type PlayerBody,
  type SavedChest,
  type SavedSatchel,
  type SavedSurvivalPlayer,
  type ShootIntent,
  type SurvivalEvent,
  SurvivalSim,
  unpackPos,
} from '@hub/shared';
import { settings } from '../../../core/settings';
import type { VoxelGame } from '../VoxelGame';
import type { PrivateEvent, SurvivalBackend } from './SurvivalBackend';

const STEP = 0.05;
const ID = 'local';

/** Offline survival save (index.ts OfflineSave.survival). */
export interface LocalSurvivalSave {
  v: 1;
  day: number;
  rules: { keepInventory: boolean };
  vitals: { hp: number; food: number; air: number; dead: boolean };
  spawn: [number, number, number] | null;
  inv: ([number, number, number] | 0)[];
  /** packPos, flags, [slot, item, count, meta][] */
  chests: [number, number, [number, number, number, number][]][];
  /** x, y, z, [item, count, meta][] */
  satchels: [number, number, number, [number, number, number][]][];
}

function parseSave(raw: unknown): LocalSurvivalSave | null {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return null;
  return raw as LocalSurvivalSave;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class LocalSurvival implements SurvivalBackend {
  readonly sim: SurvivalSim;
  readonly online = false;
  private clock = 1_000_000;
  private acc = 0;
  private dayCount = 1;
  private lastTime: number;
  private readonly events: ClientEvent[] = [];
  private readonly priv: PrivateEvent[] = [];

  constructor(
    private readonly game: VoxelGame,
    readonly creative: boolean,
    saved: unknown,
  ) {
    this.sim = new SurvivalSim(
      {
        getBlock: () => game.world.getBlock,
        generator: game.generator,
        now: () => this.clock,
        random: Math.random,
        timeOfDay: () => game.sky.time,
        skipNight: () => {
          game.sky.time = DAWN_TIME;
          this.lastTime = DAWN_TIME;
          this.dayCount++;
          this.priv.push({ type: 'notice', text: `The night passes. Day ${this.dayCount}.` });
        },
        teleport: (_id, x, y, z) => game.player.teleport(x, y, z),
        announce: (text) => this.priv.push({ type: 'notice', text }),
        entities: () => game.localEntities?.api ?? null,
      },
      { pvp: false, keepInventory: false, creative },
      // Offline satchels never expire.
      { satchelsExpire: false },
    );
    this.lastTime = game.sky.time;
    const b = game.player.body;
    const s = creative ? null : parseSave(saved);
    let player: SavedSurvivalPlayer | null = null;
    if (s) {
      this.dayCount = Math.max(1, num(s.day, 1));
      this.sim.setRules({ keepInventory: !!s.rules?.keepInventory });
      const slots: SavedSurvivalPlayer['slots'] = [];
      (Array.isArray(s.inv) ? s.inv : []).forEach((e, slot) => {
        if (Array.isArray(e) && itemDef(e[0]) && e[1] > 0) slots.push([slot, e[0], e[1], e[2] ?? 0]);
      });
      player = {
        x: b.x, y: b.y, z: b.z, yaw: 0, pitch: 0,
        health: num(s.vitals?.hp, 20), food: num(s.vitals?.food, 20), dead: !!s.vitals?.dead,
        spawn: Array.isArray(s.spawn) ? { x: s.spawn[0], y: s.spawn[1], z: s.spawn[2] } : null, slots,
      };
      const chests: SavedChest[] = (Array.isArray(s.chests) ? s.chests : []).map(([key, flags, slots]) => {
        const [x, y, z] = unpackPos(key);
        return { x, y, z, flags, slots: Array.isArray(slots) ? slots : [] };
      });
      this.sim.loadChests(chests);
      const satchels: SavedSatchel[] = (Array.isArray(s.satchels) ? s.satchels : []).map(([x, y, z, items]) => ({
        owner: ID, x, y, z, createdMs: 0, items: (Array.isArray(items) ? items : []).map(([item, count, meta]) => ({ item, count, meta })),
      }));
      this.sim.loadSatchels(satchels);
    }
    const name = settings.get().nickname || 'You';
    const p = this.sim.addPlayer(ID, 1, name, null, player, { x: b.x, y: b.y, z: b.z });
    if (player) p.air = Math.max(0, Math.min(10, num(s?.vitals?.air, 10)));
    game.localEntities?.setPlayerHooks(this.sim);
    this.flush();
  }

  localEid(): number {
    return 1;
  }

  update(dt: number, paused: boolean): void {
    if (paused) return;
    this.clock += dt * 1000;
    // Day counter: the sky wrapping past midnight starts a new day.
    const t = this.game.sky.time;
    if (t < this.lastTime - 0.5) this.dayCount++;
    this.lastTime = t;
    this.acc = Math.min(this.acc + dt, STEP * 4);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.sim.preTick();
      this.sim.tick(STEP);
    }
    this.flush();
  }

  /** Converts sim events and the player's private state into backend events. */
  private flush(): void {
    for (const e of this.sim.takeEvents()) this.events.push(this.toClient(e));
    const p = this.sim.players.get(ID);
    if (!p || this.creative) return;
    const sync = p.takeInvSync(this.sim.openContainer(p));
    if (sync) this.priv.push({ type: 'inv', ...sync });
    const v = p.takeVitals(this.clock);
    if (v) this.priv.push({ type: 'vitals', ...v });
    for (const c of p.containerEvents.splice(0)) this.priv.push({ type: 'container', ...c });
    for (const text of p.notices.splice(0)) this.priv.push({ type: 'notice', text });
    if (p.dead && !this.deadSent) {
      this.deadSent = true;
      this.priv.push({ type: 'dead', ...p.dead });
    } else if (!p.dead) this.deadSent = false;
  }

  private deadSent = false;

  private toClient(e: SurvivalEvent): ClientEvent {
    switch (e.type) {
      case 'dropSpawn': {
        const d = e.drop;
        return { type: 'dropSpawn', id: d.id, item: d.item, count: d.count, meta: d.meta, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, satchel: !!d.satchel, yours: !!d.satchel };
      }
      case 'dropRemove':
        return { type: 'dropRemove', id: e.id, picker: e.picker === ID ? 1 : 0 };
      case 'sound':
        return { type: 'sound', sfx: e.sfx, x: e.x, y: e.y, z: e.z };
      default:
        return e;
    }
  }

  pose(body: PlayerBody, yaw: number, pitch: number, crouch: boolean, sprint: boolean, climbing: boolean): void {
    this.sim.setPose(ID, body.x, body.y, body.z, yaw, pitch, crouch, sprint, {
      grounded: body.onGround,
      cushioned: body.inWater || climbing || overlapsClimbable(this.game.world.getBlock, body.x, body.y, body.z),
      falling: body.vy < -1 && !body.onGround && !body.inWater,
    });
  }

  hand(slot: number, flags: number, creativeItem: number): void {
    this.sim.setHand(ID, slot, flags, creativeItem);
  }

  digStart(x: number, y: number, z: number): void {
    this.sim.digStart(ID, x, y, z);
  }

  attack(a: AttackIntent): void {
    this.sim.attack(ID, a);
    this.flush();
  }

  shoot(s: ShootIntent): void {
    this.sim.shoot(ID, s);
    this.flush();
  }

  invOp(seq: number, op: InvOp): void {
    this.sim.invOp(ID, seq, op);
    this.flush();
  }

  interact(kind: InteractKind, x: number, y: number, z: number): void {
    this.sim.interact(ID, kind, x, y, z);
    this.flush();
  }

  respawn(): void {
    this.sim.respawn(ID);
    this.flush();
  }

  setRules(r: { pvp?: boolean; keepInventory?: boolean }): void {
    if (r.keepInventory !== undefined) this.sim.setRules({ keepInventory: r.keepInventory });
  }

  afterLocalEdit(x: number, y: number, z: number, before: number, after: number, player: boolean): void {
    this.sim.onEdit(player ? ID : null, x, y, z, before, after);
    this.flush();
  }

  takeEvents(): ClientEvent[] {
    return this.events.splice(0);
  }

  takePrivate(): PrivateEvent[] {
    return this.priv.splice(0);
  }

  rules(): { pvp: boolean; keepInventory: boolean } {
    return { pvp: false, keepInventory: this.sim.rules.keepInventory };
  }

  day(): number {
    return this.dayCount;
  }

  canSetRules(): boolean {
    return !this.creative;
  }

  pvpConfigurable(): boolean {
    return false;
  }

  /** Debug and tests: the sim's player. */
  get player() {
    return this.sim.players.get(ID)!;
  }

  saveData(): LocalSurvivalSave | undefined {
    if (this.creative) return undefined;
    const p = this.player;
    const inv: LocalSurvivalSave['inv'] = [];
    for (let i = 0; i < 37; i++) inv.push(p.inv.counts[i] ? [p.inv.items[i], p.inv.counts[i], p.inv.metas[i]] : 0);
    return {
      v: 1,
      day: this.dayCount,
      rules: { keepInventory: this.sim.rules.keepInventory },
      vitals: { hp: p.health, food: p.food, air: p.air, dead: !p.alive },
      spawn: p.spawn ? [p.spawn.x, p.spawn.y, p.spawn.z] : null,
      inv,
      chests: this.sim.saveChests().map((c) => [packPos(c.x, c.y, c.z), c.flags, c.slots]),
      satchels: this.sim.saveSatchels().map((s) => [s.x, s.y, s.z, s.items.map((i) => [i.item, i.count, i.meta] as [number, number, number])]),
    };
  }

  dispose(): void {
    this.game.localEntities?.setPlayerHooks(null);
  }
}
