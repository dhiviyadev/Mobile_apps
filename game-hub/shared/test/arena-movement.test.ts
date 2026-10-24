/**
 * Arcfire Arena movement envelope (design-arena-movement §2, §4, §12): run,
 * jump, slide, stairs, walls, slide-under, launch pads, determinism and
 * reconciliation. Uses fixture geometry only (flatArenaMap, deckWithStairs),
 * never real maps. The envelope is frozen: WP3's maps are validated against it.
 */
import { describe, expect, it } from 'vitest';
import {
  type ArenaEvent,
  type ArenaMoveInput,
  ArenaSimulation,
  applyCommand,
  applyLaunch,
  BUTTON_MASK,
  type BoxWorld,
  Buttons,
  canStartSlide,
  clonePlayerSim,
  CMD_DT,
  type Command,
  createArenaWorld,
  createMoveState,
  createPlayerSim,
  decodeSnapshot,
  deckWithStairs,
  encodePoses,
  encodeSnapshot,
  eyeHeight,
  flatArenaMap,
  type LaunchPad,
  launcherPad,
  launchVelocityForHeight,
  makeCommand,
  type MapBox,
  MOVE,
  type MoveState,
  PAD,
  type PlayerSim,
  SLIDE,
  stepMovement,
  trampolinePad,
  WeaponId,
} from '../src';

const DT = CMD_DT;
const flat = createArenaWorld(flatArenaMap());
/** Rifle run input (moveMul 0.95) straight ahead (yaw 0 looks toward -Z). */
const RUN: ArenaMoveInput = { moveX: 0, moveY: 1, yaw: 0, jump: false, crouch: false, speedMul: 0.95 };
const hs = (s: MoveState) => Math.hypot(s.vx, s.vz);

function steps(s: MoveState, n: number, input: Partial<ArenaMoveInput> = {}, world: BoxWorld = flat): void {
  for (let i = 0; i < n; i++) stepMovement(s, { ...RUN, ...input }, world, DT);
}

/** A runner at full rifle speed heading -Z from (x, y, z). */
function runner(x = 0, y = 0, z = 0, world: BoxWorld = flat, input: Partial<ArenaMoveInput> = {}): MoveState {
  const s = createMoveState(x, y, z);
  steps(s, 30, input, world);
  return s;
}

function box(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number, kind: MapBox['kind'] = 'cover'): MapBox {
  return { minX, maxX, minY, maxY, minZ, maxZ, kind };
}

describe('running and stopping', () => {
  it('reaches run speed in 7 commands (9 m/s, 8.55 with a rifle) and stops in 8', () => {
    const s = createMoveState();
    steps(s, 7, { speedMul: 1 });
    expect(hs(s)).toBeCloseTo(MOVE.walkSpeed, 6);
    expect(MOVE.walkSpeed).toBe(9);
    steps(s, 8, { moveY: 0, speedMul: 1 });
    expect(hs(s)).toBe(0);
    const r = createMoveState();
    steps(r, 7);
    expect(hs(r)).toBeCloseTo(8.55, 6);
  });

  it('crouch-walks at 4.2 m/s and cannot slide from it', () => {
    const s = createMoveState();
    steps(s, 20, { crouch: true, speedMul: 1 });
    expect(hs(s)).toBeCloseTo(MOVE.crouchSpeed, 6);
    expect(canStartSlide(s, 0)).toBe(false);
  });
});

