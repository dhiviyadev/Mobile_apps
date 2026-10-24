/**
 * Arena player movement: acceleration-based running, crouch, jump, gravity,
 * step-up for stairs, snapping down when walking off small steps, slides
 * (crouch while running) and launch pads (trampolines, launchers, speed strips).
 *
 * Shared by the server (authoritative), the client (prediction/replay) and
 * bots, so all three move identically for the same inputs.
 *
 * The envelope (speeds, jump, slide, pads) is design-arena-movement §2–§4,
 * ported from the prototype the maps were validated against; see MOVE.
 */
import type { Vec3 } from '../util/math';
import { CMD_DT, MOVE, PAD, PLAYER, SLIDE } from './constants';
import type { BoxWorld, LaunchPad } from './geometry';

export interface MoveState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  crouching: boolean;
  /** Slide in progress (crouch hitbox, slide eye). */
  sliding: boolean;
  /** Seconds since the slide started (0 when not sliding). */
  slideTime: number;
  /** Seconds until another slide may start (set to SLIDE.cooldown at slide start). */
  slideCooldown: number;
  /** Seconds a slide request stays queued. */
  slideBuffer: number;
}

export interface ArenaMoveInput {
  moveX: number;
  moveY: number;
  yaw: number;
  jump: boolean;
  crouch: boolean;
  /** Edge-triggered slide request (Buttons.Slide). */
  slide?: boolean;
  /** Weapon / aiming speed multiplier. */
  speedMul: number;
}

export interface MoveResult {
  jumped: boolean;
  landed: boolean;
  /** Downward speed at landing (for sounds / effects). */
  impact: number;
  slideStarted: boolean;
  slideEnded: boolean;
  /** Index into world.pads of the pad that launched us this step, or -1. */
  launched: number;
}

const R = PLAYER.radius;
const EPS = 1e-4;
/** Slide steering per command, computed once. */
const TURN_COS = Math.cos(SLIDE.turnRate * CMD_DT);
const TURN_SIN = Math.sin(SLIDE.turnRate * CMD_DT);

/** Timers snap to zero within a microsecond, like the weapon timers in player.ts. */
const snap = (t: number): number => (t < 1e-6 ? 0 : t);

export function createMoveState(x = 0, y = 0, z = 0): MoveState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: true, crouching: false, sliding: false, slideTime: 0, slideCooldown: 0, slideBuffer: 0 };
}

export const bodyHeight = (crouching: boolean): number => (crouching ? PLAYER.crouchHeight : PLAYER.height);
export const eyeHeight = (crouching: boolean, sliding = false): number => (sliding ? PLAYER.slideEye : crouching ? PLAYER.crouchEye : PLAYER.eye);

function blocked(world: BoxWorld, x: number, y: number, z: number, h: number): boolean {
  return world.overlaps(x - R + EPS, y + EPS, z - R + EPS, x + R - EPS, y + h - EPS, z + R - EPS);
}

function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) return [tx, tz];
  return [vx + (dx / d) * maxDelta, vz + (dz / d) * maxDelta];
}

/** Rescales the horizontal velocity to length `speed` (no-op when standing still). */
function setHorizontalSpeed(s: MoveState, speed: number): void {
  const cur = Math.hypot(s.vx, s.vz);
  if (cur < 1e-9) return;
  s.vx *= speed / cur;
  s.vz *= speed / cur;
}

function endSlide(s: MoveState): void {
  // The cooldown was already set when the slide started.
  s.sliding = false;
  s.slideTime = 0;
}

/** Same test the sim uses (the client shows the Slide icon with it): grounded, fast enough, not backwards. */
export function canStartSlide(s: MoveState, yaw: number): boolean {
  if (!s.onGround || s.sliding || s.slideCooldown > 0) return false;
  const sp = Math.hypot(s.vx, s.vz);
  if (sp < SLIDE.minStartSpeed) return false;
  return (s.vx * -Math.sin(yaw) + s.vz * -Math.cos(yaw)) / sp >= SLIDE.minForwardDot;
}

