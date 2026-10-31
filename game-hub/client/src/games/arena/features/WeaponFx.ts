/**
 * Weapon presentation (design-arena-weapons): the first-person viewmodel and its events, shot visuals
 * and sounds (local and remote, per weapon), crossbow bolts, camera recoil, the ammo / crosshair /
 * scope / auto-shoot HUD, touch aim assist, auto-shoot, and the loadout and auto-shoot preferences.
 */
import * as THREE from 'three';
import {
  type ArenaEvent,
  type ArenaMap,
  Buttons,
  type CommandEvents,
  currentSpread,
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  isPrimary,
  isSecondary,
  type PlayerSim,
  TICK_DT,
  traceRay,
  type Tuple3,
  viewDir,
  WeaponId,
  weaponDef,
} from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { InputFrame } from '../../../core/input/InputManager';
import { type Settings, settings } from '../../../core/settings';
import { toast } from '../../../core/ui/overlays';
import { Projectiles } from '../render/Projectiles';
import { RecoilController } from '../render/RecoilController';
import { WEAPON_VISUALS } from '../render/weaponVisuals';
import { TEAM_COLORS } from '../ui/Scoreboard';
import { AimAssist } from './AimAssist';
import { type AimTarget, AutoShoot, buildAimTargets, fireBit } from './AutoShoot';
import { type ArenaClient, type ArenaFeature, BASE_FOV, type RemotePose } from './types';

/** Tracers stop here even when the shot flies on (the far end of a big map). */
const TRACER_MAX = 140;
/** Remote gunfire is heard this far. */
const SHOT_HEARING = 90;

const smooth = (x: number) => x * x * (3 - 2 * x);

