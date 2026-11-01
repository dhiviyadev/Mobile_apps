/**
 * A* on the voxel grid for creatures (design-voxel-mobs §4.8): 8 directions
 * without corner cutting, 1-block jumps, drops up to maxDrop, swimming, wall
 * climbing for crawlers, hazards impassable, a node cap per request and a
 * budget per tick (PathScheduler). Bosses use a 2D ArenaGrid instead.
 */
import { CONTACT_DAMAGE, IS_LIQUID, IS_SOLID } from '../blocks';
import type { BlockQuery } from '../physics';
import type { Box3i } from '../structures/types';
import type { Mob } from './types';

export interface PathRequest {
  /** Start feet cell. */
  sx: number;
  sy: number;
  sz: number;
  /** Goal cell. */
  tx: number;
  ty: number;
  tz: number;
  /** Body height in blocks. */
  height: number;
  maxDrop: number;
  /** Crawlers: vertical moves along walls. */
  climb: boolean;
  swim: 'avoid' | 'allow' | 'only';
  maxNodes: number;
  /** Accept nodes within this horizontal distance of the goal. */
  goalRadius: number;
  leash: Box3i | null;
}

export interface PathResult {
  /** x, y, z triples from the start (excluded) to the end. */
  cells: Int16Array;
  length: number;
  /** False: best-effort partial path toward the closest node found. */
  complete: boolean;
  expanded: number;
}

const MAX_NODES = 4096;
const DIRS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];
const packKey = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (z + 1024)) * 64 + y;

export class Pathfinder {
  private readonly nx = new Int16Array(MAX_NODES);
  private readonly ny = new Int16Array(MAX_NODES);
  private readonly nz = new Int16Array(MAX_NODES);
  private readonly ng = new Float32Array(MAX_NODES);
  private readonly npar = new Int32Array(MAX_NODES);
  private readonly nclosed = new Uint8Array(MAX_NODES);
  private hk = new Float64Array(MAX_NODES);
  private hv = new Int32Array(MAX_NODES);
  private hn = 0;
  private readonly map = new Map<number, number>();

  constructor(private readonly get: BlockQuery) {}

  private hazard(b: number): boolean {
    return CONTACT_DAMAGE[b] > 0;
  }

  /** Body fits at the feet cell and something holds it up (floor, liquid for swimmers, a wall for climbers). */
  private standable(x: number, y: number, z: number, r: PathRequest): boolean {
    if (y < 1 || y > 62) return false;
    const get = this.get;
    const h = Math.max(1, Math.ceil(r.height - 0.01));
    for (let k = 0; k < h; k++) {
      const b = get(x, y + k, z);
      if (IS_SOLID[b] || this.hazard(b)) return false;
    }
    const feet = get(x, y, z);
    const below = get(x, y - 1, z);
    if (this.hazard(below)) return false;
    if (r.swim === 'only') return IS_LIQUID[feet] === 1;
    if (IS_SOLID[below]) return true;
    if (IS_LIQUID[feet] || IS_LIQUID[below]) return r.swim !== 'avoid' || IS_LIQUID[feet] === 1;
    if (r.climb) return IS_SOLID[get(x + 1, y, z)] + IS_SOLID[get(x - 1, y, z)] + IS_SOLID[get(x, y, z + 1)] + IS_SOLID[get(x, y, z - 1)] > 0;
    return false;
  }

  private inLeash(x: number, y: number, z: number, b: Box3i | null): boolean {
    return !b || (x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1 && y >= b.y0 - 1 && y < b.y1);
  }