describe('jumping and climbing', () => {
  it('jumps 1.22–1.32 m high', () => {
    const s = createMoveState();
    let peak = 0;
    stepMovement(s, { ...RUN, moveY: 0, jump: true }, flat, DT);
    for (let i = 0; i < 60 && !s.onGround; i++) {
      stepMovement(s, { ...RUN, moveY: 0 }, flat, DT);
      peak = Math.max(peak, s.y);
    }
    expect(peak).toBeGreaterThan(1.22);
    expect(peak).toBeLessThan(1.32);
    expect(s.onGround).toBe(true);
  });

  /** Runs at a wall of height h 3 m ahead and jumps at the last moment; returns the final height. */
  function climb(h: number): number {
    const world = createArenaWorld({ boxes: [...flatArenaMap().boxes, box(-3, 3, 0, h, -40, -5)] });
    const s = createMoveState(0, 0, 0);
    steps(s, 10, {}, world);
    // Jump about 1 m before the face.
    while (s.z > -3.9) stepMovement(s, RUN, world, DT);
    stepMovement(s, { ...RUN, jump: true }, world, DT);
    steps(s, 90, {}, world);
    return s.y;
  }

  it('mounts 1.2, 1.6 and 1.70 m ledges with a running jump but not 1.80 m', () => {
    expect(climb(1.2)).toBeCloseTo(1.2, 6);
    expect(climb(1.6)).toBeCloseTo(1.6, 6);
    expect(climb(1.7)).toBeCloseTo(1.7, 6);
    expect(climb(1.8)).toBe(0);
  });

  it('jumps a 5.6 m running gap but not much more', () => {
    const s = runner();
    const z0 = s.z;
    stepMovement(s, { ...RUN, jump: true }, flat, DT);
    while (!s.onGround) stepMovement(s, RUN, flat, DT);
    const gap = z0 - s.z;
    expect(gap).toBeGreaterThan(5.2);
    expect(gap).toBeLessThan(6.0);
  });
});