export function stepMovement(s: MoveState, input: ArenaMoveInput, world: BoxWorld, dt: number): MoveResult {
  const result: MoveResult = { jumped: false, landed: false, impact: 0, slideStarted: false, slideEnded: false, launched: -1 };

  // ---- slide timers and request buffer ---------------------------------------------
  s.slideCooldown = snap(Math.max(0, s.slideCooldown - dt));
  s.slideBuffer = snap(Math.max(0, s.slideBuffer - dt));
  if (input.slide === true) s.slideBuffer = SLIDE.buffer;

  // ---- wish direction ------------------------------------------------------------------
  let mx = input.moveX;
  let my = input.moveY;
  const ml0 = Math.hypot(mx, my);
  if (ml0 > 1) {
    mx /= ml0;
    my /= ml0;
  }
  const ml = Math.min(1, ml0);
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // forward = (-sin, -cos), right = (cos, -sin)
  const wx = mx * cos - my * sin;
  const wz = -mx * sin - my * cos;

  // ---- slide start (before friction, so landing speed is kept) ----------------------------
  if (s.slideBuffer > 0 && canStartSlide(s, input.yaw)) {
    const sp = Math.hypot(s.vx, s.vz);
    setHorizontalSpeed(s, Math.max(sp, Math.min(sp + SLIDE.boost, SLIDE.boostCap * input.speedMul)));
    s.sliding = true;
    s.slideTime = 0;
    s.slideCooldown = SLIDE.cooldown;
    s.slideBuffer = 0;
    result.slideStarted = true;
  }

  // ---- crouch: sliding forces it; otherwise stand up only if there is headroom ------------
  if (s.sliding || input.crouch) s.crouching = true;
  else if (s.crouching && !blocked(world, s.x, s.y, s.z, PLAYER.height)) s.crouching = false;
  const h = bodyHeight(s.crouching);

  // ---- horizontal velocity --------------------------------------------------------
  if (s.sliding) {
    let sp = Math.hypot(s.vx, s.vz);
    let dx = sp > 0 ? s.vx / sp : 0;
    let dz = sp > 0 ? s.vz / sp : 0;
    if (ml > 0.1) {
      const ux = wx / ml;
      const uz = wz / ml;
      const dot = dx * ux + dz * uz;
      const cross = dx * uz - dz * ux;
      if (dot < -0.5) {
        // Pulling back brakes.
        sp = Math.max(0, sp - SLIDE.brake * dt);
      } else if (dot >= TURN_COS) {
        // Within one step of the stick direction: snap to it.
        dx = ux;
        dz = uz;
      } else {
        // Turn toward the stick at the slide's turn rate.
        const sg = cross >= 0 ? 1 : -1;
        const ndx = dx * TURN_COS - dz * TURN_SIN * sg;
        const ndz = dx * TURN_SIN * sg + dz * TURN_COS;
        dx = ndx;
        dz = ndz;
      }
    }
    sp = Math.max(0, sp - SLIDE.decel * dt);
    s.vx = dx * sp;
    s.vz = dz * sp;
  } else {
    const speed = (s.crouching ? MOVE.crouchSpeed : MOVE.walkSpeed) * input.speedMul;
    if (s.onGround) {
      const cur = Math.hypot(s.vx, s.vz);
      const target = speed * ml;
      let rate: number = ml > 0.01 ? MOVE.groundAccel : MOVE.groundDecel;
      // Faster than the target and still pushing the same way (after a slide or launch): bleed off gently.
      if (ml > 0.01 && cur > target + 0.05 && (s.vx * wx + s.vz * wz) / (cur * ml) > 0.7) {
        rate = Math.max(MOVE.overspeedDecel, (cur - target) * MOVE.overspeedDamping);
      }
      [s.vx, s.vz] = approach2(s.vx, s.vz, wx * speed, wz * speed, rate * dt);
    } else if (ml > 0.01) {
      // Air control steers but never removes momentum on purpose (slide-jumps, launcher arcs).
      const cur = Math.hypot(s.vx, s.vz);
      const cap = Math.max(speed * ml, cur);
      [s.vx, s.vz] = approach2(s.vx, s.vz, (wx / ml) * cap, (wz / ml) * cap, MOVE.airAccel * dt);
    }
  }

  // ---- vertical ---------------------------------------------------------------------
  if (input.jump && s.onGround) {
    s.vy = MOVE.jumpVelocity;
    s.onGround = false;
    result.jumped = true;
    if (s.sliding) {
      // Slide-jump: keep the momentum, up to a cap.
      endSlide(s);
      result.slideEnded = true;
      if (Math.hypot(s.vx, s.vz) > SLIDE.jumpMaxSpeed) setHorizontalSpeed(s, SLIDE.jumpMaxSpeed);
    }
  }
  s.vy = Math.max(-MOVE.maxFallSpeed, s.vy - MOVE.gravity * dt);

  const wasOnGround = s.onGround;
  const y0 = s.y;

  // ---- horizontal move with step-up -----------------------------------------------
  const moveAxis = (axis: 'x' | 'z', delta: number) => {
    if (delta === 0) return;
    const nx = axis === 'x' ? s.x + delta : s.x;
    const nz = axis === 'z' ? s.z + delta : s.z;
    if (!blocked(world, nx, s.y, nz, h)) {
      s.x = nx;
      s.z = nz;
      return;
    }
    // Try stepping up onto a low obstacle (stairs, kerbs).
    if (wasOnGround || s.vy <= 0) {
      const top = world.highestTop(nx - R + EPS, nz - R + EPS, nx + R - EPS, nz + R - EPS, s.y + EPS, s.y + MOVE.stepHeight + EPS);
      if (top > -Infinity && !blocked(world, nx, top, nz, h)) {
        s.x = nx;
        s.z = nz;
        s.y = top;
        return;
      }
    }
    if (axis === 'x') s.vx = 0;
    else s.vz = 0;
  };
  moveAxis('x', s.vx * dt);
  moveAxis('z', s.vz * dt);

  // ---- vertical move ----------------------------------------------------------------
  const ny = s.y + s.vy * dt;
  if (s.vy <= 0) {
    // Land on the highest surface we would pass through.
    const top = world.highestTop(s.x - R + EPS, s.z - R + EPS, s.x + R - EPS, s.z + R - EPS, ny - EPS, s.y + EPS);
    if (top > -Infinity) {
      if (!wasOnGround) {
        result.landed = true;
        result.impact = -s.vy;
      }
      s.y = top;
      s.vy = 0;
      s.onGround = true;
    } else {
      s.y = ny;
      s.onGround = false;
      // Walking down stairs: stick to the ground instead of hopping off each step.
      if (wasOnGround && !result.jumped) {
        const below = world.highestTop(s.x - R + EPS, s.z - R + EPS, s.x + R - EPS, s.z + R - EPS, s.y - MOVE.stepHeight, s.y);
        if (below > -Infinity) {
          s.y = below;
          s.vy = 0;
          s.onGround = true;
        }
      }
    }
  } else {
    if (blocked(world, s.x, ny, s.z, h)) s.vy = 0; // head bump
    else s.y = ny;
    s.onGround = false;
  }

  // ---- slide upkeep -------------------------------------------------------------------
  if (s.sliding) {
    if (!s.onGround) {
      // Slid off a ledge: keep the velocity, stop sliding.
      endSlide(s);
      result.slideEnded = true;
    } else {
      // Stairs: stepping up (+dy) costs speed, snapping down (−dy) gains it.
      const dy = s.y - y0;
      let sp = Math.hypot(s.vx, s.vz);
      if (dy !== 0 && sp > 0) {
        sp = Math.min(SLIDE.maxSpeed, Math.sqrt(Math.max(0, sp * sp - 2 * MOVE.gravity * dy * SLIDE.slopeGain)));
        setHorizontalSpeed(s, sp);
      }
      s.slideTime += dt;
      // slideTime travels as f32 in snapshots; the tolerance keeps replays ending on the same command.
      if (s.slideTime >= SLIDE.maxTime - 1e-6 || Math.hypot(s.vx, s.vz) < SLIDE.endSpeed) {
        endSlide(s);
        result.slideEnded = true;
      }
    }
  }

  // ---- launch pads: grounded on a pad top → launch ------------------------------------------
  if (s.onGround && world.pads.length) {
    const i = world.padAt(s.x, s.y, s.z, R);
    if (i >= 0) {
      applyLaunch(s, world.pads[i], input.jump, result.landed ? result.impact : 0);
      if (s.sliding) {
        endSlide(s);
        result.slideEnded = true;
      }
      result.launched = i;
      result.landed = false;
    }
  }

  // ---- safety clamp ------------------------------------------------------------------
  if (Math.hypot(s.vx, s.vz) > MOVE.maxHorizontalSpeed) setHorizontalSpeed(s, MOVE.maxHorizontalSpeed);
  return result;
}