  private push(f: number, v: number): void {
    if (this.hn >= this.hk.length) {
      const a = new Float64Array(this.hk.length * 2);
      a.set(this.hk);
      this.hk = a;
      const b = new Int32Array(this.hv.length * 2);
      b.set(this.hv);
      this.hv = b;
    }
    let i = this.hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.hk[p] <= f) break;
      this.hk[i] = this.hk[p];
      this.hv[i] = this.hv[p];
      i = p;
    }
    this.hk[i] = f;
    this.hv[i] = v;
  }

  private pop(): number {
    const top = this.hv[0];
    const f = this.hk[--this.hn];
    const v = this.hv[this.hn];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.hn) break;
      if (c + 1 < this.hn && this.hk[c + 1] < this.hk[c]) c++;
      if (this.hk[c] >= f) break;
      this.hk[i] = this.hk[c];
      this.hv[i] = this.hv[c];
      i = c;
    }
    this.hk[i] = f;
    this.hv[i] = v;
    return top;
  }

  find(r: PathRequest): PathResult {
    const get = this.get;
    const map = this.map;
    map.clear();
    this.hn = 0;
    let n = 0;
    const heur = (x: number, y: number, z: number) => {
      const ax = Math.abs(r.tx - x);
      const az = Math.abs(r.tz - z);
      return 1.1 * (Math.max(ax, az) + 0.414 * Math.min(ax, az)) + 0.5 * Math.abs(r.ty - y);
    };
    const add = (x: number, y: number, z: number, g: number, p: number) => {
      const id = n++;
      this.nx[id] = x;
      this.ny[id] = y;
      this.nz[id] = z;
      this.ng[id] = g;
      this.npar[id] = p;
      this.nclosed[id] = 0;
      map.set(packKey(x, y, z), id);
      this.push(g + heur(x, y, z), id);
    };
    const relax = (x: number, y: number, z: number, g: number, c: number) => {
      if (!this.inLeash(x, y, z, r.leash)) return;
      const k = packKey(x, y, z);
      const ex = map.get(k);
      if (ex === undefined) {
        if (n < MAX_NODES - 1) add(x, y, z, g, c);
      } else if (!this.nclosed[ex] && g < this.ng[ex]) {
        this.ng[ex] = g;
        this.npar[ex] = c;
        this.push(g + heur(x, y, z), ex);
      }
    };
    add(r.sx, r.sy, r.sz, 0, -1);
    const h = Math.max(1, Math.ceil(r.height - 0.01));
    let best = 0;
    let bestH = Infinity;
    let expanded = 0;
    let complete = false;
    const gr2 = r.goalRadius * r.goalRadius;
    while (this.hn > 0 && expanded < r.maxNodes) {
      const c = this.pop();
      if (this.nclosed[c]) continue;
      this.nclosed[c] = 1;
      expanded++;
      const cx = this.nx[c];
      const cy = this.ny[c];
      const cz = this.nz[c];
      const ddx = r.tx - cx;
      const ddz = r.tz - cz;
      const hd = Math.hypot(ddx, ddz) + Math.abs(r.ty - cy);
      if (hd < bestH) {
        bestH = hd;
        best = c;
      }
      if (ddx * ddx + ddz * ddz <= Math.max(gr2, 0.01) && Math.abs(cy - r.ty) <= 1.5) {
        best = c;
        complete = true;
        break;
      }
      for (const [dx, dz, cost] of DIRS) {
        const x = cx + dx;
        const z = cz + dz;
        if (dx && dz) {
          // No corner cutting: both orthogonal neighbours must be open at both rows.
          let clear = true;
          for (let k = 0; k < h && clear; k++) {
            if (IS_SOLID[get(cx + dx, cy + k, cz)] || IS_SOLID[get(cx, cy + k, cz + dz)]) clear = false;
          }
          if (!clear) continue;
        }
        let y = -1;
        let extra = 0;
        if (this.standable(x, cy, z, r)) y = cy;
        else if (!dx || !dz) {
          // Jump up one block (needs headroom above the current cell).
          if (this.standable(x, cy + 1, z, r) && !IS_SOLID[get(cx, cy + h, cz)]) {
            y = cy + 1;
            extra = 0.8;
          }
        }
        if (y < 0) {
          for (let d = 1; d <= r.maxDrop; d++) {
            if (IS_SOLID[get(x, cy - d + h, z)]) break;
            if (this.standable(x, cy - d, z, r)) {
              y = cy - d;
              extra = 0.4 * d;
              break;
            }
          }
          if (y < 0) continue;
        }
        if (r.swim === 'avoid' && IS_LIQUID[get(x, y, z)]) extra += 4;
        // Next to cactus costs more.
        if (CONTACT_DAMAGE[get(x + 1, y, z)] || CONTACT_DAMAGE[get(x - 1, y, z)] || CONTACT_DAMAGE[get(x, y, z + 1)] || CONTACT_DAMAGE[get(x, y, z - 1)]) extra += 6;
        relax(x, y, z, this.ng[c] + cost + extra, c);
      }
      // Climbers: straight up along a wall, up to 8 above the floor.
      if (r.climb && !IS_SOLID[get(cx, cy + h, cz)]) {
        const wall = IS_SOLID[get(cx + 1, cy, cz)] + IS_SOLID[get(cx - 1, cy, cz)] + IS_SOLID[get(cx, cy, cz + 1)] + IS_SOLID[get(cx, cy, cz - 1)] > 0;
        if (wall && this.standable(cx, cy + 1, cz, r)) {
          let floor = 0;
          while (floor < 9 && !IS_SOLID[get(cx, cy - floor - 1, cz)]) floor++;
          if (floor < 8) relax(cx, cy + 1, cz, this.ng[c] + 1.5, c);
        }
      }
      // Fish: up and down in water.
      if (r.swim === 'only') {
        for (const dy of [1, -1]) if (this.standable(cx, cy + dy, cz, r)) relax(cx, cy + dy, cz, this.ng[c] + 1, c);
      }
    }
    let len = 0;
    for (let i = best; i > 0 && this.npar[i] >= 0; i = this.npar[i]) len++;
    const cells = new Int16Array(len * 3);
    let k = len - 1;
    for (let i = best; i > 0 && this.npar[i] >= 0; i = this.npar[i], k--) {
      cells[k * 3] = this.nx[i];
      cells[k * 3 + 1] = this.ny[i];
      cells[k * 3 + 2] = this.nz[i];
    }
    return { cells, length: len, complete, expanded };
  }
}

