/**
 * A tiny procedural modelling kit for weapons (and the hands holding them).
 *
 * Model space is metres at real size: origin at the top of the pistol grip, +X right, +Y up, -Z forward
 * (toward the muzzle). A weapon spec calls the primitives below; every part has a colour, a material
 * channel (matte / metal / emissive / sleeve), a group (static body, magazine, action) and an optional
 * "detail" flag. buildWeapon() merges the parts per group:
 *  - first person ('fp'): body, mag and act are one geometry each with a `mat` attribute, so the shared
 *    WeaponMaterial draws each in one call whatever its mix of materials;
 *  - third person ('tp'): one merged geometry with vertex colours for the avatars' Lambert material,
 *    without detail parts and with fewer cylinder segments.
 * Pure three.js geometry, no DOM: unit tests build every weapon in node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];
/** M matte (polymer, wood, rubber) · K metal · E emissive (lenses, sight dots, accent strips) · S sleeve (matte × team colour). */
export type Channel = 'M' | 'K' | 'E' | 'S';
export type PartGroup = 'body' | 'mag' | 'act';
export type Lod = 'fp' | 'tp';

const CHANNEL_ID: Record<Channel, number> = { M: 0, K: 1, E: 2, S: 3 };

export interface PartOpts {
  /** Colour as it should look (sRGB hex). */
  c: number;
  ch?: Channel;
  g?: PartGroup;
  /** Small detail: left out of the third-person model. */
  d?: boolean;
  /** Euler XYZ rotation (rad) about the part's own centre, before it moves to its place. */
  rot?: V3;
}

interface Part {
  geo: THREE.BufferGeometry;
  ch: Channel;
  g: PartGroup;
  d: boolean;
  c: number;
}

/** Where the hands go and what moves (model space). */
export interface WeaponAnchors {
  muzzle: V3;
  /** Point that lines up with the eye when aiming down sights. */
  sight: V3;
  /** Ejection port (casings), or null. */
  eject: V3 | null;
  /** Right hand: middle of the pistol grip. */
  gripR: V3;
  /** Left hand: handguard, pump or foregrip; for pistols, under the right hand. */
  gripL: V3;
  /** How the left hand holds: from below, around a vertical foregrip, cupping the right hand, or not at all. */
  leftHand: 'under' | 'vertical' | 'cup' | 'none';
  /** Pivots the mag and act groups move about (their geometry is centred on it). */
  magPivot: V3;
  actPivot: V3;
  /** Crossbow string: the nock at rest and drawn, and the limb tips it runs to. */
  nockRest?: V3;
  nockDrawn?: V3;
  limbTips?: [V3, V3];
}

export interface WeaponSpec {
  /** Adds the parts and returns the anchors. */
  build(k: Kit): WeaponAnchors;
}

export interface BuiltWeapon {
  body: THREE.BufferGeometry;
  /** Centred on anchors.magPivot (null when the spec has no magazine part). */
  mag: THREE.BufferGeometry | null;
  /** Centred on anchors.actPivot. */
  act: THREE.BufferGeometry | null;
  anchors: WeaponAnchors;
  triangles: number;
}

const tmpColor = new THREE.Color();
const tmpEuler = new THREE.Euler();
const tmpMatrix = new THREE.Matrix4();

/** Reverses every triangle's winding (after a mirror). */
function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const s = a.itemSize;
    const arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < s; k++) {
        const t = arr[(i + 1) * s + k];
        arr[(i + 1) * s + k] = arr[(i + 2) * s + k];
        arr[(i + 2) * s + k] = t;
      }
    }
  }
}

/** Collects parts for one weapon at one level of detail. */
export class Kit {
  readonly parts: Part[] = [];

  constructor(readonly lod: Lod) {}

  private add(geo: THREE.BufferGeometry, at: V3, o: PartOpts): void {
    if (this.lod === 'tp' && o.d) {
      geo.dispose();
      return;
    }
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (o.rot) g.applyMatrix4(tmpMatrix.makeRotationFromEuler(tmpEuler.set(o.rot[0], o.rot[1], o.rot[2])));
    g.translate(at[0], at[1], at[2]);
    this.parts.push({ geo: g, ch: o.ch ?? 'M', g: o.g ?? 'body', d: !!o.d, c: o.c });
  }

  private seg(n: number, r: number): number {
    if (this.lod === 'fp') return n;
    return r < 0.012 ? 4 : Math.min(n, 6);
  }

