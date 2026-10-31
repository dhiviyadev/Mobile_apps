/**
 * Crossbow bolts on the client (design-arena-weapons §5.4). The server decides every hit; this draws
 * the flights and the bolts left stuck in walls.
 *
 *  - Own bolts are predicted: they fly the exact server path (projPos, traceProjectileWorld) from the
 *    moment of the shot, leaving the drawn crossbow and converging onto the true path within 0.12 s.
 *    A visual hit on an interpolated enemy ends them early; the server's `projEnd` (matched through
 *    the shot's seq → bolt id) corrects the end point.
 *  - Remote bolts start from the `proj` event, aged to the interpolation clock so they leave the
 *    shooter's avatar when it is drawn firing, and end where `projEnd` says.
 * Flying and stuck bolts share one InstancedMesh (one draw call).
 */
import * as THREE from 'three';
import {
  type ArenaEvent,
  type BoxWorld,
  type ProjectileImpact,
  type ProjectileSpec,
  projPos,
  rayBox,
  inflate,
  traceProjectileWorld,
  type Tuple3,
  weaponDef,
  type WeaponId,
} from '@hub/shared';
import type { AimTarget } from '../features/AutoShoot';
import { buildParts } from './weaponKit';
import { BLACK, ORANGE, STEEL } from './weaponSpecs';

const MAX_BOLTS = 48;
const MAX_STUCK = 24;
const STUCK_LIFE = 6;
const CONVERGE = 0.12;

interface Bolt {
  /** Server id once known. */
  id: number | null;
  seq: number;
  local: boolean;
  shooter: string;
  spec: ProjectileSpec;
  o: Tuple3;
  v: Tuple3;
  age: number;
  end: ProjectileImpact;
  /** Start offset (drawn muzzle − true origin), faded out over CONVERGE seconds. */
  offset: THREE.Vector3;
  whoosh: boolean;
}

interface Stuck {
  matrix: THREE.Matrix4;
  life: number;
}

export interface BoltEnd {
  pos: Tuple3;
  normal: Tuple3 | null;
  /** A player was hit (red sparks), not a wall. */
  flesh: boolean;
  /** The bolt was this client's own. */
  local: boolean;
}

export class Projectiles {
  readonly mesh: THREE.InstancedMesh;
  /** Called when a bolt lands (sounds and sparks are the owner's). */
  onEnd: (end: BoltEnd) => void = () => {};
  /** Called once when a remote bolt passes close to the camera. */
  onWhoosh: (at: Tuple3) => void = () => {};
  private readonly flying: Bolt[] = [];
  private readonly stuck: Stuck[] = [];
  private readonly ends = new Map<number, ArenaEvent & { type: 'projEnd' }>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly fwd = new THREE.Vector3(0, 0, -1);