describe('slides', () => {
  it('starts with crouch while running: +4 m/s, crouch hitbox, slide eye', () => {
    const s = runner();
    const r = stepMovement(s, { ...RUN, slide: true }, flat, DT);
    expect(r.slideStarted).toBe(true);
    expect(s.sliding).toBe(true);
    expect(s.crouching).toBe(true);
    expect(s.slideCooldown).toBeCloseTo(SLIDE.cooldown, 9);
    // 8.55 + 4 is capped at 13 × 0.95 = 12.35; the first slide command already decelerates.
    expect(hs(s) + SLIDE.decel * DT).toBeCloseTo(12.35, 6);
    expect(eyeHeight(s.crouching, s.sliding)).toBe(1.0);
  });

  it('lasts at most 60 commands and covers 8–9.5 m; stands up after unless crouch is held', () => {
    for (const hold of [false, true]) {
      const s = runner();
      const z0 = s.z;
      stepMovement(s, { ...RUN, slide: true, crouch: hold }, flat, DT);
      let n = 1;
      let ended = false;
      while (!ended && n < 120) {
        ended = stepMovement(s, { ...RUN, crouch: hold }, flat, DT).slideEnded;
        n++;
      }
      expect(n).toBeLessThanOrEqual(60);
      expect(z0 - s.z).toBeGreaterThan(8);
      expect(z0 - s.z).toBeLessThan(9.5);
      expect(s.sliding).toBe(false);
      stepMovement(s, { ...RUN, crouch: hold }, flat, DT);
      expect(s.crouching).toBe(hold);
      // Back to run speed (or crouch speed) quickly, without a stop.
      steps(s, 12, { crouch: hold });
      expect(hs(s)).toBeCloseTo(hold ? MOVE.crouchSpeed * 0.95 : 8.55, 1);
    }
  });

  it('is refused while slow, backwards, airborne or on cooldown', () => {
    // Half stick: 4.5 m/s.
    const slow = runner(0, 0, 0, flat, { moveY: 0.5 });
    expect(stepMovement(slow, { ...RUN, moveY: 0.5, slide: true }, flat, DT).slideStarted).toBe(false);
    // Running backwards.
    const back = runner(0, 0, 0, flat, { moveY: -1 });
    expect(stepMovement(back, { ...RUN, moveY: -1, slide: true }, flat, DT).slideStarted).toBe(false);
    // Sideways is fine (strafe slide).
    const side = runner(0, 0, 0, flat, { moveX: 1, moveY: 0 });
    expect(stepMovement(side, { ...RUN, moveX: 1, moveY: 0, slide: true }, flat, DT).slideStarted).toBe(true);
    // Airborne, pressed long before landing: the buffer runs out.
    const air = runner();
    stepMovement(air, { ...RUN, jump: true }, flat, DT);
    stepMovement(air, { ...RUN, slide: true }, flat, DT);
    let started = false;
    while (!air.onGround) started ||= stepMovement(air, RUN, flat, DT).slideStarted;
    for (let i = 0; i < 5; i++) started ||= stepMovement(air, RUN, flat, DT).slideStarted;
    expect(started).toBe(false);
    // Cooldown: a second request 0.5 s after the first slide started.
    const cd = runner();
    stepMovement(cd, { ...RUN, slide: true }, flat, DT);
    steps(cd, 29);
    expect(stepMovement(cd, { ...RUN, slide: true }, flat, DT).slideStarted).toBe(false);
  });

  it('buffers a request made 10 commands before landing', () => {
    const s = runner();
    stepMovement(s, { ...RUN, jump: true }, flat, DT);
    // Airtime is 39 commands; press with 10 to go.
    steps(s, 28);
    expect(s.onGround).toBe(false);
    let landedAt = -1;
    let startedAt = -1;
    for (let i = 0; i < 20; i++) {
      const r = stepMovement(s, { ...RUN, slide: i === 0 }, flat, DT);
      if (r.landed && landedAt < 0) landedAt = i;
      if (r.slideStarted) startedAt = i;
    }
    expect(landedAt).toBeGreaterThanOrEqual(8);
    expect(landedAt).toBeLessThanOrEqual(12);
    expect(startedAt).toBe(landedAt + 1);
  });

  it('slide-jumps keep momentum up to 12.5 m/s and clear a 7.4 m gap', () => {
    const s = runner();
    stepMovement(s, { ...RUN, slide: true }, flat, DT);
    steps(s, 2);
    const z0 = s.z;
    const r = stepMovement(s, { ...RUN, jump: true }, flat, DT);
    expect(r.jumped && r.slideEnded).toBe(true);
    expect(s.sliding).toBe(false);
    expect(hs(s)).toBeLessThanOrEqual(SLIDE.jumpMaxSpeed + 1e-9);
    expect(hs(s)).toBeGreaterThanOrEqual(11.5);
    let minAir = Infinity;
    while (!s.onGround) {
      stepMovement(s, RUN, flat, DT);
      if (!s.onGround) minAir = Math.min(minAir, hs(s));
    }
    expect(minAir).toBeGreaterThanOrEqual(11.5);
    expect(z0 - s.z).toBeGreaterThan(7.4);
  });

  it('steers at 1.8 rad/s: 30 commands of right stick turn it 51.6°', () => {
    const s = runner();
    stepMovement(s, { ...RUN, slide: true }, flat, DT);
    const h0 = Math.atan2(s.vx, -s.vz);
    steps(s, 30, { moveX: 1, moveY: 0 });
    expect(s.sliding).toBe(true);
    const turned = ((Math.atan2(s.vx, -s.vz) - h0) * 180) / Math.PI;
    expect(Math.abs(turned)).toBeGreaterThan(50.6);
    expect(Math.abs(turned)).toBeLessThan(52.6);
    expect(turned).toBeGreaterThan(0); // toward the stick (+X)
  });

  it('brakes when pulling back', () => {
    const a = runner();
    const b = runner();
    stepMovement(a, { ...RUN, slide: true }, flat, DT);
    stepMovement(b, { ...RUN, slide: true }, flat, DT);
    steps(a, 20);
    steps(b, 20, { moveY: -1 });
    expect(hs(b)).toBeLessThan(hs(a) - 2.5);
  });

  describe('on stairs (deckWithStairs: deck top 2.4, five 0.4 m steps going west)', () => {
    const world = createArenaWorld({ boxes: deckWithStairs() });
    const west: Partial<ArenaMoveInput> = { yaw: Math.PI / 2 };

    it('gains speed sliding down: over 13 m/s', () => {
      const s = createMoveState(3.5, 2.4, 0);
      steps(s, 20, west, world);
      // Drop into the slide right at the top step.
      while (s.x > -3.6) stepMovement(s, { ...RUN, ...west }, world, DT);
      expect(s.y).toBe(2.4);
      stepMovement(s, { ...RUN, ...west, slide: true }, world, DT);
      expect(s.sliding).toBe(true);
      let peak = 0;
      for (let i = 0; i < 60 && s.sliding; i++) {
        stepMovement(s, { ...RUN, ...west }, world, DT);
        peak = Math.max(peak, hs(s));
      }
      expect(peak).toBeGreaterThan(13);
      expect(peak).toBeLessThanOrEqual(SLIDE.maxSpeed);
      expect(s.y).toBe(0);
    });

    it('ends sooner sliding up than on flat ground', () => {
      const s = createMoveState(-14, 0, 0);
      const east: Partial<ArenaMoveInput> = { yaw: -Math.PI / 2 };
      steps(s, 30, east, world);
      // Start the slide just before the first step.
      while (s.x < -7.6) stepMovement(s, { ...RUN, ...east }, world, DT);
      stepMovement(s, { ...RUN, ...east, slide: true }, world, DT);
      let n = 1;
      while (s.sliding && n < 120) {
        stepMovement(s, { ...RUN, ...east }, world, DT);
        n++;
      }
      expect(s.y).toBeGreaterThan(0.3);
      expect(n).toBeLessThan(45);
    });
  });

  it('ends within 3 commands of hitting a wall head-on', () => {
    const world = createArenaWorld({ boxes: [...flatArenaMap().boxes, box(-3, 3, 0, 4, -12, -11, 'wall')] });
    const s = runner(0, 0, 0, world);
    stepMovement(s, { ...RUN, slide: true }, world, DT);
    let contact = -1;
    let ended = -1;
    for (let i = 0; i < 60 && ended < 0; i++) {
      const r = stepMovement(s, RUN, world, DT);
      // Blocked: the axis velocity is zeroed on contact.
      if (contact < 0 && s.vz === 0) contact = i;
      if (r.slideEnded) ended = i;
    }
    expect(contact).toBeGreaterThanOrEqual(0);
    expect(ended - contact).toBeLessThanOrEqual(3);
    expect(s.z).toBeGreaterThan(-11 + PLAYER_R - 1e-3);
  });

  it('passes under a 1.5 m gap only while sliding, and stays crouched until there is headroom', () => {
    // A slab from y 1.5 to 3 across the lane, 1.2 m deep.
    const world = createArenaWorld({ boxes: [...flatArenaMap().boxes, box(-3, 3, 1.5, 3, -6.2, -5)] });
    const standing = runner(0, 0, 0, world);
    steps(standing, 60, {}, world);
    expect(standing.z).toBeGreaterThan(-5 + PLAYER_R - 1e-3); // blocked at the face
    const slider = createMoveState(0, 0, 0);
    steps(slider, 30, {}, world);
    while (slider.z > -1.2) stepMovement(slider, RUN, world, DT);
    stepMovement(slider, { ...RUN, slide: true }, world, DT);
    let under = false;
    for (let i = 0; i < 90; i++) {
      stepMovement(slider, RUN, world, DT);
      if (slider.z < -5.6 && slider.z > -5.8) under = true;
    }
    expect(under).toBe(true);
    expect(slider.z).toBeLessThan(-6.2 - PLAYER_R);
    expect(slider.crouching).toBe(false);
    // A slide that dies under the slab leaves the player crouched there.
    const stuck = createMoveState(0, 0, -5.4);
    stuck.crouching = true;
    steps(stuck, 5, { moveY: 0 }, world);
    expect(stuck.crouching).toBe(true);
  });
});

