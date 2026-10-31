/**
 * Map validator (design-arena-maps §2.3–2.4), used by the tests and as dev
 * tooling; production bundles tree-shake it.
 *
 *  - validateMap: every rule a map must satisfy (standable spawns, pickups and
 *    waypoints, symmetric team spawns, pad bases, landing zones and headroom,
 *    a strongly connected nav graph, and the physical traversal of every nav
 *    edge with the real movement code and bot steering at several weapon speeds).
 *  - traverseEdge: moves a body like a bot along one nav edge.
 *  - findOpenLane: an open stretch of floor for tests that need a clear shot.
 */
import type { Vec3 } from '../util/math';
import { airThrottle, botJump, NavGraph, trampolineThrottle } from './bots';
import { CMD_DT, MOVE, PAD, PLAYER } from './constants';
import { type BoxWorld, createArenaWorld } from './geometry';
import { SHELL_BOXES } from './mapkit';
import type { ArenaMap, NavLinkKind, SpawnPoint } from './mapTypes';
import { createMoveState, stepMovement } from './movement';

export interface MapProblem {
  /** Rule that failed: 'box', 'spawn', 'pickup', 'waypoint', 'pad', 'nav', 'edge', 'size'. */
  code: string;
  message: string;
}

const R = PLAYER.radius;

/** Body free (0.7 × 1.75 m) and ground within 5 cm under the feet. */
export function standable(w: BoxWorld, x: number, y: number, z: number): boolean {
  const free = !w.overlaps(x - R, y + 0.01, z - R, x + R, y + PLAYER.height, z + R);
  const ground = w.overlaps(x - R, y - 0.05, z - R, x + R, y + 0.01, z + R);
  return free && ground;
}

/**
 * Moves a fresh body like a bot from `from` along one nav edge to `to` (through the pad node `via` for pad edges),
 * with the same jump and throttle helpers botCommand uses. ok = it stood within 0.9 m of `to` at its height.
 */
export function traverseEdge(world: BoxWorld, from: Vec3, via: Vec3 | null, to: Vec3, kind: NavLinkKind, speedMul: number): { ok: boolean; time: number; why?: string } {
  const s = createMoveState(from.x, from.y, from.z);
  let target = via ?? to;
  let launched = false;
  const run = MOVE.walkSpeed * speedMul;
  const dist = Math.hypot(to.x - from.x, to.z - from.z) + (via ? Math.hypot(via.x - from.x, via.z - from.z) : 0);
  const max = Math.ceil((dist / 4 + 5) / CMD_DT);
  for (let n = 0; n < max; n++) {
    const dx = target.x - s.x;
    const dz = target.z - s.z;
    const d = Math.hypot(dx, dz);
    if (target === to && d < 0.9 && Math.abs(s.y - to.y) < 0.35 && s.onGround) return { ok: true, time: n * CMD_DT };
    const yaw = Math.atan2(-dx, -dz);
    const coast = !s.onGround && Math.hypot(s.vx, s.vz) > run * 1.05;
    const jump = kind === 'jump' && botJump(world, s, target, d);
    // Trampolines keep horizontal speed: approach them at the speed that carries us to the landing point.
    let throttle = 1;
    if (via && target === via && !launched) {
      const pi = world.padAt(via.x, via.y, via.z, 0);
      if (pi >= 0 && world.pads[pi].horizontal === 'keep' && d < 4) throttle = trampolineThrottle(world.pads[pi], via, to, run);
    }
    if (!s.onGround) throttle = Math.min(throttle, airThrottle(s, target, d, run));
    const r = stepMovement(s, { moveX: 0, moveY: coast ? 0 : throttle, yaw, jump, crouch: false, speedMul }, world, CMD_DT);
    if (r.launched >= 0) {
      if (!via) return { ok: false, time: n * CMD_DT, why: `launched by pad ${r.launched} on a ${kind} edge` };
      if (!launched) {
        launched = true;
        target = to;
      }
    }
    if (s.y < -2) return { ok: false, time: n * CMD_DT, why: 'fell out' };
  }
  return { ok: false, time: max * CMD_DT, why: `timeout at (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})` };
}

