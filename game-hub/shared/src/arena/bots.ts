/**
 * Bots. They produce the same input commands a human client sends, so they
 * obey identical movement, fire-rate and ammo rules (design-arena-maps §6).
 *
 *  - Difficulty profiles (Easy / Normal / Hard): sight range and view cone,
 *    reaction time that grows with distance, aim that tracks where the target
 *    WAS a moment ago, a settling initial error plus a persistent wobble,
 *    burst/pause trigger discipline and a turn-rate limit. Normal is clearly
 *    weaker than the old bots; Hard is about their strength.
 *  - Weapon handling from WeaponDef.bot data: preferred range, trigger
 *    tolerance, engage range, scoping, semi-auto pulsing, ballistic lead for
 *    projectiles, knife reach.
 *  - Navigation over the map's nav graph: typed links (walk / jump / drop /
 *    pad), Dijkstra on travel time, transit-only pad nodes, jump and throttle
 *    steering for ledges and trampolines (the same helpers the map validator
 *    traverses every edge with).
 *  - Goals: chase the last sighting, investigate gunfire, turn to an unseen
 *    attacker, fetch health/ammo, hunt late in a round, otherwise roam.
 *
 * Only `import type` from sim.ts here: sim.ts imports this file as a value.
 */
import type { Vec3 } from '../util/math';
import { BOT_HUNT_AFTER, CMD_DT, MOVE, PLAYER, ROUND_TIME, SLIDE, TICK_RATE } from './constants';
import type { BoxWorld, LaunchPad } from './geometry';
import type { ArenaMap, NavLinkKind } from './mapTypes';
import { eyeHeight, type MoveState } from './movement';
import { Buttons, type Command, type PlayerSim } from './player';
import { ballisticAim } from './projectiles';
import type { ArenaSimulation, SimPlayer } from './sim';
import { weaponDef } from './weapons';

// ---- difficulty ------------------------------------------------------------------------------

export type BotDifficulty = 'easy' | 'normal' | 'hard';
/** Index = ArenaState.botDifficulty. */
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export const isBotDifficulty = (v: unknown): v is BotDifficulty => v === 'easy' || v === 'normal' || v === 'hard';

export interface BotProfile {
  // perception
  /** m: never notices an enemy farther than this. */
  sightRange: number;
  /** rad: awareness cone half-angle (a target already engaged is kept outside it). */
  fovHalf: number;
  /** m: notices anyone this close regardless of the cone. */
  closeAware: number;
  /** m: gunfire within this radius is investigated. */
  hearRange: number;
  /** s: delay before turning toward an unseen attacker. */
  reactToHit: number;
  // reaction and aim
  /** s: random range before the first shot at a newly acquired target. */
  reaction: [number, number];
  /** s of extra first-shot delay per metre of distance. */
  noticePerMetre: number;
  /** rad/s: max view turn speed. */
  turnRate: number;
  /** s: aims at where the target WAS this long ago. */
  trackLag: number;
  /** rad: initial error on acquisition (random sign, 50–100 %). */
  aimError0: number;
  /** 1/s: exponential decay of that error while tracking. */
  aimSettle: number;
  /** rad: persistent wobble amplitude (×1.3 while the bot moves). */
  aimFloor: number;
  /** Wobble re-targets per second (smoothed at 8/s). */
  wobbleHz: number;
  /** m above the feet aimed at when the target stands (×0.74 crouched); the head starts at 1.33. */
  aimHeight: number;
  /** × weapon trigger tolerance. */
  tolMul: number;
  /** m: max distance to open fire (×1.6 for scoped weapons). */
  engageRange: number;
  /** × def.bot.scopeFirst before a scoped shot. */
  scopeMul: number;
  /** Fraction of the true lead used for projectiles. */
  leadFactor: number;
  // trigger discipline
  /** s: automatic weapons hold the trigger this long… */
  burst: [number, number];
  /** s: …then pause this long. */
  pause: [number, number];
  /** s: minimum time between semi-auto / burst trigger pulls. */
  semiCadence: number;
  // movement
  /** Combat strafe stick magnitude (× run speed). */
  strafe: number;
  /** Per second: chance to slide while closing in. */
  slideChase: number;
  /** Per second: chance to slide on long roam segments. */
  slideRoam: number;
  /** Per-bot sharpness spread: sharp = 1 ± skillJitter. */
  skillJitter: number;
}

const deg = (d: number) => (d * Math.PI) / 180;

