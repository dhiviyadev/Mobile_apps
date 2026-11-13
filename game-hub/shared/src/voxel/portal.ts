/**
 * Lattice Rings: portals between the overworld and the Gloamreach (generator 4).
 *
 * A gate is twelve Lattice Stones in a 5 x 5 ring with open corners around a free
 * 3 x 3 middle, standing in a vertical plane (axis 0: the ring spans x, you
 * walk through along z; axis 1: it spans z). Using a Dusk Lens on a stone of a
 * complete ring lights it: the stones glow and the middle fills with Veil.
 * Breaking any stone closes the gate again. Standing in a lit veil for two
 * seconds carries you across (1 : 4, see realm.ts): to the lit gate nearest
 * the mapped spot, or to a new one built into the open air there.
 *
 * Everything here is plain functions over a block reader, plus PortalCore
 * (rules for lighting and travel) that runs on the server (PortalHost) and
 * offline in the browser, like TeleportCore.
 */
import { Block, IS_LIQUID, IS_REPLACEABLE, IS_SOLID } from './blocks';
import { CHUNK_HEIGHT, SEA_LEVEL } from './constants';
import { gloamToOverworld, hasDimension, overworldToGloam, Realm, realmAt, REALM_NAMES } from './realm';
import { safeSpotNear } from './teleport';

export type BlockRead = (x: number, y: number, z: number) => number;
export type BlockWrite = (x: number, y: number, z: number, id: number) => void;
type Cell = [number, number, number];

/** Seconds standing in a lit veil before the jump. */
export const PORTAL = {
  chargeMs: 2000,
  /** After arriving: no new jump for this long, and not until you stepped out of the veil. */
  cooldownMs: 4000,
  /** How far from the mapped spot a lit gate counts as the partner (blocks). */
  partnerRadius: 20,
  /** Dusk Lens use range (blocks, eye to stone centre), with the server's slack. */
  reach: 8,
  /** How long the missing-stone outline stays on screen. */
  outlineMs: 9000,
} as const;

/** Gate plane: 0 spans x (walk through along z), 1 spans z (walk through along x). */
export type GateAxis = 0 | 1;

/** A gate by its lower corner cell (u = 0, v = 0 of the 5 x 5 square) and axis. */
export interface GateFrame {
  axis: GateAxis;
  x: number;
  y: number;
  z: number;
}

/** (u, v) of the twelve ring stones in the 5 x 5 square: every border cell except the four corners. */
export const RING_UV: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let v = 0; v < 5; v++) {
    for (let u = 0; u < 5; u++) {
      const border = u === 0 || u === 4 || v === 0 || v === 4;
      const corner = (u === 0 || u === 4) && (v === 0 || v === 4);
      if (border && !corner) out.push([u, v]);
    }
  }
  return out;
})();

/** (u, v) of the 3 x 3 middle. */
export const INTERIOR_UV: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let v = 1; v <= 3; v++) for (let u = 1; u <= 3; u++) out.push([u, v]);
  return out;
})();

const at = (f: GateFrame, u: number, v: number): Cell => (f.axis === 0 ? [f.x + u, f.y + v, f.z] : [f.x, f.y + v, f.z + u]);