interface QueuedRequest {
  mob: Mob;
  req: PathRequest;
  priority: number;
  seq: number;
}

/** Runs path requests within a per-tick expansion budget, priority first, then FIFO. */
export class PathScheduler {
  private queue: QueuedRequest[] = [];
  private seq = 0;
  /** Expansions spent in the last pump. */
  lastSpent = 0;

  constructor(private readonly pf: Pathfinder) {}

  /** Replaces that mob's pending request. */
  request(mob: Mob, req: PathRequest, priority: number): void {
    this.cancel(mob);
    mob.pathPending = true;
    this.queue.push({ mob, req, priority, seq: this.seq++ });
  }

  cancel(mob: Mob): void {
    if (!mob.pathPending) return;
    this.queue = this.queue.filter((q) => q.mob !== mob);
    mob.pathPending = false;
  }

  get pending(): number {
    return this.queue.length;
  }

  pump(budget: number): void {
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let spent = 0;
    while (this.queue.length) {
      const remaining = budget - spent;
      const q = this.queue[0];
      if (remaining < Math.min(q.req.maxNodes, 40)) break;
      this.queue.shift();
      if (!q.mob.alive) continue;
      const req = q.req.maxNodes > remaining ? { ...q.req, maxNodes: remaining } : q.req;
      const res = this.pf.find(req);
      spent += res.expanded;
      q.mob.pathPending = false;
      q.mob.path = res;
      q.mob.pathIndex = 0;
    }
    this.lastSpent = spent;
  }
}

/**
 * Bosses: a 2D walkability grid of the arena floor (obstacles inflated by the
 * boss's half width) with A* when the straight line to a goal is blocked.
 */
export class ArenaGrid {
  readonly w: number;
  readonly d: number;
  readonly open: Uint8Array;