/** Measured against a strafing player at 8–20 m: Normal takes 2–3× as long to kill as the old bots, Easy 5–6×, Hard ≈ old. */
export const BOT_PROFILES: Readonly<Record<BotDifficulty, Readonly<BotProfile>>> = {
  easy: {
    sightRange: 45, fovHalf: deg(50), closeAware: 2.5, hearRange: 15, reactToHit: 0.9,
    reaction: [0.7, 0.95], noticePerMetre: 0.012, turnRate: 2.4, trackLag: 0.13,
    aimError0: 0.3, aimSettle: 1.4, aimFloor: 0.04, wobbleHz: 2.5, aimHeight: 1.05,
    tolMul: 1.3, engageRange: 32, scopeMul: 2.5, leadFactor: 0.4,
    burst: [0.25, 0.45], pause: [0.5, 0.8], semiCadence: 0.5,
    strafe: 0.35, slideChase: 0, slideRoam: 0, skillJitter: 0.1,
  },
  normal: {
    sightRange: 65, fovHalf: deg(60), closeAware: 3.5, hearRange: 25, reactToHit: 0.55,
    reaction: [0.5, 0.7], noticePerMetre: 0.008, turnRate: 3.2, trackLag: 0.09,
    aimError0: 0.22, aimSettle: 2.0, aimFloor: 0.028, wobbleHz: 3, aimHeight: 1.15,
    tolMul: 1.0, engageRange: 48, scopeMul: 1.7, leadFactor: 0.6,
    burst: [0.35, 0.65], pause: [0.3, 0.5], semiCadence: 0.32,
    strafe: 0.5, slideChase: 0.2, slideRoam: 0.1, skillJitter: 0.1,
  },
  hard: {
    sightRange: 90, fovHalf: deg(70), closeAware: 5, hearRange: 40, reactToHit: 0.3,
    reaction: [0.3, 0.42], noticePerMetre: 0.004, turnRate: 4.6, trackLag: 0.06,
    aimError0: 0.15, aimSettle: 3.0, aimFloor: 0.016, wobbleHz: 4, aimHeight: 1.25,
    tolMul: 0.8, engageRange: 75, scopeMul: 1.1, leadFactor: 0.85,
    burst: [0.6, 1.0], pause: [0.15, 0.3], semiCadence: 0.22,
    strafe: 0.7, slideChase: 0.45, slideRoam: 0.2, skillJitter: 0.1,
  },
};

// ---- navigation -----------------------------------------------------------------------------------

export interface NavEdge {
  to: number;
  kind: NavLinkKind;
  /** Travel time estimate (s). */
  cost: number;
}

export const NAV = {
  /** m: auto-link same-level waypoints this close. */
  autoLinkDist: 16,
  /** m: "same level". */
  autoLinkDy: 0.3,
  /** m: ground sampling along auto links. */
  groundStep: 0.5,
  /** Walk links keep this far from pads (stepping on one launches you). */
  padClearance: PLAYER.radius + 0.25,
  /** m/s: edge cost = distance / walkSpeed. */
  walkSpeed: 8,
  /** s added to jump edges. */
  jumpPenalty: 0.4,
  /** m/s for pad edges… */
  padSpeed: 14,
  /** …plus this. */
  padPenalty: 0.6,
} as const;

type Point = { x: number; y: number; z: number };

export class NavGraph {
  readonly points: readonly Point[];
  readonly adj: NavEdge[][];
  /** Pad index under each waypoint, or -1. Pad nodes are transit-only (never a path start or goal). */
  readonly padNode: number[];
  /** Nearest non-pad node to each map pickup. */
  readonly pickupNode: number[];

  constructor(map: ArenaMap, private readonly world: BoxWorld) {
    this.points = map.waypoints;
    this.adj = this.points.map(() => []);
    this.padNode = this.points.map((p) => world.padAt(p.x, p.y, p.z, 0));
    const add = (a: number, b: number, kind: NavLinkKind) => {
      if (a === b || this.adj[a].some((e) => e.to === b)) return;
      const p = this.points[a];
      const q = this.points[b];
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      const cost = kind === 'pad' ? d / NAV.padSpeed + NAV.padPenalty : d / NAV.walkSpeed + (kind === 'jump' ? NAV.jumpPenalty : 0);
      this.adj[a].push({ to: b, kind, cost });
    };
    for (const l of map.links) {
      if (!this.points[l.a] || !this.points[l.b]) continue;
      if (l.kind === 'pad' || l.kind === 'drop' || l.oneWay) {
        add(l.a, l.b, l.kind);
        continue;
      }
      // walk / jump: two-way, except that nothing walks OFF a pad node (it launches you).
      if (this.padNode[l.a] < 0) add(l.a, l.b, l.kind);
      if (this.padNode[l.b] < 0) add(l.b, l.a, l.kind);
    }
    // Auto-link points on the same level with a clear, grounded, pad-free walk between them.
    for (let i = 0; i < this.points.length; i++) {
      if (this.padNode[i] >= 0) continue;
      for (let j = i + 1; j < this.points.length; j++) {
        if (this.padNode[j] >= 0) continue;
        const p = this.points[i];
        const q = this.points[j];
        if (Math.abs(p.y - q.y) > NAV.autoLinkDy || Math.hypot(p.x - q.x, p.z - q.z) > NAV.autoLinkDist) continue;
        if (!walkable(world, p, q)) continue;
        add(i, j, 'walk');
        add(j, i, 'walk');
      }
    }
    this.pickupNode = map.pickups.map((pk) => this.nearest(pk.x, pk.y, pk.z));
  }

  /**
   * Nearest non-pad node (vertical distance weighted ×2), preferring one in plain sight at knee and chest
   * height, so a bot never starts a path at a node behind a wall.
   */
  nearest(x: number, y: number, z: number): number {
    let best = -1;
    let bestD = Infinity;
    let seen = -1;
    let seenD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      if (this.padNode[i] >= 0) continue;
      const p = this.points[i];
      const d = Math.hypot(p.x - x, (p.y - y) * 2, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (d < seenD && d < 24 && this.world.visible(x, y + 0.5, z, p.x, p.y + 0.5, p.z) && this.world.visible(x, y + 1.5, z, p.x, p.y + 1.5, p.z)) {
        seenD = d;
        seen = i;
      }
    }
    return Math.max(0, seen >= 0 ? seen : best);
  }

