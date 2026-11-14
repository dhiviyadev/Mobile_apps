import { describe, expect, it } from 'vitest';
import {
  Block,
  bestFrameAround,
  checkGate,
  chunkBlock,
  createWorldGenerator,
  findLitGateNear,
  gateArrival,
  gateCenter,
  gateInterior,
  gateRing,
  type GateFrame,
  IS_LIQUID,
  IS_SOLID,
  LootTableId,
  overworldToGloam,
  PORTAL,
  PortalCore,
  type PortalEvent,
  Realm,
  realmAt,
  StructureType,
  type WorldGenerator,
} from '../src/index';
import { fallenVariant } from '../src/voxel/structures/gloam';

/** A world for gate tests: generated terrain (or flat air over a floor) plus recorded edits. */
class Sim {
  readonly edits = new Map<string, number>();
  private readonly chunks = new Map<string, Uint8Array>();
  constructor(private readonly gen: WorldGenerator | null, private readonly floor = 4) {}
  read = (x: number, y: number, z: number): number => {
    const e = this.edits.get(`${x},${y},${z}`);
    if (e !== undefined) return e;
    if (y < 0) return Block.Bedrock;
    if (!this.gen) return y < this.floor ? Block.Stone : Block.Air;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = this.gen.generateChunk(cx, cz)));
    return chunkBlock(c, x - cx * 16, y, z - cz * 16);
  };
  /** What each edit replaced, in order (to check a build only used open cells). */
  readonly log: number[] = [];
  edit = (x: number, y: number, z: number, id: number): void => {
    this.log.push(this.read(x, y, z));
    this.edits.set(`${x},${y},${z}`, id);
  };
  ring(f: GateFrame, skip: number[] = [], id: number = Block.LatticeStone): void {
    gateRing(f).forEach((c, i) => {
      if (!skip.includes(i)) this.edit(c[0], c[1], c[2], id);
    });
  }
}

interface Harness {
  core: PortalCore;
  sim: Sim;
  pos: { x: number; y: number; z: number };
  events: PortalEvent[];
  clock: { t: number };
  keys: { n: number };
  moves: { x: number; y: number; z: number }[];
  bossNear: { v: boolean };
  alive: { v: boolean };
}

function harness(sim: Sim, o: { genVersion?: number; survival?: boolean; keys?: number; pos?: { x: number; y: number; z: number } } = {}): Harness {
  const h: Harness = {
    core: null as never,
    sim,
    pos: o.pos ?? { x: 0.5, y: 5, z: 0.5 },
    events: [],
    clock: { t: 1000 },
    keys: { n: o.keys ?? 1 },
    moves: [],
    bossNear: { v: false },
    alive: { v: true },
  };
  h.core = new PortalCore({
    now: () => h.clock.t,
    survival: () => o.survival ?? true,
    genVersion: () => o.genVersion ?? 4,
    pos: () => h.pos,
    alive: () => h.alive.v,
    read: sim.read,
    edit: sim.edit,
    takeKey: () => {
      if (!(o.survival ?? true)) return true;
      if (h.keys.n < 1) return false;
      h.keys.n--;
      return true;
    },
    bossNear: () => h.bossNear.v,
    move: (_id, x, y, z) => {
      h.pos = { x, y, z };
      h.moves.push({ x, y, z });
    },
    send: (_id, e) => h.events.push(e),
  });
  h.core.addPlayer('p');
  return h;
}

/** Steps the clock in 50 ms ticks for `ms`, ticking the core. */
function advance(h: Harness, ms: number): void {
  for (let t = 0; t < ms; t += 50) {
    h.clock.t += 50;
    h.core.tick();
  }
}

const notices = (h: Harness) => h.events.filter((e): e is Extract<PortalEvent, { kind: 'notice' }> => e.kind === 'notice').map((e) => e.text);
const FRAME0: GateFrame = { axis: 0, x: 10, y: 5, z: 10 };

/** Clears the air a gate needs (the plane and a step either side) and lays a platform under it. */
function clearSite(sim: Sim, f: GateFrame): void {
  for (let v = -1; v < 6; v++) {
    for (let u = -1; u <= 5; u++) {
      for (const side of [-3, -2, -1, 0, 1, 2, 3]) {
        const x = f.axis === 0 ? f.x + u : f.x + side;
        const z = f.axis === 0 ? f.z + side : f.z + u;
        sim.edit(x, f.y + v, z, v === -1 ? Block.StoneBricks : Block.Air);
      }
    }
  }
}

