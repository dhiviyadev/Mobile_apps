/**
 * First-person weapon and hands, drawn in their own scene after the world (depth cleared) so they never
 * clip into walls.
 *
 * Each weapon is built once from its spec (weaponKit/weaponSpecs) as three meshes (static body,
 * magazine, action) in one shared shader, so a weapon costs at most three draw calls whatever it is
 * made of; the gloved hands, the muzzle flash and the casings are one call each. The rig:
 *  - aims down sights by moving the weapon so its sight anchor lands on the view axis (computed from
 *    the model, driven by the predicted `ads`, so sight picture, spread and FOV agree);
 *  - cycles its action on every shot (carrier, pistol slide, pump, bolt, cylinder, crossbow string),
 *    ejects casings, kicks per weapon and flashes per muzzle device;
 *  - plays a keyframed reload per weapon type (magazine, box, shell by shell, bolt, cylinder, crossbow),
 *    with the left hand fetching the magazine and the mechanical sounds on their keyframes;
 *  - draws in with an overshoot, bobs and sways, and leans into slides.
 */
import * as THREE from 'three';
import { WeaponId, weaponDef } from '@hub/shared';
import type { SfxName } from '../../../core/audio/sfx';
import { ShellEjector } from './ShellEjector';
import { buildParts, buildWeapon, type BuiltWeapon, createWeaponMaterial, type V3 } from './weaponKit';
import { buildHand, type HandPose, STRING, WEAPON_SPECS } from './weaponSpecs';
import { type FlashStyle, WEAPON_VISUALS, type WeaponVisual } from './weaponVisuals';

/** Models are authored at real-world size; the viewmodel draws them smaller and closer. */
export const MODEL_SCALE = 0.45;
/** Distance (m) from the eye to the sight when fully aimed. */
const EYE_RELIEF = 0.12;

export interface ViewmodelState {
  weapon: WeaponId;
  /** Predicted aim-down-sights progress 0..1. */
  ads: number;
  /** 0..1 progress of a magazine reload (1 − reload / reloadTime), or −1. */
  reload: number;
  /** A shell-by-shell reload is running. */
  shellReload: boolean;
  /** 0..1 progress of drawing the weapon, or −1. */
  draw: number;
  /** Rounds in the magazine. */
  mag: number;
  speed: number;
  onGround: boolean;
  sliding: boolean;
  lookDX: number;
  lookDY: number;
  visible: boolean;
}

/** One weapon's meshes, built on first use and kept. */
interface Rig {
  id: WeaponId;
  group: THREE.Group;
  body: THREE.Mesh;
  mag: THREE.Mesh | null;
  act: THREE.Mesh | null;
  string: THREE.InstancedMesh | null;
  built: BuiltWeapon;
  vis: WeaponVisual;
  hip: THREE.Vector3;
  ads: THREE.Vector3;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0→1 between a and b. */
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Reload keyframes: [t, sound, pitch]. Sounds fire when the progress crosses t. */
const RELOAD_SOUNDS: Record<string, [number, SfxName, number][]> = {
  mag: [[0.12, 'mag_out', 1], [0.68, 'mag_in', 1]],
  box: [[0.08, 'charge', 0.7], [0.2, 'mag_out', 0.85], [0.62, 'mag_in', 0.85], [0.8, 'charge', 0.8]],
  bolt: [[0.08, 'bolt_cycle', 1], [0.2, 'mag_out', 1], [0.66, 'mag_in', 1], [0.88, 'charge', 1.1]],
  cylinder: [[0.08, 'cylinder', 1], [0.25, 'casing', 1], [0.6, 'mag_in', 1.3], [0.82, 'cylinder', 1.1]],
  crossbow: [[0.02, 'xbow_cock', 1], [0.6, 'click', 1.4], [0.82, 'mag_in', 1.4]],
};

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(56, 1, 0.01, 10);
  /** Mechanical sounds on animation keyframes (set by the owner; silent by default). */
  onSound: (name: SfxName, pitch?: number, volume?: number) => void = () => {};
  private readonly root = new THREE.Group();
  private readonly material = createWeaponMaterial();
  private readonly flashMaterial: THREE.MeshBasicMaterial;
  private readonly flashes = new Map<FlashStyle, THREE.Mesh>();
  private readonly rigs = new Map<WeaponId, Rig>();
  private readonly handGeos = new Map<HandPose, THREE.BufferGeometry>();
  private readonly handR: THREE.Mesh;
  private readonly handL: THREE.Mesh;
  private readonly shells: ShellEjector;
  private rig: Rig;
  private flash: THREE.Mesh | null = null;
  private time = 0;
  private lastShot = -1e9;
  private readonly pending: { at: number; name: SfxName; shot: number }[] = [];
  private kick = 0;
  private kickRoll = 1;
  private flashTime = 0;
  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  private slideK = 0;
  private slash = 0;
  private slashDir = 1;
  private slideLocked = false;
  private cylinderTurns = 0;
  private cylinderAngle = 0;
  private ejectAt = -1;
  private prevReload = -1;
  private reloadFromEmpty = false;
  private shellTilt = 0;
  private shellPush = -1;
  private shellsLoaded = 0;
  private rackAt = -1;
  private boltLoaded = true;
  private readonly pos = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly mat4 = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();

