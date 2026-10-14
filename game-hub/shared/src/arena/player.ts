/**
 * Per-command player update: look, movement and the weapon state machine
 * (switching, reloading, fire rate, ammo, bloom, deterministic spread).
 *
 * `applyCommand` is the single source of truth used by the server, by
 * offline play, and by client-side prediction and replay.
 */
import { hash4, mulberry32 } from '../util/rng';
import { clamp } from '../util/math';
import { CMD_DT, MAX_HP, MOVE } from './constants';
import type { BoxWorld } from './geometry';
import { eyeHeight, type MoveState, stepMovement } from './movement';
import { WeaponId, weaponDef } from './weapons';

export const Buttons = {
  Jump: 1,
  Crouch: 2,
  Fire: 4,
  Aim: 8,
  Reload: 16,
  Melee: 32,
} as const;

/** One client input command (60 per second). */
export interface Command {
  /** Monotonic sequence number. */
  seq: number;
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Desired weapon slot 0..2, or 255 for "no change". */
  slot: number;
  /** Server tick the client was rendering other players at (lag compensation). */
  viewTick: number;
}

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
}

export interface PlayerSim extends MoveState {
  yaw: number;
  pitch: number;
  alive: boolean;
  hp: number;
  slot: number;
  weapons: [WeaponState, WeaponState, WeaponState];
  /** Seconds until the next shot is allowed. */
  cooldown: number;
  /** Remaining reload time (0 = not reloading). */
  reload: number;
  /** Remaining weapon draw time after a switch. */
  switching: number;
  bloom: number;
  aiming: boolean;
  fireHeld: boolean;
  /** Seconds of simulated time (sum of command dts). */
  clock: number;
  /** Last processed command sequence number. */
  lastSeq: number;
}

/** A fired shot: origin and one direction per pellet. */
export interface Shot {
  weapon: WeaponId;
  ox: number;
  oy: number;
  oz: number;
  dirs: [number, number, number][];
  seq: number;
  viewTick: number;
}

const snap = (t: number): number => (t < 1e-6 ? 0 : t);

export function createPlayerSim(primary: WeaponId = WeaponId.Rifle): PlayerSim {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, crouching: false,
    yaw: 0, pitch: 0, alive: true, hp: MAX_HP, slot: 0,
    weapons: [freshWeapon(primary), freshWeapon(WeaponId.Pistol), freshWeapon(WeaponId.Blade)],
    cooldown: 0, reload: 0, switching: 0, bloom: 0, aiming: false, fireHeld: false, clock: 0, lastSeq: 0,
  };
}

export function freshWeapon(id: WeaponId): WeaponState {
  const d = weaponDef(id);
  return { id, mag: d.magazine, reserve: d.reserve };
}

export function clonePlayerSim(p: PlayerSim): PlayerSim {
  return { ...p, weapons: [{ ...p.weapons[0] }, { ...p.weapons[1] }, { ...p.weapons[2] }] };
}

export function currentWeapon(p: PlayerSim): WeaponState {
  return p.weapons[p.slot];
}

/** Current spread cone half-angle for the held weapon. */
export function currentSpread(p: PlayerSim): number {
  const d = weaponDef(currentWeapon(p).id);
  const speed = Math.hypot(p.vx, p.vz) / MOVE.walkSpeed;
  let s = d.spread * (p.aiming ? d.aimSpreadMul : 1) + p.bloom + d.moveSpread * Math.min(1, speed) + (p.onGround ? 0 : d.airSpread);
  if (p.crouching) s *= 0.8;
  return s;
}

export function eyePosition(p: PlayerSim): [number, number, number] {
  return [p.x, p.y + eyeHeight(p.crouching), p.z];
}