describe('gate shapes', () => {
  it('a ring is twelve stones in a 5 x 5 square with open corners, either way round', () => {
    for (const axis of [0, 1] as const) {
      const f: GateFrame = { axis, x: 10, y: 5, z: 10 };
      expect(gateRing(f)).toHaveLength(12);
      expect(gateInterior(f)).toHaveLength(9);
      const sim = new Sim(null);
      sim.ring(f);
      const s = checkGate((x, y, z) => sim.read(x, y, z), f);
      expect(s.complete).toBe(true);
      expect(s.lit).toBe(false);
      // The corners never matter: stones there change nothing.
      const corner = axis === 0 ? [10, 5, 10] : [10, 5, 10];
      sim.edit(corner[0], corner[1], corner[2], Block.Stone);
      expect(checkGate(sim.read, f).complete).toBe(true);
    }
  });

  it('lights a good ring (survival takes the Dusk Lens) and fills the middle with Veil', () => {
    const sim = new Sim(null);
    sim.ring(FRAME0);
    const h = harness(sim, { pos: { x: 12.5, y: 5, z: 8.5 } });
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(h.keys.n).toBe(0);
    const s = checkGate(sim.read, FRAME0);
    expect(s.lit).toBe(true);
    for (const c of gateInterior(FRAME0)) expect(sim.read(c[0], c[1], c[2])).toBe(Block.Veil);
    for (const c of gateRing(FRAME0)) expect(sim.read(c[0], c[1], c[2])).toBe(Block.LatticeStoneLit);
    expect(h.events.some((e) => e.kind === 'lit')).toBe(true);
    // Lighting again does nothing and costs nothing.
    h.keys.n = 1;
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(h.keys.n).toBe(1);
  });

  it('wrong shapes show the missing stones, take no key and light nothing', () => {
    const sim = new Sim(null);
    sim.ring(FRAME0, [3, 9]);
    const h = harness(sim, { pos: { x: 12.5, y: 5, z: 8.5 } });
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    const outline = h.events.find((e): e is Extract<PortalEvent, { kind: 'outline' }> => e.kind === 'outline')!;
    const ring = gateRing(FRAME0);
    expect(outline.missing).toEqual([ring[3], ring[9]]);
    expect(outline.blocked).toEqual([]);
    expect(notices(h).some((t) => /missing 2 stones/.test(t))).toBe(true);
    expect(h.keys.n).toBe(1);
    expect(checkGate(sim.read, FRAME0).lit).toBe(false);
    // Something in the way inside the ring.
    sim.edit(12, 7, 10, Block.Stone);
    sim.edit(ring[3][0], ring[3][1], ring[3][2], Block.LatticeStone);
    sim.edit(ring[9][0], ring[9][1], ring[9][2], Block.LatticeStone);
    h.events.length = 0;
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    const o2 = h.events.find((e): e is Extract<PortalEvent, { kind: 'outline' }> => e.kind === 'outline')!;
    expect(o2.blocked).toEqual([[12, 7, 10]]);
    expect(notices(h).some((t) => /in the way/.test(t))).toBe(true);
    // A stray pair of stones is not a gate.
    const sim2 = new Sim(null);
    sim2.edit(30, 5, 30, Block.LatticeStone);
    sim2.edit(31, 5, 30, Block.LatticeStone);
    const h2 = harness(sim2, { pos: { x: 30.5, y: 5, z: 28.5 } });
    h2.core.handle('p', { op: 'light', x: 30, y: 5, z: 30 });
    expect(notices(h2).some((t) => /twelve/i.test(t))).toBe(true);
  });

  it('needs a key in survival, none in sandbox, and the stone in reach', () => {
    const sim = new Sim(null);
    sim.ring(FRAME0);
    const h = harness(sim, { keys: 0, pos: { x: 12.5, y: 5, z: 8.5 } });
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(notices(h).some((t) => /Dusk Lens/.test(t))).toBe(true);
    expect(checkGate(sim.read, FRAME0).lit).toBe(false);
    const far = harness(sim, { pos: { x: 40.5, y: 5, z: 40.5 } });
    far.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(notices(far).some((t) => /Too far/.test(t))).toBe(true);
    const sb = harness(sim, { survival: false, keys: 0, pos: { x: 12.5, y: 5, z: 8.5 } });
    sb.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(checkGate(sim.read, FRAME0).lit).toBe(true);
  });

  it('breaking a stone collapses the veil and darkens the rest', () => {
    const sim = new Sim(null);
    sim.ring(FRAME0);
    const h = harness(sim, { pos: { x: 12.5, y: 5, z: 8.5 } });
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(checkGate(sim.read, FRAME0).lit).toBe(true);
    // The server applies the player's edit, then tells the core.
    sim.edit(10 + 2, 5, 10, Block.Air);
    h.core.afterEdit(12, 5, 10, Block.LatticeStoneLit, Block.Air);
    for (const c of gateInterior(FRAME0)) expect(sim.read(c[0], c[1], c[2])).toBe(Block.Air);
    const lit = gateRing(FRAME0).filter((c) => sim.read(c[0], c[1], c[2]) === Block.LatticeStoneLit);
    expect(lit).toEqual([]);
    expect(gateRing(FRAME0).filter((c) => sim.read(c[0], c[1], c[2]) === Block.LatticeStone)).toHaveLength(11);
    // Mending the ring and lighting it again works.
    sim.edit(12, 5, 10, Block.LatticeStone);
    h.keys.n = 1;
    h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
    expect(checkGate(sim.read, FRAME0).lit).toBe(true);
  });

  it('old worlds refuse politely and nothing lights', () => {
    const sim = new Sim(null);
    sim.ring(FRAME0);
    for (const gen of [1, 2, 3]) {
      const h = harness(sim, { genVersion: gen, pos: { x: 12.5, y: 5, z: 8.5 } });
      h.core.handle('p', { op: 'light', x: 11, y: 5, z: 10 });
      expect(notices(h)).toEqual(['This world is too old for rifts. Create a new world to find the Gloamreach.']);
      expect(h.keys.n).toBe(1);
      expect(checkGate(sim.read, FRAME0).lit).toBe(false);
    }
  });
});