  constructor() {
    this.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(this.root);
    this.flashMaterial = new THREE.MeshBasicMaterial({
      map: makeFlashTexture(),
      color: 0xffe0a0,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.handR = new THREE.Mesh(this.handGeo('grip'), this.material);
    this.handL = new THREE.Mesh(this.handGeo('under'), this.material);
    for (const m of [this.handR, this.handL]) m.frustumCulled = false;
    this.shells = new ShellEjector(this.material, MODEL_SCALE);
    this.scene.add(this.shells.mesh);
    this.rig = this.ensureRig(WeaponId.Rifle);
    this.attach(this.rig);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** A little of the map's sky in the weapon's colours. */
  setTint(color: THREE.Color): void {
    (this.material.uniforms.uTint.value as THREE.Color).copy(color);
  }

  /** Sleeve colour (team or player colour). */
  setSleeve(hex: number): void {
    (this.material.uniforms.uSleeve.value as THREE.Color).setHex(hex, THREE.LinearSRGBColorSpace).multiplyScalar(0.8);
  }

  /** Low quality keeps fewer casings in the air. */
  setEffects(level: number): void {
    this.shells.setMax(level < 0.75 ? 8 : 24);
  }

  get current(): WeaponId {
    return this.rig.id;
  }

  /** Draw calls the visible viewmodel costs (for the budget test). */
  get meshCount(): number {
    let n = 0;
    this.scene.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) n++;
    });
    return n;
  }

  // ---- events --------------------------------------------------------------------------------

  /** A local shot of the held weapon; `magAfter` = rounds left. */
  fire(magAfter: number): void {
    const r = this.rig;
    const v = r.vis;
    this.lastShot = this.time;
    this.kick = Math.min(1.25, this.kick * 0.5 + 1);
    this.kickRoll = Math.random() < 0.5 ? -1 : 1;
    if (r.id === WeaponId.Blade) {
      this.slash = 1;
      this.slashDir = -this.slashDir;
      return;
    }
    if (v.flash) this.showFlash(v.flash.style, v.flash.size, v.flash.color);
    if (v.eject !== 'none') this.ejectAt = this.time + v.ejectDelay;
    if (v.action === 'slide' && magAfter === 0) this.slideLocked = true;
    if (v.action === 'cylinder') this.cylinderTurns++;
    if (v.action === 'string') this.boltLoaded = false;
    if (v.action === 'pump') this.onSoundAt(0.18, 'pump');
    if (v.action === 'bolt' && magAfter > 0) this.onSoundAt(0.3, 'bolt_cycle');
  }

  /** The shotgun took one shell. */
  shellInserted(): void {
    this.shellPush = this.time;
    this.shellsLoaded++;
    this.onSound('shell_in', 0.95 + Math.random() * 0.1);
  }

  /** A reload started; `empty` = the magazine was empty (charging handle, pump rack at the end). */
  reloadStarted(empty: boolean): void {
    this.reloadFromEmpty = empty;
    this.shellsLoaded = 0;
    this.prevReload = 0;
  }

  /** A shell reload ended (full, cancelled by firing, or switched away). */
  reloadEnded(): void {
    if (this.rig.vis.reloadAnim === 'shell' && this.reloadFromEmpty && this.shellsLoaded > 0) {
      this.rackAt = this.time;
      this.onSound('pump');
    }
    this.reloadFromEmpty = false;
  }

  /** Switched to a weapon: it draws in from below. */
  equip(weapon: WeaponId): void {
    this.setWeapon(weapon);
    this.onSound('equip');
  }

