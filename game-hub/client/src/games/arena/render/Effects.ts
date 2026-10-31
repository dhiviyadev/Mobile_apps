/**
 * Pooled combat effects, each drawn with a single InstancedMesh:
 * bullet tracers, impact sparks, bullet holes, and muzzle flashes for other players.
 */
import * as THREE from 'three';
import { makeFlashTexture } from './Viewmodel';

interface Tracer {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  life: number;
  max: number;
  color: number;
  width: number;
}

interface Decal {
  matrix: THREE.Matrix4;
  life: number;
}

/** Bullet holes last this long, shrinking away over the last second. */
const DECAL_LIFE = 8;
const DECAL_SIZE = 0.06;

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
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly flashes: THREE.Sprite[] = [];
  private readonly flashLife: number[] = [];
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  private readonly decals: Decal[] = [];
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
    this.decalMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE),
      new THREE.MeshBasicMaterial({ map: makeHoleTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      64,
    );
    for (const mesh of [this.tracerMesh, this.sparkMesh, this.decalMesh]) {
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

  /** A glowing streak from a to b; `width` scales its thickness, `life` how long it shows (s). */
  tracer(a: THREE.Vector3 | [number, number, number], b: [number, number, number], color = 0xffe7a8, width = 1, life = 0.09): void {
    const [ax, ay, az] = Array.isArray(a) ? a : [a.x, a.y, a.z];
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    this.tracers.push({ ax, ay, az, bx: b[0], by: b[1], bz: b[2], life, max: life, color, width });
  }

  /** A bullet hole on a wall (axis-aligned normal), kept up to 8 s; 64 at once (24 on low effects). */
  decal(p: [number, number, number], normal: [number, number, number]): void {
    const max = this.effects >= 0.75 ? 64 : 24;
    while (this.decals.length >= max) this.decals.shift();
    const n = this.v.set(normal[0], normal[1], normal[2]).normalize();
    this.q.setFromUnitVectors(this.z, n);
    // A random spin so holes don't look stamped.
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.z, Math.random() * Math.PI * 2));
    const at = new THREE.Vector3(p[0] + n.x * 0.005, p[1] + n.y * 0.005, p[2] + n.z * 0.005);
    const k = 0.8 + Math.random() * 0.5;
    this.decals.push({ matrix: new THREE.Matrix4().compose(at, this.q.clone(), new THREE.Vector3(k, k, k)), life: DECAL_LIFE });
  }

  /** Removes every bullet hole (map change). */
  clearDecals(): void {
    this.decals.length = 0;
    this.decalMesh.count = 0;
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

  /** Dust kicked up at the feet (slides, landings); shares the spark pool. */
  dust(p: [number, number, number], count = 3, color = 0xd9d2c4): void {
    const n = Math.round(count * this.effects);
    for (let i = 0; i < n; i++) {
      if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
      this.sparks.push({
        x: p[0] + (Math.random() - 0.5) * 0.4,
        y: p[1],
        z: p[2] + (Math.random() - 0.5) * 0.4,
        vx: (Math.random() - 0.5) * 1.6,
        vy: 0.8 + Math.random() * 1.2,
        vz: (Math.random() - 0.5) * 1.6,
        life: 0.3 + Math.random() * 0.2,
        color,
      });
    }
  }

  /** A muzzle flash for another player's shot; `size` is its diameter (m). */
  muzzleFlash(p: [number, number, number], size = 0.5, color = 0xffd090): void {
    let i = this.flashLife.findIndex((l) => l <= 0);
    if (i < 0) i = 0;
    this.flashLife[i] = 0.05;
    const f = this.flashes[i];
    f.position.set(p[0], p[1], p[2]);
    f.material.rotation = Math.random() * Math.PI;
    f.material.color.setHex(color);
    f.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    f.visible = true;
  }

  update(dt: number): void {
    let n = 0;
    this.tracers = this.tracers.filter((t) => (t.life -= dt) > 0);
    for (const t of this.tracers) {
      this.v.set(t.bx - t.ax, t.by - t.ay, t.bz - t.az);
      const len = this.v.length();
      if (len < 0.01) continue;
      this.q.setFromUnitVectors(this.z, this.v.normalize());
      const w = (0.025 * (t.life / t.max) + 0.008) * t.width;
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

    n = 0;
    for (let i = this.decals.length - 1; i >= 0; i--) if ((this.decals[i].life -= dt) <= 0) this.decals.splice(i, 1);
    for (const d of this.decals) {
      const k = Math.min(1, d.life);
      this.m.copy(d.matrix);
      if (k < 1) this.m.scale(this.s.set(k, k, k));
      this.decalMesh.setMatrixAt(n++, this.m);
    }
    this.decalMesh.count = n;
    this.decalMesh.visible = n > 0;
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.tracerMesh.geometry.dispose();
    (this.tracerMesh.material as THREE.Material).dispose();
    this.sparkMesh.geometry.dispose();
    (this.sparkMesh.material as THREE.Material).dispose();
    this.decalMesh.geometry.dispose();
    (this.decalMesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.decalMesh.material as THREE.Material).dispose();
    for (const f of this.flashes) f.material.dispose();
  }
}

/** A scorched bullet hole: dark core, soft sooty rim, transparent outside. */
function makeHoleTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(8,8,10,1)');
  g.addColorStop(0.28, 'rgba(14,14,16,0.95)');
  g.addColorStop(0.45, 'rgba(40,36,34,0.55)');
  g.addColorStop(1, 'rgba(40,36,34,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
