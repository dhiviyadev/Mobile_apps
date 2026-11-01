/**
 * Creatures as the client sees them (WP-C, design-voxel-mobs §9.7, §11, §13):
 * snapshot interpolation (online 'N'/'V', offline frames from LocalEntities),
 * instanced rendering with procedural animation, decals (shadows, telegraphs,
 * hazards), particles, sounds, boss bar and music, the target label, feeding
 * and naming, and picking for survival's attacks.
 */
import * as THREE from 'three';
import {
  BossFlag,
  BurstKind,
  decodeEntitySnapshot,
  decodeEvents,
  decodeMobInteractResult,
  displayName,
  encodeMobInteract,
  EntityEventType,
  HazardKind,
  INTERACT_REACH,
  itemKey,
  MOB_DEFS,
  MobAction,
  MobCategory,
  MobKind,
  PROJECTILE_DEFS,
  ProjFlag,
  SnapFlag,
  TelegraphShape,
  unwrapSeq,
  VoxelMsg,
  bossTitle,
  type BossSnap,
  type EntityEvent,
  type EntitySnapshot,
  type HazardSnap,
  type InteractResult,
  type MobSnap,
  type ProjSnap,
} from '@hub/shared';
import { audio, type SfxName } from '../../../core/audio/audio';
import { SFX } from '../../../core/audio/sfx';
import { isTouchDevice } from '../../../core/device';
import type { InputFrame } from '../../../core/input/InputManager';
import { settings } from '../../../core/settings';
import { h } from '../../../core/ui/dom';
import { dialog } from '../../../core/ui/overlays';
import { makeNameSprite } from '../../common/Avatars';
import type { InteractionHooks, VoxelModule } from '../modules';
import type { VoxelNet } from '../net/VoxelNet';
import { BossBar } from '../ui/BossBar';
import { TargetLabel } from '../ui/TargetLabel';
import type { VoxelGame } from '../VoxelGame';
import type { VoxelUniforms } from '../world/materials';
import { animate, createPose, type AnimState, type Pose } from './animate';
import { DecalRenderer, DecalShape } from './DecalRenderer';
import { EntityFx } from './EntityFx';
import { EntityRenderer, type Lighting } from './EntityRenderer';
import { mobModel, paletteColor, projectileModel } from './models';

const ONLINE_DELAY_MS = 150;
const TICK_MS = 50;
const BOSS_COLORS: Partial<Record<MobKind, number>> = {
  [MobKind.SunforgedSentinel]: 0xf2c63a,
  [MobKind.RimeWarden]: 0x8ae0ff,
  [MobKind.Thornmaw]: 0xc83a6a,
  [MobKind.AshenKnight]: 0xff6a2a,
};
const ROAR: Partial<Record<MobKind, SfxName>> = {
  [MobKind.SunforgedSentinel]: 'sentinelRoar',
  [MobKind.RimeWarden]: 'wardenRoar',
  [MobKind.Thornmaw]: 'thornmawRoar',
  [MobKind.AshenKnight]: 'knightRoar',
};

interface Sample {
  t: number;
  s: MobSnap;
}

interface MobView {
  id: number;
  kind: MobKind;
  samples: Sample[];
  /** Interpolated state this frame. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  headYaw: number;
  headPitch: number;
  health: number;
  flags: number;
  action: MobAction;
  variant: number;
  progress: number;
  actionSeq: number;
  actionStart: number;
  phase: number;
  speed: number;
  lastX: number;
  lastZ: number;
  flash: number;
  hurtTilt: number;
  deathT: number;
  died: boolean;
  goneAt: number;
  fade: number;
  sky: number;
  block: number;
  name: string;
  owner: string;
  idleIn: number;
  pose: Pose;
  crumbT: number;
  stepT: number;
}

interface ProjView {
  snap: ProjSnap;
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  trailT: number;
}

interface TeleView {
  shape: TelegraphShape;
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  yaw: number;
  halfAngle: number;
  seconds: number;
  start: number;
}

const SHAPE_DECAL: Record<TelegraphShape, number> = {
  [TelegraphShape.Circle]: DecalShape.Circle,
  [TelegraphShape.Ring]: DecalShape.Ring,
  [TelegraphShape.Line]: DecalShape.Line,
  [TelegraphShape.Arc]: DecalShape.Arc,
  [TelegraphShape.Marker]: DecalShape.Marker,
};
const HAZARD_DECAL: Record<number, [number, number]> = {
  [HazardKind.SporeCloud]: [DecalShape.Spores, 0xb8a0e0],
  [HazardKind.FrostPatch]: [DecalShape.Frost, 0xbfe8ff],
  [HazardKind.ThornPatch]: [DecalShape.Thorns, 0x3f6a2a],
  [HazardKind.FireTrail]: [DecalShape.Fire, 0xff7a2a],
  [HazardKind.ThornRing]: [DecalShape.Ring, 0x5a8a2a],
};

export class EntityView implements VoxelModule {
  private readonly renderer: EntityRenderer;
  private readonly decals: DecalRenderer;
  private readonly fx: EntityFx;
  private hudParts: { bossBar: BossBar; label: TargetLabel } | null = null;
  private readonly mobs = new Map<number, MobView>();
  private readonly projectiles = new Map<number, ProjView>();
  private hazards: HazardSnap[] = [];
  private hazardAt = 0;
  private bosses: BossSnap[] = [];
  private telegraphs: TeleView[] = [];
  private readonly names = new Map<number, { name: string; owner: string }>();
  private readonly tags = new Map<number, { sprite: THREE.Sprite; text: string }>();
  private readonly tagGroup = new THREE.Group();
  private net: VoxelNet | null = null;
  private readonly offs: (() => void)[] = [];
  /** Online: arrival minus tick time over recent snapshots. */
  private offsets: number[] = [];
  private lastTick = -1;
  private unwrappedTick = 0;
  /** Offline: the sim clock (ms) supplied by LocalEntities each frame. */
  private localClock: (() => number) | null = null;
  private time = 0;
  private bossVisibleFor = 0;
  private bossHiddenFor = 99;
  private musicBoss = false;
  private seenBosses = new Set<number>();
  private idleBudget = 0;
  private targetId = 0;
  private targetDist = Infinity;
  private placeLabel: string | null = null;
  /** Last feeding result (e2e). */
  lastTameResult: InteractResult | null = null;
  private readonly tmpV = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private frameNo = 0;
  readonly interaction: Partial<InteractionHooks>;