const fmt = (p: Vec3) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

/**
 * Runs the map rules (design-arena-maps §2.3) on a map built by MapBuilder (its first SHELL_BOXES boxes are the
 * floor, perimeter walls and cap trim). Returns [] when the map is valid.
 */
export function validateMap(map: ArenaMap, opts: { speeds?: number[] } = {}): MapProblem[] {
  const out: MapProblem[] = [];
  const err = (code: string, message: string) => out.push({ code, message });
  const w = createArenaWorld(map);
  const b = map.bounds;
  const eps = 1e-6;

  // 1. Boxes: non-degenerate, inside the walls.
  map.boxes.forEach((bx, i) => {
    if (!(bx.minX < bx.maxX && bx.minY < bx.maxY && bx.minZ < bx.maxZ)) err('box', `box ${i} is degenerate`);
    if (i >= SHELL_BOXES && (bx.minX < b.minX - eps || bx.maxX > b.maxX + eps || bx.minZ < b.minZ - eps || bx.maxZ > b.maxZ + eps)) {
      err('box', `box ${i} (${bx.kind}) lies outside the bounds`);
    }
  });
  // 8. Size and climb heights.
  const long = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  if (long < 72 || long > 96) err('size', `long axis ${long} m is outside 72–96 m`);
  map.boxes.forEach((bx, i) => {
    const h = bx.maxY - bx.minY;
    if (bx.minY <= eps && h > 1.7 + eps && h < 1.8 - eps) err('size', `box ${i} is ${h.toFixed(2)} m tall: ambiguous to climb`);
  });

  // 2–3. Spawns, pickups and waypoints.
  const spawnLists: [string, SpawnPoint[]][] = [['team 0', map.spawns.team[0]], ['team 1', map.spawns.team[1]], ['ffa', map.spawns.ffa]];
  for (const [name, list] of spawnLists) {
    list.forEach((s, i) => {
      if (!standable(w, s.x, s.y, s.z)) err('spawn', `${name} spawn ${i} ${fmt(s)} is not standable`);
      if (w.padAt(s.x, s.y, s.z, R) >= 0) err('spawn', `${name} spawn ${i} is on a pad`);
    });
  }
  if (map.spawns.team[0].length !== 6 || map.spawns.team[1].length !== 6) err('spawn', 'each team needs 6 spawns');
  if (map.spawns.ffa.length !== 8) err('spawn', `${map.spawns.ffa.length} FFA spawns (need 8)`);
  map.spawns.team[0].forEach((s, i) => {
    const m = map.spawns.team[1][i];
    const mirrored = m && Math.abs(m.x + s.x) < eps && Math.abs(m.y - s.y) < eps && (Math.abs(m.z + s.z) < eps || Math.abs(m.z - s.z) < eps);
    if (!mirrored) err('spawn', `team spawn ${i} has no mirror on the other side`);
  });
  map.pickups.forEach((p, i) => {
    if (!standable(w, p.x, p.y, p.z)) err('pickup', `pickup ${i} ${fmt(p)} is not standable`);
    if (w.padAt(p.x, p.y, p.z, R) >= 0) err('pickup', `pickup ${i} is on a pad`);
  });
  map.waypoints.forEach((p, i) => {
    if (!standable(w, p.x, p.y, p.z)) err('waypoint', `waypoint ${i} ${fmt(p)} is not standable`);
  });

  // 4. Pads: a matching base box, a clear 0.15 m step at every edge, headroom over trampolines.
  map.pads.forEach((p, i) => {
    const base = map.boxes.some((bx) => bx.kind === 'pad' && Math.abs(bx.maxY - p.top) < eps && Math.abs(bx.minX - p.minX) < eps && Math.abs(bx.maxX - p.maxX) < eps && Math.abs(bx.minZ - p.minZ) < eps && Math.abs(bx.maxZ - p.maxZ) < eps);
    if (!base) err('pad', `pad ${i} has no base box`);
    const h = p.top - Math.max(...map.boxes.filter((bx) => bx.kind !== 'pad' && bx.minX < p.maxX && bx.maxX > p.minX && bx.minZ < p.maxZ && bx.maxZ > p.minZ && bx.maxY <= p.top - 0.1).map((bx) => bx.maxY));
    if (h < 0.2 - eps || h > 0.35 + eps) err('pad', `pad ${i} is ${h.toFixed(2)} m tall (0.2–0.35)`);
    const cx = (p.minX + p.maxX) / 2;
    const cz = (p.minZ + p.maxZ) / 2;
    for (const [ox, oz] of [[p.minX - 0.5, cz], [p.maxX + 0.5, cz], [cx, p.minZ - 0.5], [cx, p.maxZ + 0.5]]) {
      const top = w.highestTop(ox - 0.05, oz - 0.05, ox + 0.05, oz + 0.05, p.top - 0.5, p.top + 0.14);
      if (top > -Infinity && Math.abs(top - p.top) < 0.15) err('pad', `pad ${i}: a surface beside it is within 0.15 m of its top`);
    }
    if (p.horizontal === 'keep') {
      const apex = ((p.vy * p.vy) / (2 * MOVE.gravity)) * PAD.jumpBonus * PAD.jumpBonus;
      const hit = w.raycast(cx, p.top + PLAYER.height + 0.01, cz, 0, 1, 0, apex + 0.5);
      if (hit) err('pad', `pad ${i}: trampoline ceiling ${hit.t.toFixed(2)} m above the head`);
    }
    if (p.horizontal === 'set') {
      // Landing zone: the arc comes down inside a 4 × 4 m area of one walkable level.
      const land = launchLanding(w, p);
      if (!land) err('pad', `pad ${i}: launcher never lands`);
      else if (!flatSquareAround(w, land, 4)) err('pad', `pad ${i}: no 4 × 4 m landing zone around ${fmt(land)}`);
    }
  });

  // 5–7. Navigation.
  const nav = new NavGraph(map, w);
  map.pads.forEach((p, i) => {
    if (p.horizontal !== 'add' && !nav.padNode.includes(i)) err('nav', `pad ${i} (${p.horizontal}) has no waypoint: bots never use it`);
  });
  const nodes = nav.points.map((_, i) => i).filter((i) => nav.padNode[i] < 0);
  if (nodes.length) {
    const fwd = reach(nav, nodes[0], false);
    const back = reach(nav, nodes[0], true);
    for (const i of nodes) {
      if (!fwd.has(i)) err('nav', `waypoint ${i} ${fmt(nav.points[i])} is unreachable`);
      if (!back.has(i)) err('nav', `waypoint ${i} ${fmt(nav.points[i])} has no way back`);
    }
  }
  for (const speed of opts.speeds ?? [1]) {
    nav.adj.forEach((edges, a) => {
      for (const e of edges) {
        if (nav.padNode[e.to] >= 0) continue; // checked as part of the pad edge out of it
        if (e.kind === 'pad') {
          const sources = nav.adj.map((es, i) => (es.some((x) => x.to === a) ? i : -1)).filter((i) => i >= 0);
          if (!sources.length) err('nav', `pad node ${a} has no way in`);
          for (const src of sources) {
            const r = traverseEdge(w, nav.points[src], nav.points[a], nav.points[e.to], 'pad', speed);
            if (!r.ok) err('edge', `pad ${src}→${a}→${e.to} at ×${speed}: ${r.why}`);
          }
          continue;
        }
        const r = traverseEdge(w, nav.points[a], null, nav.points[e.to], e.kind, speed);
        if (!r.ok) err('edge', `${e.kind} ${a} ${fmt(nav.points[a])} → ${e.to} ${fmt(nav.points[e.to])} at ×${speed}: ${r.why}`);
      }
    });
  }
  return out;
}

