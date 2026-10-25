/**
 * Launch pads (design-arena-maps §4.1): animated glowing caps on top of the
 * pads' solid base boxes (drawn by MapRenderer), plus a pulsing ring where
 * each aimed launcher lands you.
 *
 * Caps are one InstancedMesh with an unlit shader: trampolines show rings
 * rippling outward, launchers and speed strips show chevrons running along
 * the launch direction. A launch makes the cap pop and flare (pulse()).
 * Two draw calls at most, none on maps without pads.
 */
import * as THREE from 'three';
import { type ArenaMap, type BoxWorld, CMD_DT, createMoveState, type LaunchPad, stepMovement, type Vec3 } from '@hub/shared';

/** Cap thickness: reaches below the pad top so a popped cap never shows a gap. */
const CAP_H = 0.12;
/** The cap's top surface sits this far above the walkable pad top. */
const CAP_RAISE = 0.03;
/** Caps overhang the base box a little so their sides never z-fight with it. */
const CAP_LIP = 0.015;

export const PAD_KIND = { trampoline: 0, launcher: 1, strip: 2 } as const;

export function padKind(pad: LaunchPad): number {
  return pad.horizontal === 'keep' ? PAD_KIND.trampoline : pad.horizontal === 'set' ? PAD_KIND.launcher : PAD_KIND.strip;
}

/**
 * Where a launcher drops a player who stands on its centre and lets go of the stick: steps the
 * movement integrator itself, so the mark matches the real flight. Null when it never lands (8 s).
 */
export function padLanding(pad: LaunchPad, world: BoxWorld): Vec3 | null {
  const s = createMoveState((pad.minX + pad.maxX) / 2, pad.top, (pad.minZ + pad.maxZ) / 2);
  Object.assign(s, { vx: pad.vx, vy: pad.vy, vz: pad.vz, onGround: false });
  const input = { moveX: 0, moveY: 0, yaw: 0, jump: false, crouch: false, speedMul: 1 };
  for (let i = 0; i < 480; i++) {
    stepMovement(s, input, world, CMD_DT);
    if (s.onGround) return { x: s.x, y: s.y, z: s.z };
  }
  return null;
}

const capVertex = /* glsl */ `
  attribute float aKind;
  attribute vec2 aDir;
  attribute vec2 aSize;
  attribute float aPulse;
  uniform float uTime;
  varying vec2 vLocal;
  varying vec2 vSize;
  varying vec2 vDir;
  varying float vKind;
  varying float vPulse;
  varying float vTop;
  varying float vFogDist;
  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    // Pop on launch; trampolines also breathe gently.
    world.y += 0.05 * aPulse + (aKind < 0.5 ? 0.01 * sin(uTime * 6.2831853) : 0.0);
    vLocal = position.xz * aSize;
    vSize = aSize;
    vDir = aDir;
    vKind = aKind;
    vPulse = aPulse;
    vTop = step(0.5, normal.y);
    vec4 mv = viewMatrix * world;
    vFogDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const capFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vLocal;
  varying vec2 vSize;
  varying vec2 vDir;
  varying float vKind;
  varying float vPulse;
  varying float vTop;
  varying float vFogDist;
  // A soft stripe across the start of each period.
  float band(float x) {
    return smoothstep(0.0, 0.12, x) * smoothstep(0.5, 0.3, x);
  }
  void main() {
    float b;
    if (vKind < 0.5) {
      // Trampoline: rings rippling outward.
      b = band(fract(length(vLocal) * 2.0 - uTime * 1.2));
    } else {
      // Launcher / strip: chevrons running along the launch direction (tips forward).
      vec2 perp = vec2(-vDir.y, vDir.x);
      float speed = vKind > 1.5 ? 3.0 : 2.0;
      b = band(fract(dot(vLocal, vDir) * 1.5 - uTime * speed + abs(dot(vLocal, perp)) * 0.6));
    }
    float edge = min(vSize.x * 0.5 - abs(vLocal.x), vSize.y * 0.5 - abs(vLocal.y));
    float frame = 1.0 - smoothstep(0.1, 0.13, edge);
    float k = mix(0.35 + 0.65 * b, 0.16, frame);
    k = mix(0.22, k, vTop);
    vec3 c = uColor * k * (1.0 + 1.2 * vPulse);
    gl_FragColor = vec4(mix(c, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist)), 1.0);
  }
`;

export class PadRenderer {
  readonly group = new THREE.Group();
  private caps: THREE.InstancedMesh | null = null;
  private rings: THREE.InstancedMesh | null = null;
  private pulseAttr: THREE.InstancedBufferAttribute | null = null;
  private readonly capMaterial: THREE.ShaderMaterial;
  /** Normal blending (additive rings vanish on light floors); one-sided: transparent double-sided materials cost two draw calls. */
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private time = 0;

