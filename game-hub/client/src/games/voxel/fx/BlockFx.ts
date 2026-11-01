/**
 * Block interaction visuals: target highlight box, crack overlay while
 * breaking, and a pooled instanced particle burst when a block breaks.
 */
import * as THREE from 'three';
import { ATLAS_COLS, blockDef, SHAPE_BOUNDS, Tile } from '@hub/shared';

const MAX_PARTICLES = 160;

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  color: number;
}

export class BlockFx {
  readonly group = new THREE.Group();
  private readonly highlight: THREE.LineSegments;
  private readonly crack: THREE.Mesh;
  private readonly crackTiles: THREE.BufferAttribute;
  private readonly particles: THREE.InstancedMesh;
  private readonly pool: Particle[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(crackMaterial: THREE.Material, private effects = 1) {
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.highlight = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: 0x10131c, transparent: true, opacity: 0.55 }));
    this.highlight.visible = false;

    // Crack overlay: a slightly larger cube using the atlas crack tiles.
    const cube = new THREE.BoxGeometry(1.01, 1.01, 1.01);
    const n = cube.attributes.position.count;
    this.crackTiles = new THREE.BufferAttribute(new Uint8Array(n * 2), 2);
    // Shade, sky, block, emissive: full-bright (the crack shader ignores light).
    const light = new THREE.BufferAttribute(new Uint8Array(n * 4).fill(255), 4, true);
    cube.setAttribute('tile', this.crackTiles);
    cube.setAttribute('light', light);
    this.crack = new THREE.Mesh(cube, crackMaterial);
    this.crack.visible = false;
    this.crack.renderOrder = 3;

    this.particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PARTICLES);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.group.add(this.highlight, this.crack, this.particles);
  }

  setEffects(level: number): void {
    this.effects = level;
  }

  /** Outlines the target cell, shrunk to the block's shape (slabs, plants, torches...). */
  showHighlight(x: number, y: number, z: number, block = 1): void {
    this.highlight.visible = true;
    this.fitToShape(this.highlight, x, y, z, block);
  }

  /** Scales and moves a unit-cube object to the shape bounds of `block` at (x, y, z). */
  private fitToShape(o: THREE.Object3D, x: number, y: number, z: number, block: number): void {
    const b = block * 6;
    const x0 = SHAPE_BOUNDS[b], y0 = SHAPE_BOUNDS[b + 1], z0 = SHAPE_BOUNDS[b + 2];
    const x1 = SHAPE_BOUNDS[b + 3], y1 = SHAPE_BOUNDS[b + 4], z1 = SHAPE_BOUNDS[b + 5];
    o.scale.set(Math.max(0.02, x1 - x0), Math.max(0.02, y1 - y0), Math.max(0.02, z1 - z0));
    o.position.set(x + (x0 + x1) / 2, y + (y0 + y1) / 2, z + (z0 + z1) / 2);
  }

  hideHighlight(): void {
    this.highlight.visible = false;
    this.crack.visible = false;
  }

  /** @param progress 0..1, hides the overlay at 0 */
  setCrack(x: number, y: number, z: number, progress: number, block = 1): void {
    if (progress <= 0) {
      this.crack.visible = false;
      return;
    }
    const stage = Math.min(7, Math.floor(progress * 8));
    const tile = Tile.Crack0 + stage;
    for (let i = 0; i < this.crackTiles.count; i++) this.crackTiles.setXY(i, tile % ATLAS_COLS, Math.floor(tile / ATLAS_COLS));
    this.crackTiles.needsUpdate = true;
    this.crack.visible = true;
    this.fitToShape(this.crack, x, y, z, block);
  }

  burst(x: number, y: number, z: number, block: number): void {
    const count = Math.round(14 * this.effects);
    const base = blockDef(block).color;
    for (let i = 0; i < count; i++) {
      const p: Particle = {
        x: x + 0.2 + Math.random() * 0.6,
        y: y + 0.2 + Math.random() * 0.6,
        z: z + 0.2 + Math.random() * 0.6,
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 3,
        vz: (Math.random() - 0.5) * 4,
        life: 0.5 + Math.random() * 0.4,
        size: 0.08 + Math.random() * 0.1,
        color: this.color.setHex(base).multiplyScalar(0.7 + Math.random() * 0.45).getHex(),
      };
      if (this.pool.length >= MAX_PARTICLES) this.pool.shift();
      this.pool.push(p);
    }
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= 18 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const s = p.size * Math.min(1, p.life * 3);
      this.matrix.makeScale(s, s, s);
      this.matrix.setPosition(p.x, p.y, p.z);
      this.particles.setMatrixAt(n, this.matrix);
      this.color.setHex(p.color);
      this.particles.setColorAt(n, this.color);
      this.pool[n++] = p;
    }
    this.pool.length = n;
    this.particles.count = n;
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