  /** World position of the muzzle as drawn: the viewmodel muzzle's screen point at ~0.6 m in the world camera. */
  muzzleWorld(mainCamera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    const r = this.rig;
    this.root.updateMatrixWorld();
    const ndc = this.tmp.set(...r.built.anchors.muzzle).applyMatrix4(r.group.matrixWorld).project(this.camera);
    const dir = this.tmp2.set(ndc.x, ndc.y, 0.5).unproject(mainCamera).sub(mainCamera.position).normalize();
    return out.copy(mainCamera.position).addScaledVector(dir, 0.6);
  }

  // ---- per frame -----------------------------------------------------------------------------

  update(dt: number, s: ViewmodelState): void {
    this.time += dt;
    if (s.weapon !== this.rig.id) this.setWeapon(s.weapon);
    const r = this.rig;
    const v = r.vis;
    const a = r.built.anchors;
    this.root.visible = s.visible;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      if (this.time < q.at) continue;
      this.pending.splice(i, 1);
      if (q.shot === this.lastShot) this.onSound(q.name);
    }

    // Aim, kick, bob, sway and the slide lean (design-arena-movement §7.3).
    const ease = smooth(clamp01(s.ads));
    this.kick = Math.max(0, this.kick - dt * v.recoil.recover);
    this.slash = Math.max(0, this.slash - dt * 4);
    this.slideK += ((s.sliding ? 1 : 0) - this.slideK) * Math.min(1, dt * 12);
    if (s.onGround && !s.sliding) this.bob += dt * Math.min(1.5, s.speed / 6) * 8;
    this.swayX += (-s.lookDX * 0.6 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (s.lookDY * 0.6 - this.swayY) * Math.min(1, dt * 10);
    const p = this.pos.copy(r.hip).lerp(r.ads, ease);
    const bobAmt = (1 - ease * 0.85) * Math.min(1, s.speed / 7);
    const steady = 1 - ease * 0.8;
    p.x += Math.cos(this.bob) * 0.012 * bobAmt + this.swayX * 0.04 * steady - 0.03 * this.slideK;
    p.y += Math.abs(Math.sin(this.bob)) * 0.014 * bobAmt + this.swayY * 0.04 * steady;
    p.y -= 0.025 * this.slideK + (Math.random() - 0.5) * 0.002 * this.slideK;
    p.z += this.kick * v.recoil.back * MODEL_SCALE * 1.6 * (1 - ease * 0.6);
    let rx = this.kick * v.recoil.up * (1 - ease * 0.6) + 0.05 * this.slideK;
    let ry = 0;
    let rz = this.kick * v.recoil.roll * this.kickRoll + 0.32 * this.slideK;

    // Reloads move the weapon, its parts and the left hand.
    const left = this.left.set(...a.gripL);
    let leftVisible = a.leftHand !== 'none';
    this.resetParts(r, s);
    if (s.reload >= 0 && v.reloadAnim !== 'shell') {
      this.reloadSounds(v.reloadAnim, s.reload);
      const tilt = smooth(seg(s.reload, 0, 0.12)) * (1 - smooth(seg(s.reload, 0.85, 1)));
      rz += 0.35 * tilt;
      rx -= 0.15 * tilt;
      p.y -= 0.02 * tilt;
      leftVisible = this.animateReload(r, s.reload, left) && leftVisible;
    } else if (v.reloadAnim !== 'shell') {
      this.prevReload = -1;
      if (this.slideLocked && s.mag > 0) this.slideLocked = false;
    }
    // Shell by shell: the gun rolls over and the left hand pushes each shell into the loading port.
    this.shellTilt += ((s.shellReload ? 1 : 0) - this.shellTilt) * Math.min(1, dt * 8);
    if (v.reloadAnim === 'shell' && this.shellTilt > 0.01) {
      const tilt = smooth(this.shellTilt);
      rz += 0.45 * tilt;
      rx -= 0.1 * tilt;
      const push = this.shellPush >= 0 ? seg(this.time - this.shellPush, 0, 0.18) : 1;
      const port = this.tmp.set(a.magPivot[0] + 0.01, a.magPivot[1] - 0.03, a.magPivot[2] + 0.03 + 0.04 * (1 - Math.sin(push * Math.PI)));
      left.lerp(port, tilt);
      if (r.mag) {
        r.mag.visible = s.shellReload;
        r.mag.position.set(a.magPivot[0], a.magPivot[1], a.magPivot[2] + 0.07 * (1 - smooth(push)));
      }
    }

    // Draw (switch) animation with a little overshoot.
    if (s.draw >= 0) {
      const e = easeOutBack(clamp01(s.draw));
      p.y -= 0.16 * (1 - e);
      rx -= 0.6 * (1 - e);
    }
    // Knife slashes alternate left→right and right→left.
    if (this.slash > 0) {
      const t = Math.sin(this.slash * Math.PI);
      p.x -= t * 0.08 * this.slashDir;
      ry += t * 0.8 * this.slashDir;
      rz -= t * 0.35 * this.slashDir;
      rx -= t * 0.2;
    }
    this.root.position.copy(p);
    this.root.rotation.set(rx, ry, rz);

    this.animateAction(r, s, dt);

    // Left hand (rides the pump on the shotgun).
    this.handL.visible = leftVisible;
    if (leftVisible) {
      if (v.action === 'pump' && r.act && this.shellTilt < 0.02) left.z += r.act.position.z - a.actPivot[2];
      this.handL.position.copy(left);
    }

    // Casings and the muzzle flash.
    if (this.ejectAt >= 0 && this.time >= this.ejectAt) {
      this.ejectAt = -1;
      if (a.eject) {
        this.root.updateMatrixWorld();
        this.shells.spawn(this.tmp.set(...a.eject).applyMatrix4(r.group.matrixWorld), v.eject);
      }
    }
    this.shells.update(dt);
    this.flashTime -= dt;
    if (this.flash) this.flash.visible = this.flashTime > 0 && s.visible;
  }

