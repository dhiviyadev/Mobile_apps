/**
 * First-person weapon, drawn in its own scene after the world (depth cleared)
 * so it never clips into walls. Animates sway, bob, recoil kick, reload dip,
 * weapon draw and aim-down-sights; shows a muzzle flash on each shot.
 */
import * as THREE from 'three';
import { WeaponId } from '@hub/shared';
import { buildWeaponGeometry, MUZZLE } from './weaponModels';

/** Models are authored at real-world size; the viewmodel draws them smaller and closer. */
const MODEL_SCALE = 0.55;
const HIP = new THREE.Vector3(0.15, -0.15, -0.42);
const ADS: Record<WeaponId, THREE.Vector3> = {
  [WeaponId.Rifle]: new THREE.Vector3(0, -0.07, -0.34),
  [WeaponId.Shotgun]: new THREE.Vector3(0, -0.075, -0.34),
  [WeaponId.Sniper]: new THREE.Vector3(0, -0.085, -0.3),
  [WeaponId.Pistol]: new THREE.Vector3(0, -0.065, -0.36),
  [WeaponId.Blade]: new THREE.Vector3(0.15, -0.15, -0.42),
};

export interface ViewmodelState {
  weapon: WeaponId;
  aiming: boolean;
  /** 0..1 progress of a reload, or -1. */
  reload: number;
  /** 0..1 progress of drawing the weapon, or -1. */
  draw: number;
  speed: number;
  onGround: boolean;
  lookDX: number;
  lookDY: number;
  visible: boolean;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private readonly root = new THREE.Group();
  private readonly models = new Map<WeaponId, THREE.Mesh>();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly flash: THREE.Sprite;
  private current: WeaponId = WeaponId.Rifle;
  private kick = 0;
  private flashTime = 0;
  private aim = 0;
  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  private slash = 0;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.5, 1, 0.4);
    this.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(key, this.root);
    const flashTex = makeFlashTexture();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffe0a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.scale.setScalar(0.18);
    this.flash.visible = false;
    this.root.add(this.flash);
    this.setWeapon(WeaponId.Rifle);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(id: WeaponId): void {
    if (!this.models.has(id)) {
      const mesh = new THREE.Mesh(buildWeaponGeometry(id), this.material);
      mesh.visible = false;
      this.models.set(id, mesh);
      this.root.add(mesh);
    }
    for (const [w, m] of this.models) m.visible = w === id;
    this.current = id;
    const [mx, my, mz] = MUZZLE[id];
    this.flash.position.set(mx, my, mz);
  }

  fire(): void {
    this.kick = 1;
    if (this.current === WeaponId.Blade) {
      this.slash = 1;
      return;
    }
    this.flashTime = 0.05;
    this.flash.material.rotation = Math.random() * Math.PI;
  }

  /** World-space muzzle position for tracers (approximate, from the main camera). */
  muzzleWorld(mainCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    const m = MUZZLE[this.current];
    out.set(this.root.position.x + m[0] * MODEL_SCALE, this.root.position.y + (m[1] + 0.02) * MODEL_SCALE, this.root.position.z + m[2] * MODEL_SCALE);
    return mainCamera.localToWorld(out);
  }

  update(dt: number, s: ViewmodelState): void {
    if (s.weapon !== this.current) this.setWeapon(s.weapon);
    this.root.visible = s.visible;
    this.aim += ((s.aiming ? 1 : 0) - this.aim) * Math.min(1, dt * 14);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.slash = Math.max(0, this.slash - dt * 4);
    if (s.onGround) this.bob += dt * Math.min(1.4, s.speed / 4) * 9;
    this.swayX += (-s.lookDX * 0.6 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (s.lookDY * 0.6 - this.swayY) * Math.min(1, dt * 10);

    const p = HIP.clone().lerp(ADS[this.current], this.aim);
    const bobAmt = (1 - this.aim * 0.85) * Math.min(1, s.speed / 5);
    p.x += Math.cos(this.bob) * 0.012 * bobAmt + this.swayX * 0.04;
    p.y += Math.abs(Math.sin(this.bob)) * 0.014 * bobAmt + this.swayY * 0.04;
    p.z += this.kick * 0.03 * (1 - this.aim * 0.6);
    let rx = this.kick * 0.12 * (1 - this.aim * 0.5);
    let ry = 0;
    let rz = 0;
    if (s.reload >= 0) {
      const t = Math.sin(Math.min(1, s.reload) * Math.PI);
      p.y -= t * 0.08;
      rx -= t * 0.5;
      rz += t * 0.3;
    }
    if (s.draw >= 0) {
      p.y -= (1 - s.draw) * 0.16;
      rx -= (1 - s.draw) * 0.6;
    }
    if (this.slash > 0) {
      const t = Math.sin(this.slash * Math.PI);
      p.x -= t * 0.1;
      ry += t * 0.9;
      rz -= t * 0.4;
    }
    this.root.position.copy(p);
    this.root.rotation.set(rx, ry, rz);

    this.flashTime -= dt;
    this.flash.visible = this.flashTime > 0 && s.visible;
  }

  dispose(): void {
    for (const m of this.models.values()) m.geometry.dispose();
    this.material.dispose();
    this.flash.material.map?.dispose();
    this.flash.material.dispose();
  }
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