  constructor(protected readonly game: VoxelGame) {
    const uniforms = (game as unknown as { uniforms: VoxelUniforms }).uniforms;
    const effects = game.renderer.profile.effects;
    this.renderer = new EntityRenderer(uniforms);
    this.renderer.translucentAsOpaque = game.renderer.profile.preset === 'low';
    this.decals = new DecalRenderer(uniforms);
    this.fx = new EntityFx(effects);
    game.scene.add(this.renderer.group, this.decals.mesh, this.fx.mesh, this.tagGroup);
    // Survival's hooks keep working: ours chain to them.
    this.interaction = {
      entityDistance: () => Math.min(this.targetDist, (this.game.survival as VoxelModule | null)?.interaction?.entityDistance?.() ?? Infinity),
    };
    if (import.meta.env.DEV) this.installDevHooks();
  }

  /** The HUD is built after the modules: boss bar and label mount lazily. */
  private get ui(): { bossBar: BossBar; label: TargetLabel } {
    return (this.hudParts ??= { bossBar: new BossBar(this.game.hud.root), label: new TargetLabel(this.game.hud.root) });
  }

  // ---- data in ------------------------------------------------------------------------

  /** Online: register 'N', 'V', 'mr' handlers on net.session. */
  attachNet(net: VoxelNet): void {
    this.net = net;
    const s = net.session;
    this.offs.push(
      s.onMessage(VoxelMsg.Entities, (bytes: Uint8Array) => {
        let snap: EntitySnapshot;
        try {
          snap = decodeEntitySnapshot(bytes);
        } catch {
          return;
        }
        this.unwrappedTick = this.lastTick < 0 ? snap.tick : unwrapSeq(snap.tick, this.unwrappedTick);
        this.lastTick = snap.tick;
        const t = this.unwrappedTick * TICK_MS;
        this.offsets.push(performance.now() - t);
        if (this.offsets.length > 20) this.offsets.shift();
        this.pushSnapshot(snap, t);
      }),
      s.onMessage(VoxelMsg.EntityEvents, (bytes: Uint8Array) => {
        try {
          for (const e of decodeEvents(bytes).events) this.applyEvent(e);
        } catch {
          /* malformed batch: skip */
        }
      }),
      s.onMessage(VoxelMsg.MobInteractResult, (bytes: Uint8Array) => {
        const r = decodeMobInteractResult(bytes);
        if (r) this.onInteractResult(r.mobId, r.result);
      }),
    );
  }

  /** Offline: LocalEntities hands frames over without encoding. */
  setLocalClock(clock: () => number): void {
    this.localClock = clock;
  }

  pushLocal(snap: EntitySnapshot, events: readonly EntityEvent[]): void {
    this.pushSnapshot(snap, snap.tick * TICK_MS);
    for (const e of events) this.applyEvent(e);
  }

  /** Render time on the snapshot timeline (ms). */
  private renderTime(): number {
    if (this.localClock) return this.localClock() - TICK_MS;
    if (!this.offsets.length) return -Infinity;
    return performance.now() - Math.min(...this.offsets) - ONLINE_DELAY_MS;
  }

  private projectileTime(): number {
    if (this.localClock) return this.localClock();
    return performance.now() - Math.min(...this.offsets);
  }

  private pushSnapshot(snap: EntitySnapshot, t: number): void {
    const seen = new Set<number>();
    for (const m of snap.mobs) {
      seen.add(m.id);
      let v = this.mobs.get(m.id);
      if (!v) {
        v = this.newView(m);
        this.mobs.set(m.id, v);
      }
      v.goneAt = Infinity;
      v.samples.push({ t, s: m });
      if (v.samples.length > 4) v.samples.shift();
      if (m.flags & SnapFlag.Hurt) v.flash = Math.max(v.flash, 0.6);
    }
    for (const v of this.mobs.values()) if (!seen.has(v.id) && v.goneAt === Infinity) v.goneAt = t;
    const pseen = new Set<number>();
    for (const p of snap.projectiles) {
      pseen.add(p.id);
      const cur = this.projectiles.get(p.id);
      if (cur) {
        cur.snap = p;
        cur.t = t;
      } else this.projectiles.set(p.id, { snap: p, t, x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0, trailT: 0 });
    }
    for (const id of this.projectiles.keys()) if (!pseen.has(id)) this.projectiles.delete(id);
    this.hazards = snap.hazards;
    this.hazardAt = this.time;
    this.bosses = snap.bosses;
  }