const PLAYER_R = 0.35;

describe('launch pads', () => {
  it('sizes launches to their apex within 1 cm', () => {
    for (const h of [1, 3, 8]) {
      const s = createMoveState();
      s.vy = launchVelocityForHeight(h);
      s.onGround = false;
      let peak = 0;
      for (let i = 0; i < 200 && (s.vy > 0 || s.y > 0); i++) {
        stepMovement(s, { ...RUN, moveY: 0 }, flat, DT);
        peak = Math.max(peak, s.y);
      }
      expect(Math.abs(peak - h)).toBeLessThan(0.01);
    }
  });

  /** A pad box and its pad on the flat fixture. */
  function padWorld(pads: LaunchPad[], extra: MapBox[] = []): BoxWorld {
    const boxes: MapBox[] = pads.map((p) => box(p.minX, p.maxX, 0, p.top, p.minZ, p.maxZ, 'pad'));
    return createArenaWorld({ boxes: [...flatArenaMap().boxes, ...boxes, ...extra], pads });
  }

  /** Walks from (x, z) toward -Z onto whatever is there; returns the peak height and the launch results. */
  function ride(world: BoxWorld, x: number, z: number, input: Partial<ArenaMoveInput> = {}, n = 240) {
    const s = createMoveState(x, 0, z);
    let peak = 0;
    let launched = -1;
    let launches = 0;
    let stoppedInput = false;
    for (let i = 0; i < n; i++) {
      const r = stepMovement(s, { ...RUN, moveY: stoppedInput ? 0 : 1, ...input }, world, DT);
      if (r.launched >= 0) {
        launches++;
        if (launched < 0) launched = r.launched;
        stoppedInput = true;
      }
      if (launched >= 0) peak = Math.max(peak, s.y);
    }
    return { s, peak, launched, launches };
  }

  it('bounces a trampoline to its design height (±2%), higher with Jump held', () => {
    const tramp = trampolinePad(0, -5, 2, 2, 0.3, 5);
    const world = padWorld([tramp]);
    const plain = ride(world, 0, 0, {}, 100);
    expect(plain.launched).toBe(0);
    expect(Math.abs(plain.peak - (0.3 + 5)) / 5.3).toBeLessThan(0.02);
    const held = ride(world, 0, 0, { jump: true }, 100);
    expect(held.peak - 0.3).toBeGreaterThan(5 * PAD.jumpBonus * PAD.jumpBonus * 0.97);
  });

  it('reflects a high fall with bounce, but never past PAD.maxVy', () => {
    const tramp = trampolinePad(0, 0, 2, 2, 0.3, 2);
    const s = createMoveState(0, 9, 0);
    s.onGround = false;
    const world = padWorld([tramp]);
    let impact = 0;
    let launched = false;
    for (let i = 0; i < 120 && !launched; i++) {
      const vy = s.vy;
      const r = stepMovement(s, { ...RUN, moveY: 0 }, world, DT);
      if (r.launched === 0) {
        launched = true;
        impact = -(vy - MOVE.gravity * DT);
      }
    }
    expect(launched).toBe(true);
    expect(s.vy).toBeCloseTo(impact * tramp.bounce, 6);
    expect(s.vy).toBeGreaterThan(tramp.vy);
    const high = createMoveState();
    applyLaunch(high, tramp, true, 60);
    expect(high.vy).toBe(PAD.maxVy);
  });

  it('throws a launcher onto its target within 1.0 m with no input', () => {
    const target = { x: 0, y: 4, z: -24 };
    const pad = launcherPad(0, -2, 2, 2, 0.3, target, 7);
    const ledge = box(-4, 4, 0, 4, -30, -21, 'platform');
    const world = padWorld([pad], [ledge]);
    const s = createMoveState(0, 0.3, -2);
    let r = stepMovement(s, { ...RUN, moveY: 0 }, world, DT);
    expect(r.launched).toBe(0);
    for (let i = 0; i < 240 && !s.onGround; i++) r = stepMovement(s, { ...RUN, moveY: 0 }, world, DT);
    expect(s.y).toBe(4);
    expect(Math.hypot(s.x - target.x, s.z - target.z)).toBeLessThan(1.0);
  });

  it('adds speed on a strip and ends a slide that reaches a pad', () => {
    const strip: LaunchPad = { minX: -1, maxX: 1, minZ: -8, maxZ: -5, top: 0.2, vx: 0, vy: 3, vz: -8, horizontal: 'add', bounce: 0 };
    const world = padWorld([strip]);
    const s = runner(0, 0, 0, world);
    stepMovement(s, { ...RUN, slide: true }, world, DT);
    let r = stepMovement(s, RUN, world, DT);
    for (let i = 0; i < 60 && r.launched < 0; i++) r = stepMovement(s, RUN, world, DT);
    expect(r.launched).toBe(0);
    expect(r.slideEnded).toBe(true);
    expect(s.sliding).toBe(false);
    expect(hs(s)).toBeGreaterThan(17);
    expect(s.vy).toBeCloseTo(3 - 0, 6);
  });

  it('never launches anyone standing or running beside a pad', () => {
    const tramp = trampolinePad(0, -5, 2, 2, 0.3, 5);
    const world = padWorld([tramp]);
    // Lane just past the pad's footprint (pad x ∈ [-1, 1], player radius 0.35).
    const beside = ride(world, 1.36, 0, {}, 120);
    expect(beside.launched).toBe(-1);
    const still = createMoveState(-1.4, 0, -5);
    for (let i = 0; i < 60; i++) expect(stepMovement(still, { ...RUN, moveY: 0, jump: i % 20 === 0 }, world, DT).launched).toBe(-1);
  });
});