export const gateRing = (f: GateFrame): Cell[] => RING_UV.map(([u, v]) => at(f, u, v));
export const gateInterior = (f: GateFrame): Cell[] => INTERIOR_UV.map(([u, v]) => at(f, u, v));
/** The cell centre of the middle (for effects and arrival). */
export const gateCenter = (f: GateFrame): { x: number; y: number; z: number } => {
  const [x, y, z] = at(f, 2, 2);
  return { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
};

export const isStone = (b: number): boolean => b === Block.LatticeStone || b === Block.LatticeStoneLit;

/** Cells the middle may be lit through: nothing solid, nothing liquid, no big plants worth keeping. */
const interiorFree = (b: number): boolean => b === Block.Air || b === Block.Veil || (IS_REPLACEABLE[b] === 1 && IS_LIQUID[b] === 0);

export interface GateStatus {
  frame: GateFrame;
  /** Ring cells holding a Lattice Stone (lit or not). */
  stones: number;
  /** Ring cells without one. */
  missing: Cell[];
  /** Middle cells that are in the way. */
  blocked: Cell[];
  /** All twelve stones present and the middle free. */
  complete: boolean;
  /** Every stone lit and every middle cell Veil. */
  lit: boolean;
}

export function checkGate(get: BlockRead, f: GateFrame): GateStatus {
  const missing: Cell[] = [];
  let stones = 0;
  let litStones = 0;
  for (const c of gateRing(f)) {
    const b = get(c[0], c[1], c[2]);
    if (isStone(b)) {
      stones++;
      if (b === Block.LatticeStoneLit) litStones++;
    } else missing.push(c);
  }
  const blocked: Cell[] = [];
  let veil = 0;
  for (const c of gateInterior(f)) {
    const b = get(c[0], c[1], c[2]);
    if (b === Block.Veil) veil++;
    else if (!interiorFree(b)) blocked.push(c);
  }
  return { frame: f, stones, missing, blocked, complete: stones === 12 && blocked.length === 0, lit: litStones === 12 && veil === 9 };
}

/** Every frame (both axes) that has this cell as one of its ring stones. */
export function framesWithRingCell(x: number, y: number, z: number): GateFrame[] {
  const out: GateFrame[] = [];
  for (const [u, v] of RING_UV) {
    out.push({ axis: 0, x: x - u, y: y - v, z });
    out.push({ axis: 1, x, y: y - v, z: z - u });
  }
  return out;
}

/** Every frame (both axes) with this cell in its middle. */
export function framesWithInteriorCell(x: number, y: number, z: number): GateFrame[] {
  const out: GateFrame[] = [];
  for (const [u, v] of INTERIOR_UV) {
    out.push({ axis: 0, x: x - u, y: y - v, z });
    out.push({ axis: 1, x, y: y - v, z: z - u });
  }
  return out;
}

/** The frame around a stone that is complete, else the incomplete one with the most stones (null when there is no ring worth showing). */
export function bestFrameAround(get: BlockRead, x: number, y: number, z: number): GateStatus | null {
  let best: GateStatus | null = null;
  for (const f of framesWithRingCell(x, y, z)) {
    if (f.y < 1) continue;
    const s = checkGate(get, f);
    if (s.complete || s.lit) return s;
    if (!best || s.stones > best.stones || (s.stones === best.stones && s.blocked.length < best.blocked.length)) best = s;
  }
  return best;
}

/** Lights a complete gate: stones glow, the middle fills with Veil. */
export function lightGate(set: BlockWrite, s: GateStatus): void {
  for (const c of gateRing(s.frame)) set(c[0], c[1], c[2], Block.LatticeStoneLit);
  for (const c of gateInterior(s.frame)) set(c[0], c[1], c[2], Block.Veil);
}

/** Closes a gate: lit stones go dark, the veil goes. Cells that are not ours stay as they are. */
export function closeGate(get: BlockRead, set: BlockWrite, f: GateFrame): void {
  for (const c of gateRing(f)) if (get(c[0], c[1], c[2]) === Block.LatticeStoneLit) set(c[0], c[1], c[2], Block.LatticeStone);
  for (const c of gateInterior(f)) if (get(c[0], c[1], c[2]) === Block.Veil) set(c[0], c[1], c[2], Block.Air);
}

/** The lit gate with this veil cell in its middle, or null. */
export function litGateAtVeil(get: BlockRead, x: number, y: number, z: number): GateFrame | null {
  for (const f of framesWithInteriorCell(x, y, z)) {
    if (f.y < 1) continue;
    if (checkGate(get, f).lit) return f;
  }
  return null;
}

/** The nearest lit gate whose centre is within `radius` (horizontal) of (x, z), scanning y in [yMin, yMax]. */
export function findLitGateNear(get: BlockRead, x: number, z: number, radius: number, yMin = 2, yMax = 160): GateFrame | null {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  let best: { f: GateFrame; d: number } | null = null;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > radius || (best && d >= best.d)) continue;
      for (let y = yMin; y <= yMax; y++) {
        if (get(cx + dx, y, cz + dz) !== Block.Veil) continue;
        const f = litGateAtVeil(get, cx + dx, y, cz + dz);
        if (f) {
          best = { f, d };
          break;
        }
      }
    }
  }
  return best?.f ?? null;
}

/**
 * A standing spot in front of a lit gate: a cell one step off the plane on either side
 * at the bottom of the middle, feet and head free, solid below. Null when neither side works.
 */