  private newView(m: MobSnap): MobView {
    const model = mobModel(m.kind);
    const def = MOB_DEFS[m.kind];
    const known = this.names.get(m.id);
    return {
      id: m.id, kind: m.kind, samples: [], x: m.x, y: m.y, z: m.z, yaw: m.yaw, headYaw: m.headYaw, headPitch: m.headPitch, health: m.health,
      flags: m.flags, action: m.action, variant: m.variant, progress: m.progress, actionSeq: m.actionSeq, actionStart: this.time - m.progress * 0.5,
      phase: Math.random() * 6, speed: 0, lastX: m.x, lastZ: m.z, flash: 0, hurtTilt: 0, deathT: -1, died: false, goneAt: Infinity, fade: 0,
      sky: 15, block: 0, name: known?.name ?? '', owner: known?.owner ?? '',
      idleIn: def.idleEvery[0] + Math.random() * (def.idleEvery[1] - def.idleEvery[0]), pose: createPose(model.parts.length), crumbT: 0, stepT: 0,
    };
  }

  // ---- events -------------------------------------------------------------------------

  private sound(name: SfxName | string, x: number, z: number, maxDist = 32, volume = 1, pitch = 1): void {
    if (!(name in AUDIO_NAMES)) return;
    const p = this.game.player.body;
    audio.playAt(name as SfxName, x - p.x, z - p.z, this.game.player.yaw, maxDist, volume, pitch);
  }

  private mobColor(v: MobView): number {
    const model = mobModel(v.kind);
    const slot = model.parts.find((p) => p.role === 'torso')?.color ?? model.parts[0].color;
    return paletteColor(model.def, slot, v.variant);
  }

  private applyEvent(e: EntityEvent): void {
    switch (e.type) {
      case EntityEventType.MobHurt: {
        const v = this.mobs.get(e.id);
        if (!v) return;
        v.flash = 1;
        v.hurtTilt = 1;
        const def = MOB_DEFS[v.kind];
        this.fx.spray(v.x, v.y + def.height * 0.6, v.z, 4, 0xfff0b0, { speed: 2, up: 2, size: 0.07, life: 0.35 });
        if (!e.killed) this.sound(def.sounds.hurt, v.x, v.z, def.category === MobCategory.Boss ? 64 : 32, 1, v.flags & SnapFlag.Baby ? 1.4 : 1);
        if (e.byYou) audio.play('mobHit' as SfxName, { volume: 0.6 });
        return;
      }
      case EntityEventType.MobDied: {
        const v = this.mobs.get(e.id);
        if (!v) return;
        v.died = true;
        v.deathT = 0;
        const def = MOB_DEFS[v.kind];
        this.sound(def.sounds.death, v.x, v.z, 40, 1, v.flags & SnapFlag.Baby ? 1.4 : 1);
        return;
      }
      case EntityEventType.MobAction: {
        const v = this.mobs.get(e.id);
        if (!v) return;
        const def = MOB_DEFS[v.kind];
        const boss = def.category === MobCategory.Boss;
        let s: string | undefined;
        if (boss) s = e.action === MobAction.Slam ? 'bossSlam' : e.action === MobAction.Charge ? 'bossCharge' : e.action === MobAction.Summon ? 'bossSummon' : e.action === MobAction.Attack ? (v.kind === MobKind.Thornmaw ? 'vineLash' : 'cleave') : e.action === MobAction.Cast ? (v.kind === MobKind.RimeWarden ? 'shardWhoosh' : v.kind === MobKind.AshenKnight ? 'emberWhoosh' : v.kind === MobKind.Thornmaw ? 'seedPop' : 'bossSummon') : e.action === MobAction.Burrow ? 'ruptureCrack' : undefined;
        else if (e.action === MobAction.Draw) s = 'mobBowDraw';
        else if (e.action === MobAction.Inflate) s = 'puffInflate';
        else s = def.sounds.attack;
        if (s) this.sound(s, v.x, v.z, boss ? 64 : 32);
        return;
      }
      case EntityEventType.Telegraph:
        this.telegraphs.push({ ...e, start: this.time });
        return;
      case EntityEventType.Burst: {
        const color = e.kind === BurstKind.Spores ? 0xb8a0e0 : e.kind === BurstKind.Nova || e.kind === BurstKind.Hail ? 0xcff0ff : e.kind === BurstKind.Seed ? 0x5a8a2a : e.kind === BurstKind.Rupture ? 0xff7a2a : 0xd8c8a0;
        this.fx.ring(e.x, e.y, e.z, Math.max(1, e.radius), color);
        this.fx.spray(e.x, e.y + 0.5, e.z, Math.round(6 + e.radius * 3), color, { speed: e.radius * 1.5, up: 3, size: 0.16, life: 0.8, spread: e.radius });
        const s = e.kind === BurstKind.Spores ? 'sporeBurst' : e.kind === BurstKind.Nova ? 'frostNova' : e.kind === BurstKind.Hail ? 'hailCrash' : e.kind === BurstKind.Rupture || e.kind === BurstKind.Emerge ? 'ruptureCrack' : e.kind === BurstKind.Seed ? 'seedPop' : e.kind === BurstKind.Pulse ? 'bossTeleport' : 'bossSlam';
        this.sound(s, e.x, e.z, 64);
        return;
      }
      case EntityEventType.ProjHit: {
        const color = e.projKind === 4 ? 0xffe08a : e.projKind === 5 ? 0xcff0ff : e.projKind === 7 || e.projKind === 8 ? 0xff7a2a : e.projKind === 6 ? 0x5a8a2a : 0xd8c8a8;
        this.fx.spray(e.x, e.y, e.z, 5, color, { speed: 2, up: 1.5, size: 0.08, life: 0.4 });
        if (e.projKind === 5) this.sound('hailCrash', e.x, e.z, 24, 0.5);
        return;
      }
      case EntityEventType.BossPhase: {
        const v = this.mobs.get(e.id);
        if (v) this.sound(ROAR[v.kind] ?? 'bossHurt', v.x, v.z, 96);
        return;
      }
      case EntityEventType.BossAwake: {
        const v = this.mobs.get(e.id);
        const x = v?.x ?? this.game.player.body.x;
        const z = v?.z ?? this.game.player.body.z;
        this.sound(ROAR[e.kind] ?? 'bossSlam', x, z, 96);
        this.game.hud.showPlace(`The ${MOB_DEFS[e.kind].name}`, bossTitle(e.kind), 3200);
        this.seenBosses.add(e.id);
        return;
      }
      case EntityEventType.BossDefeated: {
        audio.play('bossDefeat' as SfxName, { volume: 0.9 });
        this.game.hud.flash(`${MOB_DEFS[e.kind].name} defeated!`, 3000, 'good');
        return;
      }
      case EntityEventType.Tamed: {
        const v = this.mobs.get(e.id);
        if (!v) return;
        const top = v.y + MOB_DEFS[v.kind].height;
        if (e.how === 1) {
          this.fx.smoke(v.x, top, v.z);
          this.sound('tameFail', v.x, v.z, 24);
        } else {
          this.fx.hearts(v.x, top, v.z);
          this.sound('tameHeart', v.x, v.z, 24);
        }
        return;
      }
      case EntityEventType.MobInfo: {
        this.names.set(e.id, { name: e.name, owner: e.owner });
        const v = this.mobs.get(e.id);
        if (v) {
          v.name = e.name;
          v.owner = e.owner;
        }
        return;
      }
    }
  }

