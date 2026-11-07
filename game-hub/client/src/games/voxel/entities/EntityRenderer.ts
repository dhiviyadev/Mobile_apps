/**
 * Draws every creature part and creature projectile as instances of one unit
 * cube (design-voxel-mobs §11.1, §11.3): one opaque draw call plus one
 * translucent call (wings, glows). The shader lights boxes like the terrain
 * (sky and block light from the cell the creature is in, the time of day,
 * fog), adds the hit flash and makes eyes and cores emissive.
 */
import * as THREE from 'three';
import type { MobVariant } from '@hub/shared';
import { FOG_DISTANCE, type VoxelUniforms } from '../world/materials';
import type { Pose } from './animate';
import { paletteColor, type CompiledModel } from './models';

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute vec4 aLight;
  uniform float uDaylight;
  varying vec3 vColor;
  varying vec3 vLight;
  varying float vFogDist;
  ${FOG_DISTANCE}
  float brightness(float level) { return pow(0.8, (1.0 - level) * 15.0); }
  void main() {
    vec3 n = normalize(mat3(instanceMatrix) * normal);
    float shade = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.55 : (abs(n.x) > 0.5 ? 0.82 : 0.68));
    float sky = brightness(aLight.x) * mix(0.16, 1.0, uDaylight);
    vec3 lamp = brightness(aLight.y) * vec3(1.0, 0.85, 0.62);
    // Creatures read a little brighter than terrain so they stand out in dim places.
    vec3 lit = min(max(max(vec3(sky), lamp) * 1.25, vec3(0.2)), vec3(1.1));
    vLight = mix(shade * lit, vec3(1.0), aLight.w);
    vColor = mix(aColor, vec3(1.0, 0.32, 0.28), aLight.z * 0.75);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFogDist = fogDistance(modelMatrix * instanceMatrix * vec4(position, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAlpha;
  varying vec3 vColor;
  varying vec3 vLight;
  varying float vFogDist;
  void main() {
    vec3 c = vColor * vLight;
    gl_FragColor = vec4(mix(c, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist)), uAlpha);
  }
`;

class InstanceLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly color: THREE.InstancedBufferAttribute;
  readonly light: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(
    readonly capacity: number,
    uniforms: VoxelUniforms,
    translucent: boolean,
  ) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.light = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.light.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aLight', this.light);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uDaylight: uniforms.uDaylight, uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uFogVertical: uniforms.uFogVertical, uAlpha: { value: translucent ? 0.85 : 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: translucent,
      depthWrite: !translucent,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = translucent ? 3 : 1;
    this.mesh.name = translucent ? 'creatures-translucent' : 'creatures';
  }

  push(m: THREE.Matrix4, color: number, sky: number, block: number, flash: number, emissive: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.mesh.setMatrixAt(i, m);
    const c = this.color.array as Float32Array;
    c[i * 3] = ((color >> 16) & 255) / 255;
    c[i * 3 + 1] = ((color >> 8) & 255) / 255;
    c[i * 3 + 2] = (color & 255) / 255;
    const l = this.light.array as Float32Array;
    l[i * 4] = sky;
    l[i * 4 + 1] = block;
    l[i * 4 + 2] = flash;
    l[i * 4 + 3] = emissive;
  }

  finish(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.color.needsUpdate = true;
    this.light.needsUpdate = true;
    this.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export interface RootTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
  /** Head scale multiplier (babies 1.3). */
  headScale?: number;
}

export interface Lighting {
  /** 0..1 sky / block light. */
  sky: number;
  block: number;
  flash: number;
  /** Extra emissive for every part (target highlight, enraged glow). */
  glow: number;
}

const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export class EntityRenderer {
  readonly group = new THREE.Group();
  private readonly opaque: InstanceLayer;
  private readonly translucent: InstanceLayer;
  private joints: THREE.Matrix4[] = [];
  private readonly root = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly box = new THREE.Matrix4();
  /** Low preset: translucent parts drawn opaque. */
  translucentAsOpaque = false;

  constructor(uniforms: VoxelUniforms, opaqueCapacity = 1024, translucentCapacity = 128) {
    this.opaque = new InstanceLayer(opaqueCapacity, uniforms, false);
    this.translucent = new InstanceLayer(translucentCapacity, uniforms, true);
    this.group.add(this.opaque.mesh, this.translucent.mesh);
    this.group.name = 'creatures';
  }

  /** Adds one model's parts. `skipDetail` drops detail parts (far LOD). */
  addModel(model: CompiledModel, variant: MobVariant, rt: RootTransform, pose: Pose | null, light: Lighting, skipDetail: boolean, colorOverride?: (slot: string) => number | null): void {
    const parts = model.parts;
    while (this.joints.length < parts.length) this.joints.push(new THREE.Matrix4());
    tmpEuler.set(rt.pitch + (pose?.rootPitch ?? 0), rt.yaw, rt.roll + (pose?.rootRoll ?? 0), 'YXZ');
    tmpQ.setFromEuler(tmpEuler);
    tmpV.set(rt.x, rt.y + (pose?.rootY ?? 0) * rt.scale, rt.z);
    tmpS.set(rt.scale, rt.scale, rt.scale);
    this.root.compose(tmpV, tmpQ, tmpS);
    const boost = pose?.emissiveBoost ?? 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const r = i * 3;
      const parent = p.parentIndex >= 0 ? this.joints[p.parentIndex] : this.root;
      tmpEuler.set(p.restRad[0] + (pose ? pose.rot[r] : 0), p.restRad[1] + (pose ? pose.rot[r + 1] : 0), p.restRad[2] + (pose ? pose.rot[r + 2] : 0), 'YXZ');
      tmpQ.setFromEuler(tmpEuler);
      tmpV.set(p.at[0] + (pose ? pose.pos[r] : 0), p.at[1] + (pose ? pose.pos[r + 1] : 0), p.at[2] + (pose ? pose.pos[r + 2] : 0));
      const s = (pose ? pose.scale[i] : 1) * (p.role === 'head' && rt.headScale ? rt.headScale : 1);
      tmpS.set(s, s, s);
      this.local.compose(tmpV, tmpQ, tmpS);
      const joint = this.joints[i].multiplyMatrices(parent, this.local);
      if (skipDetail && p.detail) continue;
      tmpV.set(p.offset[0], p.offset[1], p.offset[2]);
      tmpS.set(p.size[0], p.size[1], p.size[2]);
      this.box.compose(tmpV, tmpQ.identity(), tmpS);
      this.box.premultiply(joint);
      const color = colorOverride?.(p.color) ?? paletteColor(model.def, p.color, variant);
      const emissive = p.emissive ? Math.min(1, 0.85 + boost) : light.glow;
      const layer = p.alpha !== undefined && p.alpha < 1 && !this.translucentAsOpaque ? this.translucent : this.opaque;
      layer.push(this.box, color, light.sky, light.block, light.flash, emissive);
    }
  }

  /** A loose box (particles of death poofs drop parts this way). */
  addBox(x: number, y: number, z: number, size: number, color: number, light: Lighting, yaw = 0): void {
    tmpEuler.set(0, yaw, 0);
    tmpQ.setFromEuler(tmpEuler);
    tmpV.set(x, y, z);
    tmpS.set(size, size, size);
    this.box.compose(tmpV, tmpQ, tmpS);
    this.opaque.push(this.box, color, light.sky, light.block, light.flash, light.glow);
  }

  get instances(): number {
    return this.opaque.mesh.count + this.translucent.mesh.count;
  }

  finish(): void {
    this.opaque.finish();
    this.translucent.finish();
  }

  dispose(): void {
    this.opaque.dispose();
    this.translucent.dispose();
  }
}

