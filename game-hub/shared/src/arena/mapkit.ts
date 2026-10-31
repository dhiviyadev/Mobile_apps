/**
 * Map builder for the arena maps (design-arena-maps §2.2).
 *
 * Maps are symmetric: everything declared on the west half is mirrored to the
 * east half ('point' = through the origin (x, z) → (−x, −z), 'mirrorX' = across
 * the x = 0 plane). Items declared with mid* (or `mid = true`) are not mirrored
 * and must be self-symmetric. `build()` adds the floor slab, the perimeter walls
 * with a cap trim, and resolves named waypoints into nav links.
 *
 * Pads come from the movement builders, so their launch numbers are exactly the
 * ones the movement code (and the map validator) uses.
 */
import { boostPad, launcherPad, trampolinePad } from './movement';
import type { LaunchPad } from './geometry';
import type { ArenaMap, BoxKind, MapBox, MapPickup, MapTheme, NavLink, NavLinkKind, PickupKind, SpawnPoint } from './mapTypes';

export type Symmetry = 'point' | 'mirrorX';
/** Yaw that looks toward +X (team 0 faces east). */
export const YAW_EAST = -Math.PI / 2;
export const YAW_WEST = Math.PI / 2;
/** Yaw that looks toward −Z. */
export const YAW_NORTH = 0;
export const YAW_SOUTH = Math.PI;

export interface BuilderOptions {
  /** Half extents of the playable floor (inside the perimeter walls). */
  halfX: number;
  halfZ: number;
  /** Perimeter wall height (m). */
  wallH: number;
  symmetry: Symmetry;
}

/** A doorway in a room wall: centred at `at` along the wall, `width` wide; with `height` it is a window/slit up to that height. */
export interface Doorway {
  side: 'n' | 's' | 'w' | 'e';
  at: number;
  width: number;
  height?: number;
}

interface Wp {
  name: string;
  x: number;
  y: number;
  z: number;
}

/** Number of shell boxes `build()` puts first (floor, 4 walls, 4 cap trims). They may extend past the bounds. */
export const SHELL_BOXES = 9;

export class MapBuilder {
  private readonly half: MapBox[] = [];
  private readonly mid: MapBox[] = [];
  private readonly halfPads: LaunchPad[] = [];
  private readonly midPads: LaunchPad[] = [];
  private readonly halfPickups: MapPickup[] = [];
  private readonly midPickups: MapPickup[] = [];
  private readonly halfWps: Wp[] = [];
  private readonly midWps: Wp[] = [];
  private readonly linkSpecs: { a: string; b: string; kind: NavLinkKind; oneWay: boolean }[] = [];
  private readonly team: SpawnPoint[] = [];
  private readonly ffa: SpawnPoint[] = [];

  constructor(readonly o: BuilderOptions) {}

  // ---- geometry ----------------------------------------------------------------------------

  /** Box from centre (x, z), size w (X) × d (Z), height h, base y. Mirrored. */
  box(x: number, z: number, w: number, d: number, h: number, kind: BoxKind = 'cover', y = 0): this {
    this.half.push(mk(x, z, w, d, h, kind, y));
    return this;
  }

  /** Box from two corners. Mirrored. */
  rect(x0: number, z0: number, x1: number, z1: number, h: number, kind: BoxKind = 'cover', y = 0): this {
    this.half.push(corners(x0, z0, x1, z1, h, kind, y));
    return this;
  }

  /** Not mirrored: must be self-symmetric. */
  midBox(x: number, z: number, w: number, d: number, h: number, kind: BoxKind = 'cover', y = 0): this {
    this.mid.push(mk(x, z, w, d, h, kind, y));
    return this;
  }

  /** Not mirrored: must be self-symmetric. */
  midRect(x0: number, z0: number, x1: number, z1: number, h: number, kind: BoxKind = 'cover', y = 0): this {
    this.mid.push(corners(x0, z0, x1, z1, h, kind, y));
    return this;
  }

  /**
   * Solid stairs climbing to `base + height` at `edge`, descending away from it in direction `dir`
   * along `axis`, spanning [from, to] on the other axis (rise 0.4 m, run 0.6 m).
   */
  stairs(edge: number, axis: 'x' | 'z', dir: 1 | -1, from: number, to: number, height: number, base = 0, mid = false): this {
    (mid ? this.mid : this.half).push(...stairBoxes(edge, axis, dir, from, to, height, base));
    return this;
  }