  // ---- interaction ---------------------------------------------------------------------

  private myName(): string {
    if (this.net) {
      const me = (this.net.session.state as { players?: Map<string, { name: string }> } | undefined)?.players?.get(this.net.session.sessionId);
      return me?.name ?? '';
    }
    return settings.get().nickname || 'You';
  }

  private heldKey(): string | null {
    const item = this.game.hotbar.heldItem(this.game.hud.selected);
    return item ? itemKey(item) : null;
  }

  /** What secondary would do on this creature now ('Feed', 'Name' or null). */
  private interactLabel(v: MobView): string | null {
    const def = MOB_DEFS[v.kind];
    if (def.category !== MobCategory.Friendly || !def.likes.length || v.deathT >= 0) return null;
    const held = this.heldKey();
    if (held && def.likes.includes(held)) return 'Feed';
    if (v.flags & SnapFlag.Tamed && v.owner && v.owner === this.myName()) return 'Name';
    return null;
  }

  private interact(v: MobView): void {
    const held = this.heldKey();
    const local = this.game.localEntities;
    if (local?.sim) {
      const res = local.interact(v.id, held);
      this.onInteractResult(v.id, res);
    } else if (this.net) {
      this.net.session.sendBytes(VoxelMsg.MobInteract, encodeMobInteract(v.id, held));
    }
  }

  private onInteractResult(mobId: number, result: InteractResult): void {
    this.lastTameResult = result;
    if (result === 'tamed') this.game.hud.flash('Tamed!', 1800, 'good');
    else if (result === 'cap') this.game.hud.flash("This world can't keep more tamed creatures", 2500);
    else if (result === 'not-owner') {
      const v = this.mobs.get(mobId);
      this.game.hud.flash(`Tamed by ${v?.owner || 'someone else'}`, 1800);
    } else if (result === 'name') void this.askName(mobId);
  }

  private async askName(mobId: number): Promise<void> {
    const v = this.mobs.get(mobId);
    if (!v) return;
    const input = h('input', { type: 'text', maxlength: '16', placeholder: 'Name', value: v.name, class: 'text-input', 'data-testid': 'mob-name-input' }) as HTMLInputElement;
    setTimeout(() => input.focus(), 50);
    const ok = await dialog(`Name your ${MOB_DEFS[v.kind].name}`, h('div', null, input), [
      { label: 'Cancel', value: '' },
      { label: 'Save', value: 'save' },
    ]);
    if (ok !== 'save') return;
    const name = input.value.trim().slice(0, 16);
    if (this.game.localEntities?.sim) this.game.localEntities.rename(mobId, this.myName(), name);
    else this.net?.session.send(VoxelMsg.MobName, { id: mobId, name });
  }

  // ---- picking ------------------------------------------------------------------------

