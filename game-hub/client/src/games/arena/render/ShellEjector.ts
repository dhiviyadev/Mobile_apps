/**
 * Spent casings flying out of the first-person weapon: one pooled InstancedMesh in the viewmodel
 * scene (camera space). Rifle and pistol brass and red shotgun hulls share one shape, told apart by
 * instance scale and colour. No allocation per shot.
 */
import * as THREE from 'three';
import type { EjectKind } from './weaponVisuals';
import { buildParts } from './weaponKit';
import { BRASS, buildCasing, SHELL_RED } from './weaponSpecs';

interface Casing {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
  life: number;
  kind: EjectKind;
}

const SIZE: Record<Exclude<EjectKind, 'none'>, [number, number]> = { rifle: [1, 1], pistol: [0.9, 0.55], shell: [1.8, 1.36] };
const GRAVITY = 4.5; // camera space is ~0.45 scale; a lighter fall reads right

export class ShellEjector {
  readonly mesh: THREE.InstancedMesh;
  private readonly pool: Casing[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(material: THREE.Material, private readonly scale: number, private max = 24) {
    this.mesh = new THREE.InstancedMesh(buildParts(buildCasing), material, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.c.setRGB(1, 1, 1));
  }

  /** Fewer casings on low quality. */
  setMax(n: number): void {
    this.max = Math.max(1, Math.min(n, this.mesh.instanceMatrix.count));
  }

  /** A casing leaves `at` (camera space) toward the right and up. */
  spawn(at: THREE.Vector3, kind: EjectKind): void {
    if (kind === 'none') return;
    if (this.pool.length >= this.max) this.pool.shift();
    const shell = kind === 'shell';
    this.pool.push({
      x: at.x, y: at.y, z: at.z,
      vx: (0.55 + Math.random() * 0.35) * (shell ? 0.8 : 1),
      vy: 0.45 + Math.random() * 0.35,
      vz: 0.1 + Math.random() * 0.25,
      rx: Math.random() * 3, ry: Math.random() * 3, rz: Math.random() * 3,
      sx: (Math.random() - 0.5) * 30, sy: (Math.random() - 0.5) * 30, sz: 10 + Math.random() * 20,
      life: 0.7,
      kind,
    });
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.pool.length - 1; i >= 0; i--) if ((this.pool[i].life -= dt) <= 0) this.pool.splice(i, 1);
    for (const c of this.pool) {
      c.vy -= GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      c.rx += c.sx * dt;
      c.ry += c.sy * dt;
      c.rz += c.sz * dt;
      if (c.kind === 'none') continue;
      const [r, l] = SIZE[c.kind];
      this.q.setFromEuler(this.e.set(c.rx, c.ry, c.rz));
      this.m.compose(this.p.set(c.x, c.y, c.z), this.q, this.s.set(r * this.scale, r * this.scale, l * this.scale));
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.c.setHex(c.kind === 'shell' ? SHELL_RED : BRASS, THREE.LinearSRGBColorSpace));
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.pool.length = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