/** Launches a player standing on `pad`. Applied by stepMovement; exported for tests. */
export function applyLaunch(s: MoveState, pad: LaunchPad, jumpHeld: boolean, impact: number): void {
  let vy = pad.vy;
  // Falling from higher bounces higher.
  if (pad.bounce > 0) vy = Math.max(vy, impact * pad.bounce);
  // Trampolines only: launchers stay aimed.
  if (jumpHeld && pad.horizontal === 'keep') vy *= PAD.jumpBonus;
  s.vy = Math.min(vy, PAD.maxVy);
  if (pad.horizontal === 'set') {
    s.vx = pad.vx;
    s.vz = pad.vz;
  } else if (pad.horizontal === 'add') {
    s.vx += pad.vx;
    s.vz += pad.vz;
  }
  s.onGround = false;
}

// ---- pad builders (the maps use these) ----------------------------------------------------

/** Launch vy whose discrete (60 Hz semi-implicit) apex is exactly `height` above the pad top. */
export function launchVelocityForHeight(height: number): number {
  const g = MOVE.gravity;
  const dt = CMD_DT;
  return g * (dt / 2 + Math.sqrt((dt * dt) / 4 + (2 * Math.max(0, height)) / g));
}

/**
 * Ballistic velocity from `from` (pad top centre) to land on `to`, peaking `apex` m above from.y.
 * apex is clamped to ≥ (to.y − from.y) + 0.5. Flight time comes from stepping the sim's integrator.
 */
