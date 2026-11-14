/**
 * The Gloamreach's sky (package D): no sun, a fixed violet twilight with two
 * moons (a great pale one with craters and a small cyan one), slow aurora
 * ribbons and drifting motes of light. Sky.ts blends it in when the player is
 * in the realm and drives update() every frame.
 */
import * as THREE from 'three';
import { mulberry32 } from '@hub/shared';

const R = 190;
const MOTES = 160;
const MOTE_BOX = 26;

/** A moon disc with soft craters, painted once. */
function moonTexture(base: [number, number, number], shade: [number, number, number], seed: number): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(seed);
  const img = g.createImageData(size, size);
  const craters: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) craters.push([rnd() * 1.6 - 0.8, rnd() * 1.6 - 0.8, 0.07 + rnd() * 0.16]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1;
      const v = (y / (size - 1)) * 2 - 1;
      const d = Math.hypot(u, v);
      const i = (y * size + x) * 4;
      if (d > 1) {
        img.data[i + 3] = 0;
        continue;
      }
      let k = 0;
      for (const [cx, cy, cr] of craters) {
        const e = Math.hypot(u - cx, v - cy);
        if (e < cr) k = Math.max(k, 1 - e / cr);
        else if (e < cr * 1.25) k = Math.max(k, -0.35);
      }
      const limb = 1 - Math.pow(d, 6) * 0.35;
      for (let ch = 0; ch < 3; ch++) img.data[i + ch] = Math.max(0, Math.min(255, (base[ch] + (shade[ch] - base[ch]) * Math.max(0, k)) * limb * (k < 0 ? 1.08 : 1)));
      img.data[i + 3] = d > 0.97 ? 150 : 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const AURORA_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const AURORA_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uPhase;
  varying vec2 vUv;
  void main() {
    // A curtain: bright lower edge fading upward, rippling vertical rays.
    float rays = 0.55 + 0.45 * sin(vUv.x * 46.0 + uTime * 0.6 + uPhase) * sin(vUv.x * 13.0 - uTime * 0.35);
    float body = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.6);
    float ends = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x);
    float wave = 0.75 + 0.25 * sin(uTime * 0.4 + vUv.x * 6.0 + uPhase);
    vec3 col = mix(uColorA, uColorB, vUv.y + 0.2 * sin(uTime * 0.3 + uPhase));
    gl_FragColor = vec4(col * (0.8 + rays), body * ends * wave * rays * uOpacity);
  }