  /** A room: four walls of thickness t around [x0,x1]×[z0,z1] with doorway gaps and an optional (walkable) roof slab. */
  room(x0: number, z0: number, x1: number, z1: number, h: number, doors: Doorway[], opts: { t?: number; roof?: number; kind?: BoxKind; mid?: boolean; y?: number } = {}): this {
    const t = opts.t ?? 0.6;
    const y0 = opts.y ?? 0;
    const kind = opts.kind ?? 'wall';
    const out = opts.mid ? this.mid : this.half;
    const side = (s: Doorway['side']) => doors.filter((d) => d.side === s).sort((a, b) => a.at - b.at);
    // North (z0) and south (z1) walls run along X; west (x0) and east (x1) walls run along Z between them.
    const runX = (z: number, s: 'n' | 's') => {
      let cur = x0;
      for (const d of side(s)) {
        const a = d.at - d.width / 2;
        const b = d.at + d.width / 2;
        if (a > cur) out.push({ minX: cur, maxX: a, minY: y0, maxY: y0 + h, minZ: z, maxZ: z + t, kind });
        if (d.height !== undefined) out.push({ minX: a, maxX: b, minY: y0 + d.height, maxY: y0 + h, minZ: z, maxZ: z + t, kind });
        cur = b;
      }
      if (cur < x1) out.push({ minX: cur, maxX: x1, minY: y0, maxY: y0 + h, minZ: z, maxZ: z + t, kind });
    };
    const runZ = (x: number, s: 'w' | 'e') => {
      let cur = z0 + t;
      for (const d of side(s)) {
        const a = d.at - d.width / 2;
        const b = d.at + d.width / 2;
        if (a > cur) out.push({ minX: x, maxX: x + t, minY: y0, maxY: y0 + h, minZ: cur, maxZ: a, kind });
        if (d.height !== undefined) out.push({ minX: x, maxX: x + t, minY: y0 + d.height, maxY: y0 + h, minZ: a, maxZ: b, kind });
        cur = b;
      }
      if (cur < z1 - t) out.push({ minX: x, maxX: x + t, minY: y0, maxY: y0 + h, minZ: cur, maxZ: z1 - t, kind });
    };
    runX(z0, 'n');
    runX(z1 - t, 's');
    runZ(x0, 'w');
    runZ(x1 - t, 'e');
    if (opts.roof !== undefined) out.push({ minX: x0, maxX: x1, minY: y0 + h, maxY: y0 + h + opts.roof, minZ: z0, maxZ: z1, kind: 'platform' });
    return this;
  }

  /** Stepped mound: `layers` solid boxes, each 0.4 m higher and `inset` m smaller on every side (walkable without jumping). */
  mound(x: number, z: number, w: number, d: number, layers: number, inset = 1.2, kind: BoxKind = 'cover', mid = false): this {
    const out = mid ? this.mid : this.half;
    for (let k = 0; k < layers; k++) {
      const ww = w - 2 * inset * k;
      const dd = d - 2 * inset * k;
      if (ww <= 0 || dd <= 0) break;
      out.push(mk(x, z, ww, dd, 0.4 * (k + 1), kind, 0));
    }
    return this;
  }

  // ---- interactive pads --------------------------------------------------------------------

  /** Trampoline: square pad of side `size` whose base rests on `y`; apex `height` above the pad top. */
  trampoline(x: number, z: number, size: number, height: number, y = 0, mid = false): this {
    const top = y + 0.3;
    (mid ? this.mid : this.half).push(mk(x, z, size, size, 0.3, 'pad', y));
    (mid ? this.midPads : this.halfPads).push(trampolinePad(x, z, size, size, top, height));
    return this;
  }

  /** Aimed launcher: pad centre (x, z) on surface y, lands on `target`, peaking `apex` above the pad top. */
  launcher(x: number, z: number, size: number, target: { x: number; y: number; z: number }, apex: number, y = 0, mid = false): this {
    const top = y + 0.3;
    (mid ? this.mid : this.half).push(mk(x, z, size, size, 0.3, 'pad', y));
    (mid ? this.midPads : this.halfPads).push(launcherPad(x, z, size, size, top, target, apex));
    return this;
  }

  /** Speed strip: w × d pad, 0.2 m tall, pushes `speed` m/s toward dirYaw with a small hop. */
  boost(x: number, z: number, w: number, d: number, dirYaw: number, speed = 8, y = 0): this {
    const top = y + 0.2;
    this.half.push(mk(x, z, w, d, 0.2, 'pad', y));
    this.halfPads.push(boostPad(x, z, w, d, top, dirYaw, speed, 4.5));
    return this;
  }