  dispose(): void {
    for (const r of this.rigs.values()) {
      r.body.geometry.dispose();
      r.mag?.geometry.dispose();
      r.act?.geometry.dispose();
      r.string?.geometry.dispose();
    }
    for (const g of this.handGeos.values()) g.dispose();
    for (const f of this.flashes.values()) f.geometry.dispose();
    this.shells.dispose();
    this.material.dispose();
    this.flashMaterial.map?.dispose();
    this.flashMaterial.dispose();
  }

  // ---- internals -----------------------------------------------------------------------------

  private handGeo(pose: HandPose): THREE.BufferGeometry {
    let g = this.handGeos.get(pose);
    if (!g) {
      g = buildParts((k) => buildHand(k, pose));
      this.handGeos.set(pose, g);
    }
    return g;
  }

  private ensureRig(id: WeaponId): Rig {
    let r = this.rigs.get(id);
    if (r) return r;
    const built = buildWeapon(WEAPON_SPECS[id], 'fp');
    const a = built.anchors;
    const group = new THREE.Group();
    const mesh = (g: THREE.BufferGeometry | null, at: V3): THREE.Mesh | null => {
      if (!g) return null;
      const m = new THREE.Mesh(g, this.material);
      m.position.set(...at);
      m.frustumCulled = false;
      group.add(m);
      return m;
    };
    const body = mesh(built.body, [0, 0, 0])!;
    const mag = mesh(built.mag, a.magPivot);
    const act = mesh(built.act, a.actPivot);
    let string: THREE.InstancedMesh | null = null;
    if (a.limbTips && a.nockRest) {
      const geo = buildParts((k) => k.cyl(0.0022, 1, 'y', [0, 0.5, 0], { c: STRING, ch: 'M', seg: 4 }));
      string = new THREE.InstancedMesh(geo, this.material, 2);
      string.frustumCulled = false;
      group.add(string);
    }
    const vis = WEAPON_VISUALS[id];
    // ADS is computed, not tuned: the sight anchor lands on the view axis, EYE_RELIEF in front of the eye.
    const S = MODEL_SCALE;
    const adsPos = new THREE.Vector3(-a.sight[0] * S, -a.sight[1] * S, -EYE_RELIEF - a.sight[2] * S);
    r = { id, group, body, mag, act, string, built, vis, hip: v3(vis.hip), ads: id === WeaponId.Blade ? v3(vis.hip) : adsPos };
    this.rigs.set(id, r);
    return r;
  }