export function gateArrival(get: BlockRead, f: GateFrame, preferSide = 1): { x: number; y: number; z: number; yaw: number } | null {
  const free = (b: number) => !IS_SOLID[b] && !IS_LIQUID[b];
  for (const side of [preferSide, -preferSide]) {
    for (const dist of [1, 2]) {
      const [bx, by, bz] = at(f, 2, 1);
      const x = f.axis === 0 ? bx : bx + side * dist;
      const z = f.axis === 0 ? bz + side * dist : bz;
      if (free(get(x, by, z)) && free(get(x, by + 1, z)) && IS_SOLID[get(x, by - 1, z)]) {
        // Face the gate: yaw 0 looks toward -z in this game (forward = (-sin yaw, -cos yaw)).
        const yaw = f.axis === 0 ? (side > 0 ? 0 : Math.PI) : side > 0 ? Math.PI / 2 : -Math.PI / 2;
        return { x: x + 0.5, y: by, z: z + 0.5, yaw };
      }
    }
  }
  return null;
}

// ---- building a partner gate ------------------------------------------------------------------

const open = (b: number): boolean => b === Block.Air || (IS_REPLACEABLE[b] === 1 && b !== Block.Veil);

/** Highest solid or liquid cell of a column at or below `from`, or -1. */
function groundAt(get: BlockRead, x: number, z: number, from: number): number {
  for (let y = from; y >= 1; y--) {
    const b = get(x, y, z);
    if (IS_SOLID[b] || IS_LIQUID[b]) return y;
  }
  return -1;
}

export interface GatePlan {
  frame: GateFrame;
  /** Platform cells to fill (only open cells; solid ground is left alone). */
  platform: Cell[];
}

/**
 * Finds where to build a gate near (tx, tz): the nearest spot where the 5 x 5 plane
 * and a step either side are free air standing on ground or on a platform that
 * only fills open cells. Searches rings out to `radius`. Null when nothing fits.
 */
export function planGate(get: BlockRead, tx: number, tz: number, realm: Realm, radius = 40): GatePlan | null {
  const topY = realm === Realm.Gloamreach ? 62 : 150;
  const cx = Math.floor(tx);
  const cz = Math.floor(tz);
  for (let r = 0; r <= radius; r += r < 12 ? 2 : 4) {
    const n = r === 0 ? 1 : Math.max(8, r * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = cx + Math.round(Math.cos(a) * r);
      const z = cz + Math.round(Math.sin(a) * r);
      const g = groundAt(get, x, z, topY);
      if (g < 1) continue;
      if (IS_LIQUID[get(x, g, z)] && g < SEA_LEVEL - 1) continue;
      const baseY = g;
      for (const axis of [0, 1] as GateAxis[]) {
        const f: GateFrame = axis === 0 ? { axis, x: x - 2, y: baseY + 1, z } : { axis, x, y: baseY + 1, z: z - 2 };
        if (f.y + 5 >= CHUNK_HEIGHT - 2) continue;
        const plan = tryPlan(get, f, baseY);
        if (plan) return plan;
      }
    }
  }
  return null;
}

function tryPlan(get: BlockRead, f: GateFrame, baseY: number): GatePlan | null {
  // The 5 x 5 plane and one cell either side must be open air above the platform level.
  for (let v = 0; v < 5; v++) {
    for (let u = 0; u < 5; u++) {
      for (const side of [-1, 0, 1]) {
        const c = at(f, u, v);
        const x = f.axis === 0 ? c[0] : c[0] + side;
        const z = f.axis === 0 ? c[2] + side : c[2];
        if (!open(get(x, c[1], z))) return null;
      }
    }
  }
  // The platform: baseY level, 5 wide, three deep (one either side of the plane): only open cells are filled,
  // so solid ground stays and a spot over the void gets its own floor.
  const platform: Cell[] = [];
  for (let u = 0; u < 5; u++) {
    for (const side of [-1, 0, 1]) {
      const c = at(f, u, 0);
      const x = f.axis === 0 ? c[0] : c[0] + side;
      const z = f.axis === 0 ? c[2] + side : c[2];
      const b = get(x, baseY, z);
      if (!IS_SOLID[b] || IS_LIQUID[b]) platform.push([x, baseY, z]);
    }
  }
  return { frame: f, platform };
}

/** Builds a planned gate lit: platform of Gloam Bricks, twelve lit stones, Veil in the middle, a lamp on each side. */
export function buildLitGate(set: BlockWrite, plan: GatePlan): void {
  for (const [x, y, z] of plan.platform) set(x, y, z, Block.GloamBricks);
  const s = { frame: plan.frame } as GateStatus;
  lightGate(set, s);
  // Two Moonlamps on the platform's ends (the ring's open corners stay open).
  const f = plan.frame;
  for (const u of [-1, 5]) {
    const c = at(f, u, 1);
    set(c[0], c[1], c[2], Block.Moonlamp);
  }
}

// ---- PortalCore: lighting and travel rules ---------------------------------------------------------

