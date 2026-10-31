import { describe, expect, it } from 'vitest';
import {
  ARENA_MAPS,
  arenaMapIndex,
  ArenaSimulation,
  BOT_DIFFICULTIES,
  BOT_HUNT_AFTER,
  BOT_PROFILES,
  type BotBrain,
  type BotDifficulty,
  type BotProfile,
  createBotBrain,
  flatArenaMap,
  isBotDifficulty,
  makeCommand,
  mulberry32,
  PRIMARY_WEAPONS,
  ROUND_TIME,
  type SimPlayer,
  WeaponId,
  weaponDef,
} from '../src';

/** The sim's bot brains (private in the class; tests reach in). */
const brainsOf = (sim: ArenaSimulation) => (sim as unknown as { brains: Map<string, BotBrain> }).brains;

/** Steps until the loadout phase is over. */
function toLive(sim: ArenaSimulation, during?: () => void): void {
  for (let i = 0; i < 30 * 20 && sim.phase !== 'live'; i++) {
    during?.();
    sim.step();
  }
  expect(sim.phase).toBe('live');
}

describe('bot difficulty profiles', () => {
  it('get weaker from hard to easy on every perception, aim, trigger and movement value', () => {
    const [e, n, h] = BOT_DIFFICULTIES.map((d) => BOT_PROFILES[d]);
    // Bigger is stronger.
    const up: (keyof BotProfile)[] = ['sightRange', 'fovHalf', 'closeAware', 'hearRange', 'turnRate', 'aimSettle', 'aimHeight', 'engageRange', 'leadFactor', 'strafe', 'slideChase', 'slideRoam'];
    // Smaller is stronger.
    const down: (keyof BotProfile)[] = ['reactToHit', 'noticePerMetre', 'trackLag', 'aimError0', 'aimFloor', 'tolMul', 'scopeMul', 'semiCadence'];
    for (const k of up) {
      expect(e[k] <= n[k] && n[k] <= h[k], k).toBe(true);
      expect(e[k] < h[k], k).toBe(true);
    }
    for (const k of down) {
      expect(e[k] >= n[k] && n[k] >= h[k], k).toBe(true);
      expect(e[k] > h[k], k).toBe(true);
    }
    for (const k of ['reaction', 'pause'] as const) for (const i of [0, 1]) expect(e[k][i] > n[k][i] && n[k][i] > h[k][i], k).toBe(true);
    for (const i of [0, 1]) expect(e.burst[i] < n.burst[i] && n.burst[i] < h.burst[i]).toBe(true);
    expect(isBotDifficulty('hard')).toBe(true);
    expect(isBotDifficulty('nightmare')).toBe(false);
  });

  it('gives each bot a slightly different sharpness and switches profiles live', () => {
    const rnd = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const b = createBotBrain(rnd);
      expect(b.difficulty).toBe('normal');
      expect(b.p).toBe(BOT_PROFILES.normal);
      expect(Math.abs(b.sharp - 1)).toBeLessThanOrEqual(BOT_PROFILES.normal.skillJitter);
    }
    const sim = new ArenaSimulation(ARENA_MAPS[0], 'ffa', { botDifficulty: 'hard' });
    for (let i = 0; i < 4; i++) sim.addPlayer({ id: `b${i}`, name: 'B', color: 1, bot: true });
    for (const b of brainsOf(sim).values()) expect(b.p).toBe(BOT_PROFILES.hard);
    const sharp = [...brainsOf(sim).values()].map((b) => b.sharp);
    sim.setBotDifficulty('easy');
    expect(sim.botDifficulty).toBe('easy');
    expect([...brainsOf(sim).values()].map((b) => [b.difficulty, b.p])).toEqual(sharp.map(() => ['easy', BOT_PROFILES.easy]));
    expect([...brainsOf(sim).values()].map((b) => b.sharp)).toEqual(sharp);
    sim.addPlayer({ id: 'late', name: 'L', color: 1, bot: true });
    expect(brainsOf(sim).get('late')!.p).toBe(BOT_PROFILES.easy);
  });
});