  private attach(r: Rig): void {
    const a = r.built.anchors;
    this.root.add(r.group);
    r.group.add(this.handR, this.handL);
    this.handR.geometry = this.handGeo(r.id === WeaponId.Blade ? 'knife' : 'grip');
    this.handR.position.set(...a.gripR);
    // The fist follows the grip's backward slant.
    const def = weaponDef(r.id);
    this.handR.rotation.set(r.id === WeaponId.Blade ? 0 : def.slot === 1 ? -0.3 : -0.2, 0, 0);
    this.handL.geometry = this.handGeo(a.leftHand === 'none' ? 'under' : a.leftHand);
    this.handL.rotation.set(a.leftHand === 'vertical' ? -0.08 : 0, 0, 0);
    this.handL.position.set(...a.gripL);
    if (r.vis.flash) this.attachFlash(r);
  }

  private setWeapon(id: WeaponId): void {
    if (id === this.rig.id) return;
    this.root.remove(this.rig.group);
    this.rig = this.ensureRig(id);
    this.attach(this.rig);
    this.kick = this.slash = 0;
    this.slideLocked = false;
    this.ejectAt = -1;
    this.flashTime = 0;
    this.shellTilt = 0;
    this.shellPush = -1;
    this.rackAt = -1;
    this.prevReload = -1;
    this.lastShot = -1e9;
    this.boltLoaded = true;
    this.cylinderAngle = this.cylinderTurns * (Math.PI / 3);
  }

  /** Puts the moving parts back to rest before this frame's animation. */
  private resetParts(r: Rig, s: ViewmodelState): void {
    const a = r.built.anchors;
    if (r.mag) {
      r.mag.position.set(...a.magPivot);
      r.mag.rotation.set(0, 0, 0);
      const hiddenAtRest = r.vis.reloadAnim === 'shell' || r.vis.reloadAnim === 'cylinder';
      r.mag.visible = !hiddenAtRest;
      if (r.vis.action === 'string') {
        if (s.mag > 0 && s.reload < 0) this.boltLoaded = true;
        r.mag.visible = this.boltLoaded && s.mag > 0;
      }
    }
    if (r.act) {
      r.act.position.set(...a.actPivot);
      r.act.rotation.set(0, 0, 0);
    }
  }

  /** The action cycle after a shot (and the pump rack after a shell reload). */
  private animateAction(r: Rig, s: ViewmodelState, dt: number): void {
    const v = r.vis;
    const t = this.time - this.lastShot;
    const act = r.act;
    switch (v.action) {
      case 'carrier':
        if (act) act.position.z += 0.02 * (t < 0.03 ? t / 0.03 : clamp01(1 - (t - 0.03) / 0.03));
        break;
      case 'slide':
        if (act) act.position.z += this.slideLocked ? 0.03 : 0.03 * (t < 0.03 ? t / 0.03 : clamp01(1 - (t - 0.03) / 0.04));
        break;
      case 'pump': {
        const rack = Math.max(this.pumpCurve(t), this.rackAt >= 0 ? this.pumpCurve(this.time - this.rackAt + 0.18) : 0);
        if (act) act.position.z += 0.09 * rack;
        break;
      }
      case 'bolt': {
        if (!act) break;
        const k = this.boltCurve(t);
        act.rotation.z = 1.0 * k.lift;
        act.position.z += 0.08 * k.back;
        break;
      }
      case 'cylinder': {
        // The cylinder turns 60° per shot (about 0.1 s).
        const target = this.cylinderTurns * (Math.PI / 3);
        this.cylinderAngle += (target - this.cylinderAngle) * Math.min(1, dt * 30);
        if (act && s.reload < 0) act.rotation.z = this.cylinderAngle;
        break;
      }
      case 'string':
        this.updateString(r, s);
        break;
    }
  }

  /** Pump travel 0..1 for the time since the shot: back over .18–.30 s, forward over .30–.42 s. */
  private pumpCurve(t: number): number {
    return smooth(seg(t, 0.18, 0.3)) * (1 - smooth(seg(t, 0.3, 0.42)));
  }

  /** Bolt-action cycle .25–.85 s: lift, pull back, push forward, lock down. */
  private boltCurve(t: number): { lift: number; back: number } {
    const lift = smooth(seg(t, 0.25, 0.33)) * (1 - smooth(seg(t, 0.75, 0.85)));
    const back = smooth(seg(t, 0.33, 0.5)) * (1 - smooth(seg(t, 0.6, 0.75)));
    return { lift, back };
  }

