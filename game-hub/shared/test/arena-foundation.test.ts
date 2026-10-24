/**
 * Arcfire Arena upgrade foundation: wire layouts, pads in the collision world,
 * the system hooks in the simulation, loadout rules, and the ported movement
 * envelope (design-arena-movement §2; the movement package tests it in depth).
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  ArenaSimulation,
  ballisticAim,
  BUTTON_MASK,
  Buttons,
  createArenaWorld,
  createMoveState,
  createPlayerSim,
  decodeCommands,
  decodeSnapshot,
  encodeCommands,
  encodePoses,
  encodeSnapshot,
  eyeHeight,
  flatArenaMap,
  launchVelocityForHeight,
  makeCommand,
  type MapBox,
  MOVE,
  PoseFlags,
  stepMovement,
  trampolinePad,
  WeaponId,
} from '../src';

describe('arena protocol 2', () => {
  it('round-trips the slide and weapon fields in a 70-byte self block', () => {
    const self = createPlayerSim(WeaponId.Sniper);
    Object.assign(self, { sliding: true, crouching: true, slideTime: 0.4, slideCooldown: 1.0, slideBuffer: 0.15, ads: 0.5, burstLeft: 2 });
    const bytes = encodeSnapshot(10, 5, self, encodePoses([]));
    expect(bytes.length).toBe(7 + 70 + 1);
    const back = decodeSnapshot(bytes, 0).self!;
    expect(back.sliding).toBe(true);
    expect(back.crouching).toBe(true);
    expect(back.slideTime).toBeCloseTo(0.4, 6);
    expect(back.slideCooldown).toBeCloseTo(1.0, 6);
    expect(back.slideBuffer).toBeCloseTo(0.15, 6);
    expect(back.ads).toBeCloseTo(0.5, 6);
    expect(back.burstLeft).toBe(2);
    expect(back.weapons.map((w) => w.id)).toEqual([WeaponId.Sniper, WeaponId.Pistol, WeaponId.Blade]);
    const idle = decodeSnapshot(encodeSnapshot(10, 5, createPlayerSim(), encodePoses([])), 0).self!;
    expect(idle).toMatchObject({ sliding: false, slideTime: 0, slideCooldown: 0, slideBuffer: 0, ads: 0, burstLeft: 0 });
  });

  it('carries the Slide pose flag and button bit', () => {
    const flags = PoseFlags.Alive | PoseFlags.Crouch | PoseFlags.Slide;
    const snap = decodeSnapshot(encodeSnapshot(1, 0, null, encodePoses([{ index: 2, x: 1, y: 0, z: 2, yaw: 0, pitch: 0, flags, hp: 90, weapon: WeaponId.Rifle }])), 0);
    expect(snap.poses[0].flags & PoseFlags.Slide).toBe(PoseFlags.Slide);
    const [c] = decodeCommands(encodeCommands([makeCommand(7, { buttons: Buttons.Slide | Buttons.Crouch | Buttons.Fire })]), 0);
    expect(c.buttons).toBe(Buttons.Slide | Buttons.Crouch | Buttons.Fire);
    expect(BUTTON_MASK).toBe(0x7f);
  });
});

describe('launch pads in the collision world', () => {
  const pad = trampolinePad(0, -5, 2, 2, 0.3, 4);
  const padBox: MapBox = { minX: -1, maxX: 1, minY: 0, maxY: 0.3, minZ: -6, maxZ: -4, kind: 'pad' };

  it('finds the pad under feet on its top only', () => {
    const world = createArenaWorld({ boxes: [padBox], pads: [pad] });
    expect(world.pads).toHaveLength(1);
    expect(world.padAt(0, 0.3, -5, 0.35)).toBe(0);
    expect(world.padAt(0.9, 0.32, -4.1, 0.35)).toBe(0); // footprint overlapping the edge
    expect(world.padAt(1.2 + 0.35, 0.3, -5, 0.35)).toBe(-1); // 0.2 m beside it
    expect(world.padAt(0, 0.1, -5, 0.35)).toBe(-1); // 0.2 m below its top
    expect(createArenaWorld({ boxes: [padBox] }).padAt(0, 0.3, -5, 0.35)).toBe(-1); // map without pads
  });

  it('launches a player who runs onto it and reports the launch', () => {
    const sim = new ArenaSimulation(flatArenaMap({ pads: [pad], boxes: [padBox] }), '1v1');
    expect(sim.mapIndex).toBe(-1);
    const p = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.drainEvents();
    Object.assign(p.sim, { x: 0, y: 0, z: 0, yaw: 0 });
    let peak = 0;
    const launches: unknown[] = [];
    for (let i = 1; i <= 120; i++) {
      sim.queueCommand('a', makeCommand(i, { moveY: i <= 30 ? 1 : 0 }));
      sim.step();
      peak = Math.max(peak, p.sim.y);
      launches.push(...sim.drainEvents().filter((e) => e.type === 'launch'));
    }
    expect(launches[0]).toEqual({ type: 'launch', id: 'a', pad: 0 });
    expect(p.launchPad).toBe(0);
    expect(p.launchedAt).toBeGreaterThan(0);
    // A 4 m trampoline from a 0.3 m pad top (bounce never lowers it).
    expect(peak).toBeGreaterThan(4.2);
  });
});

describe('simulation systems', () => {
  it('starts the match straight away when no vote is possible (fixture map)', () => {
    const sim = new ArenaSimulation(flatArenaMap(), '1v1');
    sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    sim.startVote();
    expect(sim.phase).toBe('loadout');
    expect(sim.vote).toBeNull();
    expect(sim.voting.lastMatchMap).toBe(-1);
    expect(sim.castVote('a', 0)).toBe(false);
  });

  it('applies loadout picks per slot and ignores invalid ones', () => {
    const sim = new ArenaSimulation(flatArenaMap(), '1v1');
    const p = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    sim.startMatch();
    expect(sim.phase).toBe('loadout');
    sim.setLoadout('a', WeaponId.Sniper, WeaponId.Pistol);
    expect(p.primary).toBe(WeaponId.Sniper);
    expect(p.sim.weapons[0]).toEqual({ id: WeaponId.Sniper, mag: 5, reserve: 15 });
    // Wrong slots: a pistol is no primary and a rifle no secondary.
    sim.setLoadout('a', WeaponId.Pistol, WeaponId.Rifle);
    expect(p.primary).toBe(WeaponId.Sniper);
    expect(p.secondary).toBe(WeaponId.Pistol);
    expect(p.sim.weapons.map((w) => w.id)).toEqual([WeaponId.Sniper, WeaponId.Pistol, WeaponId.Blade]);
    // Only the secondary.
    p.sim.weapons[1].mag = 3;
    sim.setLoadout('a', undefined, WeaponId.Pistol);
    expect(p.sim.weapons[1].mag).toBe(12);
    expect(p.sim.weapons[0].id).toBe(WeaponId.Sniper);
    expect(p.primary).toBe(WeaponId.Sniper);
  });

  it('freezes players during the map vote', () => {
    const sim = new ArenaSimulation(flatArenaMap(), '1v1');
    const p = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.phase = 'vote';
    const x0 = p.sim.x;
    const z0 = p.sim.z;
    for (let i = 1; i <= 40; i++) sim.queueCommand('a', makeCommand(i, { moveY: 1, buttons: Buttons.Fire }));
    for (let i = 0; i < 25; i++) sim.step();
    expect(p.sim.lastSeq).toBe(40);
    expect(p.sim.x).toBe(x0);
    expect(p.sim.z).toBe(z0);
    expect(p.stats.shots).toBe(0);
    expect(sim.phase).toBe('vote');
  });

  it('solves low-arc launches for bots', () => {
    expect(ballisticAim(40, 0, 0, 95, 7)!.pitch).toBeCloseTo(0.01551, 4);
    expect(ballisticAim(2000, 0, 0, 95, 7)).toBeNull(); // max range ≈ 1289 m
    expect(ballisticAim(0, 5, 0, 95, 7)!.pitch).toBeCloseTo(Math.PI / 2);
  });
});

describe('ported movement envelope', () => {
  const world = createArenaWorld(flatArenaMap());
  const run = { moveX: 0, moveY: 1, yaw: 0, jump: false, crouch: false, speedMul: 0.95 };

  it('runs at 9 m/s × weapon and slides with crouch while running', () => {
    const s = createMoveState();
    for (let i = 0; i < 30; i++) stepMovement(s, run, world, 1 / 60);
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(MOVE.walkSpeed * 0.95, 3);
    const r = stepMovement(s, { ...run, slide: true }, world, 1 / 60);
    expect(r.slideStarted).toBe(true);
    expect(s.sliding && s.crouching).toBe(true);
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(12.35 - 7.5 / 60, 2);
    expect(eyeHeight(s.crouching, s.sliding)).toBe(1.0);
    const z0 = s.z;
    let n = 1;
    while (s.sliding && n < 120) {
      stepMovement(s, run, world, 1 / 60);
      n++;
    }
    expect(n).toBeLessThanOrEqual(60);
    expect(z0 - s.z).toBeGreaterThan(7.8);
    expect(z0 - s.z).toBeLessThan(9.5);
    // Crouch not held: standing again on the next command.
    stepMovement(s, run, world, 1 / 60);
    expect(s.crouching).toBe(false);
  });

  it('keeps aiming off while sliding and clears the slide when frozen', () => {
    const p = createPlayerSim();
    let seq = 0;
    for (let i = 0; i < 30; i++) applyCommand(p, makeCommand(++seq, { moveY: 1 }), world, false, 0);
    applyCommand(p, makeCommand(++seq, { moveY: 1, buttons: Buttons.Slide | Buttons.Aim }), world, false, 0);
    expect(p.sliding).toBe(true);
    expect(p.aiming).toBe(false);
    expect(p.ads).toBe(0);
    applyCommand(p, makeCommand(++seq, { moveY: 1 }), world, true, 0);
    expect(p).toMatchObject({ sliding: false, slideTime: 0, slideBuffer: 0, vx: 0, vz: 0 });
  });

  it('jumps 1.27 m and sizes pads to their apex', () => {
    const s = createMoveState();
    let peak = 0;
    stepMovement(s, { ...run, moveY: 0, jump: true }, world, 1 / 60);
    for (let i = 0; i < 60; i++) {
      stepMovement(s, { ...run, moveY: 0 }, world, 1 / 60);
      peak = Math.max(peak, s.y);
    }
    expect(peak).toBeGreaterThan(1.22);
    expect(peak).toBeLessThan(1.32);
    expect(launchVelocityForHeight(1.27)).toBeCloseTo(8.01, 2);
  });
});
