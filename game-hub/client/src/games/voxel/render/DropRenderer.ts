/**
 * Item drops in the world (design-voxel-survival §17.4): small spinning,
 * bobbing blocks and item models, simulated locally with the shared drop
 * physics between the server's DropMove corrections, lit like their cell.
 * Picked-up drops fly to the picker and shrink away. Lost Satchels glint.
 */
import * as THREE from 'three';
import { type BlockQuery, type ClientDrop, FIRST_ITEM, stepDrop } from '@hub/shared';
import { createBlockGeometry } from '../world/blockGeometry';
import type { VoxelUniforms } from '../world/materials';
import { createItemMaterial } from './itemMaterial';
import { buildItemModel } from './itemModels';

interface Drop extends ClientDrop {
  mesh: THREE.Mesh;
  onGround: boolean;
  /** Correction offset blended away over 0.1 s. */
  ox: number;
  oy: number;
  oz: number;
  phase: number;
  lightT: number;
  /** Pickup fly-in target and time left. */
  fly: { x: number; y: number; z: number; t: number } | null;
}

const MAX_DIST = 48;

export class DropRenderer {
  readonly group = new THREE.Group();
  private readonly drops = new Map<number, Drop>();
  private readonly itemMat: THREE.ShaderMaterial;
  private readonly satchelMat: THREE.ShaderMaterial;
  private time = 0;

  constructor(
    private readonly opaque: THREE.Material,
    uniforms: VoxelUniforms,
    private readonly get: BlockQuery,
    private readonly lightAt: (x: number, y: number, z: number) => number,
  ) {
    this.itemMat = createItemMaterial(uniforms);
    this.satchelMat = createItemMaterial(uniforms);
  }

  get size(): number {
    return this.drops.size;
  }

  info(id: number): { item: number; count: number; satchel: boolean } | null {
    const d = this.drops.get(id);
    return d ? { item: d.item, count: d.count, satchel: d.satchel } : null;
  }

  /** The newest satchel of ours, if any. */
  ourSatchel(): { x: number; y: number; z: number } | null {
    let best: Drop | null = null;
    for (const d of this.drops.values()) if (d.satchel && d.yours && (!best || d.id > best.id)) best = d;
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  spawn(d: ClientDrop): void {
    const old = this.drops.get(d.id);
    if (old && old.item === d.item) {
      // Same drop updated (count changed, merged).
      Object.assign(old, { count: d.count, meta: d.meta, satchel: d.satchel, yours: d.yours });
      old.ox += old.x - d.x;
      old.oy += old.y - d.y;
      old.oz += old.z - d.z;
      Object.assign(old, { x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz });
      return;
    }
    if (old) this.remove(d.id, null);
    const geo = d.item < FIRST_ITEM ? createBlockGeometry(d.item, 0.25) : buildItemModel(d.item, 'tp').clone();
    if (d.item >= FIRST_ITEM) geo.center();
    const mesh = new THREE.Mesh(geo, d.item < FIRST_ITEM ? this.opaque : d.satchel ? this.satchelMat : this.itemMat);
    if (d.satchel) mesh.scale.setScalar(1.5);
    this.group.add(mesh);
    this.drops.set(d.id, { ...d, mesh, onGround: false, ox: 0, oy: 0, oz: 0, phase: (d.id * 1.37) % 6.28, lightT: 0, fly: null });
  }

  move(id: number, x: number, y: number, z: number): void {
    const d = this.drops.get(id);
    if (!d || d.fly) return;
    d.ox += d.x - x;
    d.oy += d.y - y;
    d.oz += d.z - z;
    d.x = x;
    d.y = y;
    d.z = z;
    d.vx = d.vy = d.vz = 0;
  }

  /** Removes a drop; with `to`, it first flies there (pickup). */
  remove(id: number, to: { x: number; y: number; z: number } | null): void {
    const d = this.drops.get(id);
    if (!d) return;
    if (to) {
      d.fly = { ...to, t: 0.15 };
      return;
    }
    this.group.remove(d.mesh);
    d.mesh.geometry.dispose();
    this.drops.delete(id);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    const cam = camera.position;
    for (const d of this.drops.values()) {
      if (d.fly) {
        const k = Math.min(1, dt / Math.max(0.01, d.fly.t));
        d.x += (d.fly.x - d.x) * k;
        d.y += (d.fly.y - d.y) * k;
        d.z += (d.fly.z - d.z) * k;
        d.fly.t -= dt;
        d.mesh.scale.multiplyScalar(0.85);
        if (d.fly.t <= 0) {
          this.remove(d.id, null);
          continue;
        }
      } else if (Math.abs(d.vx) + Math.abs(d.vy) + Math.abs(d.vz) > 0.01 || !d.onGround) {
        stepDrop(d, this.get, Math.min(dt, 0.05));
      }
      const blend = Math.max(0, 1 - dt / 0.1);
      d.ox *= blend;
      d.oy *= blend;
      d.oz *= blend;
      const visible = Math.abs(d.x - cam.x) < MAX_DIST && Math.abs(d.z - cam.z) < MAX_DIST;
      d.mesh.visible = visible;
      if (!visible) continue;
      const bob = 0.06 * Math.sin(this.time * 2.2 * Math.PI * 0.5 + d.phase);
      d.mesh.position.set(d.x + d.ox, d.y + d.oy + 0.2 + bob, d.z + d.oz);
      d.mesh.rotation.y = this.time * 1.5 + d.phase;
      if ((d.lightT -= dt) <= 0) {
        d.lightT = 0.5;
        this.relight(d);
      }
    }
    this.satchelMat.uniforms.uFlash.value = 0;
  }

  private relight(d: Drop): void {
    const l = this.lightAt(Math.floor(d.x), Math.floor(d.y + 0.2), Math.floor(d.z));
    const attr = d.mesh.geometry.getAttribute('light') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const bytes = attr.array as Uint8Array;
    const sky = (l >> 4) * 17;
    const lamp = Math.max(l & 15, d.satchel ? 9 : 0) * 17;
    if (bytes[1] === sky && bytes[2] === lamp) return;
    for (let i = 0; i < attr.count; i++) {
      bytes[i * 4 + 1] = sky;
      bytes[i * 4 + 2] = lamp;
    }
    attr.needsUpdate = true;
  }

  clear(): void {
    for (const id of [...this.drops.keys()]) this.remove(id, null);
  }

  dispose(): void {
    this.clear();
    this.itemMat.dispose();
    this.satchelMat.dispose();
  }
}