  /** Crossbow string from limb tip to nock to limb tip; the nock is drawn back while loaded. */
  private updateString(r: Rig, s: ViewmodelState): void {
    const a = r.built.anchors;
    if (!r.string || !a.limbTips || !a.nockRest || !a.nockDrawn) return;
    let drawn: number;
    if (s.reload >= 0) drawn = smooth(seg(s.reload, 0.05, 0.6)) ** 1.4;
    else drawn = this.boltLoaded && s.mag > 0 ? 1 : 1 - clamp01((this.time - this.lastShot) / 0.03);
    if (!this.boltLoaded && s.reload < 0) drawn = 0;
    const nock = this.tmp.set(...a.nockRest).lerp(this.tmp2.set(...a.nockDrawn), drawn);
    for (let i = 0; i < 2; i++) {
      const tip = new THREE.Vector3(...a.limbTips[i]);
      const dir = tip.clone().sub(nock);
      const len = dir.length();
      this.quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      this.mat4.compose(nock, this.quat, new THREE.Vector3(1, len, 1));
      r.string.setMatrixAt(i, this.mat4);
    }
    r.string.instanceMatrix.needsUpdate = true;
    // The loaded bolt slides onto the rail late in the reload.
    if (r.mag && s.reload >= 0) {
      const on = smooth(seg(s.reload, 0.65, 0.9));
      r.mag.visible = s.reload >= 0.65;
      r.mag.position.z = a.magPivot[2] + 0.25 * (1 - on);
      r.mag.position.y = a.magPivot[1] + 0.03 * (1 - on);
    }
  }

  /** Magazine-style reload: the parts and the left hand; returns whether the left hand is on screen. */
  private animateReload(r: Rig, t: number, left: THREE.Vector3): boolean {
    const v = r.vis;
    const a = r.built.anchors;
    const mag = r.mag;
    const act = r.act;
    // Timeline per kind: [grab, out, gone, back, in, done].
    const tl =
      v.reloadAnim === 'box' ? [0.12, 0.2, 0.36, 0.48, 0.62, 0.72]
        : v.reloadAnim === 'bolt' ? [0.12, 0.2, 0.36, 0.5, 0.66, 0.76]
          : v.reloadAnim === 'cylinder' ? [0.3, 0.4, 0.45, 0.5, 0.62, 0.72]
            : v.reloadAnim === 'crossbow' ? [0.6, 0.62, 0.62, 0.62, 0.65, 0.92]
              : [0.06, 0.12, 0.3, 0.5, 0.68, 0.8];
    const [grab, out, gone, back, into, done] = tl;
    const magDrop = -0.3;
    // Magazine leaves and comes back.
    if (mag && v.reloadAnim !== 'crossbow') {
      const down = smooth(seg(t, out, gone));
      const up = 1 - smooth(seg(t, back, into));
      const off = t < back ? down : up;
      if (v.reloadAnim === 'cylinder') {
        // Speedloader rises from below into the open cylinder.
        mag.visible = t > 0.4 && t < 0.66;
        mag.position.set(a.magPivot[0] - 0.04, a.magPivot[1] - 0.12 * (1 - smooth(seg(t, 0.4, 0.6))), a.magPivot[2] + 0.02);
      } else {
        mag.position.y = a.magPivot[1] + magDrop * off;
        mag.position.x = a.magPivot[0] + 0.03 * off;
        mag.rotation.x = -0.4 * off;
        mag.visible = !(t > gone && t < back);
      }
    }
    // The left hand reaches for the magazine, follows it down and brings the new one.
    const magPt = this.tmp.set(a.magPivot[0] + 0.02, a.magPivot[1] - 0.06, a.magPivot[2] + 0.02);
    const toMag = smooth(seg(t, grab - 0.08, grab));
    const offscreen = smooth(seg(t, out, gone)) * (1 - smooth(seg(t, back, into)));
    const home = smooth(seg(t, into, done));
    left.lerp(magPt, toMag * (1 - home));
    left.y += magDrop * offscreen;
    let leftOn = !(t > gone + 0.04 && t < back - 0.04);
    switch (v.reloadAnim) {
      case 'box':
        if (act) act.rotation.x = 0.9 * smooth(seg(t, 0.08, 0.18)) * (1 - smooth(seg(t, 0.75, 0.82)));
        break;
      case 'bolt':
        if (act) {
          const open = smooth(seg(t, 0.05, 0.12)) * (1 - smooth(seg(t, 0.82, 0.9)));
          act.rotation.z = 1.0 * open;
          act.position.z += 0.08 * smooth(seg(t, 0.08, 0.15)) * (1 - smooth(seg(t, 0.8, 0.86)));
        }
        break;
      case 'cylinder':
        if (act) {
          const swing = smooth(seg(t, 0.08, 0.2)) * (1 - smooth(seg(t, 0.78, 0.86)));
          act.position.x -= 0.04 * swing;
          act.rotation.z = this.cylinderAngle + 0.6 * swing;
        }
        if (this.prevReload < 0.25 && t >= 0.25) {
          this.root.updateMatrixWorld();
          for (let i = 0; i < 6; i++) this.shells.spawn(this.tmp2.set(a.actPivot[0] - 0.04, a.actPivot[1], a.actPivot[2] + 0.04).applyMatrix4(r.group.matrixWorld), 'pistol');
        }
        break;
      case 'crossbow':
        leftOn = true;
        left.copy(this.tmp.set(...a.gripL));
        break;
      default:
        // Charging handle after an empty magazine.
        if (this.reloadFromEmpty && act) act.position.z += 0.04 * smooth(seg(t, 0.8, 0.84)) * (1 - smooth(seg(t, 0.84, 0.9)));
        if (this.reloadFromEmpty && this.prevReload < 0.8 && t >= 0.8) this.onSound(r.vis.action === 'slide' ? 'clank' : 'charge');
        break;
    }
    this.prevReload = t;
    return leftOn;
  }

