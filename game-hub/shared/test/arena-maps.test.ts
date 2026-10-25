import { describe, expect, it } from 'vitest';
import {
  ARENA_MAPS,
  type ArenaMap,
  arenaMapIndex,
  ArenaSimulation,
  CMD_DT,
  flatArenaMap,
  makeCommand,
  MOVE,
  validateMap,
  VOTE,
} from '../src';

/** Height above its top a pad's vy reaches (inverse of launchVelocityForHeight). */
function designedApex(vy: number): number {
  const g = MOVE.gravity;
  const a = vy / g - CMD_DT / 2;
  return (g / 2) * (a * a - (CMD_DT * CMD_DT) / 4);
}

const mirrors = {
  point: (x: number, z: number): [number, number] => [-x, -z],
  mirrorX: (x: number, z: number): [number, number] => [-x, z],
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Which symmetry maps every box onto a box of the same kind, or null. */
function symmetryOf(map: ArenaMap): keyof typeof mirrors | null {
  for (const [name, m] of Object.entries(mirrors) as [keyof typeof mirrors, (x: number, z: number) => [number, number]][]) {
    const ok = map.boxes.every((b) => {
      const [x0, z0] = m(b.minX, b.minZ);
      const [x1, z1] = m(b.maxX, b.maxZ);
      return map.boxes.some((c) => c.kind === b.kind && near(c.minY, b.minY) && near(c.maxY, b.maxY) && near(c.minX, Math.min(x0, x1)) && near(c.maxX, Math.max(x0, x1)) && near(c.minZ, Math.min(z0, z1)) && near(c.maxZ, Math.max(z0, z1)));
    });
    if (ok) return name;
  }
  return null;
}

/** A sim on `map` with one human ('h') and `bots` bots, stepped into warmup. */
function voteSim(map: ArenaMap, mode: '1v1' | '2v2' | 'ffa', bots: number, seed = 5, humans = ['h']): ArenaSimulation {
  const sim = new ArenaSimulation(map, mode, { seed });
  for (const id of humans) sim.addPlayer({ id, name: id, color: 1 });
  for (let i = 0; i < bots; i++) sim.addPlayer({ id: `b${i}`, name: `B${i}`, color: 2, bot: true });
  return sim;
}

/** Steps until the vote reaches `stage` (or ends when stage is null). */
function stepVoteTo(sim: ArenaSimulation, stage: 'reveal' | null, limit = 30 * 30): void {
  for (let i = 0; i < limit; i++) {
    if (stage === 'reveal' ? sim.vote?.stage === 'reveal' : sim.phase !== 'vote') return;
    sim.step();
  }
  throw new Error(`vote never reached ${stage}`);
}

describe('map registry', () => {
  it('has the six maps in wire order', () => {
    expect(ARENA_MAPS.map((m) => m.id)).toEqual(['foundry', 'courts', 'skybridge', 'verdant', 'dunes', 'frostline']);
    expect(new Set(ARENA_MAPS.map((m) => m.name)).size).toBe(6);
    expect(arenaMapIndex('dunes')).toBe(4);
    expect(arenaMapIndex('nowhere')).toBe(-1);
    for (const m of ARENA_MAPS) {
      expect(m.tags.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.description.length, m.id).toBeGreaterThan(20);
    }
  });
});

describe('map validation', () => {
  it('passes every rule on every map at the slowest, normal and fastest weapon speed', () => {
    const t0 = performance.now();
    for (const map of ARENA_MAPS) expect(validateMap(map, { speeds: [0.85, 1.0, 1.12] }), map.id).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it('reports broken maps', () => {
    const base = ARENA_MAPS[0];
    const codes = (m: ArenaMap) => new Set(validateMap(m).map((p) => p.code));
    // A waypoint inside a container, and a spawn in the air.
    const inWall = { ...base, waypoints: base.waypoints.map((w, i) => (i === 0 ? { x: -22, y: 0, z: -18 } : w)) };
    expect(codes(inWall).has('waypoint')).toBe(true);
    const floating = { ...base, spawns: { ...base.spawns, ffa: base.spawns.ffa.map((s, i) => (i === 0 ? { ...s, y: 3 } : s)) } };
    expect(codes(floating).has('spawn')).toBe(true);
    // Without explicit links the deck, roofs and container stack cannot be reached or left.
    expect(codes({ ...base, links: [] }).has('nav')).toBe(true);
    // A walk link straight through the smelter-hall wall cannot be walked.
    const spawn = base.waypoints.findIndex((w) => w.x === -38 && w.z === 0);
    const deck = base.waypoints.findIndex((w) => w.x === -4.5 && w.y === 3.2);
    expect(codes({ ...base, links: [...base.links, { a: spawn, b: deck, kind: 'walk' }] }).has('edge')).toBe(true);
    // A box sticking out through the perimeter, and a map that is too small.
    expect(codes({ ...base, boxes: [...base.boxes, { minX: 40, maxX: 44, minY: 0, maxY: 1, minZ: 0, maxZ: 1, kind: 'cover' }] }).has('box')).toBe(true);
    expect(codes({ ...base, bounds: { minX: -30, maxX: 30, minZ: -28, maxZ: 28 } }).has('size')).toBe(true);
  });

  it('is symmetric for both teams', () => {
    for (const map of ARENA_MAPS) {
      const sym = symmetryOf(map);
      expect(sym, `${map.id} boxes mirror`).not.toBeNull();
      const m = mirrors[sym!];
      expect(map.spawns.team[0].length).toBe(6);
      expect(map.spawns.team[1].length).toBe(6);
      map.spawns.team[0].forEach((s, i) => {
        const [x, z] = m(s.x, s.z);
        expect(map.spawns.team[1][i], map.id).toMatchObject({ x, y: s.y, z });
      });
      for (const p of map.pads) {
        const [ax, az] = m(p.minX, p.minZ);
        const [bx, bz] = m(p.maxX, p.maxZ);
        const twin = map.pads.some(
          (q) => q.horizontal === p.horizontal && near(q.top, p.top) && near(q.vy, p.vy) && near(Math.hypot(q.vx, q.vz), Math.hypot(p.vx, p.vz)) &&
            near(q.minX, Math.min(ax, bx)) && near(q.maxX, Math.max(ax, bx)) && near(q.minZ, Math.min(az, bz)) && near(q.maxZ, Math.max(az, bz)),
        );
        expect(twin, `${map.id} pad mirror`).toBe(true);
      }
      for (const pk of map.pickups) {
        const [x, z] = m(pk.x, pk.z);
        expect(map.pickups.some((q) => q.kind === pk.kind && near(q.x, x) && near(q.z, z) && near(q.y, pk.y)), `${map.id} pickup mirror`).toBe(true);
      }
    }
  });

  it('is large, walled and full of things to use', () => {
    for (const map of ARENA_MAPS) {
      const b = map.bounds;
      const long = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
      expect(long, map.id).toBeGreaterThanOrEqual(72);
      expect(long, map.id).toBeLessThanOrEqual(96);
      const walls = map.boxes.filter((x) => x.kind === 'wall' && x.maxY - x.minY >= 8);
      expect(walls.length, `${map.id} perimeter walls`).toBeGreaterThanOrEqual(4);
      expect(map.boxes.length, map.id).toBeGreaterThan(100);
      expect(new Set(map.boxes.map((x) => x.maxY)).size, `${map.id} height levels`).toBeGreaterThan(8);
      expect(map.pads.length, map.id).toBeGreaterThanOrEqual(4);
      expect(map.pads.some((p) => p.horizontal === 'keep'), `${map.id} trampoline`).toBe(true);
      expect(map.pickups.filter((p) => p.kind === 'health').length, map.id).toBeGreaterThanOrEqual(3);
      expect(map.pickups.filter((p) => p.kind === 'ammo').length, map.id).toBeGreaterThanOrEqual(4);
      expect(map.theme.fogFar, map.id).toBeGreaterThan(130);
    }
  });
});

describe('pads in the simulation', () => {
  it("launches a player off each map's first trampoline to its designed height", () => {
    for (const map of ARENA_MAPS) {
      const pi = map.pads.findIndex((p) => p.horizontal === 'keep');
      const pad = map.pads[pi];
      const sim = new ArenaSimulation(map, 'ffa');
      const p = sim.addPlayer({ id: 'h', name: 'H', color: 1 });
      // Walk slowly onto the pad from the nav node that leads to it.
      const padNode = sim.nav.padNode.indexOf(pi);
      const from = sim.nav.points[sim.nav.adj.findIndex((es) => es.some((e) => e.to === padNode))];
      const to = sim.nav.points[padNode];
      Object.assign(p.sim, { x: from.x, y: from.y, z: from.z, vx: 0, vy: 0, vz: 0 });
      const yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
      let peak = -Infinity;
      let launched = false;
      let seq = 0;
      for (let t = 0; t < 30 * 6; t++) {
        for (let k = 0; k < 2; k++) sim.queueCommand('h', makeCommand(++seq, { yaw, moveY: launched ? 0 : 0.35 }));
        sim.step();
        if (sim.drainEvents().some((e) => e.type === 'launch' && e.id === 'h' && e.pad === pi)) launched = true;
        if (launched) peak = Math.max(peak, p.sim.y);
      }
      expect(launched, map.id).toBe(true);
      expect(p.launchPad, map.id).toBe(pi);
      expect(Math.abs(peak - (pad.top + designedApex(pad.vy))), map.id).toBeLessThan(0.5);
    }
  });

  it('throws you from the Courts fountain onto the north terrace', () => {
    const map = ARENA_MAPS[arenaMapIndex('courts')];
    const sim = new ArenaSimulation(map, 'ffa');
    const p = sim.addPlayer({ id: 'h', name: 'H', color: 1 });
    Object.assign(p.sim, { x: -3, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    let launched = false;
    let seq = 0;
    let landed: { x: number; y: number; z: number } | null = null;
    for (let t = 0; t < 30 * 6 && !landed; t++) {
      for (let k = 0; k < 2; k++) sim.queueCommand('h', makeCommand(++seq, { yaw: -Math.PI / 2, moveY: launched ? 0 : 0.5 }));
      sim.step();
      if (sim.drainEvents().some((e) => e.type === 'launch' && e.id === 'h')) launched = true;
      else if (launched && p.sim.onGround) landed = { x: p.sim.x, y: p.sim.y, z: p.sim.z };
    }
    expect(landed).not.toBeNull();
    expect(landed!.y).toBeCloseTo(2.4, 3);
    expect(Math.hypot(landed!.x - 0, landed!.z + 28)).toBeLessThan(1.5);
  });
});

describe('map vote', () => {
  it('opens with three distinct candidates and never offers the map just played', () => {
    const sim = voteSim(ARENA_MAPS[0], 'ffa', 5);
    sim.startVote();
    expect(sim.phase).toBe('vote');
    expect(sim.phaseTimer).toBe(VOTE.time);
    const c = sim.vote!.candidates;
    expect(c).toHaveLength(3);
    expect(new Set(c).size).toBe(3);
    for (const m of c) expect(m >= 0 && m < ARENA_MAPS.length).toBe(true);
    for (let seed = 0; seed < 100; seed++) {
      const s = voteSim(ARENA_MAPS[seed % 6], '1v1', 1, seed);
      s.startMatch();
      s.phase = 'matchEnd';
      s.startVote();
      expect(s.vote!.candidates, `seed ${seed}`).not.toContain(seed % 6);
    }
  });

  it('validates votes and lets players change theirs until the reveal', () => {
    const sim = voteSim(ARENA_MAPS[1], '1v1', 1);
    expect(sim.castVote('h', 0)).toBe(false); // no vote yet
    sim.startVote();
    const [a, b] = sim.vote!.candidates;
    const other = [0, 1, 2, 3, 4, 5].find((m) => !sim.vote!.candidates.includes(m))!;
    expect(sim.castVote('h', other)).toBe(false);
    expect(sim.castVote('h', 99)).toBe(false);
    expect(sim.castVote('h', 1.5)).toBe(false);
    expect(sim.castVote('nobody', a)).toBe(false);
    expect(sim.castVote('h', a)).toBe(true);
    expect(sim.castVote('h', b)).toBe(true);
    expect(sim.vote!.votes.get('h')).toBe(b);
    stepVoteTo(sim, 'reveal');
    expect(sim.castVote('h', a)).toBe(false);
    expect(sim.vote!.winner).toBe(b);
  });

  it('lets bots vote 1.5–6 s in, and closes early once every human has voted', () => {
    const sim = voteSim(ARENA_MAPS[2], 'ffa', 5);
    sim.startVote();
    const t0 = sim.time;
    const at = new Map<string, number>();
    while (sim.time - t0 < 7) {
      sim.step();
      for (const id of sim.vote!.votes.keys()) if (!at.has(id)) at.set(id, sim.time - t0);
    }
    expect(at.size).toBe(5);
    for (const t of at.values()) {
      expect(t).toBeGreaterThanOrEqual(VOTE.botVoteMin);
      expect(t).toBeLessThanOrEqual(VOTE.botVoteMax + 0.05);
    }
    expect(sim.phaseTimer).toBeGreaterThan(7);
    // Fresh vote: the human votes at once, so 3 s remain and every bot votes now.
    const s2 = voteSim(ARENA_MAPS[2], 'ffa', 5);
    s2.startVote();
    s2.step();
    s2.castVote('h', s2.vote!.candidates[0]);
    expect(s2.phaseTimer).toBeLessThanOrEqual(VOTE.allVotedTime);
    expect(s2.vote!.votes.size).toBe(6);
  });

  it('lets human votes outrank bots, and bots break ties between humans', () => {
    const sim = voteSim(ARENA_MAPS[0], 'ffa', 5);
    sim.startVote();
    const [a, b] = sim.vote!.candidates;
    for (let i = 0; i < 5; i++) sim.castVote(`b${i}`, b);
    sim.castVote('h', a);
    stepVoteTo(sim, 'reveal');
    expect(sim.vote!.winner).toBe(a);
    expect(sim.vote!.tie).toBe(false);

    const two = voteSim(ARENA_MAPS[0], 'ffa', 3, 9, ['h1', 'h2']);
    two.startVote();
    const [x, y] = two.vote!.candidates;
    two.castVote('b0', y);
    two.castVote('b1', y);
    two.castVote('b2', x);
    two.castVote('h1', x);
    two.castVote('h2', y);
    stepVoteTo(two, 'reveal');
    expect(two.vote!.winner).toBe(y);
  });

  it('breaks a full tie at random, the same way for the same seed', () => {
    const winners = new Set<number>();
    for (let seed = 0; seed < 12; seed++) {
      const run = () => {
        const sim = voteSim(ARENA_MAPS[3], '1v1', 0, seed, ['h1', 'h2']);
        sim.startVote();
        sim.castVote('h1', sim.vote!.candidates[0]);
        sim.castVote('h2', sim.vote!.candidates[1]);
        const events: unknown[] = [];
        for (let i = 0; i < 30 * 4 && sim.vote?.stage !== 'reveal'; i++) {
          sim.step();
          events.push(...sim.drainEvents().filter((e) => e.type === 'mapVote'));
        }
        expect(sim.vote!.tie).toBe(true);
        expect(events).toEqual([{ type: 'mapVote', winner: sim.vote!.winner, tie: true }]);
        return sim.vote!.winner;
      };
      const w = run();
      expect(run()).toBe(w);
      winners.add(w);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it('loads the winner after the reveal and starts round 1 there', () => {
    const sim = voteSim(ARENA_MAPS[0], '2v2', 3);
    sim.startVote();
    const pick = sim.vote!.candidates[2];
    sim.castVote('h', pick);
    stepVoteTo(sim, 'reveal');
    const revealTicks = Math.round(VOTE.revealTime * 30);
    for (let i = 0; i < revealTicks - 2; i++) sim.step();
    expect(sim.phase).toBe('vote');
    stepVoteTo(sim, null);
    expect(sim.phase).toBe('loadout');
    expect(sim.round).toBe(1);
    expect(sim.mapIndex).toBe(pick);
    expect(sim.map).toBe(ARENA_MAPS[pick]);
    expect(sim.nav.points).toBe(ARENA_MAPS[pick].waypoints);
    expect(sim.vote).toBeNull();
    expect(sim.voting.lastMatchMap).toBe(pick);
    const b = sim.map.bounds;
    for (const p of sim.players.values()) {
      expect(p.sim.alive).toBe(true);
      expect(p.sim.x > b.minX && p.sim.x < b.maxX && p.sim.z > b.minZ && p.sim.z < b.maxZ).toBe(true);
    }
  });

  it('returns to warmup on the winner when players left during the vote', () => {
    const sim = voteSim(ARENA_MAPS[4], '1v1', 0, 3, ['h1', 'h2']);
    sim.startVote();
    const pick = sim.vote!.candidates[1];
    sim.castVote('h1', pick);
    sim.removePlayer('h2');
    expect(sim.phaseTimer).toBeLessThanOrEqual(VOTE.allVotedTime); // the only human left has voted
    stepVoteTo(sim, null);
    expect(sim.phase).toBe('warmup');
    expect(sim.mapIndex).toBe(pick);
    expect(sim.players.get('h1')!.sim.alive).toBe(true);
  });

  it('freezes everyone during the vote and keeps custom maps out of it', () => {
    const sim = voteSim(ARENA_MAPS[5], 'ffa', 3);
    sim.startVote();
    const p = sim.players.get('h')!;
    const bots = [...sim.players.values()].filter((q) => q.bot).map((q) => ({ q, x: q.sim.x, z: q.sim.z }));
    const x0 = p.sim.x;
    for (let i = 1; i <= 60; i++) sim.queueCommand('h', makeCommand(i, { moveY: 1 }));
    for (let i = 0; i < 30; i++) sim.step();
    expect(p.sim.x).toBe(x0);
    for (const b of bots) expect([b.q.sim.x, b.q.sim.z]).toEqual([b.x, b.z]);

    const custom = new ArenaSimulation(flatArenaMap(), '1v1');
    custom.addPlayer({ id: 'a', name: 'A', color: 1 });
    custom.addPlayer({ id: 'b', name: 'B', color: 2 });
    custom.startVote();
    expect(custom.phase).toBe('loadout');
  });
});
