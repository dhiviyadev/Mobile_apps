/**
 * Per-command player update: look, movement and the weapon state machine
 * (switching, reloading, fire rate, ammo, bloom, deterministic spread).
 *
 * `applyCommand` is the single source of truth used by the server, by
 * offline play, and by client-side prediction and replay. It runs fixed
 * sections in a fixed order (see applyCommand); each section is its own
 * function so the movement and weapon code can evolve separately.
 */
import { hash4, mulberry32 } from '../util/rng';
import { clamp, lerp } from '../util/math';
import { CMD_DT, MAX_HP, MOVE } from './constants';
import type { BoxWorld } from './geometry';
import { createMoveState, eyeHeight, type MoveState, stepMovement } from './movement';
import { type MeleeSpec, WeaponId, weaponDef } from './weapons';

export const Buttons = {
  Jump: 1,
  Crouch: 2,
  Fire: 4,
  Aim: 8,
  Reload: 16,
  Melee: 32,
  /** Edge-triggered: set on one command per crouch press; the sim buffers it for SLIDE.buffer. */
  Slide: 64,
} as const;

/** Every defined button bit; the server masks incoming commands with it. */
export const BUTTON_MASK = Object.values(Buttons).reduce((a, b) => a | b, 0); // 0x7f

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
  /** ADS progress 0..1 (spread, FOV, viewmodel). */
  ads: number;
  /** Rounds left in the current burst (burst weapons). */
  burstLeft: number;
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

export function createPlayerSim(primary: WeaponId = WeaponId.Rifle, secondary: WeaponId = WeaponId.Pistol): PlayerSim {
  return {
    ...createMoveState(),
    yaw: 0, pitch: 0, alive: true, hp: MAX_HP, slot: 0,
    weapons: [freshWeapon(primary), freshWeapon(secondary), freshWeapon(WeaponId.Blade)],
    cooldown: 0, reload: 0, switching: 0, bloom: 0, aiming: false, fireHeld: false, ads: 0, burstLeft: 0, clock: 0, lastSeq: 0,
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
  let s = d.spread * lerp(1, d.aimSpreadMul, p.ads) + p.bloom + d.moveSpread * Math.min(1, speed) + (p.onGround ? 0 : d.airSpread);
  if (p.crouching && !p.sliding) s *= 0.8;
  return s;
}

export function eyePosition(p: PlayerSim): [number, number, number] {
  return [p.x, p.y + eyeHeight(p.crouching, p.sliding), p.z];
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
  /** Shotgun: one shell inserted this command. */
  shellLoaded: boolean;
  /** Shell reload interrupted by a fresh trigger press. */
  reloadCancelled: boolean;
  switched: boolean;
  jumped: boolean;
  landed: number;
  dryFire: boolean;
  slideStarted: boolean;
  slideEnded: boolean;
  /** Pad index that launched the player this command, or -1. */
  launched: number;
}

/**
 * Applies one command to a player.
 * @param frozen players can look but not move or shoot (loadout, vote and match-end phases)
 * @param playerIndex stable small integer used to seed spread
 */
export function applyCommand(p: PlayerSim, cmd: Command, world: BoxWorld, frozen: boolean, playerIndex: number): CommandEvents {
  const dt = CMD_DT;
  const ev: CommandEvents = {
    shot: null, reloadStarted: false, reloadDone: false, shellLoaded: false, reloadCancelled: false,
    switched: false, jumped: false, landed: 0, dryFire: false, slideStarted: false, slideEnded: false, launched: -1,
  };
  p.lastSeq = cmd.seq;
  p.clock += dt;
  if (!Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.pitch)) return ev;
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -1.5, 1.5);
  if (!p.alive) return ev;
  // Fixed order: aiming is decided before movement (it sets the speed), ADS ramps from the
  // final aiming state after movement (sliding cancels it), and the trigger comes last.
  stepWeaponTimers(p, dt, ev);
  stepWeaponSwitch(p, cmd, frozen, ev);
  stepAim(p, cmd.buttons, frozen);
  applyMove(p, cmd, world, frozen, dt, ev);
  stepAds(p, dt);
  stepTrigger(p, cmd, frozen, playerIndex, ev);
  return ev;
}