export function aimLaunch(from: Vec3, to: Vec3, apex: number): { vx: number; vy: number; vz: number; flightTime: number } {
  const a = Math.max(apex, to.y - from.y + 0.5);
  const vy = launchVelocityForHeight(a);
  let y = from.y;
  let v = vy;
  let n = 0;
  for (;;) {
    v = Math.max(-MOVE.maxFallSpeed, v - MOVE.gravity * CMD_DT);
    const ny = y + v * CMD_DT;
    n++;
    if (v <= 0 && ny <= to.y) break;
    y = ny;
    if (n > 2000) break;
  }
  const T = n * CMD_DT;
  return { vx: (to.x - from.x) / T, vy, vz: (to.z - from.z) / T, flightTime: T };
}

/** Trampoline: centre (x, z), size w × d, walkable top y; bounces `height` m up. */
export function trampolinePad(x: number, z: number, w: number, d: number, top: number, height: number, bounce = 0.85): LaunchPad {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top, vx: 0, vy: launchVelocityForHeight(height), vz: 0, horizontal: 'keep', bounce };
}

/** Launcher: throws the player from the pad centre onto `target`, peaking `apex` m above the pad. */
export function launcherPad(x: number, z: number, w: number, d: number, top: number, target: Vec3, apex: number): LaunchPad {
  const L = aimLaunch({ x, y: top, z }, target, apex);
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top, vx: L.vx, vy: L.vy, vz: L.vz, horizontal: 'set', bounce: 0 };
}

/** Speed strip: adds `speed` toward `dirYaw` (and a small hop). */
export function boostPad(x: number, z: number, w: number, d: number, top: number, dirYaw: number, speed: number, vy = 3): LaunchPad {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top, vx: -Math.sin(dirYaw) * speed, vy, vz: -Math.cos(dirYaw) * speed, horizontal: 'add', bounce: 0 };
}