  /** Cheapest path (Dijkstra over travel-time costs), excluding the start; [] when unreachable. */
  path(from: number, to: number): number[] {
    if (from === to) return [to];
    const { dist, prev } = this.dijkstra(from, to);
    if (!Number.isFinite(dist[to])) return [];
    const out: number[] = [];
    for (let v = to; v !== from; v = prev[v]) out.unshift(v);
    return out;
  }

  /** Travel time from `from` to every node (Infinity when unreachable). */
  costsFrom(from: number): Float64Array {
    return this.dijkstra(from, -1).dist;
  }

  /** Link kind from → to, or null when they are not linked. */
  kind(from: number, to: number): NavLinkKind | null {
    return this.adj[from]?.find((e) => e.to === to)?.kind ?? null;
  }

  private dijkstra(from: number, stopAt: number): { dist: Float64Array; prev: Int32Array } {
    const n = this.points.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u < 0 || u === stopAt) break;
      done[u] = 1;
      for (const e of this.adj[u]) {
        const nd = dist[u] + e.cost;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
        }
      }
    }
    return { dist, prev };
  }
}

/** Same-level walk check: sight at knee and chest (and at body-radius offsets), ground all along, no pad in the way. */
export function walkable(world: BoxWorld, p: Point, q: Point): boolean {
  if (!world.visible(p.x, p.y + 0.5, p.z, q.x, q.y + 0.5, q.z) || !world.visible(p.x, p.y + 1.5, p.z, q.x, q.y + 1.5, q.z)) return false;
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  // Parallel lines offset by the body radius on both sides (doorframes, pillars).
  const ox = (-dz / len) * PLAYER.radius;
  const oz = (dx / len) * PLAYER.radius;
  for (const s of [1, -1]) {
    if (!world.visible(p.x + ox * s, p.y + 1.0, p.z + oz * s, q.x + ox * s, q.y + 1.0, q.z + oz * s)) return false;
  }
  const steps = Math.ceil(len / NAV.groundStep);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = p.x + dx * t;
    const z = p.z + dz * t;
    const y = p.y + (q.y - p.y) * t;
    if (world.highestTop(x - 0.1, z - 0.1, x + 0.1, z + 0.1, y - 0.5, y + 0.46) === -Infinity) return false;
  }
  const c = NAV.padClearance;
  for (const pad of world.pads) {
    if (segmentHitsRect(p.x, p.z, q.x, q.z, pad.minX - c, pad.minZ - c, pad.maxX + c, pad.maxZ + c)) return false;
  }
  return true;
}

/** Whether the 2-D segment a→b touches the rectangle [x0,x1]×[z0,z1] (Liang–Barsky clip). */
export function segmentHitsRect(ax: number, az: number, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dz, az - z0) && clip(dz, z1 - az) && t0 <= t1;
}

// ---- steering helpers (shared with the map validator) -------------------------------------------------

/** 'jump' edges: hop up onto a higher level, hop over a low obstacle, or jump at a ledge lip (not when the target is lower). */
export function botJump(w: BoxWorld, s: MoveState, target: Vec3, d: number): boolean {
  if (!s.onGround || d < 0.5) return false;
  const ux = (target.x - s.x) / d;
  const uz = (target.z - s.z) / d;
  const ax = s.x + ux * 0.7;
  const az = s.z + uz * 0.7;
  const rise = target.y - s.y;
  if (rise > 0.45 && d < 2.8) return true;
  if (w.overlaps(ax - 0.2, s.y + 0.5, az - 0.2, ax + 0.2, s.y + 1.0, az + 0.2)) return true;
  const ground = w.highestTop(ax - 0.15, az - 0.15, ax + 0.15, az + 0.15, s.y - 6, s.y + 0.46);
  return rise > -0.5 && ground < s.y - 0.5;
}

/** Stick magnitude for running onto a 'keep' pad so the bounce carries us to `to` (trampolines keep horizontal speed). */
export function trampolineThrottle(pad: LaunchPad, padPt: Vec3, to: Vec3, runSpeed: number): number {
  const g = MOVE.gravity;
  const disc = pad.vy * pad.vy - 2 * g * (to.y - pad.top);
  if (disc <= 0) return 1;
  const t = (pad.vy + Math.sqrt(disc)) / g;
  return Math.max(0.25, Math.min(1, Math.hypot(to.x - padPt.x, to.z - padPt.z) / t / runSpeed));
}

/** In the air, push only as hard as needed to arrive over `to` when we come down to its height. */
export function airThrottle(s: MoveState, to: Vec3, dH: number, runSpeed: number): number {
  const g = MOVE.gravity;
  const disc = s.vy * s.vy + 2 * g * (s.y - to.y);
  if (disc <= 0) return 1;
  const t = (s.vy + Math.sqrt(disc)) / g;
  return Math.max(0, Math.min(1, dH / Math.max(0.05, t) / runSpeed));
}