/* ==== weapon state machine ============================================================= */

/** Cooldown, draw, bloom recovery and reload completion (a whole magazine, or one shell). */
function stepWeaponTimers(p: PlayerSim, dt: number, ev: CommandEvents): void {
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
      if (def0.reloadKind === 'shell') {
        if (w.reserve > 0 && w.mag < def0.magazine) {
          w.mag++;
          w.reserve--;
          ev.shellLoaded = true;
        }
        // The next shell goes straight in; the reload ends when the tube is full or the reserve is empty.
        if (w.mag < def0.magazine && w.reserve > 0) p.reload = def0.shellTime;
        else ev.reloadDone = true;
      } else {
        const take = Math.min(def0.magazine - w.mag, w.reserve);
        w.mag += take;
        w.reserve -= take;
        ev.reloadDone = true;
      }
    }
  }
}

/** Slot changes (melee button = quick switch to the blade). A switch cancels reloads, bursts and ADS. */
function stepWeaponSwitch(p: PlayerSim, cmd: Command, frozen: boolean, ev: CommandEvents): void {
  let wantSlot = cmd.slot <= 2 ? cmd.slot : p.slot;
  if (cmd.buttons & Buttons.Melee) wantSlot = 2;
  if (wantSlot !== p.slot && !frozen) {
    p.slot = wantSlot;
    p.reload = 0;
    p.switching = weaponDef(currentWeapon(p).id).drawTime;
    p.bloom = 0;
    p.burstLeft = 0;
    p.ads = 0;
    ev.switched = true;
  }
}

/** Aiming: not while drawing, reloading or sliding (`p.sliding` is the previous command's); melee never aims. */
function stepAim(p: PlayerSim, b: number, frozen: boolean): void {
  p.aiming =
    (b & Buttons.Aim) !== 0 && p.switching === 0 && p.reload === 0 && weaponDef(currentWeapon(p).id).kind !== 'melee' && !frozen && !p.sliding;
}

/** ADS progress ramps in over def.adsTime (out 30% faster), so there are no instant scoped shots. */
function stepAds(p: PlayerSim, dt: number): void {
  const t = weaponDef(currentWeapon(p).id).adsTime;
  if (p.aiming) p.ads = t > 0 ? Math.min(1, p.ads + dt / t) : 1;
  else p.ads = t > 0 ? Math.max(0, p.ads - dt / (t * 0.7)) : 0;
}

/** The knife's rays: evenly spread over the fan at the view pitch, centre ray first (auto-shoot reuses it). */
export function meleeFan(yaw: number, pitch: number, spec: MeleeSpec): [number, number, number][] {
  const offsets: number[] = [];
  for (let i = 0; i < spec.rays; i++) offsets.push(spec.rays > 1 ? (i / (spec.rays - 1) - 0.5) * spec.fan : 0);
  offsets.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  return offsets.map((off) => viewDir(yaw + off, pitch));
}

/**
 * The trigger: shell-reload interrupt, reload start (button, fire on empty, or automatic on an empty
 * magazine), then fire rate, bursts, ammo, bloom and deterministic spread (or the melee fan).
 */