/** Where a launcher's arc comes down (stepping the movement integrator from the pad top centre). */
export function launchLanding(w: BoxWorld, p: { minX: number; maxX: number; minZ: number; maxZ: number; top: number; vx: number; vy: number; vz: number }): Vec3 | null {
  const s = createMoveState((p.minX + p.maxX) / 2, p.top, (p.minZ + p.maxZ) / 2);
  s.vx = p.vx;
  s.vy = p.vy;
  s.vz = p.vz;
  s.onGround = false;
  for (let n = 0; n < 600; n++) {
    stepMovement(s, { moveX: 0, moveY: 0, yaw: 0, jump: false, crouch: false, speedMul: 1 }, w, CMD_DT);
    // stepMovement keeps the launch momentum in the air; grounded friction would not matter here.
    if (s.onGround) return { x: s.x, y: s.y, z: s.z };
  }
  return null;
}

/** Whether some size × size square containing `p` has clear, walkable ground at p.y (within a step) all over it. */
function flatSquareAround(w: BoxWorld, p: Vec3, size: number): boolean {
  const level = (x: number, z: number) =>
    Math.abs(w.highestTop(x - 0.05, z - 0.05, x + 0.05, z + 0.05, p.y - 1, p.y + 0.46) - p.y) <= 0.45 &&
    !w.overlaps(x - 0.05, p.y + 0.5, z - 0.05, x + 0.05, p.y + 1.7, z + 0.05);
  for (let ox = -size; ox <= 0; ox += 0.5) {
    for (let oz = -size; oz <= 0; oz += 0.5) {
      let ok = true;
      for (let i = 0; i <= 4 && ok; i++) for (let j = 0; j <= 4 && ok; j++) ok = level(p.x + ox + (size * i) / 4, p.z + oz + (size * j) / 4);
      if (ok) return true;
    }
  }
  return false;
}

