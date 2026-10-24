/**
 * Weapon presentation: local and remote shot visuals and sounds, recoil, the
 * first-person viewmodel, the ammo / crosshair / scope HUD and touch aim assist.
 * Weapon models, auto-shoot and the loadout picker grow here (design-arena-weapons).
 */
import * as THREE from 'three';
import { type ArenaEvent, type CommandEvents, currentSpread, type PlayerSim, viewDir, WeaponId, weaponDef } from '@hub/shared';
import { audio, type SfxName } from '../../../core/audio/audio';
import type { InputFrame } from '../../../core/input/InputManager';
import { settings } from '../../../core/settings';
import { AimAssist } from '../AimAssist';
import { type ArenaClient, type ArenaFeature, BASE_FOV, type RemotePose } from './types';

const SHOT_SOUND: Record<WeaponId, SfxName> = {
  [WeaponId.Rifle]: 'rifle',
  [WeaponId.Shotgun]: 'shotgun',
  [WeaponId.Sniper]: 'sniper',
  [WeaponId.Pistol]: 'pistol',
  [WeaponId.Blade]: 'melee',
};

export class WeaponFx implements ArenaFeature {
  private recoilKick = 0;
  private recoilReturn = 0;
  private lastLookDX = 0;
  private lastLookDY = 0;
  private readonly aimAssist = new AimAssist();
  private readonly tmpV = new THREE.Vector3();

  constructor(readonly client: ArenaClient) {}

  // ---- calls from ArenaGame ----------------------------------------------------------------

  /** Kicks the view up quickly, then lets ~70% of it settle back. */
  applyRecoil(dt: number): void {
    const c = this.client;
    const k = Math.min(1, dt * 30);
    const kick = this.recoilKick * k;
    this.recoilKick -= kick;
    c.pitch = Math.min(1.45, c.pitch + kick);
    this.recoilReturn += kick * 0.7;
    const back = this.recoilReturn * Math.min(1, dt * 6);
    this.recoilReturn -= back;
    c.pitch -= back;
  }

  /** FOV (deg) the camera eases toward for a live player. */
  fovTarget(p: PlayerSim): number {
    return p.aiming ? weaponDef(p.weapons[p.slot].id).aimFov : BASE_FOV;
  }

  /** A loadout card was picked. */
  pickLoadout(primary: WeaponId, secondary: WeaponId): void {
    this.client.backend.chooseLoadout(primary, secondary);
  }

  /** Third-person held-item key for a weapon (AvatarPose.held). */
  heldKey(weapon: WeaponId): number {
    return weapon;
  }

  // ---- hooks ---------------------------------------------------------------------------------

  beforeCommands(input: InputFrame): void {
    this.lastLookDX = input.lookYaw;
    this.lastLookDY = input.lookPitch;
  }

  onLocalCommand(ev: CommandEvents, p: PlayerSim): void {
    const c = this.client;
    if (ev.shot) {
      const def = weaponDef(ev.shot.weapon);
      c.viewmodel.fire();
      audio.play(SHOT_SOUND[ev.shot.weapon], { pitch: 0.96 + Math.random() * 0.08 });
      this.recoilKick += def.recoil * (p.aiming ? 0.6 : 1);
      c.yaw += (Math.random() - 0.5) * def.recoilYaw;
      if (ev.shot.weapon !== WeaponId.Blade) {
        const muzzle = c.viewmodel.muzzleWorld(c.camera, this.tmpV.set(0, 0, 0));
        for (const [dx, dy, dz] of ev.shot.dirs) {
          const hit = c.world.raycast(ev.shot.ox, ev.shot.oy, ev.shot.oz, dx, dy, dz, def.range);
          const t = hit ? hit.t : Math.min(def.range, 80);
          const end: [number, number, number] = [ev.shot.ox + dx * t, ev.shot.oy + dy * t, ev.shot.oz + dz * t];
          c.effects.tracer(muzzle, end);
          if (hit) c.effects.impact(end, [hit.nx, hit.ny, hit.nz], 0xffe2a0, def.pellets > 1 ? 2 : 6);
        }
      }
    }
    if (ev.reloadStarted) audio.play('reload');
    if (ev.dryFire) audio.play('empty');
    if (ev.switched) audio.play('click', { pitch: 0.8 });
  }

