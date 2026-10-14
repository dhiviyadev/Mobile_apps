/**
 * Pooled combat effects, each drawn with a single InstancedMesh:
 * bullet tracers, impact sparks, and muzzle flashes for other players.
 */
import * as THREE from 'three';
import { makeFlashTexture } from './Viewmodel';

interface Tracer {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  life: number;
  max: number;
  color: number;
}

interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  color: number;
}

const MAX_TRACERS = 96;
const MAX_SPARKS = 192;

export class Effects {
  readonly group = new THREE.Group();
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly flashes: THREE.Sprite[] = [];
  private readonly flashLife: number[] = [];
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly z = new THREE.Vector3(0, 0, 1);

  constructor(private effects = 1) {
    // Tracer: unit box along +Z, additive so it glows.
    this.tracerMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_TRACERS,
    );
    this.sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SPARKS);
    for (const mesh of [this.tracerMesh, this.sparkMesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
    const tex = makeFlashTexture();
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffd090, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.visible = false;
      sp.scale.setScalar(0.5);
      this.flashes.push(sp);
      this.flashLife.push(0);
      this.group.add(sp);
    }
  }

  setLevel(effects: number): void {
    this.effects = effects;
  }

  tracer(a: THREE.Vector3 | [number, number, number], b: [number, number, number], color = 0xffe7a8): void {
    const [ax, ay, az] = Array.isArray(a) ? a : [a.x, a.y, a.z];
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    this.tracers.push({ ax, ay, az, bx: b[0], by: b[1], bz: b[2], life: 0.09, max: 0.09, color });
  }

  impact(p: [number, number, number], normal: [number, number, number] | null, color = 0xffd27a, count = 6): void {
    const n = Math.round(count * this.effects);
    const [nx, ny, nz] = normal ?? [0, 1, 0];
    for (let i = 0; i < n; i++) {
      if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
      this.sparks.push({
        x: p[0], y: p[1], z: p[2],
        vx: nx * 3 + (Math.random() - 0.5) * 4,
        vy: ny * 3 + Math.random() * 3,
        vz: nz * 3 + (Math.random() - 0.5) * 4,
        life: 0.25 + Math.random() * 0.25,
        color,
      });
    }
  }

  muzzleFlash(p: [number, number, number]): void {
    let i = this.flashLife.findIndex((l) => l <= 0);
    if (i < 0) i = 0;
    this.flashLife[i] = 0.05;
    this.flashes[i].position.set(p[0], p[1], p[2]);
    this.flashes[i].material.rotation = Math.random() * Math.PI;
    this.flashes[i].visible = true;
  }

  update(dt: number): void {
    let n = 0;
    this.tracers = this.tracers.filter((t) => (t.life -= dt) > 0);
    for (const t of this.tracers) {
      this.v.set(t.bx - t.ax, t.by - t.ay, t.bz - t.az);
      const len = this.v.length();
      if (len < 0.01) continue;
      this.q.setFromUnitVectors(this.z, this.v.normalize());
      const w = 0.025 * (t.life / t.max) + 0.008;
      this.m.compose(this.s.set(t.ax, t.ay, t.az), this.q, this.v.set(w, w, len));
      this.tracerMesh.setMatrixAt(n, this.m);
      this.tracerMesh.setColorAt(n, this.c.setHex(t.color).multiplyScalar(t.life / t.max));
      n++;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;

    n = 0;
    this.sparks = this.sparks.filter((s) => (s.life -= dt) > 0);
    for (const s of this.sparks) {
      s.vy -= 14 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const k = 0.05 * Math.min(1, s.life * 4);
      this.m.makeScale(k, k, k).setPosition(s.x, s.y, s.z);
      this.sparkMesh.setMatrixAt(n, this.m);
      this.sparkMesh.setColorAt(n, this.c.setHex(s.color));
      n++;
    }
    this.sparkMesh.count = n;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < this.flashes.length; i++) {
      this.flashLife[i] -= dt;
      if (this.flashLife[i] <= 0) this.flashes[i].visible = false;
    }
  }

  dispose(): void {
    this.tracerMesh.geometry.dispose();
    (this.tracerMesh.material as THREE.Material).dispose();
    this.sparkMesh.geometry.dispose();
    (this.sparkMesh.material as THREE.Material).dispose();
    for (const f of this.flashes) f.material.dispose();
  }
}