  /** Nearest rendered creature box hit by the ray (pad inflates boxes; touch aim help 0.15). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, pad = 0): { id: number; distance: number } | null {
    let best: { id: number; distance: number } | null = null;
    for (const v of this.mobs.values()) {
      if (v.deathT >= 0 || v.goneAt !== Infinity) continue;
      const def = MOB_DEFS[v.kind];
      const baby = v.flags & SnapFlag.Baby ? 0.55 : 1;
      const hw = def.halfWidth * baby + pad;
      const ht = def.height * baby;
      const t = rayBox(ox, oy, oz, dx, dy, dz, v.x - hw, v.y - pad, v.z - hw, v.x + hw, v.y + ht + pad, v.z + hw);
      if (t >= 0 && t <= maxDist && (!best || t < best.distance)) best = { id: v.id, distance: t };
    }
    return best;
  }

  /** A rendered creature overlaps the block cell (client-side placement check). */
  overlapsCell(x: number, y: number, z: number): boolean {
    for (const v of this.mobs.values()) {
      if (v.deathT >= 0 || v.goneAt !== Infinity) continue;
      const def = MOB_DEFS[v.kind];
      const baby = v.flags & SnapFlag.Baby ? 0.55 : 1;
      const hw = def.halfWidth * baby;
      if (x + 1 > v.x - hw && x < v.x + hw && z + 1 > v.z - hw && z < v.z + hw && y + 1 > v.y && y < v.y + def.height * baby) return true;
    }
    return false;
  }

  /** Number of creatures currently shown (dev hooks, e2e). */
  count(): number {
    let n = 0;
    for (const v of this.mobs.values()) if (v.deathT < 0 && v.goneAt === Infinity) n++;
    return n;
  }

  get instanceCount(): number {
    return this.renderer.instances;
  }

  // ---- per frame ----------------------------------------------------------------------

  /** Every frame after interaction: interpolate, animate, draw. */
  render(dt: number, camera: THREE.Camera, daylight: number): void {
    void daylight;
    this.time += dt;
    this.frameNo++;
    const rt = this.renderTime();
    const cam = camera.position;
    const preset = this.game.renderer.profile.preset;
    const maxDrawn = preset === 'low' ? 24 : preset === 'medium' ? 40 : 64;
    const lod = preset === 'low' ? 0.7 : 1;
    this.projScreen.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // Interpolate and retire.
    const order: { v: MobView; d: number }[] = [];
    for (const v of [...this.mobs.values()]) {
      this.interpolate(v, rt, dt);
      if (v.goneAt !== Infinity && rt >= v.goneAt && !v.died) {
        v.fade += dt / 0.2;
        if (v.fade >= 1) {
          this.dropView(v);
          continue;
        }
      }
      const def = MOB_DEFS[v.kind];
      if (v.deathT >= 0) {
        v.deathT += dt;
        const boss = def.category === MobCategory.Boss;
        if (v.deathT >= (boss ? 2.5 : 0.5)) {
          this.fx.poof(v.x, v.y + def.height * 0.5, v.z, this.mobColor(v), boss);
          if (boss) this.fx.ring(v.x, v.y, v.z, 4, 0xd8c8a0);
          this.dropView(v);
          continue;
        }
      }
      order.push({ v, d: Math.hypot(v.x - cam.x, v.z - cam.z) });
    }
    order.sort((a, b) => a.d - b.d);

    let drawn = 0;
    for (const { v, d } of order) {
      const def = MOB_DEFS[v.kind];
      const boss = def.category === MobCategory.Boss;
      this.sounds(v, d, dt);
      if (d > 80 * lod && !boss) continue;
      this.sphere.center.set(v.x, v.y + def.height / 2, v.z);
      this.sphere.radius = Math.max(1, def.height);
      if (!this.frustum.intersectsSphere(this.sphere)) {
        if (d < 32) this.shadow(v, def.height, d);
        continue;
      }
      if (drawn >= maxDrawn && !boss) continue;
      drawn++;
      this.drawMob(v, d, lod);
      if (d < 32 * lod && v.kind !== MobKind.Glimmerfin) this.shadow(v, def.height, d);
    }
    this.drawProjectiles(dt);
    this.drawHazards();
    this.drawTelegraphs();
    this.renderer.finish();
    this.decals.finish();
    this.fx.update(dt);
    this.updateBoss(dt);
    this.updateTags(cam);
  }

  private dropView(v: MobView): void {
    this.mobs.delete(v.id);
    const tag = this.tags.get(v.id);
    if (tag) {
      this.tagGroup.remove(tag.sprite);
      tag.sprite.material.map?.dispose();
      tag.sprite.material.dispose();
      this.tags.delete(v.id);
    }
  }

