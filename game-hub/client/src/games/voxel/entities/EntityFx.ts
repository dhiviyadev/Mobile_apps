/**
 * Creature particles in one instanced draw call (design-voxel-mobs §11.5):
 * death poofs, hit sparks, drying crumbs, spores, hearts, smoke, ember and
 * ice bits, dust rings.
 */
import * as THREE from 'three';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  color: number;
  gravity: number;
  spin: number;
}

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s = new THREE.Vector3();
const c = new THREE.Color();

export class EntityFx {
  readonly mesh: THREE.InstancedMesh;
  private readonly list: Particle[] = [];
  private readonly capacity: number;

  constructor(effects: number) {
    this.capacity = Math.max(48, Math.round(192 * effects));
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'creature-fx';
  }

  get count(): number {
    return this.list.length;
  }

  private add(p: Particle): void {
    if (this.list.length >= this.capacity) this.list.shift();
    this.list.push(p);
  }

  /** n cubes thrown out from a point. */
  spray(x: number, y: number, z: number, n: number, color: number, o: { speed?: number; up?: number; size?: number; life?: number; gravity?: number; spread?: number } = {}): void {
    const speed = o.speed ?? 2.5;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.6);
      const life = (o.life ?? 0.7) * (0.6 + Math.random() * 0.6);
      const spread = o.spread ?? 0.3;
      this.add({
        x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread,
        vx: Math.cos(a) * sp, vy: (o.up ?? 2) * (0.5 + Math.random()), vz: Math.sin(a) * sp,
        life, max: life, size: (o.size ?? 0.12) * (0.7 + Math.random() * 0.6), color, gravity: o.gravity ?? 9, spin: Math.random() * 6,
      });
    }
  }

  poof(x: number, y: number, z: number, color: number, big = false): void {
    this.spray(x, y, z, big ? 40 : 12, color, { speed: big ? 5 : 2.5, up: big ? 4 : 2.5, size: big ? 0.25 : 0.14, life: big ? 1.2 : 0.7, spread: big ? 1.5 : 0.5 });
    this.spray(x, y, z, big ? 16 : 6, 0x9a9a9a, { speed: 1, up: 1.5, size: big ? 0.35 : 0.2, life: 1, gravity: -1.5, spread: big ? 1.5 : 0.5 });
  }

  hearts(x: number, y: number, z: number): void {
    this.spray(x, y, z, 3, 0xff6a9a, { speed: 0.4, up: 1.2, size: 0.16, life: 1.2, gravity: -0.5 });
  }

  smoke(x: number, y: number, z: number): void {
    this.spray(x, y, z, 5, 0x707070, { speed: 0.4, up: 1, size: 0.18, life: 0.9, gravity: -0.8 });
  }

  ring(x: number, y: number, z: number, radius: number, color: number): void {
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.add({ x: x + Math.cos(a) * 0.5, y: y + 0.1, z: z + Math.sin(a) * 0.5, vx: Math.cos(a) * radius * 2, vy: 0.8, vz: Math.sin(a) * radius * 2, life: 0.5, max: 0.5, size: 0.22, color, gravity: 2, spin: 0 });
    }
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.list.splice(i, 1);
        continue;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - dt * 1.5;
      p.vz *= 1 - dt * 1.5;
    }
    for (const p of this.list) {
      const k = p.size * Math.min(1, (p.life / p.max) * 2);
      e.set(p.spin * p.life, p.spin * p.life * 0.7, 0);
      q.setFromEuler(e);
      m.compose(v.set(p.x, p.y, p.z), q, s.set(k, k, k));
      this.mesh.setMatrixAt(n, m);
      this.mesh.setColorAt(n, c.setHex(p.color));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