/** C→S (VoxelMsg.PortalOp). */
export type PortalOp = { op: 'light'; x: number; y: number; z: number } | { op: 'cancel' };

/** S→C (VoxelMsg.PortalEvent). */
export type PortalEvent =
  | { kind: 'lit'; x: number; y: number; z: number }
  | { kind: 'charging'; ms: number }
  | { kind: 'cancelled' }
  | { kind: 'arrived'; realm: Realm; name: string; x: number; y: number; z: number }
  | { kind: 'outline'; missing: Cell[]; blocked: Cell[]; ms: number }
  | { kind: 'notice'; text: string; error?: boolean };

export function parsePortalOp(raw: unknown): PortalOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.op === 'cancel') return { op: 'cancel' };
  const n = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  if (o.op === 'light' && n(o.x) && n(o.y) && n(o.z) && (o.y as number) >= 1 && (o.y as number) < CHUNK_HEIGHT) return { op: 'light', x: o.x as number, y: o.y as number, z: o.z as number };
  return null;
}

export interface PortalHooks {
  now(): number;
  survival(): boolean;
  genVersion(): number;
  pos(id: string): { x: number; y: number; z: number } | null;
  /** False once dead (no travel). */
  alive(id: string): boolean;
  /** Reads any cell, generating terrain that is not loaded yet. */
  read: BlockRead;
  /** Authoritative edit: applied, recorded and broadcast. */
  edit: BlockWrite;
  /** Survival: takes one Dusk Lens from the player's inventory (false when none); sandbox: always true. */
  takeKey(id: string): boolean;
  bossNear(x: number, y: number, z: number): boolean;
  move(id: string, x: number, y: number, z: number, yaw?: number): void;
  send(id: string, e: PortalEvent): void;
}

interface PortalPlayer {
  /** Ms spent in a lit veil (0 = not charging). */
  charge: number;
  lastTick: number;
  cooldownUntil: number;
  /** Must step out of the veil before the next jump (after arriving). */
  mustLeave: boolean;
}

export class PortalCore {
  private readonly players = new Map<string, PortalPlayer>();
  private closing = false;

  constructor(private readonly h: PortalHooks) {}

