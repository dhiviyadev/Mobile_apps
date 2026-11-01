/**
 * Offline creature simulation (WP-C, design-voxel-mobs §10): the shared
 * EntityWorld stepped at 20 Hz on the main thread (at most 3 steps a frame),
 * implementing EntityHost with the local world. Frames go straight to the
 * EntityView without encoding. Survival plugs in its PlayerHooks; until then
 * nobody is hurt and feeding is free.
 */
import {
  buildSnapshot,
  buildTestArena,
  DamageKind,
  defaultPlayerHooks,
  EntityWorld,
  type EntityCaps,
  type EntityWorldApi,
  type InteractResult,
  itemKey,
  mobKindFromKey,
  mobsFromJson,
  mobsToJson,
  OFFLINE_CAPS,
  OFFLINE_LOW_CAPS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type PlayerHooks,
  type PlayerTarget,
  rulesForMode,
  StructureType,
  type VoxelMode,
} from '@hub/shared';
import { settings } from '../../../core/settings';
import type { VoxelGame } from '../VoxelGame';

export interface LocalEntitiesOptions {
  mode: VoxelMode;
  /** Offline save `mobs` payload ({ v: 1, list }), or undefined. */
  saved: unknown;
}

const STEP = 0.05;
const MAX_STEPS = 3;
/** Mean step time (ms) above which the offline sim drops to the low caps. */
const SLOW_STEP_MS = 2.5;

const BOSS_STRUCTURES: Record<string, StructureType> = {
  'sunforged-sentinel': StructureType.SunscorchTemple,
  'rime-warden': StructureType.FrostCitadel,
  thornmaw: StructureType.OvergrownShrine,
  'ashen-knight': StructureType.AshenCrypt,
};

export class LocalEntities {
  /** The sim for survival's attacks and arrows. */
  readonly api: EntityWorldApi;
  readonly sim: EntityWorld;
  private acc = 0;
  private readonly target: PlayerTarget;
  private readonly defaults: PlayerHooks;
  private stepMs: number[] = [];
  private low = false;
  /** Block reader, renewed every step (World.reader caches chunks). */
  private read: (x: number, y: number, z: number) => number;

  constructor(
    protected readonly game: VoxelGame,
    protected readonly opts: LocalEntitiesOptions,
  ) {
    const world = game.world;
    this.read = world.reader();
    this.low = game.renderer.profile.preset === 'low';
    this.sim = new EntityWorld(
      {
        getBlock: (x, y, z) => this.read(x, y, z),
        isAvailable: (x, z) => world.isLoaded(x, z),
        generator: game.generator,
        timeOfDay: () => game.sky.time,
        setBlock: (x, y, z, id) => game.applyWorldEdit(x, y, z, id),
        announce: (text) => game.hud?.flash(text, 3000, 'good'),
      },
      { seed: (world.seed ^ 0x51ab) >>> 0, rules: rulesForMode(opts.mode), caps: this.caps() },
    );
    this.target = {
      id: 'local', eid: 0, name: this.ownerName(), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, crouching: false, sprinting: false,
      // Without survival nobody is hurt; hostiles still notice survival players.
      targetable: opts.mode === 'survival', alive: true, halfWidth: PLAYER_WIDTH / 2, height: PLAYER_HEIGHT, blockingYaw: null,
    };
    this.defaults = defaultPlayerHooks(() => [this.target], () => {
      const item = game.hotbar.heldItem(game.hud?.selected ?? 0);
      return item ? itemKey(item) : null;
    });
    this.sim.setPlayerHooks(this.defaults);
    this.sim.loadMobs(mobsFromJson(opts.saved));
    this.api = this.sim;
    game.entities?.setLocalClock(() => (this.sim.tick + this.acc / STEP) * 50);
  }

  private ownerName(): string {
    return settings.get().nickname || 'You';
  }

  /** Caps for this device, radii from the render distance. */
  private caps(): EntityCaps {
    const base = this.low ? OFFLINE_LOW_CAPS : OFFLINE_CAPS;
    const r = this.game.world.renderDistance * 16;
    return { ...base, spawnMax: Math.max(base.spawnMin + 4, Math.min(40, r - 8)), simDist: Math.min(56, r), despawnDist: Math.min(64, r + 8) };
  }

