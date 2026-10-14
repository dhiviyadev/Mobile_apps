/**
 * Day/night cycle: gradient sky dome, blocky sun and moon, stars and a slow
 * drifting cloud layer. Exposes `daylight` (0 night .. 1 day) and the horizon
 * colour, which the terrain shader uses for lighting and fog.
 */
import * as THREE from 'three';
import { mulberry32 } from '@hub/shared';

const DAY_TOP = new THREE.Color(0x5aa9f5);
const DAY_HORIZON = new THREE.Color(0xbfe3ff);
const DUSK_TOP = new THREE.Color(0x4a5a9a);
const DUSK_HORIZON = new THREE.Color(0xffa36b);
const NIGHT_TOP = new THREE.Color(0x070b1e);
const NIGHT_HORIZON = new THREE.Color(0x1a2342);

/** Must stay inside the camera's far plane (see VoxelGame.applyRenderDistance). */
export const SKY_RADIUS = 200;
const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;

export class Sky {
  readonly group = new THREE.Group();
  /** 0..1, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  time = 0.3;
  daylight = 1;
  readonly horizon = new THREE.Color();
  readonly zenith = new THREE.Color();
  private readonly dome: THREE.Mesh;
  private readonly domeColors: THREE.BufferAttribute;
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly clouds: THREE.InstancedMesh;
  private cloudOffset = 0;
  private lastDomeTime = -1;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpDir = new THREE.Vector3();
  private readonly cloudBase: { x: number; z: number; sx: number; sz: number }[] = [];

  constructor(cloudCount = 40) {
    const domeGeo = new THREE.SphereGeometry(SKY_RADIUS, 24, 12);
    this.domeColors = new THREE.BufferAttribute(new Float32Array(domeGeo.attributes.position.count * 3), 3);
    domeGeo.setAttribute('color', this.domeColors);
    this.dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0xfff1b0, fog: false, depthWrite: false }));
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), new THREE.MeshBasicMaterial({ color: 0xdfe7ff, fog: false, depthWrite: false, transparent: true }));
    this.sun.renderOrder = this.moon.renderOrder = -9;

    const rnd = mulberry32(99);
    const starPos: number[] = [];
    for (let i = 0; i < 500; i++) {
      const u = rnd() * Math.PI * 2;
      const v = Math.acos(rnd() * 0.95);
      starPos.push(Math.sin(v) * Math.cos(u) * SKY_RADIUS * 0.95, Math.cos(v) * SKY_RADIUS * 0.95, Math.sin(v) * Math.sin(u) * SKY_RADIUS * 0.95);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;

    this.clouds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false }),
      cloudCount,
    );
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 2;
    for (let i = 0; i < cloudCount; i++) {
      this.cloudBase.push({ x: (rnd() - 0.5) * 360, z: (rnd() - 0.5) * 360, sx: 12 + rnd() * 26, sz: 8 + rnd() * 18 });
    }

    this.group.add(this.dome, this.sun, this.moon, this.stars, this.clouds);
    this.update(0, new THREE.Vector3());
  }

  /** Advances time (seconds of real time, given the cycle length) and follows the camera. */
  update(dtDays: number, cameraPos: THREE.Vector3): void {
    this.time = (this.time + dtDays) % 1;
    const sunAngle = (this.time - 0.25) * Math.PI * 2; // 0 at sunrise
    const elevation = Math.sin(sunAngle);
    this.daylight = THREE.MathUtils.smoothstep(elevation, -0.18, 0.25);
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);

    this.zenith.copy(NIGHT_TOP).lerp(DAY_TOP, this.daylight).lerp(DUSK_TOP, dusk * 0.4);
    this.horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, this.daylight).lerp(DUSK_HORIZON, dusk * 0.7);

    // Dome gradient: vertex colour by height (only recomputed when the sky visibly changes).
    if (Math.abs(this.time - this.lastDomeTime) > 0.0008) {
      this.lastDomeTime = this.time;
      const pos = this.dome.geometry.attributes.position as THREE.BufferAttribute;
      const c = this.tmpColor;
      for (let i = 0; i < pos.count; i++) {
        const t = THREE.MathUtils.clamp(pos.getY(i) / SKY_RADIUS, -0.2, 1);
        c.copy(this.horizon).lerp(this.zenith, Math.pow(Math.max(0, t), 0.6));
        this.domeColors.setXYZ(i, c.r, c.g, c.b);
      }
      this.domeColors.needsUpdate = true;
    }

    this.group.position.copy(cameraPos);
    const dir = this.tmpDir.set(Math.cos(sunAngle), Math.sin(sunAngle), 0.25).normalize();
    this.sun.position.copy(dir).multiplyScalar(SKY_RADIUS * 0.85);
    this.sun.lookAt(0, 0, 0);
    this.moon.position.copy(dir).multiplyScalar(-SKY_RADIUS * 0.85);
    this.moon.lookAt(0, 0, 0);
    (this.moon.material as THREE.MeshBasicMaterial).opacity = 1 - this.daylight * 0.8;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - this.daylight * 2.2);

    // Clouds drift along +X and stay put in world space, wrapping in a 360 m tile around the camera.
    this.cloudOffset += dtDays * 2400;
    const m = this.tmpMatrix;
    const cloudTint = 0.35 + this.daylight * 0.65;
    (this.clouds.material as THREE.MeshBasicMaterial).color.setRGB(cloudTint, cloudTint, cloudTint * 1.04);
    for (let i = 0; i < this.cloudBase.length; i++) {
      const b = this.cloudBase[i];
      const x = wrap(b.x + this.cloudOffset - cameraPos.x);
      const z = wrap(b.z - cameraPos.z);
      m.makeScale(b.sx, 2.5, b.sz);
      m.setPosition(x, 78 - cameraPos.y, z);
      this.clouds.setMatrixAt(i, m);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