// ---- brain ------------------------------------------------------------------------------------------------

export type BotGoal = 'roam' | 'chase' | 'investigate' | 'pickup' | 'hunt';

export interface BotBrain {
  seq: number;
  difficulty: BotDifficulty;
  /** BOT_PROFILES[difficulty]. */
  p: Readonly<BotProfile>;
  /** Per-bot sharpness around 1 (± skillJitter): > 1 reacts and aims faster. */
  sharp: number;
  yaw: number;
  pitch: number;
  // combat
  targetId: string | null;
  acquiredAt: number;
  /** sim.time from which the first shot at the target may go. */
  reactAt: number;
  errYaw: number;
  errPitch: number;
  wobYaw: number;
  wobPitch: number;
  wobTargetYaw: number;
  wobTargetPitch: number;
  wobNext: number;
  /** Automatic weapons: trigger held until (0 = no burst running), then paused until. */
  triggerUntil: number;
  pauseUntil: number;
  /** Last semi-auto / burst trigger pull. */
  lastPull: number;
  /** When the bot started scoping on the current target (0 = not scoping). */
  scopeSince: number;
  strafe: number;
  strafeUntil: number;
  // awareness
  lastSeen: { x: number; y: number; z: number; at: number } | null;
  heard: { x: number; y: number; z: number; at: number } | null;
  /** An unseen attacker; the bot turns toward it at `at`. */
  hurtBy: { id: string; at: number } | null;
  /** Look toward lookYaw (an alert) until this time. */
  lookUntil: number;
  lookYaw: number;
  // navigation
  path: number[];
  goal: number;
  /** Node the bot last reached (-1 = none): with path[0] it names the link being traversed. */
  lastNode: number;
  goalKind: BotGoal;
  /** Re-plan at this time even if the path is not finished. */
  repathAt: number;
  /** Pickup the bot is heading for (-1 = none), the exact point once its node is reached, and when to give up. */
  pickupIndex: number;
  walkTo: Point | null;
  walkUntil: number;
  /** No pickup goals before this time (after one was fetched or failed). */
  pickupRetryAt: number;
  /** Airborne in the previous command (landing check). */
  airborne: boolean;
  stuckCheckAt: number;
  stuckPos: { x: number; z: number };
  jumpUntil: number;
  rnd: () => number;
}

export function createBotBrain(rnd: () => number, difficulty: BotDifficulty = 'normal'): BotBrain {
  const p = BOT_PROFILES[difficulty];
  return {
    seq: 0,
    difficulty,
    p,
    sharp: 1 + (rnd() * 2 - 1) * p.skillJitter,
    yaw: 0,
    pitch: 0,
    targetId: null,
    acquiredAt: 0,
    reactAt: 0,
    errYaw: 0,
    errPitch: 0,
    wobYaw: 0,
    wobPitch: 0,
    wobTargetYaw: 0,
    wobTargetPitch: 0,
    wobNext: 0,
    triggerUntil: 0,
    pauseUntil: 0,
    lastPull: -1e9,
    scopeSince: 0,
    strafe: 1,
    strafeUntil: 0,
    lastSeen: null,
    heard: null,
    hurtBy: null,
    lookUntil: 0,
    lookYaw: 0,
    path: [],
    goal: -1,
    lastNode: -1,
    goalKind: 'roam',
    repathAt: Infinity,
    pickupIndex: -1,
    walkTo: null,
    walkUntil: 0,
    pickupRetryAt: 0,
    airborne: false,
    stuckCheckAt: 0,
    stuckPos: { x: 0, z: 0 },
    jumpUntil: 0,
    rnd,
  };
}

/** Switches a brain to another difficulty profile (keeps its per-bot sharpness). */
export function applyBotProfile(b: BotBrain, d: BotDifficulty): void {
  b.difficulty = d;
  b.p = BOT_PROFILES[d];
}

/** Forget everything tied to the old map (sim.changeMap() calls it for every brain). */
export function resetBotForMap(b: BotBrain): void {
  forgetRound(b);
}

/** Gunfire at (x, y, z) heard by this bot: investigated when within the profile's hearing range. */
export function hearNoise(b: BotBrain, self: PlayerSim, x: number, y: number, z: number, now: number): void {
  if (Math.hypot(x - self.x, y - self.y, z - self.z) > b.p.hearRange) return;
  const fresh = !b.heard || now - b.heard.at > 1;
  b.heard = { x, y, z, at: now };
  if (fresh && b.targetId === null) {
    // Glance toward it, and re-plan toward it unless already chasing someone.
    b.lookYaw = Math.atan2(-(x - self.x), -(z - self.z));
    b.lookUntil = now + 0.8;
    if (b.goalKind !== 'chase') b.repathAt = now;
  }
}

/** This bot took damage from attackerId: it turns toward an unseen attacker after the profile's reaction. */
export function botHurt(b: BotBrain, attackerId: string, now: number): void {
  if (b.targetId === attackerId) return;
  if (b.hurtBy && b.hurtBy.id === attackerId) return; // keep the earliest reaction time
  b.hurtBy = { id: attackerId, at: now + b.p.reactToHit / b.sharp };
}

