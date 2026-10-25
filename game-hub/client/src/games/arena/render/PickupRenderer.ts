/**
 * Health packs and ammo crates (design-arena-maps §4.2): small procedural
 * models floating and turning above their spots, and a ring on the floor
 * that fills up while a taken pickup respawns (a full ring = available).
 *
 * Availability comes from the authority (MatchInfo.pickupReady: the tick at
 * which each pickup is back), so pickups reappear on the exact tick. Two
 * short-lived local overrides bridge the gaps: a predicted touch hides a
 * pickup for 0.5 s before the server confirms it, and a 'pickup' event hides
 * it until the authoritative tick arrives with the next state patch.
 *
 * One InstancedMesh per kind plus one for the rings: three draw calls at
 * most, none on maps without pickups.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type ArenaMap, type MapPickup, type PickupKind, pickupTouches, pickupValue, type PlayerSim } from '@hub/shared';

/** Models float this far above the pickup's floor point. */
const FLOAT = 0.45;
const BOB = 0.06;
const BOB_HZ = 0.65;
const SPIN = 1.2;
/** Respawn pop-in time (s). */
const POP = 0.25;
/** A predicted touch hides the pickup this long (ticks) unless the server confirms it. */
export const PREDICT_HIDE_TICKS = 15;
/** After a 'pickup' event, stay hidden this long (ticks) while the authoritative respawn tick arrives. */
const EVENT_HIDE_TICKS = 30;
/** One predicted touch per pickup at most this often (ms), so standing on a useless pickup stays quiet. */
const PREDICT_COOLDOWN_MS = 1500;
export const RING_COLOR: Record<PickupKind, number> = { health: 0x34d27b, ammo: 0xffc24a };

type Part = [geo: THREE.BufferGeometry, color: number];

/** Merges coloured parts into one non-indexed geometry with vertex colours. */
function merged(parts: Part[]): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geos = parts.map(([g, color]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    c.setHex(color);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute('uv');
    return geo;
  });
  const out = mergeGeometries(geos)!;
  for (const g of geos) g.dispose();
  return out;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** White case with mint crosses on the lid and both ends (~84 triangles), centred on its middle. */
export function healthPackGeometry(): THREE.BufferGeometry {
  const MINT = 0x34d27b;
  return merged([
    [box(0.46, 0.3, 0.46), 0xf4f6f2],
    [box(0.32, 0.04, 0.1, 0, 0.16, 0), MINT],
    [box(0.1, 0.04, 0.32, 0, 0.16, 0), MINT],
    ...[-1, 1].flatMap((s): Part[] => [
      [box(0.04, 0.07, 0.22, s * 0.235, 0, 0), MINT],
      [box(0.04, 0.22, 0.07, s * 0.235, 0, 0), MINT],
    ]),
  ]);
}

/** Amber crate with a dark band and three brass rounds standing on the lid (~132 triangles). */
export function ammoCrateGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    [box(0.56, 0.32, 0.38), 0xd9a441],
    [box(0.58, 0.06, 0.4), 0x3a3326],
  ];
  for (const x of [-0.14, 0, 0.14]) {
    parts.push([new THREE.CylinderGeometry(0.05, 0.05, 0.22, 6).translate(x, 0.16 + 0.11, 0), 0xe8c76a]);
    parts.push([new THREE.ConeGeometry(0.05, 0.07, 6).translate(x, 0.16 + 0.22 + 0.035, 0), 0xc8873a]);
  }
  return merged(parts);
}

const ringVertex = /* glsl */ `
  attribute float aProgress;
  attribute vec3 aColor;
  varying vec2 vLocal;
  varying float vProgress;
  varying vec3 vColor;
  void main() {
    vLocal = position.xz;
    vProgress = aProgress;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const ringFragment = /* glsl */ `
  varying vec2 vLocal;
  varying float vProgress;
  varying vec3 vColor;
  void main() {
    // Clockwise from "north" (-Z) seen from above.
    float a = fract(atan(vLocal.x, -vLocal.y) / 6.2831853 + 1.0);
    float lit = a <= vProgress ? 0.9 : 0.15;
    gl_FragColor = vec4(vColor, lit);
  }