  addPlayer(id: string): void {
    this.players.set(id, { charge: 0, lastTick: this.h.now(), cooldownUntil: 0, mustLeave: false });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  /** Ms charged so far (tests, HUD). */
  charging(id: string): number {
    return this.players.get(id)?.charge ?? 0;
  }

  handle(id: string, op: PortalOp): void {
    const p = this.players.get(id);
    if (!p) return;
    if (op.op === 'cancel') return this.cancel(id, p);
    this.light(id, op.x, op.y, op.z);
  }

  /** Lights the gate the stone at (x, y, z) belongs to. */
  private light(id: string, x: number, y: number, z: number): void {
    const h = this.h;
    const at = h.pos(id);
    if (!at || !h.alive(id)) return;
    if (Math.hypot(x + 0.5 - at.x, y + 0.5 - (at.y + 1.5), z + 0.5 - at.z) > PORTAL.reach + 2) return this.notice(id, 'Too far away.', true);
    if (!isStone(h.read(x, y, z))) return;
    if (!hasDimension(h.genVersion())) return this.notice(id, 'This world is too old for rifts. Create a new world to find the Gloamreach.', true);
    if (realmAt(h.genVersion(), x) === Realm.Veil) return;
    const s = bestFrameAround(h.read, x, y, z);
    if (!s || s.stones < 4) return this.notice(id, 'A gate needs twelve Lattice Stones in a ring: a 5 by 5 square with open corners.', true);
    if (s.lit) return this.notice(id, 'This gate is already lit.');
    if (!s.complete) {
      h.send(id, { kind: 'outline', missing: s.missing, blocked: s.blocked, ms: PORTAL.outlineMs });
      const text = s.missing.length ? `The ring is missing ${s.missing.length} stone${s.missing.length === 1 ? '' : 's'}.` : 'Something is in the way inside the ring.';
      return this.notice(id, text, true);
    }
    if (!h.takeKey(id)) return this.notice(id, 'You need a Dusk Lens to light a gate.', true);
    this.closing = true;
    try {
      lightGate((bx, by, bz, b) => h.edit(bx, by, bz, b), s);
    } finally {
      this.closing = false;
    }
    h.send(id, { kind: 'lit', x: x, y: y, z: z });
    this.notice(id, 'The gate wakes. Stand in the veil to cross.');
  }

  /** After any block edit: breaking a lit stone closes its gate. */
  afterEdit(x: number, y: number, z: number, before: number, after: number): void {
    if (this.closing || before !== Block.LatticeStoneLit || after === Block.LatticeStoneLit) return;
    this.closing = true;
    try {
      const get = this.h.read;
      for (const f of framesWithRingCell(x, y, z)) {
        if (f.y < 1) continue;
        // The broken cell no longer reads as a lit stone: the middle is still Veil if this was one of ours.
        let veil = 0;
        for (const c of gateInterior(f)) if (get(c[0], c[1], c[2]) === Block.Veil) veil++;
        if (veil === 9) closeGate(get, (bx, by, bz, b) => this.h.edit(bx, by, bz, b), f);
      }
    } finally {
      this.closing = false;
    }
  }

  /** Advances charging for everyone; call every server tick (or frame offline). */
  tick(): void {
    const h = this.h;
    const now = h.now();
    for (const [id, p] of this.players) {
      const dt = Math.min(250, Math.max(0, now - p.lastTick));
      p.lastTick = now;
      const at = h.pos(id);
      if (!at || !h.alive(id)) {
        if (p.charge) this.cancel(id, p);
        continue;
      }
      const cell = this.veilCell(at);
      if (!cell) {
        p.mustLeave = false;
        if (p.charge) this.cancel(id, p);
        continue;
      }
      if (p.mustLeave || now < p.cooldownUntil) continue;
      if (p.charge === 0) h.send(id, { kind: 'charging', ms: PORTAL.chargeMs });
      p.charge += dt;
      if (p.charge >= PORTAL.chargeMs) {
        p.charge = 0;
        this.travel(id, p, cell);
      }
    }
  }

  /** The veil cell a body at `at` stands in (feet or head), or null. */
  private veilCell(at: { x: number; y: number; z: number }): Cell | null {
    const x = Math.floor(at.x);
    const z = Math.floor(at.z);
    for (const dy of [0.1, 1.5]) {
      const y = Math.floor(at.y + dy);
      if (this.h.read(x, y, z) === Block.Veil) return [x, y, z];
    }
    return null;
  }

  private cancel(id: string, p: PortalPlayer): void {
    if (p.charge === 0) return;
    p.charge = 0;
    this.h.send(id, { kind: 'cancelled' });
  }

  private travel(id: string, p: PortalPlayer, cell: Cell): void {
    const h = this.h;
    const gen = h.genVersion();
    const here = realmAt(gen, cell[0]);
    if (here === Realm.Veil) return;
    if (h.survival() && h.bossNear(cell[0], cell[1], cell[2])) {
      h.send(id, { kind: 'cancelled' });
      return this.notice(id, 'The veil will not open during a boss fight.', true);
    }
    const toGloam = here === Realm.Overworld;
    const dest = toGloam ? Realm.Gloamreach : Realm.Overworld;
    const t = toGloam ? overworldToGloam(cell[0] + 0.5, cell[2] + 0.5) : gloamToOverworld(cell[0] + 0.5, cell[2] + 0.5);
    let frame = findLitGateNear(h.read, t.x, t.z, PORTAL.partnerRadius, dest === Realm.Gloamreach ? 2 : 2, dest === Realm.Gloamreach ? 63 : 160);
    if (!frame) {
      const plan = planGate(h.read, t.x, t.z, dest);
      if (!plan) {
        h.send(id, { kind: 'cancelled' });
        return this.notice(id, 'The veil flickers and holds. Try again in a moment.', true);
      }
      this.closing = true;
      try {
        buildLitGate((bx, by, bz, b) => h.edit(bx, by, bz, b), plan);
      } finally {
        this.closing = false;
      }
      frame = plan.frame;
    }
    let spot = gateArrival(h.read, frame);
    if (!spot) {
      const c = gateCenter(frame);
      const s = safeSpotNear(h.read, c.x, c.y, c.z);
      spot = s ? { ...s, yaw: 0 } : null;
    }
    if (!spot) {
      h.send(id, { kind: 'cancelled' });
      return this.notice(id, 'The way through is blocked on the other side.', true);
    }
    h.move(id, spot.x, spot.y, spot.z, spot.yaw);
    p.cooldownUntil = h.now() + PORTAL.cooldownMs;
    p.mustLeave = true;
    h.send(id, { kind: 'arrived', realm: dest, name: REALM_NAMES[dest], x: spot.x, y: spot.y, z: spot.z });
  }

  private notice(id: string, text: string, error = false): void {
    this.h.send(id, error ? { kind: 'notice', text, error } : { kind: 'notice', text });
  }
}