  /** Box w × h × d centred at `at`. */
  box(w: number, h: number, d: number, at: V3, o: PartOpts): void {
    this.add(new THREE.BoxGeometry(w, h, d), at, o);
  }

  /**
   * Cylinder of radius r and length len along an axis, centred at `at`. `r2` tapers the far end
   * (−Z for 'z', +X for 'x', +Y for 'y'); `open` leaves the caps off.
   */
  cyl(r: number, len: number, axis: 'x' | 'y' | 'z', at: V3, o: PartOpts & { seg?: number; r2?: number; open?: boolean }): void {
    // Third person: no end caps (nobody sees into a barrel at that size; it halves the triangles).
    const g = new THREE.CylinderGeometry(o.r2 ?? r, r, len, this.seg(o.seg ?? 10, r), 1, !!o.open || this.lod === 'tp');
    if (axis === 'z') g.rotateX(-Math.PI / 2);
    else if (axis === 'x') g.rotateZ(-Math.PI / 2);
    this.add(g, at, o);
  }

  /** Cylinder from point a to point b (radius r at a, r2 at b): forearms, bipod legs, strings. */
  rod(a: V3, b: V3, r: number, o: PartOpts & { seg?: number; r2?: number; open?: boolean }): void {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(o.r2 ?? r, r, len, this.seg(o.seg ?? 8, r), 1, !!o.open || this.lod === 'tp');
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    this.add(g, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], { ...o, rot: undefined });
  }

  /** Cone of base radius r and length len, tip toward −axis (forward for 'z'). */
  cone(r: number, len: number, axis: 'x' | 'y' | 'z', at: V3, o: PartOpts & { seg?: number }): void {
    this.cyl(r, len, axis, at, { ...o, r2: 0 });
  }

  /** Torus ring (ring sights) around an axis. First person only: too fine to see on an avatar. */
  ring(r: number, tube: number, at: V3, axis: 'x' | 'y' | 'z', o: PartOpts): void {
    if (this.lod === 'tp') return;
    const g = new THREE.TorusGeometry(r, tube, 4, 14);
    if (axis === 'x') g.rotateY(Math.PI / 2);
    else if (axis === 'y') g.rotateX(Math.PI / 2);
    this.add(g, at, o);
  }

  /**
   * Side profile: a polygon of [z, y] points (plus optional holes) extruded `width` across X, centred
   * on `x`. Stocks, grips, receivers, curved magazines, the knife blade (`bevel` for an edge).
   */
  prof(points: [number, number][], width: number, o: PartOpts & { x?: number; holes?: [number, number][][]; bevel?: number }): void {
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
    for (const h of o.holes ?? []) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
    const bevel = o.bevel ?? 0;
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(1e-4, width - 2 * bevel),
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      curveSegments: 3,
    });
    // Shape (sx, sy) and extrusion ez → model (x, y, z) = (−ez, sy, sx): a proper rotation, so windings stay.
    g.applyMatrix4(tmpMatrix.set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
    this.add(g, [(o.x ?? 0) + width / 2 - bevel, 0, 0], o);
  }

  /** Top-down plan: a polygon of [x, z] points extruded `height` up from y (crossbow limbs). `mirror` adds the −X twin. */
  plan(points: [number, number][], height: number, y: number, o: PartOpts & { mirror?: boolean }): void {
    const make = () => {
      const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 3 });
      // (sx, sy, ez) → (x, y, z) = (sx, ez, −sy).
      g.applyMatrix4(tmpMatrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1));
      return g;
    };
    this.add(make(), [0, y, 0], o);
    if (o.mirror) {
      const m = make().toNonIndexed();
      m.scale(-1, 1, 1);
      for (const name of Object.keys(m.attributes)) if (name !== 'position' && name !== 'normal') m.deleteAttribute(name);
      flipWinding(m);
      this.add(m, [0, y, 0], o);
    }
  }
}

/** Merges one group's parts into a geometry with `color` (and, first person, `mat`) attributes. */
function mergeParts(parts: Part[], lod: Lod, center: V3 | null): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  for (const p of parts) {
    const n = p.geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    // First person: colours as displayed (the renderer writes linear values straight out, and the
    // weapon shader works in display space). Third person: linear, like the avatars' lit colours.
    if (lod === 'fp') tmpColor.setHex(p.c, THREE.LinearSRGBColorSpace);
    else tmpColor.setHex(p.c);
    if (lod === 'tp' && p.ch === 'E') tmpColor.multiplyScalar(1.3);
    for (let i = 0; i < n; i++) col.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
    p.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (lod === 'fp') p.geo.setAttribute('mat', new THREE.BufferAttribute(new Float32Array(n).fill(CHANNEL_ID[p.ch]), 1));
  }
  const merged = mergeGeometries(parts.map((p) => p.geo), false);
  for (const p of parts) p.geo.dispose();
  if (!merged) throw new Error('weapon parts could not be merged');
  if (center) merged.translate(-center[0], -center[1], -center[2]);
  merged.computeBoundingSphere();
  return merged;
}