  /** Plays reload sounds whose keyframe the progress crossed since the last frame. */
  private reloadSounds(kind: string, t: number): void {
    const prev = this.prevReload < 0 ? -1 : this.prevReload;
    for (const [k, name, pitch] of RELOAD_SOUNDS[kind] ?? []) if (prev < k && t >= k) this.onSound(name, pitch);
    if (this.prevReload < 0) this.prevReload = 0;
  }

  /** A sound some time after the shot (pump, bolt); dropped if another shot comes first. */
  private onSoundAt(delay: number, name: SfxName): void {
    this.pending.push({ at: this.time + delay, name, shot: this.lastShot });
  }

  private attachFlash(r: Rig): void {
    const v = r.vis.flash!;
    let f = this.flashes.get(v.style);
    if (!f) {
      f = new THREE.Mesh(makeFlashGeometry(v.style), this.flashMaterial);
      f.frustumCulled = false;
      f.visible = false;
      this.flashes.set(v.style, f);
    }
    if (this.flash && this.flash !== f) this.flash.visible = false;
    this.flash = f;
    r.group.add(f);
    f.position.set(...r.built.anchors.muzzle);
    f.scale.setScalar(v.size * 0.32);
  }

  private showFlash(_style: FlashStyle, size: number, color: number): void {
    if (!this.flash) return;
    this.flashTime = 0.05;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(size * 0.32 * (0.85 + Math.random() * 0.3));
    this.flashMaterial.color.setHex(color, THREE.LinearSRGBColorSpace);
  }
}

/**
 * Muzzle flash: a star facing back at the shooter plus two crossed flame tongues along the barrel;
 * muzzle brakes add side blasts. One additive mesh (one draw call), unit size, muzzle at the origin.
 */
function makeFlashGeometry(style: FlashStyle): THREE.BufferGeometry {
  const quads: THREE.BufferGeometry[] = [];
  const front = style === 'wide' ? 1.25 : style === 'small' ? 0.75 : 1;
  const tongue = style === 'wide' ? 0.9 : style === 'small' ? 0.8 : 1.3;
  quads.push(new THREE.PlaneGeometry(front, front));
  for (const rot of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(0.55 * front, tongue);
    g.rotateX(-Math.PI / 2).translate(0, 0, -tongue / 2 + 0.05).rotateZ(rot);
    quads.push(g);
  }
  if (style === 'brake') {
    for (const side of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.8, 0.35);
      g.rotateX(-Math.PI / 2).translate(side * 0.45, 0, 0);
      quads.push(g);
    }
  }
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  for (const q of quads) {
    const nq = q.toNonIndexed();
    pos.push(...(nq.attributes.position.array as Float32Array));
    uv.push(...(nq.attributes.uv.array as Float32Array));
    nq.dispose();
    q.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return merged;
}

/** A soft star-shaped flash, drawn once on a canvas. */
export function makeFlashTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.3, 'rgba(255,200,90,0.9)');
  g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 32 : 12;
    ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