  /** Survival's player side (sandbox: null = defaults). */
  setPlayerHooks(hooks: PlayerHooks | null): void {
    this.sim.setPlayerHooks(hooks ?? this.defaults);
  }

  /** Fixed 20 Hz steps (at most 3 per frame); nothing while paused. */
  update(dt: number, paused: boolean): void {
    if (paused) return;
    this.syncTarget();
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.acc -= STEP;
      steps++;
      const t0 = performance.now();
      this.read = this.game.world.reader();
      this.sim.step(STEP);
      this.governor(performance.now() - t0);
      const b = this.game.player.body;
      this.game.entities?.pushLocal(buildSnapshot(this.sim, { id: 'local', x: b.x, y: b.y, z: b.z }), this.sim.events);
    }
    if (this.acc > STEP) this.acc = STEP;
  }

  private syncTarget(): void {
    const t = this.target;
    const p = this.game.player;
    const b = p.body;
    t.x = b.x;
    t.y = b.y;
    t.z = b.z;
    t.vx = b.vx;
    t.vy = b.vy;
    t.vz = b.vz;
    t.yaw = p.yaw;
    t.crouching = p.crouching;
    t.sprinting = Math.hypot(b.vx, b.vz) > 5.5;
    t.name = this.ownerName();
  }

  /** Above 2.5 ms average the sim drops to the low caps until the next launch. */
  private governor(ms: number): void {
    this.stepMs.push(ms);
    if (this.stepMs.length > 40) this.stepMs.shift();
    if (this.low || this.stepMs.length < 40) return;
    const mean = this.stepMs.reduce((a, b) => a + b, 0) / this.stepMs.length;
    if (mean > SLOW_STEP_MS) {
      this.low = true;
      this.sim.setCaps(this.caps());
    }
  }

  interact(mobId: number, held: string | null): InteractResult {
    this.syncTarget();
    return this.sim.interact(mobId, this.target, held);
  }

  rename(mobId: number, owner: string, name: string): boolean {
    return this.sim.rename(mobId, owner, name);
  }

  /** Offline save `mobs` payload (tamed creatures), or undefined when none. */
  saveData(): unknown {
    const list = this.sim.saveMobs();
    return list.length ? mobsToJson(list) : undefined;
  }

  // ---- dev hooks (DEV builds; e2e and play-testing) ----

  devSpawn(key: string, dx: number, dz: number): number | null {
    const kind = mobKindFromKey(key);
    if (!kind) return null;
    const b = this.game.player.body;
    const x = b.x + dx;
    const z = b.z + dz;
    const get = this.game.world.getBlock;
    let y = Math.floor(b.y) + 4;
    while (y > 1 && !get(Math.floor(x), y - 1, Math.floor(z))) y--;
    return this.sim.spawnMob(kind, x, y, z, {})?.id ?? null;
  }

  /** Builds a synthetic arena of the boss's structure around the player and walks them in. */
  devTestBoss(key: string): boolean {
    const type = BOSS_STRUCTURES[key];
    if (!type) return false;
    const b = this.game.player.body;
    const cx = Math.floor(b.x);
    const cz = Math.floor(b.z) - 10;
    const a = buildTestArena(type, cx, Math.floor(b.y), cz);
    for (const [x, y, z, id] of a.edits) this.game.applyWorldEdit(x, y, z, id);
    this.sim.extraStructures.push(a.info);
    this.sim.setRules({ ...this.sim.rules, bosses: true, hostile: true });
    this.target.targetable = true;
    this.game.player.teleport(cx + 0.5, a.info.arena.y0, cz + 6.5);
    this.game.player.yaw = 0;
    return true;
  }

  devHit(mobId: number, amount: number): boolean {
    const m = this.sim.mobs.get(mobId);
    if (!m) return false;
    const b = this.game.player.body;
    const r = this.sim.damageMob(mobId, { amount, kind: DamageKind.Melee, attacker: { type: 'player', id: 'local' }, fromX: b.x, fromY: b.y + 1.5, fromZ: b.z, knockback: 4, lift: 2.5 });
    return !!r && !r.ignored;
  }

  dispose(): void {}
}