  onEvent(e: ArenaEvent): void {
    const c = this.client;
    const me = c.backend.localId;
    switch (e.type) {
      case 'shot': {
        if (e.shooter === me) return; // already predicted locally
        const def = weaponDef(e.weapon);
        const [ox, oy, oz] = e.origin;
        const first = e.ends[0];
        if (first && e.weapon !== WeaponId.Blade) {
          const d = this.tmpV.set(first[0] - ox, first[1] - oy, first[2] - oz).normalize();
          const muzzle: [number, number, number] = [ox + d.x * 0.6, oy - 0.25 + d.y * 0.6, oz + d.z * 0.6];
          c.effects.muzzleFlash(muzzle);
          e.ends.forEach((end, i) => {
            c.effects.tracer(muzzle, end, 0xffc68a);
            if (!e.hits[i] && e.normals[i]) c.effects.impact(end, e.normals[i], 0xffe2a0, def.pellets > 1 ? 2 : 5);
          });
        }
        audio.playAt(SHOT_SOUND[e.weapon], ox - c.camera.position.x, oz - c.camera.position.z, c.yaw, 70, 0.9);
        break;
      }
      case 'spawn':
        if (e.id === me) this.recoilKick = this.recoilReturn = 0;
        break;
    }
  }

  update(dt: number): void {
    this.updateViewmodel(dt);
    this.updateHud();
  }

  /** Aim assist for the next frame (touch only, setting-controlled). */
  lateUpdate(dt: number, input: InputFrame, remotes: ReadonlyMap<string, RemotePose>): void {
    const c = this.client;
    const alive = c.predicted?.alive ?? false;
    const eye: [number, number, number] = [c.camera.position.x, c.camera.position.y, c.camera.position.z];
    const enemies = [...remotes.entries()].filter(([id, p]) => p.alive && c.isEnemy(id)).map(([, p]) => p);
    c.input.touchLookMultiplier = this.aimAssist.update(dt, settings.get().aimAssist && input.touch && alive, eye, viewDir(c.yaw, c.pitch), enemies, c.world);
  }

  // ---- internals --------------------------------------------------------------------------------

  private updateViewmodel(dt: number): void {
    const c = this.client;
    const p = c.predicted;
    const weapon = p ? p.weapons[p.slot].id : WeaponId.Rifle;
    const def = weaponDef(weapon);
    const scoped = !!p && p.aiming && weapon === WeaponId.Sniper && c.fov < def.aimFov + 6;
    c.viewmodel.update(dt, {
      weapon,
      aiming: !!p?.aiming,
      reload: p && p.reload > 0 ? 1 - p.reload / def.reloadTime : -1,
      draw: p && p.switching > 0 ? 1 - p.switching / def.drawTime : -1,
      speed: p ? Math.hypot(p.vx, p.vz) : 0,
      onGround: p?.onGround ?? true,
      lookDX: this.lastLookDX,
      lookDY: this.lastLookDY,
      visible: !!p?.alive && !scoped,
    });
    c.hud.setScope(scoped ? 'scope' : null);
  }

  /** Ammo panel and crosshair. */
  private updateHud(): void {
    const c = this.client;
    const p = c.predicted;
    if (p) {
      const w = p.weapons[p.slot];
      const def = weaponDef(w.id);
      c.hud.setAmmo(w.mag, w.reserve, def.name, def.magazine === 0, p.reload > 0 ? 1 - p.reload / def.reloadTime : 0);
      const spread = currentSpread(p);
      const gap = (Math.tan(spread) / Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) * (c.renderer.height / 2) + 5;
      c.hud.setCrosshair(Math.min(80, gap), p.alive && !(p.aiming && w.id === WeaponId.Sniper));
    } else {
      c.hud.setCrosshair(10, false);
    }
  }
}