/** Forward unit vector for yaw/pitch (yaw 0 looks toward -Z). */
export function viewDir(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** Rotates `dir` by a random offset inside a cone, deterministically from `rnd`. */
function spreadDir(dir: [number, number, number], cone: number, rnd: () => number): [number, number, number] {
  if (cone <= 0) return dir;
  const [fx, fy, fz] = dir;
  // Orthonormal basis around the forward vector.
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-6) {
    rx = 1;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const a = cone * Math.sqrt(rnd());
  const phi = rnd() * Math.PI * 2;
  const s = Math.tan(a);
  const ox = Math.cos(phi) * s;
  const oy = Math.sin(phi) * s;
  const x = fx + rx * ox + ux * oy;
  const y = fy + ry * ox + uy * oy;
  const z = fz + rz * ox + uz * oy;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

export interface CommandEvents {
  shot: Shot | null;
  reloadStarted: boolean;
  reloadDone: boolean;
  switched: boolean;
  jumped: boolean;
  landed: number;
  dryFire: boolean;
}

/**
 * Applies one command to a player.
 * @param frozen players can look but not move or shoot (loadout phase)
 * @param playerIndex stable small integer used to seed spread
 */
export function applyCommand(p: PlayerSim, cmd: Command, world: BoxWorld, frozen: boolean, playerIndex: number): CommandEvents {
  const dt = CMD_DT;
  const ev: CommandEvents = { shot: null, reloadStarted: false, reloadDone: false, switched: false, jumped: false, landed: 0, dryFire: false };
  p.lastSeq = cmd.seq;
  p.clock += dt;
  if (!Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.pitch)) return ev;
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -1.5, 1.5);
  if (!p.alive) return ev;

  const b = cmd.buttons;
  // ---- timers -------------------------------------------------------------------------
  // Timers snap to zero within a microsecond so 0.1 s = exactly 6 commands despite float error.
  p.cooldown = snap(p.cooldown - dt);
  p.switching = snap(p.switching - dt);
  const def0 = weaponDef(currentWeapon(p).id);
  p.bloom = Math.max(0, p.bloom - def0.bloomRecovery * dt);
  if (p.reload > 0) {
    p.reload = snap(p.reload - dt);
    if (p.reload <= 0) {
      p.reload = 0;
      const w = currentWeapon(p);
      const need = def0.magazine - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take;
      w.reserve -= take;
      ev.reloadDone = true;
    }
  }

  // ---- weapon switching (melee button = quick switch to blade) ----------------------------
  let wantSlot = cmd.slot <= 2 ? cmd.slot : p.slot;
  if (b & Buttons.Melee) wantSlot = 2;
  if (wantSlot !== p.slot && !frozen) {
    p.slot = wantSlot;
    p.reload = 0;
    p.switching = weaponDef(currentWeapon(p).id).drawTime;
    p.bloom = 0;
    ev.switched = true;
  }
  const w = currentWeapon(p);
  const def = weaponDef(w.id);
  p.aiming = (b & Buttons.Aim) !== 0 && p.switching === 0 && !frozen;

  // ---- movement -----------------------------------------------------------------------------
  if (!frozen) {
    const mv = stepMovement(
      p,
      {
        moveX: clamp(cmd.moveX, -1, 1),
        moveY: clamp(cmd.moveY, -1, 1),
        yaw: p.yaw,
        jump: (b & Buttons.Jump) !== 0,
        crouch: (b & Buttons.Crouch) !== 0,
        speedMul: p.aiming ? def.aimMoveMul : def.moveMul,
      },
      world,
      dt,
    );
    ev.jumped = mv.jumped;
    ev.landed = mv.landed ? mv.impact : 0;
  } else {
    p.vx = p.vz = 0;
  }

  // ---- reload ---------------------------------------------------------------------------------
  const fire = (b & Buttons.Fire) !== 0 && !frozen;
  const canReload = def.magazine > 0 && w.mag < def.magazine && w.reserve > 0 && p.reload === 0 && p.switching === 0;
  if (canReload && ((b & Buttons.Reload) !== 0 || (fire && w.mag === 0))) {
    p.reload = def.reloadTime;
    p.aiming = false;
    ev.reloadStarted = true;
  }

  // ---- fire -----------------------------------------------------------------------------------
  const trigger = fire && (def.automatic || !p.fireHeld);
  if (trigger && p.cooldown <= 0 && p.switching <= 0 && p.reload <= 0) {
    if (def.magazine > 0 && w.mag <= 0) {
      if (!p.fireHeld) ev.dryFire = true;
    } else {
      if (def.magazine > 0) w.mag--;
      p.cooldown = def.interval;
      const cone = currentSpread(p);
      const [ox, oy, oz] = eyePosition(p);
      const forward = viewDir(p.yaw, p.pitch);
      const rnd = mulberry32(hash4(playerIndex, cmd.seq, w.id, 0x5eed));
      const dirs: [number, number, number][] = [];
      for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(forward, cone, rnd));
      p.bloom = Math.min(def.bloomMax, p.bloom + def.bloom);
      ev.shot = { weapon: w.id, ox, oy, oz, dirs, seq: cmd.seq, viewTick: cmd.viewTick };
    }
  }
  p.fireHeld = fire;
  return ev;
}

/** Resets a player for a new round at a spawn point. */
export function respawnPlayer(p: PlayerSim, x: number, y: number, z: number, yaw: number, primary: WeaponId): void {
  Object.assign(p, createPlayerSim(primary), { x, y, z, yaw, pitch: 0, clock: p.clock, lastSeq: p.lastSeq });
}