function stepTrigger(p: PlayerSim, cmd: Command, frozen: boolean, playerIndex: number, ev: CommandEvents): void {
  const b = cmd.buttons;
  const w = currentWeapon(p);
  const def = weaponDef(w.id);
  const fire = (b & Buttons.Fire) !== 0 && !frozen;

  // ---- reload ---------------------------------------------------------------------------------
  // A fresh trigger press with shells loaded stops a shell reload so the shotgun can fire.
  if (p.reload > 0 && def.reloadKind === 'shell' && fire && !p.fireHeld && w.mag > 0) {
    p.reload = 0;
    ev.reloadCancelled = true;
  }
  const canReload = def.magazine > 0 && w.mag < def.magazine && w.reserve > 0 && p.reload === 0 && p.switching === 0;
  const autoReload = def.magazine > 0 && w.mag === 0 && p.cooldown <= 0 && p.burstLeft === 0;
  if (canReload && ((b & Buttons.Reload) !== 0 || (fire && w.mag === 0) || autoReload)) {
    p.reload = def.reloadTime;
    p.aiming = false;
    p.burstLeft = 0;
    ev.reloadStarted = true;
  }

  // ---- fire -----------------------------------------------------------------------------------
  // Automatic and burst weapons repeat while held; a started burst finishes on its own.
  const continuing = p.burstLeft > 0;
  const trigger = fire && (def.fireMode !== 'semi' || !p.fireHeld);
  if ((trigger || continuing) && !frozen && p.cooldown <= 0 && p.switching <= 0 && p.reload <= 0) {
    if (def.magazine > 0 && w.mag <= 0) {
      if (!p.fireHeld && !continuing) ev.dryFire = true;
      p.burstLeft = 0;
    } else {
      if (def.magazine > 0) w.mag--;
      if (def.fireMode === 'burst') {
        p.burstLeft = continuing ? p.burstLeft - 1 : def.burstCount - 1;
        p.cooldown = p.burstLeft > 0 ? def.burstInterval : def.interval;
      } else p.cooldown = def.interval;
      const [ox, oy, oz] = eyePosition(p);
      let dirs: [number, number, number][];
      if (def.melee) dirs = meleeFan(p.yaw, p.pitch, def.melee);
      else {
        const cone = currentSpread(p);
        const forward = viewDir(p.yaw, p.pitch);
        const rnd = mulberry32(hash4(playerIndex, cmd.seq, w.id, 0x5eed));
        dirs = [];
        for (let i = 0; i < def.pellets; i++) dirs.push(spreadDir(forward, cone, rnd));
      }
      p.bloom = Math.min(def.bloomMax, p.bloom + def.bloom);
      ev.shot = { weapon: w.id, ox, oy, oz, dirs, seq: cmd.seq, viewTick: cmd.viewTick };
    }
  } else if (frozen) p.burstLeft = 0;
  p.fireHeld = fire;
}

/* ==== movement ============================================================================ */

/** Movement for one command; weapon speed from the aiming state. Frozen players stand still. */
function applyMove(p: PlayerSim, cmd: Command, world: BoxWorld, frozen: boolean, dt: number, ev: CommandEvents): void {
  if (frozen) {
    p.vx = p.vz = 0;
    p.sliding = false;
    p.slideTime = 0;
    p.slideBuffer = 0;
    return;
  }
  const b = cmd.buttons;
  const def = weaponDef(currentWeapon(p).id);
  const mv = stepMovement(
    p,
    {
      moveX: clamp(cmd.moveX, -1, 1),
      moveY: clamp(cmd.moveY, -1, 1),
      yaw: p.yaw,
      jump: (b & Buttons.Jump) !== 0,
      crouch: (b & Buttons.Crouch) !== 0,
      slide: (b & Buttons.Slide) !== 0,
      speedMul: p.aiming ? def.aimMoveMul : def.moveMul,
    },
    world,
    dt,
  );
  ev.jumped = mv.jumped;
  ev.landed = mv.landed ? mv.impact : 0;
  ev.slideStarted = mv.slideStarted;
  ev.slideEnded = mv.slideEnded;
  ev.launched = mv.launched;
  if (p.sliding) p.aiming = false; // hip-fire only while sliding
}

/** Resets a player for a new round at a spawn point. */
export function respawnPlayer(p: PlayerSim, x: number, y: number, z: number, yaw: number, primary: WeaponId, secondary: WeaponId = WeaponId.Pistol): void {
  Object.assign(p, createPlayerSim(primary, secondary), { x, y, z, yaw, pitch: 0, clock: p.clock, lastSeq: p.lastSeq });
}
