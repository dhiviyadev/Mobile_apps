/**
 * First-person held items (design-voxel-survival §17.1): blocks as textured
 * cubes, weapons and tools as procedural box models, sprite items extruded,
 * an off-hand shield, and the animations that make combat feel physical:
 * equip dip, sword slash, axe chop, fist jab, guard raise, bow draw with a
 * live string and nocked arrow, crossbow load and recoil, eating bob.
 * Lit like the cell the eye is in (dark in caves, warm near lamps).
 */
import * as THREE from 'three';
import { FIRST_ITEM, ItemKind, itemDef } from '@hub/shared';
import { createBlockGeometry } from '../world/blockGeometry';
import type { VoxelUniforms } from '../world/materials';
import { createItemMaterial } from './itemMaterial';
import { buildItemModel, buildProjectileModel } from './itemModels';

type SwingKind = 'sword' | 'axe' | 'fist' | 'tool' | 'use';

/** Ease-out cubic. */
const e = (t: number) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const SWING_TIME: Record<SwingKind, number> = { sword: 0.28, axe: 0.4, fist: 0.18, tool: 0.25, use: 0.2 };

export class HeldItemView {
  readonly group = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly offPivot = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private offMesh: THREE.Mesh | null = null;
  private readonly string: THREE.LineSegments;
  private readonly arrow: THREE.Mesh;
  private readonly itemMat: THREE.ShaderMaterial;
  private readonly offMat: THREE.ShaderMaterial;
  private item = -1;
  private offItem = -1;
  private kind: 'block' | 'sprite' | 'sword' | 'axe' | 'tool' | 'shield' | 'bow' | 'crossbow' | 'none' = 'none';
  private equipT = 1;
  private swingT = 1;
  private swingKind: SwingKind = 'sword';
  private draw = 0;
  private drawShown = 0;
  private load = 0;
  private loaded = false;
  private guard = 0;
  private guardTarget = 0;
  private eating = false;
  private recoilT = 1;
  private releaseT = 1;
  private hurtT = 1;
  private hurtSide = 0;
  private sky = 15;
  private lamp = 0;
  private lightKey = -1;
  private time = 0;
  visible = true;