`;

interface Item {
  pk: MapPickup;
  /** Instance index in its kind's mesh. */
  slot: number;
  /** Displayed scale (0 hidden, 1 shown; pops in). */
  scale: number;
  /** Seconds into the pop-in animation (≥ POP when done). */
  pop: number;
  shown: boolean;
  /** Local hide override: hidden until this tick (prediction or event). */
  heldUntil: number;
  /** Respawn arc: from tick → to tick. */
  spanFrom: number;
  spanTo: number;
  predictedAt: number;
}

export class PickupRenderer {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private readonly meshes: Partial<Record<PickupKind, THREE.InstancedMesh>> = {};
  private rings: THREE.InstancedMesh | null = null;
  private progressAttr: THREE.InstancedBufferAttribute | null = null;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x222222 });
  /** Seen from above only (one-sided: a transparent double-sided material costs two draw calls). */
  private readonly ringMaterial = new THREE.ShaderMaterial({ vertexShader: ringVertex, fragmentShader: ringFragment, transparent: true, depthWrite: false });
  private time = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(parent: THREE.Object3D) {
    this.group.name = 'pickups';
    parent.add(this.group);
  }

  get count(): number {
    return this.items.length;
  }

  /** Draw calls this renderer adds (0 on maps without pickups). */
  get drawCalls(): number {
    return Object.keys(this.meshes).length + (this.rings ? 1 : 0);
  }

  /** Builds the models for a map; everything starts available. */
  load(map: ArenaMap): void {
    this.clear();
    const list = map.pickups;
    if (list.length === 0) return;
    const perKind: Record<PickupKind, number> = { health: 0, ammo: 0 };
    this.items = list.map((pk) => ({ pk, slot: perKind[pk.kind]++, scale: 1, pop: POP, shown: true, heldUntil: 0, spanFrom: 0, spanTo: 0, predictedAt: -1e9 }));
    for (const kind of ['health', 'ammo'] as const) {
      if (perKind[kind] === 0) continue;
      const mesh = new THREE.InstancedMesh(kind === 'health' ? healthPackGeometry() : ammoCrateGeometry(), this.material, perKind[kind]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.name = `${kind} pickups`;
      this.meshes[kind] = mesh;
      this.group.add(mesh);
    }
    const ringGeo = new THREE.RingGeometry(0.5, 0.62, 40).rotateX(-Math.PI / 2);
    const color = new Float32Array(list.length * 3);
    const c = new THREE.Color();
    list.forEach((pk, i) => color.set(c.setHex(RING_COLOR[pk.kind]).toArray(), i * 3));
    this.progressAttr = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
    this.progressAttr.setUsage(THREE.DynamicDrawUsage);
    ringGeo.setAttribute('aProgress', this.progressAttr);
    ringGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    const rings = new THREE.InstancedMesh(ringGeo, this.ringMaterial, list.length);
    list.forEach((pk, i) => rings.setMatrixAt(i, this.m.makeTranslation(pk.x, pk.y + 0.02, pk.z)));
    rings.frustumCulled = false;
    rings.renderOrder = 2;
    rings.name = 'pickup rings';
    this.rings = rings;
    this.group.add(rings);
    this.update(0, [], 0);
  }

  /** Whether pickup i is shown as available. */
  isVisible(i: number): boolean {
    return this.items[i]?.shown ?? false;
  }

  /** Floor point of pickup i. */
  pickup(i: number): MapPickup | null {
    return this.items[i]?.pk ?? null;
  }

  /** Hides pickup i until `untilTick` at least (a predicted touch or a 'pickup' event). */
  markTaken(i: number, untilTick: number): void {
    const it = this.items[i];
    if (it) it.heldUntil = Math.max(it.heldUntil, untilTick);
  }

  /** The authority confirmed a pickup: keep it hidden until the respawn tick reaches us. */
  confirmTaken(i: number, serverTick: number): void {
    this.markTaken(i, serverTick + EVENT_HIDE_TICKS);
  }

  /** Forgets local overrides (new round, warmup): the authority's ticks rule again. */
  clearOverrides(): void {
    for (const it of this.items) it.heldUntil = 0;
  }

  /**
   * The pickup the predicted local player is collecting right now, or -1. Same touch and usefulness
   * rules as the sim; each pickup is predicted at most once per PREDICT_COOLDOWN_MS.
   */
  predictTouch(p: PlayerSim, now = performance.now()): number {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.shown || now - it.predictedAt < PREDICT_COOLDOWN_MS) continue;
      if (!pickupTouches(p, it.pk) || pickupValue(p, it.pk.kind) === 0) continue;
      it.predictedAt = now;
      return i;
    }
    return -1;
  }

  /** Whether pickup i was predicted locally within the last `ms`. */
  predictedRecently(i: number, ms = 1500, now = performance.now()): boolean {
    const it = this.items[i];
    return !!it && now - it.predictedAt < ms;
  }

  /**
   * Per frame. `ready` is the authority's per-pickup tick (0 = available). Returns the indices
   * that just came back (for the respawn chime).
   */
  update(dt: number, ready: readonly number[], serverTick: number): number[] {
    this.time += dt;
    const back: number[] = [];
    const prog = this.progressAttr;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const until = Math.max(ready[i] ?? 0, it.heldUntil);
      const shown = serverTick >= until;
      if (shown !== it.shown) {
        it.shown = shown;
        if (shown) {
          it.pop = 0;
          back.push(i);
        } else it.scale = 0;
      }
      // Respawn arc: restart it whenever the target tick moves (prediction → authority).
      if (!shown && it.spanTo !== until) {
        it.spanFrom = Math.min(serverTick, until - 1);
        it.spanTo = until;
      }
      const progress = shown ? 1 : Math.max(0, Math.min(1, (serverTick - it.spanFrom) / (it.spanTo - it.spanFrom)));
      if (prog && Math.abs(prog.getX(i) - progress) > 1e-4) {
        prog.setX(i, progress);
        prog.needsUpdate = true;
      }
      if (shown) {
        it.pop = Math.min(POP, it.pop + dt);
        it.scale = easeOutBack(it.pop / POP);
      }
      const mesh = this.meshes[it.pk.kind];
      if (!mesh) continue;
      const bob = Math.sin((this.time * BOB_HZ + i * 0.37) * Math.PI * 2) * BOB;
      this.q.setFromAxisAngle(this.up, this.time * SPIN + i * 1.7);
      this.m.compose(this.p.set(it.pk.x, it.pk.y + FLOAT + bob, it.pk.z), this.q, this.s.setScalar(Math.max(1e-4, it.scale)));
      mesh.setMatrixAt(it.slot, this.m);
    }
    for (const mesh of Object.values(this.meshes)) mesh.instanceMatrix.needsUpdate = true;
    return back;
  }

  /** Respawn progress of pickup i (0..1, 1 = available), for tests. */
  progress(i: number): number {
    return this.progressAttr && i < this.items.length ? this.progressAttr.getX(i) : 1;
  }

  clear(): void {
    for (const mesh of [...Object.values(this.meshes), this.rings]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const k of Object.keys(this.meshes) as PickupKind[]) delete this.meshes[k];
    this.rings = null;
    this.progressAttr = null;
    this.items = [];
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.material.dispose();
    this.ringMaterial.dispose();
  }
}

/** 0 → 1 with a small overshoot. */
function easeOutBack(t: number): number {
  const x = Math.max(0, Math.min(1, t)) - 1;
  const c = 1.70158;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