  constructor(parent: THREE.Object3D) {
    this.group.name = 'pads';
    this.capMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color() },
        uFogColor: { value: new THREE.Color() },
        uFogNear: { value: 30 },
        uFogFar: { value: 85 },
      },
      vertexShader: capVertex,
      fragmentShader: capFragment,
    });
    parent.add(this.group);
  }

  /** Builds the caps and landing marks for a map (nothing at all when it has no pads). */
  load(map: ArenaMap, world: BoxWorld): void {
    this.clear();
    const pads = map.pads;
    if (pads.length === 0) return;
    const u = this.capMaterial.uniforms;
    (u.uColor.value as THREE.Color).setHex(map.theme.pad);
    (u.uFogColor.value as THREE.Color).setHex(map.theme.fog);
    u.uFogNear.value = map.theme.fogNear;
    u.uFogFar.value = map.theme.fogFar;

    const geo = new THREE.BoxGeometry(1, CAP_H, 1).translate(0, -CAP_H / 2, 0);
    const kind = new Float32Array(pads.length);
    const dir = new Float32Array(pads.length * 2);
    const size = new Float32Array(pads.length * 2);
    this.pulseAttr = new THREE.InstancedBufferAttribute(new Float32Array(pads.length), 1);
    this.pulseAttr.setUsage(THREE.DynamicDrawUsage);
    const caps = new THREE.InstancedMesh(geo, this.capMaterial, pads.length);
    const m = new THREE.Matrix4();
    pads.forEach((p, i) => {
      const w = p.maxX - p.minX + CAP_LIP * 2;
      const d = p.maxZ - p.minZ + CAP_LIP * 2;
      m.makeScale(w, 1, d).setPosition((p.minX + p.maxX) / 2, p.top + CAP_RAISE, (p.minZ + p.maxZ) / 2);
      caps.setMatrixAt(i, m);
      kind[i] = padKind(p);
      const h = Math.hypot(p.vx, p.vz);
      dir.set(h > 1e-6 && p.horizontal !== 'keep' ? [p.vx / h, p.vz / h] : [0, 0], i * 2);
      size.set([w, d], i * 2);
    });
    geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
    geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 2));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
    geo.setAttribute('aPulse', this.pulseAttr);
    caps.name = 'pad caps';
    caps.computeBoundingSphere();
    this.caps = caps;
    this.group.add(caps);

    // Landing marks for aimed launchers.
    const marks = pads.filter((p) => p.horizontal === 'set').map((p) => padLanding(p, world)).filter((v): v is Vec3 => v !== null);
    if (marks.length) {
      this.ringMaterial.color.setHex(map.theme.pad);
      const ringGeo = new THREE.RingGeometry(1.2, 1.5, 32).rotateX(-Math.PI / 2);
      const rings = new THREE.InstancedMesh(ringGeo, this.ringMaterial, marks.length);
      marks.forEach((v, i) => rings.setMatrixAt(i, m.makeTranslation(v.x, v.y + 0.03, v.z)));
      rings.name = 'launcher landing marks';
      rings.renderOrder = 2;
      rings.computeBoundingSphere();
      this.rings = rings;
      this.group.add(rings);
    }
  }

  /** A pad just launched someone: the cap pops and flares. */
  pulse(i: number): void {
    const a = this.pulseAttr;
    if (!a || i < 0 || i >= a.count) return;
    a.setX(i, 1);
    a.needsUpdate = true;
  }

  /** Current flare of pad i (0..1), for tests. */
  pulseOf(i: number): number {
    return this.pulseAttr && i >= 0 && i < this.pulseAttr.count ? this.pulseAttr.getX(i) : 0;
  }

  /** Draw calls this renderer adds (0 on maps without pads). */
  get drawCalls(): number {
    return (this.caps ? 1 : 0) + (this.rings ? 1 : 0);
  }

  update(dt: number): void {
    if (!this.caps) return;
    this.time += dt;
    this.capMaterial.uniforms.uTime.value = this.time % 1000;
    const a = this.pulseAttr!;
    const decay = Math.exp(-6 * dt);
    let changed = false;
    for (let i = 0; i < a.count; i++) {
      const v = a.getX(i);
      if (v === 0) continue;
      a.setX(i, v < 0.002 ? 0 : v * decay);
      changed = true;
    }
    if (changed) a.needsUpdate = true;
    if (this.rings) this.ringMaterial.opacity = 0.6 + 0.25 * Math.sin(this.time * 3);
  }

  clear(): void {
    for (const mesh of [this.caps, this.rings]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.caps = this.rings = null;
    this.pulseAttr = null;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.capMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