  // ---- pickups, spawns, nav -------------------------------------------------------------------

  pickup(kind: PickupKind, x: number, y: number, z: number, mid = false): this {
    (mid ? this.midPickups : this.halfPickups).push({ kind, x, y, z });
    return this;
  }

  /** Team 0 spawn (team 1 gets the mirror). */
  teamSpawn(x: number, y: number, z: number, yaw = YAW_EAST): this {
    this.team.push({ x, y, z, yaw });
    return this;
  }

  /** FFA spawn facing the centre (mirrored). */
  ffaSpawn(x: number, y: number, z: number): this {
    this.ffa.push({ x, y, z, yaw: Math.atan2(x, z) });
    return this;
  }

  /** Named waypoint; its mirror is named `name'`. */
  wp(name: string, x: number, y: number, z: number): this {
    this.halfWps.push({ name, x, y, z });
    return this;
  }

  /** Waypoint on the symmetry axis (not mirrored). */
  midWp(name: string, x: number, y: number, z: number): this {
    this.midWps.push({ name, x, y, z });
    return this;
  }

  /** Links two named waypoints; mirrored automatically (a' ↔ b'). 'drop' and 'pad' links are one-way. */
  link(a: string, b: string, kind: NavLinkKind = 'walk', oneWay = kind === 'drop' || kind === 'pad'): this {
    this.linkSpecs.push({ a, b, kind, oneWay });
    return this;
  }

  /** Chain of walk links a-b-c-… */
  chain(...names: string[]): this {
    for (let i = 1; i < names.length; i++) this.link(names[i - 1], names[i]);
    return this;
  }

  // ---- mirroring ----------------------------------------------------------------------------------

  private mx(x: number, z: number): [number, number] {
    return this.o.symmetry === 'point' ? [-x, -z] : [-x, z];
  }

  private mirrorBox(b: MapBox): MapBox {
    return this.o.symmetry === 'point'
      ? { ...b, minX: -b.maxX, maxX: -b.minX, minZ: -b.maxZ, maxZ: -b.minZ }
      : { ...b, minX: -b.maxX, maxX: -b.minX };
  }

  private mirrorPad(p: LaunchPad): LaunchPad {
    return this.o.symmetry === 'point'
      ? { ...p, minX: -p.maxX, maxX: -p.minX, minZ: -p.maxZ, maxZ: -p.minZ, vx: -p.vx, vz: -p.vz }
      : { ...p, minX: -p.maxX, maxX: -p.minX, vx: -p.vx };
  }

  private mirrorYaw(yaw: number): number {
    return this.o.symmetry === 'point' ? wrap(yaw + Math.PI) : wrap(-yaw);
  }