/** Time for a bot with the Assault Rifle to kill a player strafing at 9 m/s, D m away on open ground (Infinity = > 10 s). */
function timeToKill(d: BotDifficulty, seed: number, D = 8): number {
  const rnd = mulberry32(seed * 7919 + 13);
  const sim = new ArenaSimulation(flatArenaMap({ half: 120 }), '1v1', { seed, botDifficulty: d });
  const t = sim.addPlayer({ id: 't', name: 'T', color: 1 });
  const b = sim.addPlayer({ id: 'b', name: 'B', color: 2, bot: true });
  sim.startMatch();
  const face = -Math.PI / 2 + (rnd() - 0.5) * 0.6; // roughly toward +X, ±17°
  toLive(sim, () => {
    sim.setLoadout('b', WeaponId.Rifle);
    Object.assign(b.sim, { x: 0, y: 0, z: 0, yaw: face, pitch: 0 });
    Object.assign(t.sim, { x: D, y: 0, z: 0 });
  });
  let vz = 0;
  let dir = rnd() < 0.5 ? -1 : 1;
  let flipAt = 0.35 + rnd() * 0.45;
  let tz = 0;
  const t0 = sim.time;
  for (let k = 0; k < 10 * 30; k++) {
    const now = sim.time - t0;
    if (now > flipAt) {
      dir = -dir;
      flipAt = now + 0.35 + rnd() * 0.45;
    }
    vz += Math.max(-3, Math.min(3, dir * 9 - vz));
    tz += vz / 30;
    Object.assign(t.sim, { x: b.sim.x + D, y: 0, z: tz, vx: 0, vz, onGround: true });
    sim.step();
    if (!t.sim.alive) return sim.time - t0;
  }
  return Infinity;
}

describe('bot lethality', () => {
  it('keeps each difficulty in its band against a strafing player at 8 m', () => {
    const median = (d: BotDifficulty) => {
      const ttk = Array.from({ length: 30 }, (_, i) => timeToKill(d, 1000 + i)).sort((a, b) => a - b);
      return ttk[15];
    };
    const hard = median('hard');
    const normal = median('normal');
    const easy = median('easy');
    expect(hard).toBeLessThanOrEqual(1.7);
    expect(normal).toBeGreaterThanOrEqual(2.0);
    expect(normal).toBeLessThanOrEqual(3.8);
    expect(easy).toBeGreaterThanOrEqual(4.5);
    expect(hard).toBeLessThan(normal);
    expect(normal).toBeLessThan(easy);
  }, 30_000);
});

describe('bot navigation', () => {
  /** A lone bot in warmup sent along a path to `goal`; returns its highest y and whether a pad launched it. */
  function ride(mapId: string, start: { x: number; y: number; z: number }, goal: { x: number; y: number; z: number }, seconds: number) {
    const sim = new ArenaSimulation(ARENA_MAPS[arenaMapIndex(mapId)], 'ffa', { seed: 4 });
    const bot = sim.addPlayer({ id: 'bot', name: 'Bot', color: 1, bot: true });
    Object.assign(bot.sim, { ...start, vx: 0, vy: 0, vz: 0 });
    const brain = brainsOf(sim).get('bot')!;
    const from = sim.nav.nearest(start.x, start.y, start.z);
    const to = sim.nav.nearest(goal.x, goal.y, goal.z);
    Object.assign(brain, { path: sim.nav.path(from, to), lastNode: from, goal: to, goalKind: 'roam', repathAt: Infinity });
    expect(brain.path.length).toBeGreaterThan(0);
    let peak = -Infinity;
    let launched = false;
    for (let i = 0; i < seconds * 30; i++) {
      sim.step();
      peak = Math.max(peak, bot.sim.y);
      if (sim.drainEvents().some((e) => e.type === 'launch' && e.id === 'bot')) launched = true;
    }
    return { peak, launched };
  }

  it('rides the Dune Relay launcher onto the tower', () => {
    const r = ride('dunes', { x: -4.5, y: 0, z: -15 }, { x: 0, y: 9.2, z: -2.4 }, 8);
    expect(r.launched).toBe(true);
    expect(r.peak).toBeGreaterThanOrEqual(9.0);
  });

  it('bounces off the Verdant Hall trampoline into the canopy', () => {
    const r = ride('verdant', { x: -14, y: 0, z: 0 }, { x: -2.6, y: 9.6, z: 0 }, 10);
    expect(r.launched).toBe(true);
    expect(r.peak).toBeGreaterThanOrEqual(9.5);
  });

  it('roams every map without getting stuck', () => {
    for (const map of ARENA_MAPS) {
      const sim = new ArenaSimulation(map, 'ffa', { seed: 11 });
      const bot = sim.addPlayer({ id: 'bot', name: 'Bot', color: 1, bot: true });
      const brain = brainsOf(sim).get('bot')!;
      const visited = new Set<number>();
      let travelled = 0;
      let last = { x: bot.sim.x, z: bot.sim.z };
      let stillFor = 0;
      for (let i = 0; i < 90 * 30; i++) {
        sim.step();
        if (brain.lastNode >= 0) visited.add(brain.lastNode);
        const moved = Math.hypot(bot.sim.x - last.x, bot.sim.z - last.z);
        travelled += moved;
        stillFor = moved < 0.01 ? stillFor + 1 : 0;
        expect(stillFor, `${map.id} bot stuck at ${bot.sim.x.toFixed(1)},${bot.sim.z.toFixed(1)}`).toBeLessThan(5 * 30);
        last = { x: bot.sim.x, z: bot.sim.z };
      }
      expect(visited.size, map.id).toBeGreaterThan(25);
      expect(travelled, map.id).toBeGreaterThan(400);
      expect(bot.sim.y, map.id).toBeGreaterThan(-1);
    }
  }, 30_000);
});