describe('determinism and reconciliation', () => {
  // Up the stairs, across the deck, off its edge, over a trampoline, then back west.
  const tramp = trampolinePad(16, 0, 2, 2, 0.3, 4);
  const map = flatArenaMap({ pads: [tramp], boxes: [box(15, 17, 0, 0.3, -1, 1, 'pad'), ...deckWithStairs().slice(1)] });
  const world = createArenaWorld(map);
  const start = (p: PlayerSim) => Object.assign(p, { x: -16, y: 0, z: 0 });

  /** Running, strafing, slides, slide-jumps, crouching, stairs and a trampoline. */
  function stream(n: number): Command[] {
    const cmds: Command[] = [];
    for (let i = 1; i <= n; i++) {
      const t = i % 200;
      let buttons = 0;
      if (t === 40 || t === 130) buttons |= Buttons.Slide | Buttons.Crouch;
      if (t === 50 || t === 175) buttons |= Buttons.Jump;
      if (t > 150 && t < 165) buttons |= Buttons.Crouch;
      const yaw = i < 330 ? -Math.PI / 2 + Math.sin(i / 40) * 0.12 : Math.PI / 2 + Math.sin(i / 50) * 0.5;
      cmds.push(makeCommand(i, { moveX: Math.sin(i / 37) * 0.25, moveY: t < 190 ? 1 : -0.3, yaw, buttons }));
    }
    return cmds;
  }

  const run = (p: PlayerSim, cmds: Command[]) => {
    const events = { slides: 0, launches: 0 };
    for (const c of cmds) {
      const ev = applyCommand(p, c, world, false, 0);
      if (ev.slideStarted) events.slides++;
      if (ev.launched >= 0) events.launches++;
    }
    return events;
  };

  it('gives identical states for the same 600 commands', () => {
    const cmds = stream(600);
    const a = start(createPlayerSim());
    const b = start(createPlayerSim());
    const ea = run(a, cmds);
    run(b, cmds);
    expect(a).toEqual(b);
    // The stream really exercises slides and the pad.
    expect(ea.slides).toBeGreaterThanOrEqual(4);
    expect(ea.launches).toBe(1);
  });

  it('a client replaying from snapshot state ends where the authority does', () => {
    const cmds = stream(600);
    const server = start(createPlayerSim(WeaponId.Rifle));
    let worst = 0;
    let flagsMatch = true;
    for (let cut = 50; cut < 600; cut += 50) {
      run(server, cmds.slice(cut - 50, cut));
      // The snapshot of the authority at `cut`, as a client decodes it (f32 positions, cm/s velocities).
      const snap = decodeSnapshot(encodeSnapshot(cut, cut, server, encodePoses([])), 0).self!;
      expect(snap.sliding).toBe(server.sliding);
      expect(snap.slideTime).toBeCloseTo(server.slideTime, 6);
      expect(snap.slideCooldown).toBeCloseTo(server.slideCooldown, 6);
      expect(snap.slideBuffer).toBeCloseTo(server.slideBuffer, 6);
      // Replay the next 50 commands on both.
      const client = clonePlayerSim(snap);
      const ahead = clonePlayerSim(server);
      run(client, cmds.slice(cut, cut + 50));
      run(ahead, cmds.slice(cut, cut + 50));
      worst = Math.max(worst, Math.hypot(client.x - ahead.x, client.y - ahead.y, client.z - ahead.z));
      flagsMatch &&= client.sliding === ahead.sliding && client.onGround === ahead.onGround && client.crouching === ahead.crouching;
    }
    expect(worst).toBeLessThan(0.02);
    expect(flagsMatch).toBe(true);
  });
});