  constructor(
    private readonly opaque: THREE.Material,
    uniforms: VoxelUniforms,
  ) {
    this.itemMat = createItemMaterial(uniforms);
    this.offMat = createItemMaterial(uniforms);
    this.group.add(this.pivot, this.offPivot);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    this.string = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xe8e0d0 }));
    this.string.visible = false;
    this.arrow = new THREE.Mesh(buildProjectileModel('arrow').clone(), this.itemMat);
    this.arrow.visible = false;
    this.pivot.add(this.string, this.arrow);
  }

  /** Main-hand item (0 = empty hand). */
  setItem(item: number): void {
    if (item === this.item) return;
    this.item = item;
    this.equipT = 0;
    this.swingT = 1;
    if (this.mesh) {
      this.pivot.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const def = itemDef(item);
    if (item <= 0 || !def) {
      this.kind = 'none';
    } else if (item < FIRST_ITEM) {
      this.kind = 'block';
      this.mesh = new THREE.Mesh(createBlockGeometry(item, 0.24), this.opaque);
    } else {
      this.kind = def.shield ? 'shield' : def.ranged ? def.ranged.type : def.kind === ItemKind.Sword ? 'sword' : def.tool?.kind === 'axe' ? 'axe' : def.tool ? 'tool' : def.melee ? 'sword' : 'sprite';
      this.mesh = new THREE.Mesh(buildItemModel(item, 'fp').clone(), this.itemMat);
    }
    if (this.mesh) this.pivot.add(this.mesh);
    this.string.visible = this.kind === 'bow' || this.kind === 'crossbow';
    this.lightKey = -1;
  }

  /** Off-hand item (shields; 0 = none). */
  setOffhand(item: number): void {
    if (item === this.offItem) return;
    this.offItem = item;
    if (this.offMesh) {
      this.offPivot.remove(this.offMesh);
      this.offMesh.geometry.dispose();
      this.offMesh = null;
    }
    if (item > 0 && itemDef(item)?.shield) {
      this.offMesh = new THREE.Mesh(buildItemModel(item, 'fp').clone(), this.offMat);
      this.offPivot.add(this.offMesh);
    }
    this.lightKey = -1;
  }

  swing(kind: SwingKind): void {
    this.swingKind = kind;
    this.swingT = 0;
  }

  /** Bow draw 0..1 (0 = not drawing). Dropping from > 0 to 0 plays the release snap. */
  setDraw(f: number): void {
    if (this.draw > 0.15 && f === 0) this.releaseT = 0;
    this.draw = f;
  }

  setLoad(f: number, loaded: boolean): void {
    if (!this.loaded && loaded) this.recoilT = 0.6; // click jolt
    this.load = f;
    this.loaded = loaded;
  }

  setGuard(on: boolean): void {
    this.guardTarget = on ? 1 : 0;
  }

  setEating(on: boolean): void {
    this.eating = on;
  }

  recoil(): void {
    this.recoilT = 0;
  }

  /** side: -1 left, 1 right. */
  hurt(side: number): void {
    this.hurtT = 0;
    this.hurtSide = side;
  }

  /** Camera roll to apply for the hurt kick (radians). */
  get hurtRoll(): number {
    return this.hurtT < 1 ? this.hurtSide * 0.07 * (1 - e(this.hurtT)) : 0;
  }

  update(dt: number, bob: number, dig: number, light: number): void {
    this.time += dt;
    this.equipT = Math.min(1, this.equipT + dt / 0.2);
    this.swingT = Math.min(1, this.swingT + dt / SWING_TIME[this.swingKind]);
    this.recoilT = Math.min(1, this.recoilT + dt / 0.2);
    this.releaseT = Math.min(1, this.releaseT + dt / 0.12);
    this.hurtT = Math.min(1, this.hurtT + dt / 0.25);
    this.guard += (this.guardTarget - this.guard) * Math.min(1, dt / 0.06);
    this.drawShown += ((this.draw > 0 ? 1 : 0) - this.drawShown) * Math.min(1, dt / 0.06);
    this.group.visible = this.visible;

    // Base pose by kind.
    const P = this.pivot.position;
    const R = this.pivot.rotation;
    let px = 0.34;
    let py = -0.28;
    let pz = -0.62;
    let rx = 0.2;
    let ry = -0.55;
    let rz = 0.08;
    let scale = 1;
    switch (this.kind) {
      case 'sword':
      case 'axe':
      case 'tool':
        px = 0.36; py = -0.4; pz = -0.6; rx = -0.75; ry = -0.2; rz = 0.32; scale = 0.62;
        break;
      case 'shield':
        px = 0.36; py = -0.3; pz = -0.62; rx = 0; ry = -0.35; rz = 0; scale = 0.62;
        break;
      case 'bow':
        px = 0.3; py = -0.24; pz = -0.6; rx = 0.05; ry = 0.55; rz = 0.3; scale = 0.5;
        break;
      case 'crossbow':
        px = 0.26; py = -0.28; pz = -0.42; rx = 0.08; ry = 0.05; rz = 0; scale = 0.62;
        break;
      case 'sprite':
        px = 0.32; py = -0.24; pz = -0.6; rx = 0.1; ry = -0.5; rz = 0.15;
        break;
      case 'none':
        px = 0.36; py = -0.32; pz = -0.62;
        break;
    }
    // Bow draw: to the centre, string pulled.
    if (this.kind === 'bow') {
      const d = e(this.drawShown);
      px = lerp(px, 0.06, d);
      py = lerp(py, -0.16, d);
      pz = lerp(pz, -0.55, d);
      rz = lerp(rz, 0.4, d);
      ry = lerp(ry, 0.75, d);
      if (this.draw >= 1) {
        px += Math.sin(this.time * 30) * 0.003;
        py += Math.cos(this.time * 27) * 0.003;
      }
      pz += (1 - e(this.releaseT)) * 0.04 * (this.releaseT < 1 ? 1 : 0);
    }
    if (this.kind === 'crossbow') {
      if (this.load > 0 && !this.loaded) {
        rx -= 0.6 * Math.min(1, this.load * 4);
        py -= 0.05;
      } else if (this.loaded) {
        px = 0.16;
        py = -0.2;
        pz = -0.5;
      }
      const k = this.recoilT < 1 ? 1 - e(this.recoilT) : 0;
      pz += k * 0.07;
      rx += k * 0.08;
    }
    if (this.eating && this.kind === 'sprite') {
      px = 0.12;
      py = -0.15 + Math.sin(this.time * 50) * 0.02;
      pz = -0.4;
    }
    // Guard lowers the main item.
    py -= this.guard * (this.kind === 'shield' ? 0 : 0.22);
    if (this.kind === 'shield') {
      px = lerp(px, 0.04, this.guard);
      py = lerp(py, -0.2, this.guard);
      pz = lerp(pz, -0.48, this.guard);
      ry = lerp(ry, 0.12, this.guard);
    }
    // Melee swing.
    if (this.swingT < 1) {
      const t = this.swingT;
      switch (this.swingKind) {
        case 'sword': {
          const wind = Math.min(1, t / 0.21);
          const slash = Math.max(0, Math.min(1, (t - 0.21) / 0.36));
          const back = Math.max(0, (t - 0.57) / 0.43);
          const k = e(slash) * (1 - e(back));
          rz += -0.3 * wind * (1 - slash) + 1.3 * k;
          rx += 0.5 * wind * (1 - slash) - 1.0 * k;
          px += -0.29 * k;
          pz -= 0.12 * k;
          break;
        }
        case 'axe': {
          const up = Math.min(1, t / 0.35);
          const down = Math.max(0, Math.min(1, (t - 0.35) / 0.25));
          const back = Math.max(0, (t - 0.6) / 0.4);
          rx += 0.7 * up * (1 - down) - 1.2 * e(down) * (1 - back);
          pz -= 0.13 * e(down) * (1 - back);
          py += 0.06 * up * (1 - down);
          break;
        }
        case 'fist':
        case 'use': {
          const k = Math.sin(t * Math.PI);
          pz -= 0.23 * k;
          rx -= 0.2 * k;
          break;
        }
        case 'tool': {
          const k = Math.sin(t * Math.PI);
          rx -= 0.9 * k;
          pz -= 0.08 * k;
          break;
        }
      }
    }
    // Digging loop (BlockInteraction.swing).
    if (dig > 0 && this.swingT >= 1) {
      rx -= dig * (this.kind === 'block' || this.kind === 'sprite' ? 0.6 : 0.9);
      pz += dig * 0.06;
      py -= dig * 0.04;
    }
    if (this.kind === 'none') scale = 0;
    // Equip dip.
    const equip = this.equipT < 0.4 ? this.equipT / 0.4 : 1;
    py -= (1 - e(equip)) * 0.35;
    P.set(px, py + bob, pz);
    R.set(rx, ry, rz);
    this.pivot.scale.setScalar(scale || 0.0001);

    // Off-hand shield: left side, raised in front when guarding.
    const g = e(this.guard);
    this.offPivot.position.set(lerp(-0.46, -0.16, g), lerp(-0.36, -0.24, g) + bob, lerp(-0.62, -0.64, g));
    this.offPivot.rotation.set(0, lerp(0.5, 0.12, g), 0);
    this.offPivot.scale.setScalar(0.55);

    this.updateString();
    this.updateLight(light);
  }

  private updateString(): void {
    if (!this.string.visible) {
      this.arrow.visible = false;
      return;
    }
    const pos = this.string.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (this.kind === 'bow') {
      // Tips of the 7-limb arc (radius 0.5, ±0.96 rad), string toward +Z.
      const tipY = Math.sin(0.96) * 0.5;
      const tipZ = 0.5 - Math.cos(0.96) * 0.5;
      const pull = this.releaseT < 1 ? 0 : Math.max(0, this.draw) * 0.24;
      const mz = tipZ + pull;
      pos.setXYZ(0, 0, tipY, tipZ);
      pos.setXYZ(1, 0, 0, mz);
      pos.setXYZ(2, 0, 0, mz);
      pos.setXYZ(3, 0, -tipY, tipZ);
      this.arrow.visible = this.draw > 0.05;
      if (this.arrow.visible) {
        this.arrow.position.set(0.03, 0, mz);
        this.arrow.rotation.set(0, 0, 0);
      }
    } else {
      // Crossbow: prod tips to the latch (loaded) or the prod (empty).
      const latch = this.loaded ? 0.0 : -0.32 + Math.min(1, this.load) * 0.32;
      pos.setXYZ(0, -0.29, 0.04, -0.3);
      pos.setXYZ(1, 0, 0.04, latch);
      pos.setXYZ(2, 0, 0.04, latch);
      pos.setXYZ(3, 0.29, 0.04, -0.3);
      this.arrow.visible = this.loaded;
      if (this.loaded) {
        this.arrow.position.set(0, 0.06, 0);
        this.arrow.rotation.set(0, 0, 0);
        this.arrow.scale.setScalar(0.7);
      } else this.arrow.scale.setScalar(1);
    }
    pos.needsUpdate = true;
  }

  /** Rewrites sky and block light bytes when the light at the eye changes (eased). */
  private updateLight(light: number): void {
    this.sky += ((light >> 4) - this.sky) * 0.15;
    this.lamp += ((light & 15) - this.lamp) * 0.15;
    const sky = Math.round(this.sky * 17);
    const lamp = Math.round(this.lamp * 17);
    const key = (sky << 8) | lamp;
    if (key === this.lightKey) return;
    this.lightKey = key;
    for (const m of [this.mesh, this.offMesh, this.arrow]) {
      if (!m) continue;
      const attr = m.geometry.getAttribute('light') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const bytes = attr.array as Uint8Array;
      for (let i = 0; i < attr.count; i++) {
        bytes[i * 4 + 1] = sky;
        bytes[i * 4 + 2] = lamp;
      }
      attr.needsUpdate = true;
    }
    const k = Math.max(0.2, Math.pow(0.8, 15 - this.sky));
    (this.string.material as THREE.LineBasicMaterial).color.setRGB(0.91 * k, 0.88 * k, 0.82 * k);
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.offMesh?.geometry.dispose();
    this.string.geometry.dispose();
    (this.string.material as THREE.Material).dispose();
    this.itemMat.dispose();
    this.offMat.dispose();
  }
}