export class WeaponFx implements ArenaFeature {
  readonly autoShoot = new AutoShoot();
  readonly projectiles: Projectiles;
  readonly recoil = new RecoilController();
  /** Dev and e2e: force the viewmodel to a weapon and ADS amount (weapon gallery screenshots). */
  preview: { weapon: WeaponId; ads: number } | null = null;
  private readonly aimAssist = new AimAssist();
  private readonly boltMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** Enemies as drawn in the last frame (auto-shoot, aim assist, own bolts' visual hits). */
  private targets: AimTarget[] = [];
  private autoWants = false;
  private lastLookDX = 0;
  private lastLookDY = 0;
  private shellReloading = false;
  private sleeve = -1;
  private readonly tmpV = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();

  constructor(readonly client: ArenaClient) {
    this.projectiles = new Projectiles(this.boltMaterial);
    client.scene.add(this.projectiles.mesh);
    client.viewmodel.onSound = (name, pitch, volume) => audio.play(name, { pitch, volume });
    client.viewmodel.setEffects(client.renderer.profile.effects);
    this.projectiles.onEnd = (e) => {
      const at: Tuple3 = e.pos;
      if (e.flesh) client.effects.impact(at, null, 0xff4f6b, 8);
      else {
        client.effects.impact(at, e.normal, 0xe8d6b0, 7);
        client.effects.dust(at, 4);
      }
      this.playAt(e.flesh ? 'bolt_flesh' : 'bolt_hit', at, 40, e.local ? 1 : 0.8);
    };
    this.projectiles.onWhoosh = (p) => this.playAt('bolt_fly', p, 10, 1);
    // The stored loadout and auto-shoot preference go to the authority once.
    const s = settings.get();
    client.backend.chooseLoadout(isPrimary(s.arenaPrimary) ? s.arenaPrimary : DEFAULT_PRIMARY, isSecondary(s.arenaSecondary) ? s.arenaSecondary : DEFAULT_SECONDARY);
    client.backend.setAutoShoot(s.autoShoot);
    this.showAutoShootSetting(s.autoShoot);
  }

  // ---- calls from ArenaGame ----------------------------------------------------------------

  /** Applies this frame's share of the camera recoil. */
  applyRecoil(dt: number): void {
    const c = this.client;
    const r = this.recoil.update(dt);
    c.pitch = Math.max(-1.45, Math.min(1.45, c.pitch + r.pitch));
    c.yaw += r.yaw;
  }

  /** FOV (deg) the camera eases toward for a live player: zooms in with the ADS progress. */
  fovTarget(p: PlayerSim): number {
    const def = weaponDef(p.weapons[p.slot].id);
    return BASE_FOV + (def.aimFov - BASE_FOV) * smooth(Math.max(0, Math.min(1, p.ads)));
  }

  /** A loadout card was picked: tell the authority and remember it. */
  pickLoadout(primary: WeaponId, secondary: WeaponId): void {
    this.client.backend.chooseLoadout(primary, secondary);
    settings.update({ arenaPrimary: primary, arenaSecondary: secondary });
  }

  /** Third-person held-item key for a weapon (AvatarPose.held). */
  heldKey(weapon: WeaponId): number {
    return weapon;
  }

  // ---- hooks ---------------------------------------------------------------------------------

  onMapLoaded(map: ArenaMap): void {
    this.client.viewmodel.setTint(new THREE.Color(1, 1, 1).lerp(new THREE.Color(map.theme.sky), 0.15));
    this.projectiles.clear();
    this.client.effects.clearDecals();
  }

  beforeCommands(input: InputFrame): void {
    const c = this.client;
    this.lastLookDX = input.lookYaw;
    this.lastLookDY = input.lookPitch;
    const phase = c.match.phase;
    const cam = c.camera.position;
    this.autoWants = this.autoShoot.update(performance.now(), {
      enabled: settings.get().autoShoot,
      canAct: c.input.isEnabled() && (c.touch !== null || c.kbm.isLocked()) && (phase === 'warmup' || phase === 'live'),
      p: c.predicted,
      eye: [cam.x, cam.y, cam.z],
      yaw: c.yaw,
      pitch: c.pitch,
      targets: this.targets,
      world: c.world,
    });
  }

  /** Auto-shoot's Fire bit for one command (manual fire is OR-ed by ArenaGame). */
  commandButtons(p: PlayerSim | null): number {
    if (!p) return 0;
    return fireBit(p, weaponDef(p.weapons[p.slot].id), this.autoWants) ? Buttons.Fire : 0;
  }

  onLocalCommand(ev: CommandEvents, p: PlayerSim): void {
    const c = this.client;
    const vm = c.viewmodel;
    if (ev.switched) vm.equip(p.weapons[p.slot].id);
    if (ev.shot) this.localShot(ev, p);
    if (ev.reloadStarted) vm.reloadStarted(p.weapons[p.slot].mag === 0);
    if (ev.shellLoaded) vm.shellInserted();
    if (ev.dryFire) audio.play('empty');
  }

  onEvent(e: ArenaEvent): void {
    const c = this.client;
    const me = c.backend.localId;
    switch (e.type) {
      case 'shot':
        if (e.shooter !== me) this.remoteShot(e);
        break;
      case 'proj': {
        if (e.shooter === me) {
          this.projectiles.onProj(e, me, 0, c.world, null);
          break;
        }
        const age = (c.backend.serverTick() - c.backend.interpDelayTicks() - e.tick) * TICK_DT;
        const muzzle = c.avatars.muzzleWorld(e.shooter, this.muzzle);
        this.projectiles.onProj(e, me, age, c.world, muzzle);
        this.playAt(WEAPON_VISUALS[e.weapon].sound, e.origin, 60, 0.9);
        break;
      }
      case 'projEnd':
        this.projectiles.onProjEnd(e);
        break;
      case 'hit':
        if (e.shooter === me && c.predicted && weaponDef(c.predicted.weapons[c.predicted.slot].id).kind === 'melee') audio.play('knife_hit');
        break;
      case 'spawn':
        if (e.id === me) this.recoil.reset();
        break;
      case 'phase':
        // In-flight bolts belong to the round that ended.
        this.projectiles.clear();
        if (e.phase === 'loadout' || e.phase === 'vote') c.effects.clearDecals();
        break;
    }
  }

  update(dt: number): void {
    const c = this.client;
    this.updateViewmodel(dt);
    this.updateHud();
    const cam = c.camera.position;
    this.projectiles.update(dt, this.targets, cam, (a, b) => c.effects.tracer(a, b, 0xffe2c0, 0.35, 0.06));
    c.hud.setAutoShoot(this.autoShoot.state);
  }

  /** Targets for the next frame's auto-shoot, and touch aim assist (setting-controlled). */
  lateUpdate(dt: number, input: InputFrame, remotes: ReadonlyMap<string, RemotePose>): void {
    const c = this.client;
    this.targets = buildAimTargets(remotes, (id) => c.isEnemy(id));
    const p = c.predicted;
    const alive = p?.alive ?? false;
    const def = p ? weaponDef(p.weapons[p.slot].id) : null;
    const range = !def ? 60 : def.kind === 'melee' ? 4 : Math.min(60, def.autoRange);
    const eye: [number, number, number] = [c.camera.position.x, c.camera.position.y, c.camera.position.z];
    c.input.touchLookMultiplier = this.aimAssist.update(dt, settings.get().aimAssist && input.touch && alive, eye, viewDir(c.yaw, c.pitch), this.targets, c.world, range);
  }

  onSettings(s: Readonly<Settings>, changed: readonly (keyof Settings)[]): void {
    if (!changed.includes('autoShoot')) return;
    this.client.backend.setAutoShoot(s.autoShoot);
    this.showAutoShootSetting(s.autoShoot);
    toast(s.autoShoot ? 'Auto-shoot on' : 'Auto-shoot off', 'info', 1600);
    audio.play(s.autoShoot ? 'autoshoot_on' : 'autoshoot_off');
    if (!s.autoShoot) this.autoShoot.reset();
  }

  dispose(): void {
    this.client.scene.remove(this.projectiles.mesh);
    this.projectiles.dispose();
    this.boltMaterial.dispose();
  }

  // ---- internals --------------------------------------------------------------------------------

  /** The Auto touch button and the "A" badge on Fire follow the setting. */
  private showAutoShootSetting(on: boolean): void {
    const t = this.client.touch;
    if (!t) return;
    t.setButton('auto', { active: on });
    t.el.querySelector('.touch-btn[data-id="fire"]')?.classList.toggle('auto', on);
  }

  private playAt(name: Parameters<typeof audio.play>[0], at: Tuple3 | THREE.Vector3, range: number, volume: number): void {
    const c = this.client;
    const x = Array.isArray(at) ? at[0] : at.x;
    const z = Array.isArray(at) ? at[2] : at.z;
    audio.playAt(name, x - c.camera.position.x, z - c.camera.position.z, c.yaw, range, volume);
  }

  /** Our own predicted shot: viewmodel, sound, recoil, tracers, impacts, bolts. */
  private localShot(ev: CommandEvents, p: PlayerSim): void {
    const c = this.client;
    const shot = ev.shot!;
    const def = weaponDef(shot.weapon);
    const vis = WEAPON_VISUALS[shot.weapon];
    c.viewmodel.fire(p.weapons[p.slot].mag);
    audio.play(vis.sound, { pitch: 0.96 + Math.random() * 0.08 });
    this.recoil.fire(shot.weapon, p.ads > 0.5);
    const muzzle = c.viewmodel.muzzleWorld(c.camera, this.muzzle);
    if (def.kind === 'projectile') {
      this.projectiles.spawnLocal(shot.weapon, shot.seq, [shot.ox, shot.oy, shot.oz], shot.dirs[0], muzzle, c.world, c.backend.localId);
      return;
    }
    if (def.kind === 'melee') {
      // The knife rings off a wall it reaches (enemy hits are confirmed by the server's 'hit').
      for (const [dx, dy, dz] of shot.dirs) {
        const r = traceRay(shot.ox, shot.oy, shot.oz, dx, dy, dz, def.range, c.world, this.targets);
        if (r.hitId) break;
        if (r.wall) {
          const at: Tuple3 = [shot.ox + dx * r.t, shot.oy + dy * r.t, shot.oz + dz * r.t];
          c.effects.impact(at, [r.wall.nx, r.wall.ny, r.wall.nz], 0xffe2a0, 5);
          audio.play('knife_hit', { pitch: 1.2 });
          break;
        }
      }
      return;
    }
    for (const [dx, dy, dz] of shot.dirs) {
      const r = traceRay(shot.ox, shot.oy, shot.oz, dx, dy, dz, Math.min(def.range, TRACER_MAX), c.world, this.targets);
      const end: Tuple3 = [shot.ox + dx * r.t, shot.oy + dy * r.t, shot.oz + dz * r.t];
      if (vis.tracer) c.effects.tracer(muzzle, end, vis.tracer.color, vis.tracer.width, vis.tracer.life);
      if (!r.hitId && r.wall) {
        const n: Tuple3 = [r.wall.nx, r.wall.ny, r.wall.nz];
        c.effects.impact(end, n, 0xffe2a0, def.pellets > 1 ? 2 : 6);
        c.effects.decal(end, n);
      }
    }
  }

  /** Someone else's hitscan shot: flash at their drawn muzzle, tracers, impacts, sound. */
  private remoteShot(e: ArenaEvent & { type: 'shot' }): void {
    const c = this.client;
    const def = weaponDef(e.weapon);
    const vis = WEAPON_VISUALS[e.weapon];
    this.playAt(vis.sound, e.origin, def.kind === 'melee' ? 30 : SHOT_HEARING, 0.9);
    if (def.kind === 'melee') return;
    const [ox, oy, oz] = e.origin;
    let muzzle: Tuple3;
    const drawn = c.avatars.muzzleWorld(e.shooter, this.muzzle);
    if (drawn) muzzle = [drawn.x, drawn.y, drawn.z];
    else {
      const first = e.ends[0] ?? e.origin;
      const d = this.tmpV.set(first[0] - ox, first[1] - oy, first[2] - oz).normalize();
      muzzle = [ox + d.x * 0.6, oy - 0.25 + d.y * 0.6, oz + d.z * 0.6];
    }
    if (vis.flash) c.effects.muzzleFlash(muzzle, vis.flash.size, vis.flash.color);
    e.ends.forEach((end, i) => {
      if (vis.tracer) c.effects.tracer(muzzle, end, vis.tracer.color, vis.tracer.width, vis.tracer.life);
      const n = e.normals[i];
      if (!e.hits[i] && n) {
        c.effects.impact(end, n, 0xffe2a0, def.pellets > 1 ? 2 : 5);
        c.effects.decal(end, n);
      }
    });
  }

  private updateViewmodel(dt: number): void {
    const c = this.client;
    const p = c.predicted;
    const pv = this.preview;
    const weapon = pv ? pv.weapon : p ? p.weapons[p.slot].id : WeaponId.Rifle;
    const def = weaponDef(weapon);
    const vis = WEAPON_VISUALS[weapon];
    const ads = pv ? pv.ads : (p?.ads ?? 0);
    const scopeKind = vis.optic === 'scope' ? 'scope' : vis.optic === 'optic2x' ? 'optic' : null;
    const live = pv !== null || !!p?.alive;
    const scoped = scopeKind !== null && ads > 0.9 && live;
    const reloading = !pv && !!p && p.reload > 0;
    const shellReload = reloading && def.reloadKind === 'shell';
    if (this.shellReloading && !shellReload) c.viewmodel.reloadEnded();
    this.shellReloading = shellReload;
    this.updateSleeve();
    c.viewmodel.update(dt, {
      weapon,
      ads,
      reload: reloading && !shellReload ? 1 - p!.reload / def.reloadTime : -1,
      shellReload,
      draw: !pv && p && p.switching > 0 ? 1 - p.switching / def.drawTime : -1,
      mag: pv ? def.magazine : p ? p.weapons[p.slot].mag : 0,
      speed: p && !pv ? Math.hypot(p.vx, p.vz) : 0,
      onGround: p?.onGround ?? true,
      sliding: !pv && !!p?.sliding,
      lookDX: this.lastLookDX,
      lookDY: this.lastLookDY,
      visible: live && !scoped,
    });
    c.hud.setScope(scoped ? scopeKind : null);
  }

  /** Sleeves in the team colour (team modes) or the player's colour (free-for-all). */
  private updateSleeve(): void {
    const c = this.client;
    const me = c.match.players.find((q) => q.id === c.backend.localId);
    if (!me) return;
    const color = c.match.mode === 'ffa' ? me.color : (TEAM_COLORS[me.team] ?? me.color);
    if (color === this.sleeve) return;
    this.sleeve = color;
    c.viewmodel.setSleeve(color);
  }

  /** Ammo panel, crosshair (per-weapon style, spread gap, crossbow drop marks). */
  private updateHud(): void {
    const c = this.client;
    const p = c.predicted;
    if (!p) {
      c.hud.setCrosshair(10, false);
      return;
    }
    const w = p.weapons[p.slot];
    const def = weaponDef(w.id);
    const vis = WEAPON_VISUALS[w.id];
    const shell = def.reloadKind === 'shell' && p.reload > 0;
    const progress = p.reload > 0 ? (shell ? w.mag / def.magazine : 1 - p.reload / def.reloadTime) : 0;
    c.hud.setAmmo(w.mag, w.reserve, def.name, def.magazine === 0, progress, vis.mode);
    c.hud.setWeaponIcon(w.id);
    const halfFov = Math.tan(THREE.MathUtils.degToRad(c.fov) / 2);
    const px = (angle: number) => (Math.tan(angle) / halfFov) * (c.renderer.height / 2);
    const gap = Math.min(80, px(currentSpread(p)) + 5);
    // Real sights take over once mostly aimed (the shotgun keeps its spread ring).
    const sightsUp = p.ads > 0.6 && def.kind !== 'melee' && vis.crosshair !== 'ring';
    c.hud.setCrosshair(gap, p.alive && !sightsUp, vis.crosshair);
    if (def.projectile) {
      const drop = (d: number) => Math.atan((0.5 * def.projectile!.gravity * (d / def.projectile!.speed) ** 2) / d);
      c.hud.setChevron(px(drop(30)), px(drop(60)));
    }
  }
}
