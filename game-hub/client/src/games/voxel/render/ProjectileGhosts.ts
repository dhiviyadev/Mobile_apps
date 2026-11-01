/**
 * The shooter's own arrows and bolts, drawn the moment they leave the string
 * (design-voxel-survival §19.4): simulated locally with the projectile's
 * gravity and drag and the solid-block test. The creature sim draws the
 * authoritative projectile, so with one running a ghost fizzles after 0.5 s;
 * without one (no creature sim in this build/mode) it plays its whole flight
 * and sticks for a while.
 */
import * as THREE from 'three';
import { type BlockQuery, PROJECTILE_DEFS, ProjectileKind, solidRayDistance } from '@hub/shared';
import type { VoxelUniforms } from '../world/materials';
import { createItemMaterial } from './itemMaterial';
import { buildProjectileModel } from './itemModels';

interface Ghost {
  mesh: THREE.Mesh;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  stuck: number;
  life: number;
  wobble: number;
}

export class ProjectileGhosts {
  readonly group = new THREE.Group();
  private readonly ghosts: Ghost[] = [];
  private readonly mat: THREE.ShaderMaterial;
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private readonly dir = new THREE.Vector3();
  /** Called when a ghost hits a block (sound / particles). */
  onStick: ((x: number, y: number, z: number, kind: ProjectileKind) => void) | null = null;

  constructor(uniforms: VoxelUniforms, private readonly get: BlockQuery) {
    this.mat = createItemMaterial(uniforms);
  }

  spawn(kind: ProjectileKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, authoritative: boolean): void {
    const geo = buildProjectileModel(kind === ProjectileKind.Bolt ? 'bolt' : kind === ProjectileKind.EmberArrow ? 'ember' : 'arrow');
    const mesh = new THREE.Mesh(geo, this.mat);
    this.group.add(mesh);
    this.ghosts.push({ mesh, kind, x, y, z, vx, vy, vz, age: 0, stuck: -1, life: authoritative ? 0.5 : 10, wobble: 0 });
    if (this.ghosts.length > 24) this.drop(0);
  }

  update(dt: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.age += dt;
      if (g.age > g.life || (g.stuck >= 0 && g.life <= 0.5 && g.age > g.life)) {
        this.drop(i);
        continue;
      }
      if (g.stuck < 0) {
        const def = PROJECTILE_DEFS[g.kind];
        const steps = Math.max(1, Math.ceil((Math.hypot(g.vx, g.vy, g.vz) * dt) / 0.5));
        const h = dt / steps;
        for (let s = 0; s < steps && g.stuck < 0; s++) {
          g.vy -= def.gravity * h;
          const k = Math.max(0, 1 - def.drag * h);
          g.vx *= k;
          g.vy *= k;
          g.vz *= k;
          const len = Math.hypot(g.vx, g.vy, g.vz) * h;
          const dx = (g.vx * h) / (len || 1);
          const dy = (g.vy * h) / (len || 1);
          const dz = (g.vz * h) / (len || 1);
          const t = solidRayDistance(this.get, g.x, g.y, g.z, dx, dy, dz, len);
          if (t <= len) {
            g.x += dx * (t + 0.15);
            g.y += dy * (t + 0.15);
            g.z += dz * (t + 0.15);
            g.stuck = g.age;
            g.wobble = 0.12;
            this.onStick?.(g.x, g.y, g.z, g.kind);
          } else {
            g.x += g.vx * h;
            g.y += g.vy * h;
            g.z += g.vz * h;
          }
        }
        if (g.stuck < 0) this.dir.set(g.vx, g.vy, g.vz).normalize();
        g.mesh.quaternion.setFromUnitVectors(this.fwd, g.stuck < 0 ? this.dir : this.dir);
      }
      if (g.wobble > 0) {
        g.wobble = Math.max(0, g.wobble - dt);
        g.mesh.rotateX(Math.sin(g.age * 80) * g.wobble * 0.3);
      }
      g.mesh.position.set(g.x, g.y, g.z);
      // The model's head is at -0.62: place the head at the projectile point.
      g.mesh.translateZ(0.5);
    }
  }

  private drop(i: number): void {
    const g = this.ghosts[i];
    this.group.remove(g.mesh);
    this.ghosts.splice(i, 1);
  }

  dispose(): void {
    while (this.ghosts.length) this.drop(0);
    this.mat.dispose();
  }
}