  constructor(material: THREE.Material) {
    // Shaft, steel head and two orange vanes, pointing −Z, 0.42 m long, origin at the tip.
    const geo = buildParts((k) => {
      k.cyl(0.006, 0.36, 'z', [0, 0, 0.21], { c: BLACK, seg: 5 });
      k.cone(0.011, 0.045, 'z', [0, 0, 0.0225], { c: STEEL, ch: 'K', seg: 5 });
      k.box(0.002, 0.03, 0.07, [0, 0.012, 0.35], { c: ORANGE, ch: 'E' });
      k.box(0.03, 0.002, 0.07, [0, 0.0, 0.35], { c: ORANGE, ch: 'E' });
    }, 'tp');
    this.mesh = new THREE.InstancedMesh(geo, material, MAX_BOLTS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** Bolts on screen, flying and stuck (e2e). */
  count(): number {
    return this.flying.length + this.stuck.length;
  }

  /** Our own shot, predicted: flies from the true origin, drawn from the crossbow. */
  spawnLocal(weapon: WeaponId, seq: number, origin: Tuple3, dir: Tuple3, muzzle: THREE.Vector3, world: BoxWorld, me: string): void {
    const spec = weaponDef(weapon).projectile;
    if (!spec) return;
    const v: Tuple3 = [dir[0] * spec.speed, dir[1] * spec.speed, dir[2] * spec.speed];
    const end = traceProjectileWorld(origin, v, spec, world);
    this.push({ id: null, seq, local: true, shooter: me, spec, o: origin, v, age: 0, end, offset: muzzle.clone().sub(new THREE.Vector3(...origin)), whoosh: true });
  }

  /** A `proj` event: matches our predicted bolt, or starts someone else's. `age` = its flight time now on our clock. */
  onProj(e: ArenaEvent & { type: 'proj' }, me: string, age: number, world: BoxWorld, muzzle: THREE.Vector3 | null): void {
    if (e.shooter === me) {
      const mine = this.flying.find((b) => b.local && b.id === null && b.seq === e.seq);
      if (mine) mine.id = e.id;
      return;
    }
    const spec = weaponDef(e.weapon).projectile;
    if (!spec) return;
    const end = traceProjectileWorld(e.origin, e.vel, spec, world);
    const offset = muzzle ? muzzle.clone().sub(new THREE.Vector3(...e.origin)) : new THREE.Vector3();
    this.push({ id: e.id, seq: e.seq, local: false, shooter: e.shooter, spec, o: e.origin, v: e.vel, age, end, offset, whoosh: false });
    const late = this.ends.get(e.id);
    if (late) this.onProjEnd(late);
  }

  /** The authoritative end of a bolt: where it stopped, and whether it hit a player. */
  onProjEnd(e: ArenaEvent & { type: 'projEnd' }): void {
    const b = this.flying.find((x) => x.id === e.id);
    if (!b) {
      // The proj event may come in a later batch; keep the end briefly.
      this.ends.set(e.id, e);
      if (this.ends.size > 32) this.ends.delete(this.ends.keys().next().value!);
      return;
    }
    this.ends.delete(e.id);
    const dx = e.pos[0] - b.o[0];
    const dz = e.pos[2] - b.o[2];
    const h = Math.hypot(b.v[0], b.v[2]);
    const t = h > 1 ? Math.hypot(dx, dz) / h : Math.abs(e.pos[1] - b.o[1]) / Math.max(1, Math.abs(b.v[1]));
    b.end = { kind: e.hitId ? 'player' : e.normal ? 'world' : 'expire', t: Math.max(0, t), pos: e.pos, normal: e.normal, hitId: e.hitId, headshot: e.headshot };
  }

  /**
   * Advances the flights. `targets` (enemies as drawn) give our own bolts an immediate visual hit;
   * `camera` is used for the fly-by whoosh.
   */
  update(dt: number, targets: readonly AimTarget[], camera: THREE.Vector3, trail: (a: Tuple3, b: Tuple3) => void): void {
    let n = 0;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const b = this.flying[i];
      const prev = b.age;
      b.age += dt;
      if (b.age < 0) continue;
      const a = projPos(b.o, b.v, b.spec.gravity, Math.max(0, prev));
      if (b.local && b.end.kind !== 'player') this.visualHit(b, a, targets);
      if (b.age >= b.end.t) {
        this.flying.splice(i, 1);
        this.land(b);
        continue;
      }
      const pos = projPos(b.o, b.v, b.spec.gravity, b.age);
      const k = Math.max(0, 1 - b.age / CONVERGE);
      pos[0] += b.offset.x * k;
      pos[1] += b.offset.y * k;
      pos[2] += b.offset.z * k;
      trail(a, pos);
      if (!b.whoosh && Math.hypot(pos[0] - camera.x, pos[1] - camera.y, pos[2] - camera.z) < 3) {
        b.whoosh = true;
        this.onWhoosh(pos);
      }
    }
    for (const b of this.flying) {
      if (b.age < 0 || n >= MAX_BOLTS) continue;
      const pos = projPos(b.o, b.v, b.spec.gravity, b.age);
      const k = Math.max(0, 1 - b.age / CONVERGE);
      this.p.set(pos[0] + b.offset.x * k, pos[1] + b.offset.y * k, pos[2] + b.offset.z * k);
      this.d.set(b.v[0], b.v[1] - b.spec.gravity * b.age, b.v[2]).normalize();
      this.q.setFromUnitVectors(this.fwd, this.d);
      this.mesh.setMatrixAt(n++, this.m.compose(this.p, this.q, this.one));
    }
    for (let i = this.stuck.length - 1; i >= 0; i--) if ((this.stuck[i].life -= dt) <= 0) this.stuck.splice(i, 1);
    for (const s of this.stuck) if (n < MAX_BOLTS) this.mesh.setMatrixAt(n++, s.matrix);
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** New round or map: everything goes. */
  clear(): void {
    this.flying.length = 0;
    this.stuck.length = 0;
    this.ends.clear();
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }

  private push(b: Bolt): void {
    if (this.flying.length >= MAX_BOLTS - MAX_STUCK) this.flying.shift();
    this.flying.push(b);
  }

  /** Our own bolt crossing an enemy as drawn this frame ends there (the server confirms the damage). */
  private visualHit(b: Bolt, a: Tuple3, targets: readonly AimTarget[]): void {
    const c = projPos(b.o, b.v, b.spec.gravity, Math.min(b.age, b.end.t));
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const dz = c[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    let best = len;
    for (const t of targets) {
      for (const box of [t.boxes.head, t.boxes.body]) {
        const hit = rayBox(a[0], a[1], a[2], dx / len, dy / len, dz / len, inflate(box, b.spec.radius), best);
        if (hit >= 0 && hit < best) best = hit;
      }
    }
    if (best >= len) return;
    const t = Math.max(0, b.age - dt0(b, len - best));
    b.end = { kind: 'player', t, pos: projPos(b.o, b.v, b.spec.gravity, t), normal: null, hitId: 'visual', headshot: false };
  }

  private land(b: Bolt): void {
    const pos = b.end.pos;
    if (b.end.kind === 'world') {
      // Stuck in the wall along its flight, the head buried a few centimetres.
      this.d.set(b.v[0], b.v[1] - b.spec.gravity * b.end.t, b.v[2]).normalize();
      this.q.setFromUnitVectors(this.fwd, this.d);
      this.p.set(pos[0], pos[1], pos[2]).addScaledVector(this.d, 0.04);
      if (this.stuck.length >= MAX_STUCK) this.stuck.shift();
      this.stuck.push({ matrix: new THREE.Matrix4().compose(this.p, this.q, this.one), life: STUCK_LIFE });
    }
    if (b.end.kind !== 'expire') this.onEnd({ pos, normal: b.end.normal, flesh: b.end.kind === 'player', local: b.local });
  }
}

/** Flight time covering `dist` metres at the bolt's current speed. */
function dt0(b: Bolt, dist: number): number {
  const speed = Math.hypot(b.v[0], b.v[1] - b.spec.gravity * b.age, b.v[2]);
  return dist / Math.max(1, speed);
}