`;

export class GloamSky {
  readonly group = new THREE.Group();
  private readonly auroras: THREE.Mesh[] = [];
  private readonly motes: THREE.Points;
  private readonly moteBase = new Float32Array(MOTES * 3);
  private readonly moonA: THREE.Mesh;
  private readonly moonB: THREE.Mesh;
  private time = 0;

  constructor() {
    const rnd = mulberry32(4242);
    this.moonA = new THREE.Mesh(
      new THREE.PlaneGeometry(58, 58),
      new THREE.MeshBasicMaterial({ map: moonTexture([214, 200, 240], [150, 134, 190], 7), transparent: true, fog: false, depthWrite: false }),
    );
    this.moonB = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 22),
      new THREE.MeshBasicMaterial({ map: moonTexture([150, 232, 240], [90, 170, 200], 19), transparent: true, fog: false, depthWrite: false }),
    );
    const place = (m: THREE.Mesh, az: number, el: number) => {
      m.position.set(Math.cos(el) * Math.cos(az) * R * 0.9, Math.sin(el) * R * 0.9, Math.cos(el) * Math.sin(az) * R * 0.9);
      m.lookAt(0, 0, 0);
      m.renderOrder = -9;
    };
    place(this.moonA, 0.7, 0.62);
    place(this.moonB, 2.5, 0.38);
    this.group.add(this.moonA, this.moonB);

    // Aurora curtains: strips along great arcs high in the sky.
    const arcs: { az0: number; az1: number; el: number; h: number; a: number; b: number; phase: number }[] = [
      { az0: -1.2, az1: 1.4, el: 0.55, h: 0.5, a: 0x5affc8, b: 0x8a6aff, phase: 0 },
      { az0: 1.6, az1: 3.9, el: 0.45, h: 0.42, a: 0x6ac8ff, b: 0xd86aff, phase: 2 },
      { az0: 3.6, az1: 5.6, el: 0.62, h: 0.36, a: 0x7affa8, b: 0x6a8aff, phase: 4 },
    ];
    for (const arc of arcs) {
      const seg = 40;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const az = arc.az0 + (arc.az1 - arc.az0) * t;
        const wob = Math.sin(t * 7 + arc.phase) * 0.06;
        for (const k of [0, 1]) {
          const el = arc.el + wob + k * arc.h * 0.6;
          pos.push(Math.cos(el) * Math.cos(az) * R * 0.92, Math.sin(el) * R * 0.92, Math.cos(el) * Math.sin(az) * R * 0.92);
          uv.push(t, k);
        }
        if (i < seg) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        vertexShader: AURORA_VERT,
        fragmentShader: AURORA_FRAG,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColorA: { value: new THREE.Color(arc.a) }, uColorB: { value: new THREE.Color(arc.b) }, uPhase: { value: arc.phase } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -8;
      mesh.frustumCulled = false;
      this.auroras.push(mesh);
      this.group.add(mesh);
    }

    // Motes: soft lights drifting in the air around the camera.
    for (let i = 0; i < MOTES; i++) {
      this.moteBase[i * 3] = rnd() * MOTE_BOX * 2;
      this.moteBase[i * 3 + 1] = rnd() * MOTE_BOX * 2;
      this.moteBase[i * 3 + 2] = rnd() * MOTE_BOX * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3));
    const colors: number[] = [];
    const palette = [new THREE.Color(0xb8a8ff), new THREE.Color(0x9af0ff), new THREE.Color(0xe8d8ff), new THREE.Color(0x7affd8)];
    for (let i = 0; i < MOTES; i++) {
      const c = palette[Math.floor(rnd() * palette.length)];
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 3;
    this.group.add(this.motes);
    this.group.visible = false;
  }

  /** `mix` 0..1 (how much of the realm is showing); `cam` is the camera's world position (motes wrap around it, in world space). */
  update(dt: number, mix: number, cam: THREE.Vector3, daylight: number): void {
    this.group.visible = mix > 0.01;
    if (!this.group.visible) return;
    this.time += dt;
    for (const a of this.auroras) {
      const u = (a.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = this.time;
      u.uOpacity.value = mix * 0.85;
    }
    (this.moonA.material as THREE.MeshBasicMaterial).opacity = mix;
    (this.moonB.material as THREE.MeshBasicMaterial).opacity = mix;
    const pos = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    const t = this.time;
    for (let i = 0; i < MOTES; i++) {
      // Each mote drifts slowly; coordinates wrap in a box around the camera so they never run out.
      const bx = this.moteBase[i * 3] + t * (0.25 + (i % 5) * 0.06);
      const by = this.moteBase[i * 3 + 1] + t * (0.12 + (i % 3) * 0.05) + Math.sin(t * 0.5 + i) * 0.4;
      const bz = this.moteBase[i * 3 + 2] + t * 0.18;
      const wx = ((((bx - cam.x) % (MOTE_BOX * 2)) + MOTE_BOX * 3) % (MOTE_BOX * 2)) - MOTE_BOX;
      const wy = ((((by - cam.y) % (MOTE_BOX * 2)) + MOTE_BOX * 3) % (MOTE_BOX * 2)) - MOTE_BOX;
      const wz = ((((bz - cam.z) % (MOTE_BOX * 2)) + MOTE_BOX * 3) % (MOTE_BOX * 2)) - MOTE_BOX;
      pos.setXYZ(i, wx, wy, wz);
    }
    pos.needsUpdate = true;
    (this.motes.material as THREE.PointsMaterial).opacity = mix * (0.55 + 0.25 * Math.sin(t * 1.3));
    void daylight;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      (mat as THREE.MeshBasicMaterial | undefined)?.map?.dispose();
      mat?.dispose?.();
    });
  }
}