  constructor(get: BlockQuery, readonly box: Box3i, floorY: number, half: number) {
    this.w = box.x1 - box.x0;
    this.d = box.z1 - box.z0;
    const raw = new Uint8Array(this.w * this.d);
    for (let z = 0; z < this.d; z++) {
      for (let x = 0; x < this.w; x++) {
        const wx = box.x0 + x;
        const wz = box.z0 + z;
        raw[z * this.w + x] = IS_SOLID[get(wx, floorY, wz)] || IS_SOLID[get(wx, floorY + 1, wz)] ? 0 : 1;
      }
    }
    const r = Math.max(0, Math.ceil(half - 0.5));
    this.open = new Uint8Array(this.w * this.d);
    for (let z = 0; z < this.d; z++) {
      for (let x = 0; x < this.w; x++) {
        let ok = 1;
        for (let dz = -r; dz <= r && ok; dz++) {
          for (let dx = -r; dx <= r && ok; dx++) {
            const xx = x + dx;
            const zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= this.w || zz >= this.d || !raw[zz * this.w + xx]) ok = 0;
          }
        }
        this.open[z * this.w + x] = ok;
      }
    }
  }

  isOpen(wx: number, wz: number): boolean {
    const x = Math.floor(wx) - this.box.x0;
    const z = Math.floor(wz) - this.box.z0;
    return x >= 0 && z >= 0 && x < this.w && z < this.d && this.open[z * this.w + x] === 1;
  }

  /** True when the straight line between the points stays on open cells. */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.4);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.isOpen(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /** Next waypoint (cell centre) toward the goal, or the goal itself when the line is clear. */
  nextWaypoint(ax: number, az: number, bx: number, bz: number): { x: number; z: number } {
    if (this.clearLine(ax, az, bx, bz)) return { x: bx, z: bz };
    const w = this.w;
    const sx = Math.floor(ax) - this.box.x0;
    const sz = Math.floor(az) - this.box.z0;
    let gx = Math.floor(bx) - this.box.x0;
    let gz = Math.floor(bz) - this.box.z0;
    gx = Math.max(0, Math.min(w - 1, gx));
    gz = Math.max(0, Math.min(this.d - 1, gz));
    const N = w * this.d;
    const g = new Float32Array(N).fill(Infinity);
    const par = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const start = Math.max(0, Math.min(N - 1, sz * w + sx));
    g[start] = 0;
    const open: number[] = [start];
    const goal = gz * w + gx;
    let best = start;
    let bestH = Infinity;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        const a = open[i];
        const b = open[bi];
        if (g[a] + Math.hypot((a % w) - gx, Math.floor(a / w) - gz) < g[b] + Math.hypot((b % w) - gx, Math.floor(b / w) - gz)) bi = i;
      }
      const c = open.splice(bi, 1)[0];
      if (closed[c]) continue;
      closed[c] = 1;
      const cx = c % w;
      const cz = Math.floor(c / w);
      const hd = Math.hypot(cx - gx, cz - gz);
      if (hd < bestH) {
        bestH = hd;
        best = c;
      }
      if (c === goal) break;
      for (const [dx, dz, cost] of DIRS) {
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= w || z >= this.d) continue;
        const i = z * w + x;
        if (!this.open[i] || closed[i]) continue;
        if (dx && dz && (!this.open[cz * w + x] || !this.open[z * w + cx])) continue;
        if (g[c] + cost < g[i]) {
          g[i] = g[c] + cost;
          par[i] = c;
          open.push(i);
        }
      }
    }
    // Walk back to the first step, then skip ahead while the line stays clear.
    const pathCells: number[] = [];
    for (let i = best; i !== -1 && i !== start; i = par[i]) pathCells.push(i);
    pathCells.reverse();
    let target = pathCells[0];
    for (const c of pathCells) {
      const px = this.box.x0 + (c % w) + 0.5;
      const pz = this.box.z0 + Math.floor(c / w) + 0.5;
      if (this.clearLine(ax, az, px, pz)) target = c;
      else break;
    }
    if (target === undefined) return { x: bx, z: bz };
    return { x: this.box.x0 + (target % w) + 0.5, z: this.box.z0 + Math.floor(target / w) + 0.5 };
  }
}