  private interpolate(v: MobView, rt: number, dt: number): void {
    const s = v.samples;
    if (!s.length) return;
    let a = s[0];
    let b = s[s.length - 1];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= rt) {
        a = s[i - 1];
        b = s[i];
        break;
      }
    }
    if (rt <= s[0].t) b = a;
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 1;
    const A = a.s;
    const B = b.s;
    v.x = A.x + (B.x - A.x) * k;
    v.y = A.y + (B.y - A.y) * k;
    v.z = A.z + (B.z - A.z) * k;
    v.yaw = lerpAngle(A.yaw, B.yaw, k);
    v.headYaw = lerpAngle(A.headYaw, B.headYaw, k);
    v.headPitch = A.headPitch + (B.headPitch - A.headPitch) * k;
    v.health = A.health + (B.health - A.health) * k;
    v.flags = B.flags;
    v.variant = B.variant;
    if (B.actionSeq !== v.actionSeq || B.action !== v.action) {
      if (B.actionSeq !== v.actionSeq) v.actionStart = this.time - B.progress * 0.2;
      v.actionSeq = B.actionSeq;
      v.action = B.action;
    }
    v.progress = B.progress + (b === a ? 0 : 0);
    if (B.flags & SnapFlag.Dying && !v.died) {
      v.died = true;
      v.deathT = 0;
    }
    const moved = Math.hypot(v.x - v.lastX, v.z - v.lastZ);
    const sp = dt > 0 ? Math.min(12, moved / dt) : 0;
    v.speed += (sp - v.speed) * Math.min(1, dt * 10);
    v.lastX = v.x;
    v.lastZ = v.z;
    v.flash = Math.max(0, v.flash - dt * 4);
    v.hurtTilt = Math.max(0, v.hurtTilt - dt * 5);
    // Light of the cell the creature is in, eased.
    const def = MOB_DEFS[v.kind];
    const w = this.game.world;
    let l = w.lightAt(Math.floor(v.x), Math.floor(v.y + def.height * 0.6), Math.floor(v.z));
    if ((l >> 4) === 0 && (l & 15) === 0) l = w.lightAt(Math.floor(v.x), Math.floor(v.y + def.height * 0.6) + 1, Math.floor(v.z));
    const e = Math.min(1, dt * 8);
    v.sky += ((l >> 4) - v.sky) * e;
    v.block += ((l & 15) - v.block) * e;
  }

  private drawMob(v: MobView, d: number, lod: number): void {
    const def = MOB_DEFS[v.kind];
    const model = mobModel(v.kind);
    const baby = v.flags & SnapFlag.Baby ? 0.55 : 1;
    const walk = Math.max(def.wanderSpeed, 1.2);
    v.phase += v.speed * model.def.stride * (1 / 60);
    const boss = this.bosses.find((b) => b.mobId === v.id);
    const s: AnimState = {
      kind: v.kind,
      t: this.time + v.id * 0.37,
      phase: v.phase,
      k: Math.min(1, v.speed / walk),
      action: v.action,
      actionT: this.time - v.actionStart,
      progress: v.progress,
      headYaw: wrap(v.headYaw - v.yaw),
      headPitch: v.headPitch,
      onGround: !!(v.flags & SnapFlag.OnGround),
      inWater: !!(v.flags & SnapFlag.InWater),
      deathT: def.category === MobCategory.Boss ? -1 : v.deathT,
      hurt: v.hurtTilt,
      enraged: !!boss && (boss.flags & BossFlag.Enraged) !== 0,
      phase2: !!boss && boss.phase >= 2,
      fast: v.speed > def.wanderSpeed * 1.6,
    };
    // Far creatures animate every other frame.
    if (d < 24 || (this.frameNo + v.id) % 2 === 0) animate(model, s, v.pose);
    const bossDying = def.category === MobCategory.Boss && v.deathT >= 0;
    const flicker = bossDying ? (Math.sin(this.time * 40) > 0 ? 1 : 0) : 0;
    const light: Lighting = {
      sky: v.sky / 15,
      block: v.block / 15,
      flash: v.flash,
      glow: (v.id === this.targetId ? 0.12 : 0) + flicker * 0.5,
    };
    let yaw = v.yaw;
    if (v.kind === MobKind.SunforgedSentinel && v.action === MobAction.Charge && v.progress > 0.3) yaw += this.time * 18;
    const fade = v.goneAt !== Infinity ? 1 - v.fade : 1;
    const sink = bossDying ? Math.max(0, v.deathT - 1.5) * 0.8 : 0;
    const blade = v.kind === MobKind.AshenKnight && s.phase2 ? (slot: string) => (slot === 'blade' ? 0xffb05a : null) : undefined;
    this.renderer.addModel(model, v.variant, { x: v.x, y: v.y - sink, z: v.z, yaw, pitch: 0, roll: 0, scale: baby * fade, headScale: baby < 1 ? 1.3 : 1 }, v.pose, light, d > 48 * lod, blade);
  }

  private shadow(v: MobView, height: number, d: number): void {
    const model = mobModel(v.kind);
    if (!model.def.shadow) return;
    const floor = this.floorUnder(v.x, v.y + 0.5, v.z);
    const above = v.y - floor;
    const a = 0.35 * Math.max(0, 1 - above / 4) * Math.max(0, 1 - d / 32);
    if (a <= 0.01) return;
    const baby = v.flags & SnapFlag.Baby ? 0.55 : 1;
    void height;
    this.decals.add({ shape: DecalShape.Shadow, x: v.x, y: floor, z: v.z, radius: model.def.shadow * baby, width: 0, yaw: 0, halfAngle: 0, progress: 0, alpha: a, color: 0x000000 });
  }

  private floorUnder(x: number, y: number, z: number): number {
    const get = this.game.world.getBlock;
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    for (let yy = Math.floor(y); yy > Math.floor(y) - 5 && yy > 0; yy--) {
      const b = get(bx, yy - 1, bz);
      if (b !== 0 && b !== 5) return yy;
    }
    return y - 5;
  }

  private drawProjectiles(dt: number): void {
    const now = this.projectileTime();
    const light: Lighting = { sky: 1, block: 0, flash: 0, glow: 0 };
    for (const p of this.projectiles.values()) {
      const sn = p.snap;
      const def = PROJECTILE_DEFS[sn.kind as keyof typeof PROJECTILE_DEFS];
      const model = projectileModel(sn.kind);
      if (!def || !model) continue;
      if (sn.flags & ProjFlag.Stuck) {
        p.x = sn.x;
        p.y = sn.y;
        p.z = sn.z;
      } else {
        const t = Math.max(0, Math.min(0.5, (now - p.t) / 1000));
        const tx = sn.x + sn.vx * t;
        const ty = sn.y + sn.vy * t - 0.5 * def.gravity * t * t;
        const tz = sn.z + sn.vz * t;
        const blend = Math.min(1, dt * 12);
        p.x += (tx - p.x) * blend;
        p.y += (ty - p.y) * blend;
        p.z += (tz - p.z) * blend;
        const vy = sn.vy - def.gravity * t;
        p.yaw = Math.atan2(-sn.vx, -sn.vz);
        p.pitch = Math.atan2(vy, Math.hypot(sn.vx, sn.vz));
        if (def.glow) {
          p.trailT -= dt;
          if (p.trailT <= 0) {
            p.trailT = 0.05;
            const c = sn.kind === 5 ? 0xcff0ff : sn.kind === 4 ? 0xffe08a : 0xff7a2a;
            this.fx.spray(p.x, p.y, p.z, 1, c, { speed: 0.3, up: 0.3, size: 0.07, life: 0.35, gravity: 0, spread: 0.1 });
          }
        }
      }
      const l = this.game.world.lightAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      light.sky = (l >> 4) / 15;
      light.block = (l & 15) / 15;
      this.renderer.addModel(model, 0, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, roll: 0, scale: 1 }, null, light, false);
    }
  }

  private drawHazards(): void {
    const age = this.time - this.hazardAt;
    for (const hz of this.hazards) {
      const left = hz.secondsLeft - age;
      if (left <= 0) continue;
      const [shape, color] = HAZARD_DECAL[hz.kind] ?? [DecalShape.Spores, 0xffffff];
      this.decals.add({ shape, x: hz.x, y: hz.y, z: hz.z, radius: hz.radius, width: 0, yaw: 0, halfAngle: 0, progress: 1, alpha: Math.min(1, left * 2), color });
      if (hz.kind === HazardKind.SporeCloud && Math.random() < 0.2) this.fx.spray(hz.x + (Math.random() - 0.5) * hz.radius, hz.y + 0.3, hz.z + (Math.random() - 0.5) * hz.radius, 1, 0xb8a0e0, { speed: 0.2, up: 0.5, size: 0.12, life: 0.8, gravity: -0.5 });
    }
  }

  private drawTelegraphs(): void {
    this.telegraphs = this.telegraphs.filter((t) => this.time - t.start < t.seconds + 0.1);
    for (const t of this.telegraphs) {
      const el = this.time - t.start;
      const left = t.seconds - el;
      const color = left < 0.2 ? 0xff4040 : 0xffa040;
      this.decals.add({ shape: SHAPE_DECAL[t.shape], x: t.x, y: t.y, z: t.z, radius: t.radius, width: t.width, yaw: t.yaw, halfAngle: t.halfAngle, progress: Math.min(1, el / Math.max(0.05, t.seconds)), alpha: 1, color });
    }
  }

  private sounds(v: MobView, d: number, dt: number): void {
    const def = MOB_DEFS[v.kind];
    if (v.deathT >= 0) return;
    if (def.category === MobCategory.Boss) {
      if (v.speed > 0.5 && model2(v.kind)) {
        v.stepT -= dt;
        if (v.stepT <= 0) {
          v.stepT = 0.55;
          this.sound('bossStep', v.x, v.z, 48, 0.8);
        }
      }
    }
    // Drying mudlurchs crumble, burning creatures smoke.
    if (v.flags & SnapFlag.Burning) {
      v.crumbT -= dt;
      if (v.crumbT <= 0 && d < 40) {
        v.crumbT = 0.2;
        const c = v.kind === MobKind.Mudlurch ? this.mobColor(v) : 0xff7a2a;
        this.fx.spray(v.x, v.y + def.height * 0.7, v.z, 1, c, { speed: 0.6, up: 0.5, size: 0.08, life: 0.5, spread: def.halfWidth * 2 });
      }
    }
    v.idleIn -= dt;
    if (v.idleIn > 0) return;
    v.idleIn = def.idleEvery[0] + Math.random() * (def.idleEvery[1] - def.idleEvery[0]);
    if (d > 24 || this.idleBudget > this.time) return;
    this.idleBudget = this.time + 0.5;
    this.sound(def.sounds.idle, v.x, v.z, 24, 0.9, (v.flags & SnapFlag.Baby ? 1.4 : 1) + (Math.random() - 0.5) * 0.1);
  }

  private updateBoss(dt: number): void {
    const b = this.bosses.find((x) => x.flags & BossFlag.Awake) ?? this.bosses[0];
    if (b && b.flags & BossFlag.Awake && b.health > 0) {
      const def = MOB_DEFS[b.kind];
      this.ui.bossBar.show(
        {
          name: def.name,
          color: BOSS_COLORS[b.kind] ?? 0xffffff,
          frac: b.maxHealth > 0 ? b.health / b.maxHealth : 0,
          phase: b.phase,
          scale: b.maxHealth / def.maxHealth,
          invulnerable: (b.flags & BossFlag.Invulnerable) !== 0,
          stunned: (b.flags & BossFlag.Stunned) !== 0,
        },
        dt,
      );
      this.bossVisibleFor += dt;
      this.bossHiddenFor = 0;
      if (!this.musicBoss && this.bossVisibleFor > 1) {
        this.musicBoss = true;
        audio.playMusic('boss');
      }
    } else {
      this.ui.bossBar.hide();
      this.bossVisibleFor = 0;
      this.bossHiddenFor += dt;
      if (this.musicBoss && this.bossHiddenFor > 4) {
        this.musicBoss = false;
        audio.playMusic('voxel');
      }
    }
  }

  private updateTags(cam: THREE.Vector3): void {
    const want = new Set<number>();
    for (const v of this.mobs.values()) {
      const def = MOB_DEFS[v.kind];
      const boss = def.category === MobCategory.Boss;
      const d = Math.hypot(v.x - cam.x, v.y - cam.y, v.z - cam.z);
      if (v.deathT >= 0) continue;
      if (!(boss && d < 40) && !(v.name && d < 16)) continue;
      want.add(v.id);
      const text = boss ? def.name : v.name;
      let tag = this.tags.get(v.id);
      if (!tag || tag.text !== text) {
        if (tag) this.tagGroup.remove(tag.sprite);
        tag = { sprite: makeNameSprite(text, boss ? (BOSS_COLORS[v.kind] ?? 0xffffff) : 0xffffff), text };
        this.tags.set(v.id, tag);
        this.tagGroup.add(tag.sprite);
      }
      const top = mobModel(v.kind).top * (v.flags & SnapFlag.Baby ? 0.6 : 1);
      tag.sprite.position.set(v.x, v.y + top + 0.45, v.z);
      const k = 0.9 + Math.min(d, 40) * 0.025;
      tag.sprite.scale.set(tag.sprite.userData.aspect * 0.3 * k, 0.3 * k, 1);
    }
    for (const [id, tag] of this.tags) {
      if (want.has(id)) continue;
      this.tagGroup.remove(tag.sprite);
      tag.sprite.material.map?.dispose();
      tag.sprite.material.dispose();
      this.tags.delete(id);
    }
  }

  /** Target label, feed/name on secondary, Place button label. */
  update(dt: number, input: InputFrame, paused: boolean): void {
    this.ui.label.update(dt);
    const p = this.game.player;
    const eye = this.game.camera.getWorldPosition(this.tmpV);
    const cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp;
    const dy = Math.sin(p.pitch);
    const dz = -Math.cos(p.yaw) * cp;
    const pad = input.touch || isTouchDevice() ? 0.15 : 0;
    const hit = this.raycast(eye.x, eye.y, eye.z, dx, dy, dz, 6, pad);
    this.targetId = hit?.id ?? 0;
    this.targetDist = hit ? hit.distance : Infinity;
    let place: string | null = null;
    if (hit) {
      const v = this.mobs.get(hit.id)!;
      const def = MOB_DEFS[v.kind];
      const action = hit.distance <= INTERACT_REACH ? this.interactLabel(v) : null;
      const name = def.category === MobCategory.Boss ? `The ${def.name}` : v.name || (v.flags & SnapFlag.Tamed ? `Tamed ${displayName(v.kind, v.variant, !!(v.flags & SnapFlag.Baby), '')}` : displayName(v.kind, v.variant, !!(v.flags & SnapFlag.Baby), ''));
      const hint = action ? (pad ? `Tap Place to ${action.toLowerCase()}` : `Right click: ${action}`) : '';
      this.ui.label.show(name, v.health, def.category !== MobCategory.Friendly, hint);
      place = action;
      if (action && !paused && input.pressed.has('secondary')) this.interact(v);
    }
    if (place !== this.placeLabel) {
      this.placeLabel = place;
      this.game.touchControls?.setButton('place', { label: place ?? 'Place' });
    }
  }

  /** Offline edits (player, support cascades, boss altar): stuck arrows in the cell drop or vanish. */
  afterLocalEdit(x: number, y: number, z: number): void {
    this.game.localEntities?.sim.onBlockChanged(x, y, z);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.game.scene.remove(this.renderer.group, this.decals.mesh, this.fx.mesh, this.tagGroup);
    this.renderer.dispose();
    this.decals.dispose();
    this.fx.dispose();
    for (const tag of this.tags.values()) {
      tag.sprite.material.map?.dispose();
      tag.sprite.material.dispose();
    }
    this.hudParts?.bossBar.dispose();
    this.hudParts?.label.dispose();
    if (this.musicBoss) audio.playMusic('voxel');
  }

  // ---- dev hooks (DEV builds; e2e) ------------------------------------------------------

  private installDevHooks(): void {
    const game = this.game as unknown as { debug?: Record<string, unknown> };
    game.debug = {
      ...(game.debug ?? {}),
      spawnMob: (key: string, dx = 0, dz = -4) => this.game.localEntities?.devSpawn(key, dx, dz) ?? null,
      setTime: (t: number) => {
        this.game.sky.time = t;
      },
      testBoss: (key: string) => this.game.localEntities?.devTestBoss(key) ?? null,
      hitTarget: (amount = 4) => this.game.localEntities?.devHit(this.targetId, amount) ?? false,
      creatures: () => [...this.mobs.values()].map((v) => ({ id: v.id, kind: MOB_DEFS[v.kind].key, x: v.x, y: v.y, z: v.z, health: v.health, action: v.action })),
    };
  }
}

function model2(kind: MobKind): boolean {
  return kind !== MobKind.Thornmaw && kind !== MobKind.RimeWarden;
}

const TAU = Math.PI * 2;
function wrap(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
const lerpAngle = (a: number, b: number, t: number) => a + wrap(b - a) * t;

function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return -1;
      continue;
    }
    let t0 = (lo[a] - o[a]) / d[a];
    let t1 = (hi[a] - o[a]) / d[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return Math.max(0, tmin);
}

/** Sound names this build knows (unknown recipe names are skipped). */
const AUDIO_NAMES = SFX as Record<string, unknown>;