const tris = (g: THREE.BufferGeometry | null) => (g ? g.attributes.position.count / 3 : 0);

/** Builds a weapon's geometry at a level of detail. */
export function buildWeapon(spec: WeaponSpec, lod: Lod): BuiltWeapon {
  const kit = new Kit(lod);
  const anchors = spec.build(kit);
  const of = (g: PartGroup) => kit.parts.filter((p) => p.g === g);
  if (lod === 'tp') {
    const body = mergeParts(kit.parts, lod, null)!;
    return { body, mag: null, act: null, anchors, triangles: tris(body) };
  }
  const body = mergeParts(of('body'), lod, null)!;
  const mag = mergeParts(of('mag'), lod, anchors.magPivot);
  const act = mergeParts(of('act'), lod, anchors.actPivot);
  return { body, mag, act, anchors, triangles: tris(body) + tris(mag) + tris(act) };
}

/** Builds loose geometry (hands, casings) from a spec-like function, first-person attributes, one group. */
export function buildParts(build: (k: Kit) => void, lod: Lod = 'fp'): THREE.BufferGeometry {
  const kit = new Kit(lod);
  build(kit);
  return mergeParts(kit.parts, lod, null)!;
}

/**
 * The first-person weapon material: one shader for every channel, so each mesh is one draw call.
 * Shading is a procedural matcap (a function of the view-space normal): a soft key from the top left
 * with a cool rim for matte parts; a dark body with a sky band, a sharp highlight and a bright rim
 * for metal; flat glowing colour for emissive parts; matte × `uSleeve` for sleeves. Supports
 * InstancedMesh (hands, casings). Colours are display values; `uTint` carries a little map mood.
 */
export function createWeaponMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTint: { value: new THREE.Color(1, 1, 1) },
      uSleeve: { value: new THREE.Color(0.35, 0.4, 0.5) },
    },
    vertexColors: true,
    vertexShader: /* glsl */ `
      attribute float mat;
      varying vec3 vColor;
      varying float vMat;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 p = position;
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = (instanceMatrix * vec4(p, 1.0)).xyz;
          n = mat3(instanceMatrix) * n;
        #endif
        vColor = color;
        #ifdef USE_INSTANCING_COLOR
          vColor *= instanceColor;
        #endif
        vMat = mat;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNormal = normalize(normalMatrix * n);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform vec3 uSleeve;
      varying vec3 vColor;
      varying float vMat;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(vView);
        vec3 key = normalize(vec3(-0.45, 0.8, 0.55));
        float nk = dot(n, key);
        float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
        vec3 c;
        if (vMat > 1.5 && vMat < 2.5) {
          c = vColor * 1.1;
        } else if (vMat > 0.5 && vMat < 1.5) {
          // Metal: dark base, a soft sky band from above, a tight highlight and a bright rim.
          vec3 r = reflect(-v, n);
          float sky = smoothstep(-0.3, 0.8, r.y);
          float spec = pow(max(dot(r, key), 0.0), 28.0);
          float wide = pow(max(dot(r, key), 0.0), 4.0);
          c = vColor * (0.55 + 0.75 * max(nk, 0.0) + 0.35 * sky)
            + vec3(1.0, 0.96, 0.9) * (spec * 0.55 + wide * 0.07)
            + vec3(0.62, 0.72, 0.9) * rim * 0.22;
        } else {
          // Matte: wrapped key light, a little fill from below right, a cool rim.
          vec3 base = vMat > 2.5 ? vColor * uSleeve : vColor;
          float diff = 0.42 + 0.78 * pow(clamp(nk * 0.5 + 0.5, 0.0, 1.0), 1.6);
          float fill = 0.12 * clamp(dot(n, normalize(vec3(0.6, -0.4, 0.5))), 0.0, 1.0);
          c = base * (diff + fill) + vec3(0.55, 0.65, 0.85) * rim * 0.12;
        }
        gl_FragColor = vec4(c * uTint, 1.0);
      }`,
  });
}
