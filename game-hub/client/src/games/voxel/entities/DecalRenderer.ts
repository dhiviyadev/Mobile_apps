/**
 * Ground decals in one instanced draw call (design-voxel-mobs §11.5): blob
 * shadows, boss telegraphs (circles, rings, lines, arcs, markers that fill up
 * and flash red at the end) and hazard zones (spores, frost, thorns, fire).
 */
import * as THREE from 'three';
import type { VoxelUniforms } from '../world/materials';

export const DecalShape = {
  Shadow: 0,
  Circle: 1,
  Ring: 2,
  Line: 3,
  Arc: 4,
  Marker: 5,
  Spores: 6,
  Frost: 7,
  Thorns: 8,
  Fire: 9,
  Ripple: 10,
} as const;

const VERT = /* glsl */ `
  attribute float aShape;
  attribute vec3 aColor;
  attribute vec4 aParams;
  varying vec2 vP;
  varying float vShape;
  varying vec3 vColor;
  varying vec4 vParams;
  varying float vFogDist;
  void main() {
    vP = uv * 2.0 - 1.0;
    vShape = aShape;
    vColor = aColor;
    vParams = aParams;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFogDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uDaylight;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vP;
  varying float vShape;
  varying vec3 vColor;
  varying vec4 vParams;
  varying float vFogDist;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    float r = length(vP);
    float prog = vParams.x;
    float a = 0.0;
    int s = int(vShape + 0.5);
    float pulse = prog > 0.75 ? 0.75 + 0.25 * sin(uTime * 30.0) : 1.0;
    if (s == 0) {
      a = (1.0 - smoothstep(0.2, 1.0, r)) * 0.9;
    } else if (s == 1 || s == 5) {
      if (r > 1.0) discard;
      float rim = smoothstep(0.86, 0.95, r);
      float fill = r < prog ? 0.42 : 0.16;
      a = max(fill, rim * 0.95) * pulse;
      if (s == 5) a = max(a, (abs(vP.x) < 0.06 || abs(vP.y) < 0.06) ? 0.6 : 0.0);
    } else if (s == 2) {
      a = (1.0 - smoothstep(0.0, 0.08, abs(r - 0.94))) * 0.9 * pulse;
      if (r > 1.0) discard;
    } else if (s == 3) {
      float along = vP.y * 0.5 + 0.5;
      float edge = smoothstep(0.82, 0.98, abs(vP.x));
      a = max(along < prog ? 0.42 : 0.15, edge * 0.9) * pulse;
    } else if (s == 4) {
      if (r > 1.0) discard;
      float ang = abs(atan(vP.x, vP.y));
      if (ang > vParams.y) discard;
      float rim = max(smoothstep(0.88, 0.97, r), smoothstep(vParams.y - 0.06, vParams.y, ang));
      a = max(r < prog ? 0.42 : 0.15, rim * 0.95) * pulse;
    } else if (s == 6) {
      if (r > 1.0) discard;
      vec2 g = floor(vP * 6.0 + vec2(uTime * 0.3, -uTime * 0.2));
      float dot1 = step(0.7, hash(g)) * (1.0 - smoothstep(0.6, 1.0, r));
      a = 0.18 * (1.0 - r) + dot1 * 0.5;
    } else if (s == 7) {
      if (r > 1.0) discard;
      a = 0.18 + smoothstep(0.75, 0.98, r) * 0.6 + step(0.92, hash(floor(vP * 8.0))) * 0.25;
    } else if (s == 8) {
      if (r > 1.0) discard;
      float ang = atan(vP.x, vP.y);
      float spokes = smoothstep(0.75, 1.0, abs(sin(ang * 7.0 + r * 3.0)));
      a = 0.12 + spokes * 0.55 * (1.0 - r * 0.6);
    } else if (s == 9) {
      if (r > 1.0) discard;
      float f = 0.5 + 0.5 * sin(uTime * 12.0 + hash(floor(vP * 5.0)) * 6.28);
      a = (0.35 + 0.4 * f) * (1.0 - smoothstep(0.5, 1.0, r));
    } else {
      a = (1.0 - smoothstep(0.0, 0.12, abs(r - fract(uTime * 1.5)))) * 0.5;
      if (r > 1.0) discard;
    }
    a *= vParams.z * (1.0 - smoothstep(uFogNear, uFogFar, vFogDist));
    if (a < 0.01) discard;
    vec3 c = s == 0 ? vColor : vColor * mix(0.55, 1.0, uDaylight) + (s == 9 ? vec3(0.3) : vec3(0.0));
    gl_FragColor = vec4(c, a);
  }
`;

export interface Decal {
  shape: number;
  x: number;
  y: number;
  z: number;
  /** Circle radius; lines: length. */
  radius: number;
  /** Lines: width. */
  width: number;
  yaw: number;
  halfAngle: number;
  progress: number;
  alpha: number;
  color: number;
}

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const sc = new THREE.Vector3();

export class DecalRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly shape: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor(uniforms: VoxelUniforms, readonly capacity = 128) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    // After the rotation uv.y grows toward -Z: "forward" in decal space.
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const a of [this.shape, this.color, this.params]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aShape', this.shape);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aParams', this.params);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uDaylight: uniforms.uDaylight, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'creature-decals';
  }

  add(d: Decal): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    e.set(0, d.yaw, 0);
    q.setFromEuler(e);
    if (d.shape === DecalShape.Line) {
      // Starts at (x, z) and extends `radius` forward (-Z rotated by yaw).
      v.set(d.x - Math.sin(d.yaw) * d.radius * 0.5, d.y + 0.03, d.z - Math.cos(d.yaw) * d.radius * 0.5);
      sc.set(d.width, 1, d.radius);
    } else {
      v.set(d.x, d.y + 0.03, d.z);
      sc.set(d.radius * 2, 1, d.radius * 2);
    }
    m.compose(v, q, sc);
    this.mesh.setMatrixAt(i, m);
    (this.shape.array as Float32Array)[i] = d.shape;
    const c = this.color.array as Float32Array;
    c[i * 3] = ((d.color >> 16) & 255) / 255;
    c[i * 3 + 1] = ((d.color >> 8) & 255) / 255;
    c[i * 3 + 2] = (d.color & 255) / 255;
    const p = this.params.array as Float32Array;
    p[i * 4] = d.progress;
    p[i * 4 + 1] = d.halfAngle;
    p[i * 4 + 2] = d.alpha;
  }

  finish(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shape.needsUpdate = true;
    this.color.needsUpdate = true;
    this.params.needsUpdate = true;
    this.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