  build(meta: { id: string; name: string; description: string; tags: string[]; theme: MapTheme }): ArenaMap {
    const { halfX, halfZ, wallH } = this.o;
    const shell: MapBox[] = [
      { minX: -halfX - 1, maxX: halfX + 1, minY: -1, maxY: 0, minZ: -halfZ - 1, maxZ: halfZ + 1, kind: 'floor' },
      { minX: -halfX - 1, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: -halfZ - 1, maxZ: -halfZ, kind: 'wall' },
      { minX: -halfX - 1, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: halfZ, maxZ: halfZ + 1, kind: 'wall' },
      { minX: -halfX - 1, maxX: -halfX, minY: 0, maxY: wallH, minZ: -halfZ, maxZ: halfZ, kind: 'wall' },
      { minX: halfX, maxX: halfX + 1, minY: 0, maxY: wallH, minZ: -halfZ, maxZ: halfZ, kind: 'wall' },
      // Cap trim on top of the perimeter.
      { minX: -halfX - 1.2, maxX: halfX + 1.2, minY: wallH, maxY: wallH + 0.3, minZ: -halfZ - 1.2, maxZ: -halfZ + 0.2, kind: 'trim' },
      { minX: -halfX - 1.2, maxX: halfX + 1.2, minY: wallH, maxY: wallH + 0.3, minZ: halfZ - 0.2, maxZ: halfZ + 1.2, kind: 'trim' },
      { minX: -halfX - 1.2, maxX: -halfX + 0.2, minY: wallH, maxY: wallH + 0.3, minZ: -halfZ + 0.2, maxZ: halfZ - 0.2, kind: 'trim' },
      { minX: halfX - 0.2, maxX: halfX + 1.2, minY: wallH, maxY: wallH + 0.3, minZ: -halfZ + 0.2, maxZ: halfZ - 0.2, kind: 'trim' },
    ];
    const boxes = [...shell, ...this.half, ...this.half.map((b) => this.mirrorBox(b)), ...this.mid];
    const pads = [...this.halfPads, ...this.halfPads.map((p) => this.mirrorPad(p)), ...this.midPads];
    const pickups = [
      ...this.halfPickups,
      ...this.halfPickups.map((p) => {
        const [x, z] = this.mx(p.x, p.z);
        return { ...p, x, z };
      }),
      ...this.midPickups,
    ];
    // Waypoints: half, mirrored half ("name'"), mid.
    const names = new Map<string, number>();
    const waypoints: { x: number; y: number; z: number }[] = [];
    for (const w of this.halfWps) {
      names.set(w.name, waypoints.length);
      waypoints.push({ x: w.x, y: w.y, z: w.z });
    }
    for (const w of this.halfWps) {
      const [x, z] = this.mx(w.x, w.z);
      names.set(`${w.name}'`, waypoints.length);
      waypoints.push({ x, y: w.y, z });
    }
    const midNames = new Set<string>();
    for (const w of this.midWps) {
      names.set(w.name, waypoints.length);
      midNames.add(w.name);
      waypoints.push({ x: w.x, y: w.y, z: w.z });
    }
    const mirrorName = (n: string) => (midNames.has(n) ? n : n.endsWith("'") ? n.slice(0, -1) : `${n}'`);
    const idx = (n: string) => {
      const i = names.get(n);
      if (i === undefined) throw new Error(`${meta.id}: unknown waypoint ${n}`);
      return i;
    };
    const links: NavLink[] = [];
    const seen = new Set<string>();
    const add = (a: string, b: string, kind: NavLinkKind, oneWay: boolean) => {
      const ia = idx(a);
      const ib = idx(b);
      const key = oneWay ? `${ia}>${ib}` : `${Math.min(ia, ib)}-${Math.max(ia, ib)}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push(oneWay ? { a: ia, b: ib, kind, oneWay: true } : { a: ia, b: ib, kind });
    };
    for (const l of this.linkSpecs) {
      add(l.a, l.b, l.kind, l.oneWay);
      add(mirrorName(l.a), mirrorName(l.b), l.kind, l.oneWay);
    }
    const team1 = this.team.map((s) => {
      const [x, z] = this.mx(s.x, s.z);
      return { x, y: s.y, z, yaw: this.mirrorYaw(s.yaw) };
    });
    const ffa = [
      ...this.ffa,
      ...this.ffa.map((s) => {
        const [x, z] = this.mx(s.x, s.z);
        return { x, y: s.y, z, yaw: Math.atan2(x, z) };
      }),
    ];
    return {
      ...meta,
      boxes,
      pads,
      pickups,
      spawns: { team: [[...this.team], team1], ffa },
      waypoints,
      links,
      bounds: { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ },
    };
  }
}

function mk(x: number, z: number, w: number, d: number, h: number, kind: BoxKind, y: number): MapBox {
  return { minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2, kind };
}

function corners(x0: number, z0: number, x1: number, z1: number, h: number, kind: BoxKind, y: number): MapBox {
  return { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), minY: y, maxY: y + h, kind };
}

/** Solid stair steps (see MapBuilder.stairs). `height` must be a multiple of `rise`. */
export function stairBoxes(edge: number, axis: 'x' | 'z', dir: 1 | -1, from: number, to: number, height: number, base = 0, rise = 0.4, run = 0.6): MapBox[] {
  const n = Math.round(height / rise);
  if (Math.abs(n * rise - height) > 1e-6) throw new Error(`stairs height ${height} is not a multiple of ${rise}`);
  const out: MapBox[] = [];
  for (let k = 0; k < n - 1; k++) {
    const top = base + height - rise * (k + 1);
    const a = edge + dir * k * run;
    const b = edge + dir * (k + 1) * run;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    out.push(
      axis === 'x'
        ? { minX: lo, maxX: hi, minY: base, maxY: top, minZ: from, maxZ: to, kind: 'stairs' }
        : { minX: from, maxX: to, minY: base, maxY: top, minZ: lo, maxZ: hi, kind: 'stairs' },
    );
  }
  return out;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