describe('bot awareness', () => {
  /** A lone Normal bot walking north on open ground, plus a human. */
  function setup(): { sim: ArenaSimulation; bot: SimPlayer; human: SimPlayer; brain: BotBrain } {
    const sim = new ArenaSimulation(flatArenaMap(), 'ffa', { seed: 2 });
    const human = sim.addPlayer({ id: 'h', name: 'H', color: 1 });
    const bot = sim.addPlayer({ id: 'bot', name: 'Bot', color: 2, bot: true });
    const brain = brainsOf(sim).get('bot')!;
    Object.assign(bot.sim, { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 });
    Object.assign(brain, { yaw: 0, sharp: 1, path: [sim.nav.nearest(0, 0, -10)], lastNode: sim.nav.nearest(0, 0, 0), repathAt: Infinity });
    return { sim, bot, human, brain };
  }

  it('hears gunfire within its range and goes to look', () => {
    for (const [dist, heard] of [[20, true], [30, false]] as const) {
      const { sim, bot, human, brain } = setup();
      Object.assign(human.sim, { x: 0, y: 0, z: dist, yaw: Math.PI, pitch: 1.2 }); // behind the bot, firing at the sky
      sim.queueCommand('h', makeCommand(1, { yaw: Math.PI, pitch: 1.2, buttons: 4 }));
      sim.step();
      expect(sim.drainEvents().some((e) => e.type === 'shot'), `${dist} m`).toBe(true);
      expect(brain.heard !== null, `${dist} m`).toBe(heard);
      if (!heard) continue;
      // It re-plans toward the noise, turns around and finds the shooter.
      sim.step();
      expect(brain.goalKind).toBe('investigate');
      expect(brain.goal).toBe(sim.nav.nearest(0, 0, dist));
      for (let i = 0; i < 45 && brain.targetId === null; i++) sim.step();
      expect(brain.targetId).toBe('h');
      expect(bot.sim.alive).toBe(true);
    }
  });

  it('turns toward an unseen attacker after its reaction time', () => {
    const { sim, human, brain } = setup();
    Object.assign(human.sim, { x: 0, y: 0, z: 12 }); // behind, outside the view cone
    sim.step();
    expect(brain.targetId).toBeNull();
    sim.applyDamage(human, 'bot', 10, false, WeaponId.Rifle);
    const react = BOT_PROFILES.normal.reactToHit;
    let seenAfter = Infinity;
    const t0 = sim.time;
    for (let i = 0; i < 3 * 30 && seenAfter === Infinity; i++) {
      Object.assign(human.sim, { vx: 0, vz: 0 });
      sim.step();
      if (brain.targetId === 'h') seenAfter = sim.time - t0;
    }
    expect(seenAfter).toBeGreaterThan(react - 0.05);
    expect(seenAfter).toBeLessThan(react + 1.0);
  });

  it('hunts the nearest enemy late in a round', () => {
    const map = ARENA_MAPS[0];
    const sim = new ArenaSimulation(map, '1v1', { seed: 8 });
    const human = sim.addPlayer({ id: 'h', name: 'H', color: 1 });
    const bot = sim.addPlayer({ id: 'bot', name: 'Bot', color: 2, bot: true });
    sim.startMatch();
    toLive(sim);
    const brain = brainsOf(sim).get('bot')!;
    const hide = () => {
      Object.assign(human.sim, { x: 39, y: 0, z: 2, vx: 0, vz: 0 });
      if (Math.hypot(bot.sim.x - 39, bot.sim.z - 2) < 70) Object.assign(bot.sim, { x: -39, y: 0, z: -2 });
    };
    for (let i = 0; i < 60; i++) {
      hide();
      sim.step();
    }
    expect(brain.goalKind).not.toBe('hunt');
    sim.phaseTimer = ROUND_TIME - BOT_HUNT_AFTER - 1;
    brain.path = [];
    hide();
    sim.step();
    expect(brain.targetId).toBeNull();
    expect(brain.goalKind).toBe('hunt');
    expect(brain.goal).toBe(sim.nav.nearest(39, 0, 2));
  });
});