describe('arrival spots', () => {
  it('stand on solid ground beside the gate, never in the veil and never in thin air', () => {
    const floating: GateFrame = { axis: 0, x: 10, y: 20, z: 10 };
    const sim = new Sim(null);
    sim.ring(floating);
    // Nothing under the front of the gate: no safe spot.
    expect(gateArrival(sim.read, floating)).toBeNull();
    // A step of ground in front of it: the spot stands on it, beside the plane, feet level with the ring's bottom row.
    sim.edit(12, 19, 12, Block.Stone);
    const spot = gateArrival(sim.read, floating)!;
    expect(spot).toBeTruthy();
    expect(Math.floor(spot.y)).toBe(20);
    expect(IS_SOLID[sim.read(Math.floor(spot.x), 19, Math.floor(spot.z))]).toBe(1);
    expect(sim.read(Math.floor(spot.x), Math.floor(spot.y), Math.floor(spot.z))).toBe(Block.Air);
  });
});

describe('crossing', () => {
  it('charges for two seconds in the veil, cancels when you step out, and cools down after arriving', () => {
    const gen = createWorldGenerator(11, 'survival', 4);
    const sim = new Sim(gen);
    const spawn = gen.findSpawn();
    const f: GateFrame = { axis: 0, x: Math.floor(spawn.x) - 2, y: Math.floor(spawn.y), z: Math.floor(spawn.z) + 6 };
    clearSite(sim, f);
    sim.ring(f);
    const h = harness(sim, { pos: { x: f.x + 2.5, y: f.y, z: f.z - 1.5 } });
    h.core.handle('p', { op: 'light', x: f.x + 1, y: f.y, z: f.z });
    expect(checkGate(sim.read, f).lit).toBe(true);
    // Stand in the veil for a second, then leave: cancelled, nothing moved.
    h.pos = { x: f.x + 2.5, y: f.y + 1, z: f.z + 0.5 };
    advance(h, 1000);
    expect(h.events.some((e) => e.kind === 'charging')).toBe(true);
    expect(h.core.charging('p')).toBeGreaterThan(800);
    h.pos = { x: f.x + 2.5, y: f.y, z: f.z - 1.5 };
    advance(h, 100);
    expect(h.events.some((e) => e.kind === 'cancelled')).toBe(true);
    expect(h.moves).toHaveLength(0);
    // Stay the full time: across.
    h.events.length = 0;
    h.pos = { x: f.x + 2.5, y: f.y + 1, z: f.z + 0.5 };
    advance(h, PORTAL.chargeMs + 100);
    expect(h.moves).toHaveLength(1);
    const arrived = h.events.find((e): e is Extract<PortalEvent, { kind: 'arrived' }> => e.kind === 'arrived')!;
    expect(arrived.realm).toBe(Realm.Gloamreach);
    expect(realmAt(4, h.pos.x)).toBe(Realm.Gloamreach);
    // The partner stands within reach of the mapped spot, lit, and the player is beside it, not in the veil.
    const mapped = overworldToGloam(f.x + 2.5, f.z + 0.5);
    const partner = findLitGateNear(sim.read, mapped.x, mapped.z, PORTAL.partnerRadius, 2, 63)!;
    expect(partner).toBeTruthy();
    expect(sim.read(Math.floor(h.pos.x), Math.floor(h.pos.y), Math.floor(h.pos.z))).not.toBe(Block.Veil);
    // Cooldown: even stepping into the veil right away does not carry you back.
    const c = gateCenter(partner);
    h.pos = { x: c.x, y: c.y - 0.5, z: c.z };
    advance(h, 3000);
    expect(h.moves).toHaveLength(1);
    // Step out, then in again: back to the first gate.
    h.pos = { x: h.moves[0].x, y: h.moves[0].y, z: h.moves[0].z };
    advance(h, 200);
    advance(h, PORTAL.cooldownMs);
    h.pos = { x: c.x, y: c.y - 0.5, z: c.z };
    advance(h, PORTAL.chargeMs + 100);
    expect(h.moves).toHaveLength(2);
    expect(realmAt(4, h.pos.x)).toBe(Realm.Overworld);
    expect(Math.hypot(h.pos.x - (f.x + 2.5), h.pos.z - (f.z + 0.5))).toBeLessThan(5);
    // Arrival at home is safe.
    expect(IS_SOLID[sim.read(Math.floor(h.pos.x), Math.floor(h.pos.y) - 1, Math.floor(h.pos.z))]).toBe(1);
  });

  it('no crossing while a boss fight is close, or when dead', () => {
    const gen = createWorldGenerator(11, 'survival', 4);
    const sim = new Sim(gen);
    const spawn = gen.findSpawn();
    const f: GateFrame = { axis: 1, x: Math.floor(spawn.x) + 3, y: Math.floor(spawn.y), z: Math.floor(spawn.z) - 2 };
    clearSite(sim, f);
    sim.ring(f);
    const h = harness(sim, { pos: { x: f.x - 1.5, y: f.y, z: f.z + 2.5 } });
    h.core.handle('p', { op: 'light', x: f.x, y: f.y, z: f.z + 1 });
    h.pos = { x: f.x + 0.5, y: f.y + 1, z: f.z + 2.5 };
    h.bossNear.v = true;
    advance(h, 2500);
    expect(h.moves).toHaveLength(0);
    expect(notices(h).some((t) => /boss fight/.test(t))).toBe(true);
    h.bossNear.v = false;
    h.alive.v = false;
    advance(h, 3000);
    expect(h.moves).toHaveLength(0);
  });

  it('builds the partner only into open cells and lands safely, over 24 sites in both directions', () => {
    let crossings = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const gen = createWorldGenerator(seed, 'survival', 4);
      const sim = new Sim(gen);
      const spawn = gen.findSpawn();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + seed;
        const x = Math.floor(spawn.x + Math.cos(a) * (60 + seed * 40));
        const z = Math.floor(spawn.z + Math.sin(a) * (60 + seed * 40));
        // A gate floating over whatever is there: a platform of its own, so any column works as a site.
        let g = 62;
        while (g > 1 && !IS_SOLID[sim.read(x, g, z)] && !IS_LIQUID[sim.read(x, g, z)]) g--;
        const f: GateFrame = { axis: (k % 2) as 0 | 1, x: x - (k % 2 === 0 ? 2 : 0), y: g + 2, z: z - (k % 2 === 1 ? 2 : 0) };
        clearSite(sim, f);
        sim.ring(f);
        const h = harness(sim, { pos: { x: f.x + 2.5, y: f.y, z: f.z + 3.5 } });
        const stone = gateRing(f)[1];
        h.pos = { x: stone[0] + 0.5, y: f.y, z: stone[2] + 2.5 };
        h.core.handle('p', { op: 'light', x: stone[0], y: stone[1], z: stone[2] });
        expect(checkGate(sim.read, f).lit, `seed ${seed} site ${k}`).toBe(true);
        const c = gateCenter(f);
        h.pos = { x: c.x, y: c.y - 0.5, z: c.z };
        const before = sim.edits.size;
        sim.log.length = 0;
        advance(h, PORTAL.chargeMs + 100);
        expect(h.moves.length, `seed ${seed} site ${k}`).toBe(1);
        expect(sim.edits.size).toBeGreaterThan(before);
        // Only open cells were built into: air, plants, mist, or open air over a void (never terrain, ore or water).
        for (const prev of sim.log) expect(IS_SOLID[prev] === 0 || prev === Block.Air, `replaced block ${prev}`).toBe(true);
        expect(sim.log.some((p) => IS_LIQUID[p] === 1)).toBe(false);
        const p = h.pos;
        expect(realmAt(4, p.x)).toBe(Realm.Gloamreach);
        const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
        expect(IS_SOLID[sim.read(fx, fy, fz)]).toBe(0);
        expect(IS_SOLID[sim.read(fx, fy + 1, fz)]).toBe(0);
        expect(IS_LIQUID[sim.read(fx, fy, fz)]).toBe(0);
        expect(sim.read(fx, fy, fz)).not.toBe(Block.Veil);
        expect(IS_SOLID[sim.read(fx, fy - 1, fz)]).toBe(1);
        // Everything the build wrote stays in the realm and at least overwrote nothing solid but its own platform.
        for (const key of sim.edits.keys()) {
          const ex = Number(key.split(',')[0]);
          if (ex > 12000) expect(realmAt(4, ex)).toBe(Realm.Gloamreach);
        }
        // And back: the new partner takes you home beside the first gate.
        const partner = findLitGateNear(sim.read, p.x, p.z, 8, 2, 63)!;
        expect(partner).toBeTruthy();
        const pc = gateCenter(partner);
        advance(h, 200);
        h.pos = { x: pc.x, y: pc.y - 0.5, z: pc.z };
        advance(h, PORTAL.cooldownMs + 100);
        h.pos = { x: pc.x, y: pc.y - 0.5, z: pc.z };
        advance(h, PORTAL.chargeMs + 100);
        expect(h.moves.length, `return seed ${seed} site ${k}`).toBe(2);
        expect(realmAt(4, h.pos.x)).toBe(Realm.Overworld);
        expect(Math.hypot(h.pos.x - c.x, h.pos.z - c.z)).toBeLessThan(10);
        expect(gateArrival(sim.read, f)).toBeTruthy();
        crossings += 2;
      }
    }
    expect(crossings).toBe(48);
  }, 60_000);
});