describe('the simulation', () => {
  it('masks to the seven defined buttons', () => {
    expect(BUTTON_MASK).toBe(0x7f);
    expect(BUTTON_MASK & Buttons.Slide).toBe(Buttons.Slide);
  });

  it('emits launch events for a trampoline on a fixture map and only from the pad', () => {
    const tramp = trampolinePad(0, -6, 2, 2, 0.3, 5);
    const sim = new ArenaSimulation(flatArenaMap({ pads: [tramp], boxes: [box(-1, 1, 0, 0.3, -7, -5, 'pad')] }), '1v1');
    const a = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    const b = sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    sim.drainEvents();
    Object.assign(a.sim, { x: 0, y: 0, z: 0, yaw: 0 });
    Object.assign(b.sim, { x: 3, y: 0, z: 0, yaw: 0 });
    const launches: ArenaEvent[] = [];
    let peak = 0;
    for (let i = 1; i <= 90; i++) {
      sim.queueCommand('a', makeCommand(i, { moveY: i < 40 ? 1 : 0 }));
      sim.queueCommand('b', makeCommand(i, { moveY: 1 }));
      sim.step();
      peak = Math.max(peak, a.sim.y);
      launches.push(...sim.drainEvents().filter((e) => e.type === 'launch'));
    }
    expect(launches[0]).toEqual({ type: 'launch', id: 'a', pad: 0 });
    expect(launches.every((e) => e.type === 'launch' && e.id === 'a')).toBe(true);
    expect(Math.abs(peak - 5.3) / 5.3).toBeLessThan(0.02);
  });

  it('clears a slide when the loadout freezes everyone', () => {
    const sim = new ArenaSimulation(flatArenaMap(), '1v1');
    const a = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    let seq = 0;
    for (let i = 0; i < 15; i++) {
      sim.queueCommand('a', makeCommand(++seq, { moveY: 1 }));
      sim.queueCommand('a', makeCommand(++seq, { moveY: 1, buttons: i === 14 ? Buttons.Slide | Buttons.Crouch : 0 }));
      sim.step();
    }
    expect(a.sim.sliding).toBe(true);
    sim.phase = 'loadout';
    sim.phaseTimer = 5;
    sim.queueCommand('a', makeCommand(++seq, { moveY: 1 }));
    sim.step();
    expect(a.sim).toMatchObject({ sliding: false, slideTime: 0, vx: 0, vz: 0 });
  });
});
