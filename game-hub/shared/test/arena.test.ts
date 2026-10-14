import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  ARENA_MAPS,
  ArenaSimulation,
  BoxWorld,
  Buttons,
  type Command,
  createPlayerSim,
  decodeCommands,
  decodeSnapshot,
  encodeCommands,
  encodePoses,
  encodeSnapshot,
  hitboxesFor,
  MOVE,
  PLAYER,
  resolveShot,
  stepMovement,
  TICK_RATE,
  unwrapSeq,
  WeaponId,
} from '../src';

const R = PLAYER.radius;
const cmd = (seq: number, over: Partial<Command> = {}): Command => ({ seq, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, slot: 255, viewTick: 0, ...over });

function flatWorld(extra: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }[] = []) {
  return new BoxWorld([{ minX: -50, maxX: 50, minY: -1, maxY: 0, minZ: -50, maxZ: 50 }, ...extra]);
}

describe('arena maps', () => {
  for (const map of ARENA_MAPS) {
    describe(map.name, () => {
      const world = new BoxWorld(map.boxes);
      const standable = (x: number, y: number, z: number) => {
        const free = !world.overlaps(x - R, y + 0.01, z - R, x + R, y + PLAYER.height, z + R);
        const ground = world.overlaps(x - R, y - 0.05, z - R, x + R, y + 0.01, z + R);
        return free && ground;
      };

      it('has valid spawn points for both teams and FFA', () => {
        const all = [...map.spawns.team[0], ...map.spawns.team[1], ...map.spawns.ffa];
        expect(map.spawns.team[0].length).toBeGreaterThanOrEqual(2);
        expect(map.spawns.ffa.length).toBe(8);
        for (const s of all) expect(standable(s.x, s.y, s.z), `${map.id} spawn ${JSON.stringify(s)}`).toBe(true);
      });

      it('has waypoints a player can stand on, forming one connected graph', () => {
        const sim = new ArenaSimulation(map, 'ffa');
        map.waypoints.forEach((w, i) => expect(standable(w.x, w.y, w.z), `${map.id} waypoint ${i} ${JSON.stringify(w)}`).toBe(true));
        const seen = new Set([0]);
        const queue = [0];
        while (queue.length) for (const n of sim.nav.adj[queue.shift()!]) if (!seen.has(n)) (seen.add(n), queue.push(n));
        expect(seen.size, `${map.id} reachable waypoints`).toBe(map.waypoints.length);
      });

      it('is symmetric for both teams', () => {
        expect(map.spawns.team[0].length).toBe(map.spawns.team[1].length);
      });
    });
  }
});

describe('arena movement', () => {
  it('accelerates to walk speed and stops with friction', () => {
    const world = flatWorld();
    const s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, crouching: false };
    for (let i = 0; i < 60; i++) stepMovement(s, { moveX: 0, moveY: 1, yaw: 0, jump: false, crouch: false, speedMul: 1 }, world, 1 / 60);
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(MOVE.walkSpeed, 3);
    expect(s.z).toBeLessThan(-4); // yaw 0 looks toward -Z
    for (let i = 0; i < 30; i++) stepMovement(s, { moveX: 0, moveY: 0, yaw: 0, jump: false, crouch: false, speedMul: 1 }, world, 1 / 60);
    expect(Math.hypot(s.vx, s.vz)).toBe(0);
  });

  it('jumps about 1.2 m and is blocked by walls', () => {
    const world = flatWorld([{ minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -3, maxZ: -2 }]);
    const s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, crouching: false };
    let peak = 0;
    stepMovement(s, { moveX: 0, moveY: 0, yaw: 0, jump: true, crouch: false, speedMul: 1 }, world, 1 / 60);
    for (let i = 0; i < 60; i++) {
      stepMovement(s, { moveX: 0, moveY: 1, yaw: 0, jump: false, crouch: false, speedMul: 1 }, world, 1 / 60);
      peak = Math.max(peak, s.y);
    }
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.35);
    expect(s.z).toBeGreaterThanOrEqual(-2 + R - 1e-3);
  });

  it('climbs the Foundry stairs onto the central deck', () => {
    const map = ARENA_MAPS[0];
    const world = new BoxWorld(map.boxes);
    const s = { x: -9, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, crouching: false };
    // Face east (+X): yaw = -PI/2.
    for (let i = 0; i < 70; i++) stepMovement(s, { moveX: 0, moveY: 1, yaw: -Math.PI / 2, jump: false, crouch: false, speedMul: 1 }, world, 1 / 60);
    expect(s.y).toBeCloseTo(2.4, 2);
    expect(s.x).toBeGreaterThan(-4);
  });
});

