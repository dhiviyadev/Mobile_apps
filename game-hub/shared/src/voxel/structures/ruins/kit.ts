/**
 * Drawing helpers shared by the set-2 templates (generator 4): discs,
 * cylinders, rings, rooms, pillars, stairs and weathering on a StructureVolume.
 * All coordinates are volume-local and inclusive, like StructureVolume.fill.
 */
import { Block } from '../../blocks';
import type { Vec3i } from '../types';
import type { StructureVolume } from '../volume';

export type Rng = () => number;

/** A volume with drawing helpers; it also remembers the arena cells that are not air by design. */
export class Pen {
  readonly furniture: Vec3i[] = [];
  constructor(readonly v: StructureVolume) {}

  set(x: number, y: number, z: number, id: number): void {
    this.v.set(x, y, z, id);
  }
  get(x: number, y: number, z: number): number {
    return this.v.get(x, y, z);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    this.v.fill(x0, y0, z0, x1, y1, z1, id);
  }
  /** A cell inside the arena that is solid or lit on purpose (the arena test skips furniture). */
  furnish(x: number, y: number, z: number, id: number): void {
    this.v.set(x, y, z, id);
    this.furniture.push({ x: this.v.ox + x, y: this.v.oy + y, z: this.v.oz + z });
  }
  /** Filled circle of radius r at height y. */
  disc(cx: number, cz: number, y: number, r: number, id: number): void {
    const R = r * r + 0.25;
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (z - cz) ** 2 <= R) this.set(x, y, z, id);
  }
  /** Filled cylinder from y0 to y1. */
  cyl(cx: number, cz: number, y0: number, y1: number, r: number, id: number): void {
    for (let y = y0; y <= y1; y++) this.disc(cx, cz, y, r, id);
  }
  /** Hollow wall: cells between radius r - thickness and r. */
  ringWall(cx: number, cz: number, y0: number, y1: number, r: number, id: number, thickness = 1): void {
    const o = r * r + 0.25;
    const i = (r - thickness) * (r - thickness) + 0.25;
    for (let y = y0; y <= y1; y++) {
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const d = (x - cx) ** 2 + (z - cz) ** 2;
          if (d <= o && d > i) this.set(x, y, z, id);
        }
      }
    }
  }
  /** Box shell (walls, floor and ceiling) with an air interior. */
  room(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: number, floor = wall, ceil = wall): void {
    this.fill(x0, y0, z0, x1, y1, z1, wall);
    this.fill(x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1, Block.Air);
    this.fill(x0, y0, z0, x1, y0, z1, floor);
    this.fill(x0, y1, z0, x1, y1, z1, ceil);
  }
  /** Vertical column of blocks, optionally with a different base and cap block. */
  pillar(x: number, z: number, y0: number, y1: number, shaft: number, base?: number, cap?: number): void {
    this.fill(x, y0, z, x, y1, z, shaft);
    if (base !== undefined) this.set(x, y0, z, base);
    if (cap !== undefined) this.set(x, y1, z, cap);
  }
  /** Straight 3D line (stepped along the longest axis). */
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), Math.round(z0 + ((z1 - z0) * i) / n), id);
  }
  /** Randomly replaces cells of `from` with `to` (weathering, moss, cracks). */
  weather(rng: Rng, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, from: readonly number[], to: number, chance: number): void {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (from.includes(this.get(x, y, z)) && rng() < chance) this.set(x, y, z, to);
        }
      }
    }
  }
  /**
   * Stairs of full blocks: `n` steps rising 1 per block, `w` wide, starting
   * at (x, y, z) and heading dir = [dx, dz]. The cells above each step are
   * cleared (3 high) and the cells below filled down to `y - 1`.
   */
  stairs(x: number, y: number, z: number, dir: readonly [number, number], n: number, w: number, id: number): void {
    const [dx, dz] = dir;
    const px = dz !== 0 ? 1 : 0;
    const pz = dx !== 0 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < w; k++) {
        const sx = x + dx * i + px * k;
        const sz = z + dz * i + pz * k;
        for (let yy = y - 1; yy <= y + i; yy++) this.set(sx, yy, sz, id);
        for (let h = 1; h <= 3; h++) this.set(sx, y + i + h, sz, Block.Air);
      }
    }
  }
}

export const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);