describe('bots in full matches', () => {
  it('fight with every primary weapon', () => {
    for (const weapon of PRIMARY_WEAPONS) {
      const sim = new ArenaSimulation(ARENA_MAPS[arenaMapIndex('courts')], 'ffa', { seed: 21 + weapon });
      for (let i = 0; i < 4; i++) sim.addPlayer({ id: `b${i}`, name: `B${i}`, color: i, bot: true });
      sim.startMatch();
      let kills = 0;
      let boltHits = 0;
      for (let t = 0; t < 30 * 240 && kills <= 3; t++) {
        if (sim.phase === 'loadout') for (const id of sim.players.keys()) sim.setLoadout(id, weapon);
        sim.step();
        for (const e of sim.drainEvents()) {
          if (e.type === 'kill' && e.weapon === weapon) kills++;
          if (e.type === 'projEnd' && e.hitId) boltHits++;
        }
        if (sim.phase === 'matchEnd') sim.startMatch();
      }
      expect(kills, weaponDef(weapon).name).toBeGreaterThan(3);
      if (weaponDef(weapon).kind === 'projectile') expect(boltHits, weaponDef(weapon).name).toBeGreaterThan(0);
    }
  }, 60_000);

  it('slide during a free-for-all', () => {
    const sim = new ArenaSimulation(ARENA_MAPS[arenaMapIndex('frostline')], 'ffa', { seed: 33 });
    for (let i = 0; i < 6; i++) sim.addPlayer({ id: `b${i}`, name: `B${i}`, color: i, bot: true });
    sim.startMatch();
    let slid = false;
    for (let t = 0; t < 60 * 30 && !slid; t++) {
      sim.step();
      slid = [...sim.players.values()].some((p) => p.sim.sliding);
    }
    expect(slid).toBe(true);
  });

  it('are clearly gentler on Easy than on Hard in a bot-vs-human-dummy duel', () => {
    // A still human on open ground 15 m away: Hard kills fast, Easy takes far longer or misses entirely.
    const survive = (d: BotDifficulty) => {
      let total = 0;
      for (let seed = 0; seed < 12; seed++) {
        const sim = new ArenaSimulation(flatArenaMap({ half: 60 }), '1v1', { seed, botDifficulty: d });
        const h = sim.addPlayer({ id: 'h', name: 'H', color: 1 });
        const b = sim.addPlayer({ id: 'b', name: 'B', color: 2, bot: true });
        sim.startMatch();
        toLive(sim, () => {
          sim.setLoadout('b', WeaponId.Rifle);
          Object.assign(b.sim, { x: 0, y: 0, z: 0, yaw: -Math.PI / 2 });
          Object.assign(h.sim, { x: 15, y: 0, z: 0 });
        });
        let t = 0;
        for (; t < 8 * 30 && h.sim.alive; t++) {
          Object.assign(h.sim, { x: b.sim.x + 15, z: b.sim.z, vx: 0, vz: 0 });
          sim.step();
        }
        total += t / 30;
      }
      return total / 12;
    };
    expect(survive('easy')).toBeGreaterThan(survive('hard') * 1.8);
  }, 30_000);
});