describe('weapons', () => {
  const world = flatWorld();

  it('enforces fire rate and ammo, then reloads', () => {
    const p = createPlayerSim(WeaponId.Rifle);
    let shots = 0;
    let seq = 1;
    // Hold fire for 1 second: rifle fires every 0.1 s.
    for (let i = 0; i < 60; i++) if (applyCommand(p, cmd(seq++, { buttons: Buttons.Fire }), world, false, 0).shot) shots++;
    expect(shots).toBe(10);
    expect(p.weapons[0].mag).toBe(20);
    applyCommand(p, cmd(seq++, { buttons: Buttons.Reload }), world, false, 0);
    expect(p.reload).toBeGreaterThan(0);
    for (let i = 0; i < 140; i++) applyCommand(p, cmd(seq++), world, false, 0);
    expect(p.weapons[0].mag).toBe(30);
    expect(p.weapons[0].reserve).toBe(80);
  });

  it('semi-auto pistol needs a trigger release between shots', () => {
    const p = createPlayerSim();
    let seq = 1;
    applyCommand(p, cmd(seq++, { slot: 1 }), world, false, 0);
    for (let i = 0; i < 30; i++) applyCommand(p, cmd(seq++), world, false, 0); // finish drawing
    let shots = 0;
    for (let i = 0; i < 60; i++) if (applyCommand(p, cmd(seq++, { buttons: Buttons.Fire }), world, false, 0).shot) shots++;
    expect(shots).toBe(1);
    for (let i = 0; i < 6; i++) {
      applyCommand(p, cmd(seq++), world, false, 0);
      for (let k = 0; k < 15; k++) if (applyCommand(p, cmd(seq++, { buttons: Buttons.Fire }), world, false, 0).shot) shots++;
    }
    expect(shots).toBe(7);
  });

  it('uses deterministic spread (client prediction matches the server)', () => {
    const a = createPlayerSim(WeaponId.Shotgun);
    const b = createPlayerSim(WeaponId.Shotgun);
    const sa = applyCommand(a, cmd(42, { buttons: Buttons.Fire, yaw: 0.3 }), world, false, 3).shot!;
    const sb = applyCommand(b, cmd(42, { buttons: Buttons.Fire, yaw: 0.3 }), world, false, 3).shot!;
    expect(sa.dirs).toHaveLength(9);
    expect(sa.dirs).toEqual(sb.dirs);
  });

  it('applies headshot multipliers and walls block shots', () => {
    const p = createPlayerSim(WeaponId.Rifle);
    p.x = 0;
    p.z = 10;
    const shot = applyCommand(createPlayerSim(WeaponId.Sniper), cmd(1, { buttons: Buttons.Fire | Buttons.Aim, pitch: Math.atan2(1.75 - 0.21 - 1.6, 10) }), world, false, 0);
    void shot;
    // Build a perfectly aimed shot straight at the head.
    const head = hitboxesFor({ x: 0, y: 0, z: -10, crouching: false }).head;
    const hy = (head.minY + head.maxY) / 2;
    const dir: [number, number, number] = [0, hy - 1.6, -10];
    const l = Math.hypot(...dir);
    const s = { weapon: WeaponId.Sniper, ox: 0, oy: 1.6, oz: 0, dirs: [[dir[0] / l, dir[1] / l, dir[2] / l] as [number, number, number]], seq: 1, viewTick: 0 };
    const target = { id: 't', boxes: hitboxesFor({ x: 0, y: 0, z: -10, crouching: false }) };
    const open = resolveShot(s, world, [target]);
    expect(open.damage[0]).toMatchObject({ id: 't', headshot: true, damage: Math.round(90 * 1.7) });
    const walled = new BoxWorld([...world.boxes, { minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: -5, maxZ: -4 }]);
    expect(resolveShot(s, walled, [target]).damage).toHaveLength(0);
  });
});