function forgetRound(b: BotBrain): void {
  b.path = [];
  b.goal = -1;
  b.lastNode = -1;
  b.goalKind = 'roam';
  b.repathAt = Infinity;
  b.targetId = null;
  b.lastSeen = null;
  b.heard = null;
  b.hurtBy = null;
  b.lookUntil = 0;
  b.pickupIndex = -1;
  b.walkTo = null;
  b.triggerUntil = 0;
  b.scopeSince = 0;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpRange = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;
const turnToward = (cur: number, target: number, maxStep: number) => cur + Math.max(-maxStep, Math.min(maxStep, wrap(target - cur)));

// ---- goals ------------------------------------------------------------------------------------------------

/** Picks the next navigation goal and its path (design-arena-maps §6.5, first rule that applies wins). */
function planGoal(sim: ArenaSimulation, bot: SimPlayer, brain: BotBrain): void {
  const nav = sim.nav;
  const me = bot.sim;
  const now = sim.time;
  const from = nav.nearest(me.x, me.y, me.z);
  brain.repathAt = Infinity;
  brain.walkTo = null;
  brain.pickupIndex = -1;
  const go = (goal: number, kind: BotGoal): boolean => {
    let path = nav.path(from, goal);
    if (!path.length) return false;
    // Walk to the start node first unless we are already on it.
    const s = nav.points[from];
    if (from !== goal && (Math.hypot(s.x - me.x, s.z - me.z) > 1.1 || Math.abs(s.y - me.y) > 1.2)) path = [from, ...path];
    brain.path = path;
    brain.goal = goal;
    brain.goalKind = kind;
    brain.lastNode = from;
    return true;
  };

  // 1. Chase the last sighting.
  if (brain.lastSeen && now - brain.lastSeen.at < 5) {
    const ls = brain.lastSeen;
    brain.lastSeen = null; // one attempt per sighting
    if (go(nav.nearest(ls.x, ls.y, ls.z), 'chase')) return;
  }
  // 2. Investigate a noise (or an attacker's position).
  if (brain.heard && now - brain.heard.at < 4) {
    const h = brain.heard;
    brain.heard = null;
    if (go(nav.nearest(h.x, h.y, h.z), 'investigate')) return;
  }
  // 3. Late in a live round: home in on the nearest living enemy.
  if (sim.phase === 'live' && ROUND_TIME - sim.phaseTimer > BOT_HUNT_AFTER) {
    let best: SimPlayer | null = null;
    let bestD = Infinity;
    for (const o of sim.players.values()) {
      if (o === bot || !o.sim.alive || (sim.teams > 0 && o.team === bot.team)) continue;
      const d = Math.hypot(o.sim.x - me.x, o.sim.z - me.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best && go(nav.nearest(best.sim.x, best.sim.y, best.sim.z), 'hunt')) {
      brain.repathAt = now + 3;
      return;
    }
  }
  // 4–5. Health when hurt, ammo when low: the cheapest available pickup within 6 s.
  const pickups = sim.map.pickups;
  if (pickups.length && now >= brain.pickupRetryAt) {
    const w0 = me.weapons[0];
    const d0 = weaponDef(w0.id);
    const wantHealth = me.hp <= 55;
    const wantAmmo = d0.reserve > 0 && w0.mag + w0.reserve < 0.35 * (d0.magazine + d0.reserve);
    if (wantHealth || wantAmmo) {
      const costs = nav.costsFrom(from);
      let pick = -1;
      for (const kind of ['health', 'ammo'] as const) {
        if (kind === 'health' ? !wantHealth : !wantAmmo) continue;
        let bestCost = 6;
        for (let i = 0; i < pickups.length; i++) {
          if (pickups[i].kind !== kind || (sim.pickups.ready[i] ?? 0) > sim.tick) continue;
          const c = costs[nav.pickupNode[i]];
          if (c <= bestCost) {
            bestCost = c;
            pick = i;
          }
        }
        if (pick >= 0) break;
      }
      if (pick >= 0) {
        const node = nav.pickupNode[pick];
        if (node === from || go(node, 'pickup')) {
          if (node === from) {
            brain.path = [];
            brain.goalKind = 'pickup';
            brain.lastNode = from;
          }
          brain.pickupIndex = pick;
          if (!brain.path.length) startPickupWalk(sim, brain, now);
          return;
        }
      }
    }
  }
  // 6. Roam: mostly through the middle third of the map.
  const sizeX = sim.map.bounds.maxX - sim.map.bounds.minX;
  const candidates: number[] = [];
  const middle: number[] = [];
  for (let i = 0; i < nav.points.length; i++) {
    if (nav.padNode[i] >= 0 || i === from) continue;
    candidates.push(i);
    if (Math.abs(nav.points[i].x) < sizeX / 6) middle.push(i);
  }
  for (let attempt = 0; attempt < 4 && candidates.length; attempt++) {
    const pool = brain.rnd() < 0.6 && middle.length ? middle : candidates;
    if (go(pool[Math.floor(brain.rnd() * pool.length)], 'roam')) return;
  }
  brain.path = [];
  brain.goalKind = 'roam';
}

/** The pickup's node is reached: walk onto the pickup itself for a moment. */
function startPickupWalk(sim: ArenaSimulation, brain: BotBrain, now: number): void {
  const pk = sim.map.pickups[brain.pickupIndex];
  brain.walkTo = pk ? { x: pk.x, y: pk.y, z: pk.z } : null;
  brain.walkUntil = now + 2.5;
  brain.pickupRetryAt = now + 8;
}

// ---- the command ----------------------------------------------------------------------------------------------

/** Produces one 1/60 s command for a bot. */
export function botCommand(sim: ArenaSimulation, bot: SimPlayer, brain: BotBrain): Command {
  const dt = CMD_DT;
  const now = sim.time;
  const me = bot.sim;
  const P = brain.p;
  const k = brain.sharp;
  const cmd: Command = { seq: ++brain.seq, moveX: 0, moveY: 0, yaw: brain.yaw, pitch: brain.pitch, buttons: 0, slot: 255, viewTick: sim.tick };
  if (!me.alive) {
    brain.yaw = me.yaw;
    brain.targetId = null;
    brain.path = [];
    brain.lastNode = -1;
    return { ...cmd, yaw: me.yaw };
  }
  if (sim.phase === 'loadout' || sim.phase === 'vote') {
    // Frozen: face the spawn direction and start the round with a clean head.
    brain.yaw = me.yaw;
    brain.pitch = 0;
    forgetRound(brain);
    return { ...cmd, yaw: me.yaw, pitch: 0 };
  }

  const world = sim.world;
  const nav = sim.nav;
  const eyeY = me.y + eyeHeight(me.crouching, me.sliding);
  const weapon = me.weapons[me.slot];
  const def = weaponDef(weapon.id);
  const prof = def.bot;
  const run = MOVE.walkSpeed * (me.aiming ? def.aimMoveMul : def.moveMul);
  const hs = Math.hypot(me.vx, me.vz);
  const canSlide = me.onGround && !me.sliding && me.slideCooldown === 0 && hs >= SLIDE.minStartSpeed + 0.3;

  // ---- 1. perception: nearest visible enemy within sight range, inside the cone (or close, or already engaged) ----
  let target: SimPlayer | null = null;
  let targetDist = Infinity;
  for (const o of sim.players.values()) {
    if (o === bot || !o.sim.alive) continue;
    if (sim.teams > 0 && o.team === bot.team) continue;
    const dx = o.sim.x - me.x;
    const dz = o.sim.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d >= targetDist || d > P.sightRange) continue;
    const kept = o.id === brain.targetId;
    if (!kept && d > P.closeAware && Math.abs(wrap(Math.atan2(-dx, -dz) - brain.yaw)) > P.fovHalf) continue;
    const ty = o.sim.y + (o.sim.crouching ? 0.9 : 1.2);
    if (!world.visible(me.x, eyeY, me.z, o.sim.x, ty, o.sim.z)) continue;
    target = o;
    targetDist = d;
  }

  // ---- 2. alerts: an unseen attacker makes the bot turn and investigate --------------------------------
  if (target && brain.hurtBy?.id === target.id) brain.hurtBy = null;
  if (!target && brain.hurtBy && now >= brain.hurtBy.at) {
    const att = sim.players.get(brain.hurtBy.id);
    if (att?.sim.alive) {
      brain.heard = { x: att.sim.x, y: att.sim.y, z: att.sim.z, at: now };
      brain.lookYaw = Math.atan2(-(att.sim.x - me.x), -(att.sim.z - me.z));
      brain.lookUntil = now + 1.5;
      if (brain.goalKind !== 'chase') brain.repathAt = now;
    }
    brain.hurtBy = null;
  }

  let wantX = 0;
  let wantZ = 0;
  let throttle = 1;
  let lookYaw = brain.yaw;
  let lookPitch = 0;
  let firing = false;
  let aiming = false;
  let jump = false;
  let slide = false;

  if (target) {
    // ---- 3. combat -----------------------------------------------------------------------------------
    const t = target.sim;
    if (brain.targetId !== target.id) {
      brain.targetId = target.id;
      brain.acquiredAt = now;
      brain.reactAt = now + (lerpRange(P.reaction, brain.rnd()) + P.noticePerMetre * targetDist) / k;
      brain.errYaw = ((brain.rnd() < 0.5 ? -1 : 1) * (0.5 + 0.5 * brain.rnd()) * P.aimError0) / k;
      brain.errPitch = ((brain.rnd() - 0.5) * P.aimError0) / k;
      brain.triggerUntil = 0;
      brain.scopeSince = 0;
    }
    brain.lastSeen = { x: t.x, y: t.y, z: t.z, at: now };
    brain.path = [];
    brain.walkTo = null;
    brain.goalKind = 'chase';
    // a. Where the target was a moment ago (tracking lag).
    const past = sim.poseAt(target.id, sim.tick - (P.trackLag * TICK_RATE) / k);
    let ax = past ? past.x : t.x;
    let az = past ? past.z : t.z;
    const ay = (past ? past.y : t.y) + P.aimHeight * ((past ? past.crouching : t.crouching) ? 0.74 : 1);
    // b. Projectiles: lead the target by part of the flight time.
    const spec = def.kind === 'projectile' ? def.projectile : null;
    if (spec) {
      const sol0 = ballisticAim(ax - me.x, ay - eyeY, az - me.z, spec.speed, spec.gravity);
      if (sol0) {
        ax += t.vx * sol0.time * P.leadFactor;
        az += t.vz * sol0.time * P.leadFactor;
      }
    }
    const dx = ax - me.x;
    const dz = az - me.z;
    const dy = ay - eyeY;
    const flat = Math.hypot(dx, dz);
    let basePitch = Math.atan2(dy, flat);
    if (spec) basePitch = ballisticAim(dx, dy, dz, spec.speed, spec.gravity)?.pitch ?? basePitch;
    // c. Settling error and a persistent wobble.
    const settle = Math.exp(-P.aimSettle * k * dt);
    brain.errYaw *= settle;
    brain.errPitch *= settle;
    if (now >= brain.wobNext) {
      const f = (P.aimFloor / k) * (hs > 1 ? 1.3 : 1);
      brain.wobTargetYaw = (brain.rnd() * 2 - 1) * f;
      brain.wobTargetPitch = (brain.rnd() * 2 - 1) * f * 0.6;
      brain.wobNext = now + 1 / P.wobbleHz;
    }
    const wk = Math.min(1, dt * 8);
    brain.wobYaw += (brain.wobTargetYaw - brain.wobYaw) * wk;
    brain.wobPitch += (brain.wobTargetPitch - brain.wobPitch) * wk;
    lookYaw = Math.atan2(-dx, -dz) + brain.errYaw + brain.wobYaw;
    lookPitch = basePitch + brain.errPitch + brain.wobPitch;

    // d. Keep the weapon's preferred range and strafe.
    const lx = t.x - me.x;
    const lz = t.z - me.z;
    const dirX = lx / (targetDist || 1);
    const dirZ = lz / (targetDist || 1);
    const approach = targetDist > prof.prefRange + 3 ? 1 : targetDist < prof.prefRange - 2 ? -0.6 : 0;
    if (now > brain.strafeUntil) {
      brain.strafe = brain.rnd() < 0.5 ? -1 : 1;
      brain.strafeUntil = now + 0.5 + brain.rnd() * 1.1;
    }
    wantX = dirX * approach - dirZ * brain.strafe * P.strafe;
    wantZ = dirZ * approach + dirX * brain.strafe * P.strafe;
    if (canSlide && approach > 0 && targetDist > prof.prefRange + 6 && brain.rnd() < P.slideChase * dt) slide = true;

    // e. Trigger.
    const believedErr = Math.abs(wrap(brain.yaw - lookYaw)) + Math.abs(brain.pitch - lookPitch);
    const tolerance = (prof.tolerance + prof.distTol / Math.max(4, targetDist)) * P.tolMul;
    const scoped = prof.scopeFirst > 0 && targetDist > 6;
    if (scoped) {
      aiming = true;
      if (brain.scopeSince === 0) brain.scopeSince = now;
    } else brain.scopeSince = 0;
    const scopeReady = !scoped || (now - brain.scopeSince >= (prof.scopeFirst * P.scopeMul) / k && me.ads >= 0.95);
    const inRange =
      def.kind === 'melee'
        ? targetDist <= def.range - 0.3
        : targetDist < Math.min(def.range * prof.engageMul, P.engageRange * (prof.scopeFirst > 0 ? 1.6 : 1));
    const ready = now >= brain.reactAt && believedErr < tolerance && inRange && scopeReady;
    if (def.kind === 'melee') firing = ready;
    else if (def.fireMode === 'auto') {
      // Bursts with pauses instead of a held trigger.
      if (ready && now >= brain.pauseUntil && brain.triggerUntil === 0) brain.triggerUntil = now + lerpRange(P.burst, brain.rnd());
      if (brain.triggerUntil > 0) {
        if (now < brain.triggerUntil && ready) firing = true;
        else {
          brain.triggerUntil = 0;
          brain.pauseUntil = now + lerpRange(P.pause, brain.rnd());
        }
      }
    } else {
      // Semi-auto and burst weapons: one pulse per pull, never a held trigger.
      const cadence =
        def.fireMode === 'semi'
          ? Math.max(P.semiCadence / k, def.interval)
          : Math.max(1.5 * P.semiCadence, def.interval + def.burstCount * def.burstInterval);
      if (ready && !me.fireHeld && now - brain.lastPull >= cadence) {
        firing = true;
        brain.lastPull = now;
      }
    }
  } else {
    // ---- 4. navigation ------------------------------------------------------------------------------
    brain.targetId = null;
    brain.scopeSince = 0;
    brain.triggerUntil = 0;
    // Landed somewhere unexpected (bumped mid-air, a pad we did not plan): re-plan from here.
    if (me.onGround && brain.airborne && brain.path.length) {
      const np = nav.points[brain.path[0]];
      const dH = Math.hypot(np.x - me.x, np.z - me.z);
      if ((dH > 4 && Math.abs(np.y - me.y) > 1.0) || dH > 10) brain.path = [];
    }
    // The pickup we are heading for was taken.
    if (brain.goalKind === 'pickup' && brain.pickupIndex >= 0 && (sim.pickups.ready[brain.pickupIndex] ?? 0) > sim.tick) {
      brain.path = [];
      brain.walkTo = null;
    }
    if (brain.walkTo && (now > brain.walkUntil || Math.hypot(brain.walkTo.x - me.x, brain.walkTo.z - me.z) < 0.35)) brain.walkTo = null;
    if ((brain.path.length === 0 && !brain.walkTo) || now >= brain.repathAt) planGoal(sim, bot, brain);

    if (brain.walkTo) {
      const dx = brain.walkTo.x - me.x;
      const dz = brain.walkTo.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-3) {
        wantX = dx / d;
        wantZ = dz / d;
        throttle = Math.min(1, d / 1.5 + 0.3);
        lookYaw = Math.atan2(-dx, -dz);
      }
    } else {
      // Arrival at the next node (pad nodes are passed when their pad launched us).
      while (brain.path.length) {
        const next = brain.path[0];
        const np = nav.points[next];
        const padI = nav.padNode[next];
        const dH = Math.hypot(np.x - me.x, np.z - me.z);
        const dY = np.y - me.y;
        const passedPad = padI >= 0 && bot.launchPad === padI && now - bot.launchedAt < 0.5;
        const reached = padI < 0 && dH < (me.sliding ? 2.0 : 1.1) && Math.abs(dY) < 1.2 && (me.onGround || dY > -0.2);
        if (!passedPad && !reached) break;
        brain.lastNode = brain.path.shift()!;
        if (brain.path.length === 0) {
          if (brain.goalKind === 'pickup' && brain.pickupIndex >= 0) startPickupWalk(sim, brain, now);
          else brain.goalKind = 'roam';
        }
      }
      const next = brain.path[0];
      if (next !== undefined) {
        const np = nav.points[next];
        const dx = np.x - me.x;
        const dz = np.z - me.z;
        const dH = Math.hypot(dx, dz);
        const padI = nav.padNode[next];
        const edge = nav.kind(brain.lastNode, next) ?? 'walk';
        if (dH > 1e-3) {
          wantX = dx / dH;
          wantZ = dz / dH;
          lookYaw = Math.atan2(-dx, -dz);
        }
        if (padI >= 0 && world.pads[padI].horizontal === 'keep' && dH < 4) {
          const after = brain.path[1] !== undefined ? nav.points[brain.path[1]] : np;
          throttle = trampolineThrottle(world.pads[padI], np, after, run);
        }
        if (!me.onGround) throttle = Math.min(throttle, airThrottle(me, np, dH, run));
        jump = edge === 'jump' && botJump(world, me, np, dH);
        if (canSlide && edge === 'walk' && padI < 0 && dH > 7 && brain.rnd() < P.slideRoam * dt) slide = true;
      }
    }
    if (now < brain.lookUntil) lookYaw = brain.lookYaw;
    lookPitch = 0;
  }
  brain.airborne = !me.onGround;

  // ---- 5. stuck: hop, re-plan, flip the strafe ---------------------------------------------------------------
  if (now > brain.stuckCheckAt) {
    const moved = Math.hypot(me.x - brain.stuckPos.x, me.z - brain.stuckPos.z);
    if (moved < 0.3 && (wantX || wantZ)) {
      brain.jumpUntil = now + 0.2;
      brain.path = [];
      brain.walkTo = null;
      brain.strafe = -brain.strafe;
    }
    brain.stuckPos = { x: me.x, z: me.z };
    brain.stuckCheckAt = now + 1;
  }

  // ---- 6. turn with a rate limit -------------------------------------------------------------------------------
  const turn = P.turnRate * k * dt;
  brain.yaw = turnToward(brain.yaw, lookYaw, turn);
  brain.pitch += Math.max(-turn, Math.min(turn, lookPitch - brain.pitch));

  // ---- 7. stick: world-space wish → local strafe / forward; no fighting momentum in the air --------------------
  let mx = wantX * throttle;
  let mz = wantZ * throttle;
  if (!me.onGround && hs > run * 1.05) mx = mz = 0;
  const sin = Math.sin(brain.yaw);
  const cos = Math.cos(brain.yaw);
  cmd.moveY = mx * -sin + mz * -cos;
  cmd.moveX = mx * cos + mz * -sin;
  cmd.yaw = brain.yaw;
  cmd.pitch = brain.pitch;

  // ---- 8. buttons and weapon slot -------------------------------------------------------------------------------
  let buttons = 0;
  if (firing) buttons |= Buttons.Fire;
  if (aiming) buttons |= Buttons.Aim;
  if (jump || now < brain.jumpUntil) buttons |= Buttons.Jump;
  if (slide) buttons |= Buttons.Slide;
  if (def.magazine > 0 && weapon.reserve > 0 && (weapon.mag === 0 || (!target && weapon.mag < def.magazine * 0.4))) buttons |= Buttons.Reload;
  cmd.buttons = buttons;
  // Best slot with ammo: primary, then secondary, then the blade.
  const hasAmmo = (i: number) => me.weapons[i].mag + me.weapons[i].reserve > 0;
  const best = hasAmmo(0) ? 0 : hasAmmo(1) ? 1 : 2;
  const empty = def.magazine > 0 && weapon.mag === 0 && weapon.reserve === 0;
  if ((empty && best !== me.slot) || (!target && best < me.slot)) cmd.slot = best;
  return cmd;
}