function reach(nav: NavGraph, start: number, reverse: boolean): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift()!;
    if (!reverse) {
      for (const e of nav.adj[u]) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    } else {
      nav.adj.forEach((es, v) => {
        if (!seen.has(v) && es.some((e) => e.to === u)) {
          seen.add(v);
          queue.push(v);
        }
      });
    }
  }
  return seen;
}

/**
 * Two open floor points `len` m apart along +X with clear sight at 0.5 / 1.2 / 1.6 m, plus a side-step spot `side` m
 * toward +Z from the second one (also in sight). Scans z = 0, ±1, ±2 … and x from west to east.
 */
export function findOpenLane(map: ArenaMap, len = 8, side = 2.5): { a: Vec3; b: Vec3; side: Vec3 } | null {
  const w = createArenaWorld(map);
  const { minX, maxX, minZ, maxZ } = map.bounds;
  const nearPad = (x: number, z: number) => map.pads.some((p) => x > p.minX - 1.5 && x < p.maxX + 1.5 && z > p.minZ - 1.5 && z < p.maxZ + 1.5);
  const open = (x: number, z: number) => standable(w, x, 0, z) && !nearPad(x, z);
  const sees = (a: Vec3, q: Vec3) => [0.5, 1.2, 1.6].every((h) => w.visible(a.x, a.y + 1.6, a.z, q.x, q.y + h, q.z));
  const zs = [0];
  for (let d = 1; d <= Math.floor(maxZ - minZ) / 2; d++) zs.push(d, -d);
  for (const z of zs) {
    if (z < minZ + 2 || z + side > maxZ - 2) continue;
    for (let x = Math.ceil(minX + 2); x + len <= maxX - 2; x++) {
      const a = { x, y: 0, z };
      const b = { x: x + len, y: 0, z };
      const s = { x: x + len, y: 0, z: z + side };
      if (!open(a.x, a.z) || !open(b.x, b.z) || !open(s.x, s.z)) continue;
      if (sees(a, b) && sees(a, s)) return { a, b, side: s };
    }
  }
  return null;
}