describe('arena simulation', () => {
  it('rewinds hitboxes for lag compensation (capped)', () => {
    const map = ARENA_MAPS[0];
    const sim = new ArenaSimulation(map, '1v1');
    const shooter = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    const target = sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    sim.startMatch();
    for (let i = 0; i < 6 * TICK_RATE + 2; i++) sim.step(); // through loadout
    expect(sim.phase).toBe('live');
    // Place both in the open north lane and record history while the target moves.
    Object.assign(shooter.sim, { x: -14, y: 0, z: 7, yaw: -Math.PI / 2, pitch: 0 });
    Object.assign(target.sim, { x: -6, y: 0, z: 7 });
    for (let i = 0; i < 5; i++) sim.step();
    const seenAt = sim.tick;
    Object.assign(target.sim, { z: 9.5 }); // target sidesteps 2.5 m
    sim.step();
    sim.step();
    // The shooter aims where it *saw* the target (z = 7) two ticks ago.
    const aim = Math.atan2(-(-6 - -14), -(7 - 7));
    sim.queueCommand('a', cmd(shooter.sim.lastSeq + 1, { buttons: Buttons.Fire, yaw: aim, pitch: -0.1, viewTick: seenAt }));
    sim.step();
    const hit = sim.drainEvents().find((e) => e.type === 'hit');
    expect(hit).toBeDefined();

    // A rewind far beyond the cap is clamped, so aiming at a stale position misses.
    for (let i = 0; i < 20; i++) sim.step();
    sim.drainEvents();
    sim.queueCommand('a', cmd(shooter.sim.lastSeq + 1, { buttons: Buttons.Fire, yaw: aim, pitch: -0.1, viewTick: seenAt }));
    for (let i = 0; i < 2; i++) sim.step();
    expect(sim.drainEvents().some((e) => e.type === 'hit')).toBe(false);
  });

  it('limits commands to real time (no speed hacks)', () => {
    const sim = new ArenaSimulation(ARENA_MAPS[1], '1v1');
    const p = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    for (let i = 1; i <= 300; i++) sim.queueCommand('a', cmd(i, { moveY: 1 }));
    for (let i = 0; i < 30; i++) sim.step(); // one second
    // ~60 commands per second plus the small catch-up budget, never 300.
    const processed = Math.round(p.sim.clock * 60);
    expect(processed).toBeLessThan(90);
    expect(processed).toBeGreaterThan(55);
  });

  it('plays a full bot-vs-bot match to 5 rounds in every mode', () => {
    for (const [mode, n] of [['1v1', 2], ['2v2', 4], ['ffa', 5]] as const) {
      for (const map of ARENA_MAPS) {
        const sim = new ArenaSimulation(map, mode, { seed: 7 });
        for (let i = 0; i < n; i++) sim.addPlayer({ id: `b${i}`, name: `Bot${i}`, color: i, bot: true });
        sim.startMatch();
        let kills = 0;
        let rounds = 0;
        for (let t = 0; t < 30 * 60 * 25 && sim.phase !== 'matchEnd'; t++) {
          sim.step();
          for (const e of sim.drainEvents()) {
            if (e.type === 'kill') kills++;
            if (e.type === 'roundEnd') rounds++;
          }
        }
        expect(sim.phase, `${mode} on ${map.name}`).toBe('matchEnd');
        expect(rounds).toBeGreaterThanOrEqual(5);
        expect(kills).toBeGreaterThan(3);
      }
    }
  }, 120_000);
});

describe('arena protocol', () => {
  it('round-trips commands with 16-bit sequence wrap-around', () => {
    const cmds = [cmd(65534, { moveX: 1, moveY: -0.5, yaw: 1.2, pitch: -0.3, buttons: 5, slot: 1, viewTick: 123.5 }), cmd(65535), cmd(65536), cmd(65537)];
    const out = decodeCommands(encodeCommands(cmds), 65530);
    expect(out.map((c) => c.seq)).toEqual([65534, 65535, 65536, 65537]);
    expect(out[0].moveX).toBeCloseTo(1, 2);
    expect(out[0].moveY).toBeCloseTo(-0.5, 1);
    expect(out[0].yaw).toBeCloseTo(1.2, 3);
    expect(out[0].viewTick).toBe(123.5);
    expect(unwrapSeq(2, 65534)).toBe(65538);
  });

  it('round-trips snapshots', () => {
    const self = createPlayerSim(WeaponId.Sniper);
    Object.assign(self, { x: 1.5, y: 2.4, z: -3.25, vx: 1, vy: -2, vz: 0.5, reload: 0.5, bloom: 0.01 });
    const poses = encodePoses([{ index: 3, x: -10.25, y: 0, z: 4.5, yaw: 2, pitch: 0.1, flags: 1, hp: 77, weapon: WeaponId.Shotgun }]);
    const snap = decodeSnapshot(encodeSnapshot(1234, 70000, self, poses), 69990);
    expect(snap.tick).toBe(1234);
    expect(snap.ack).toBe(70000);
    expect(snap.self!.x).toBeCloseTo(1.5);
    expect(snap.self!.weapons[0].id).toBe(WeaponId.Sniper);
    expect(snap.self!.reload).toBeCloseTo(0.5);
    expect(snap.poses[0]).toMatchObject({ index: 3, hp: 77, weapon: WeaponId.Shotgun });
    expect(snap.poses[0].x).toBeCloseTo(-10.25, 2);
  });
});