describe('Fallen Lattices', () => {
  it('stand whole (a Dusk Lens in the chest) or broken (1-3 stones gone, stones in the chest) and can be lit or mended', () => {
    let whole = 0;
    let broken = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const gen = createWorldGenerator(seed, 'survival', 4);
      const sim = new Sim(gen);
      for (const s of gen.structuresNear(0, 0, 1400).filter((q) => q.type === StructureType.FallenLattice).slice(0, 5)) {
        const v = fallenVariant(s.anchor.x, s.anchor.z);
        const F = s.bounds.y0 + 2;
        const frame: GateFrame = v.axis === 0 ? { axis: 0, x: s.anchor.x - 2, y: F + 1, z: s.anchor.z } : { axis: 1, x: s.anchor.x, y: F + 1, z: s.anchor.z - 2 };
        const status = checkGate(sim.read, frame);
        const chest = s.chests[0];
        expect(sim.read(chest.x, chest.y, chest.z), `chest of ${s.anchor.x},${s.anchor.z}`).toBe(Block.Chest);
        expect(status.stones).toBe(12 - v.gone.length);
        if (v.whole) {
          whole++;
          expect(chest.loot).toBe(LootTableId.FallenLatticeLens);
          expect(status.complete).toBe(true);
        } else {
          broken++;
          expect(v.gone.length).toBeGreaterThanOrEqual(1);
          expect(v.gone.length).toBeLessThanOrEqual(3);
          expect(chest.loot).toBe(LootTableId.FallenLatticeRepair);
          expect(status.complete).toBe(false);
          expect(status.blocked).toEqual([]);
          // Mending it with the stones from the chest makes it a ring again.
          for (const c of status.missing) sim.edit(c[0], c[1], c[2], Block.LatticeStone);
          expect(checkGate(sim.read, frame).complete).toBe(true);
          const best = bestFrameAround(sim.read, gateRing(frame)[0][0], gateRing(frame)[0][1], gateRing(frame)[0][2]);
          expect(best?.complete).toBe(true);
        }
      }
    }
    expect(whole).toBeGreaterThan(0);
    expect(broken).toBeGreaterThan(0);
  });

  it('Twilit Lattices stand lit, with a way home', () => {
    const gen = createWorldGenerator(3, 'survival', 4);
    const sim = new Sim(gen);
    const m = overworldToGloam(gen.findSpawn().x, gen.findSpawn().z);
    const lattices = gen.structuresNear(m.x, m.z, 900).filter((q) => q.type === StructureType.TwilitLattice);
    expect(lattices.length).toBeGreaterThan(2);
    for (const s of lattices.slice(0, 6)) {
      const lit = findLitGateNear(sim.read, s.anchor.x, s.anchor.z, 6, 2, 63);
      expect(lit, `twilit at ${s.anchor.x},${s.anchor.z}`).toBeTruthy();
      expect(gateArrival(sim.read, lit!)).toBeTruthy();
    }
  });
});
