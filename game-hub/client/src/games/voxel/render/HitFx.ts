/**
 * Combat particles (design-voxel-survival §17.7): crit sparks, blocked-hit
 * sparks off a shield, hit puffs, death puffs, eating crumbs and embers. One
 * instanced mesh (one draw call), pooled.
 */
import * as THREE from 'three';

const MAX = 200;

interface P {
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
}

export class HitFx {
  readonly mesh: THREE.InstancedMesh;
  private readonly ps: P[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();

  constructor(private readonly effects = 1) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  burst(x: number, y: number, z: number, color: number, count: number, o: { speed?: number; life?: number; size?: number; gravity?: number; up?: number } = {}): void {
    const n = Math.max(1, Math.round(count * this.effects));
    const speed = o.speed ?? 4;
    for (let i = 0; i < n; i++) {
      if (this.ps.length >= MAX) this.ps.shift();
      const life = (o.life ?? 0.5) * (0.7 + Math.random() * 0.6);
      this.ps.push({
        x, y, z,
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.3) * speed + (o.up ?? 1),
        vz: (Math.random() - 0.5) * speed,
        life, max: life, size: (o.size ?? 0.07) * (0.7 + Math.random() * 0.6), color, gravity: o.gravity ?? 12,
      });
    }
  }

  crit(x: number, y: number, z: number): void {
    this.burst(x, y, z, 0xffd166, 10, { speed: 6, life: 0.45, size: 0.06 });
  }

  blocked(x: number, y: number, z: number): void {
    this.burst(x, y, z, 0xd8e8ff, 8, { speed: 5, life: 0.35, size: 0.05 });
  }

  hit(x: number, y: number, z: number): void {
    this.burst(x, y, z, 0xc8303a, 6, { speed: 3, life: 0.4, size: 0.07 });
  }

  puff(x: number, y: number, z: number): void {
    this.burst(x, y + 0.9, z, 0xe8e8e8, 18, { speed: 3, life: 0.8, size: 0.15, gravity: -1, up: 0.6 });
  }

  crumbs(x: number, y: number, z: number, color: number): void {
    this.burst(x, y, z, color, 3, { speed: 1.6, life: 0.5, size: 0.04, up: 0.5 });
  }

  update(dt: number): void {
    let n = 0;
    for (const p of this.ps) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const s = p.size * Math.min(1, (p.life / p.max) * 2);
      this.m.makeScale(s, s, s).setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.c.setHex(p.color));
      this.ps[n++] = p;
    }
    this.ps.length = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
