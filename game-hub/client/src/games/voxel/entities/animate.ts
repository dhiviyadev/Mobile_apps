/**
 * Procedural animation (design-voxel-mobs §11.4): joint rotations by part
 * role and the current action, plus root motion (bob, hop, tilt, death roll,
 * burrowing).
 */
import { MobAction, MobKind } from '@hub/shared';
import type { CompiledModel } from './models';

export interface AnimState {
  kind: MobKind;
  /** Seconds (client clock). */
  t: number;
  /** Walk cycle radians. */
  phase: number;
  /** 0..1: horizontal speed relative to a brisk walk. */
  k: number;
  action: MobAction;
  /** Seconds since the action (re)started, and its 0..1 progress. */
  actionT: number;
  progress: number;
  /** Head yaw relative to the body, head pitch. */
  headYaw: number;
  headPitch: number;
  onGround: boolean;
  inWater: boolean;
  /** Seconds since death (−1 alive). */
  deathT: number;
  /** 0..1 recent-hurt tilt. */
  hurt: number;
  /** Bosses: phase 3 (faster halo, glowing blade). */
  enraged: boolean;
  phase2: boolean;
  /** Fast motion (panic, swoop). */
  fast: boolean;
}

export interface Pose {
  /** Animated rotation added to each part's rest rotation (radians, xyz). */
  rot: Float32Array;
  /** Joint offset added to each part (blocks). */
  pos: Float32Array;
  /** Uniform scale per part. */
  scale: Float32Array;
  /** Root extras: y offset, pitch, roll, uniform scale, alpha. */
  rootY: number;
  rootPitch: number;
  rootRoll: number;
  emissiveBoost: number;
}

export function createPose(n: number): Pose {
  return { rot: new Float32Array(n * 3), pos: new Float32Array(n * 3), scale: new Float32Array(n).fill(1), rootY: 0, rootPitch: 0, rootRoll: 0, emissiveBoost: 0 };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function animate(model: CompiledModel, s: AnimState, out: Pose): void {
  const parts = model.parts;
  out.rot.fill(0);
  out.pos.fill(0);
  out.scale.fill(1);
  out.rootY = 0;
  out.rootPitch = 0;
  out.rootRoll = 0;
  out.emissiveBoost = 0;
  const { t, phase, k } = s;
  const sin = Math.sin(phase);
  const biped = !!model.def.biped;
  const a = s.action;
  const attacking = a === MobAction.Attack || a === MobAction.Cast || a === MobAction.Slam || a === MobAction.Summon || a === MobAction.Draw || a === MobAction.Charge;
  // Windup (raise) over the first 75% of the action, strike in the rest.
  const p = s.progress;
  const strike = attacking ? (p < 0.75 ? -1.6 * (p / 0.75) : -1.6 + 2.0 * ((p - 0.75) / 0.25)) : 0;

  for (let i = 0; i < parts.length; i++) {
    const role = parts[i].role;
    if (!role) continue;
    const r = i * 3;
    const idx = parts[i].index ?? 0;
    switch (role) {
      case 'legA':
      case 'legB': {
        const sgn = role === 'legA' ? 1 : -1;
        if (s.kind === MobKind.Cragcrawler) {
          out.rot[r + 1] = sgn * sin * 0.4 * k;
          out.rot[r + 2] += Math.max(0, sgn * sin) * 0.3 * k * (parts[i].anchor === 'l' ? -1 : 1);
        } else if (s.kind === MobKind.Hopling) {
          out.rot[r] = s.onGround ? 0 : -0.7;
        } else if (s.kind === MobKind.Cluckit && !s.onGround) {
          out.rot[r] = -0.6;
        } else out.rot[r] = sgn * sin * (biped ? 0.7 : 0.6) * k;
        break;
      }
      case 'armL':
      case 'armR': {
        const sgn = role === 'armL' ? 1 : -1;
        let x = -sgn * sin * 0.5 * k;
        if (s.kind === MobKind.Mudlurch) x -= 0.3;
        if (attacking) x = s.kind === MobKind.Rattlebow ? (role === 'armL' ? -1.5 : -1.4 + (a === MobAction.Draw ? 0 : 0.3)) : strike;
        if (a === MobAction.Summon) x = -2.6;
        if (a === MobAction.Roar) x = -0.8 + Math.sin(t * 14) * 0.15;
        if (a === MobAction.Stunned) x = 0.3 + Math.sin(t * 3 + sgn) * 0.15;
        if (s.kind === MobKind.RimeWarden) x = attacking ? strike * 0.8 : -0.25 + Math.sin(t * 1.5 + sgn) * 0.12;
        out.rot[r] = x;
        if (s.kind === MobKind.Rattlebow && attacking && role === 'armR') out.rot[r + 1] = 0.5;
        break;
      }
      case 'arm2L':
      case 'arm2R': {
        const sgn = role === 'arm2L' ? 1 : -1;
        out.rot[r] = a === MobAction.Summon || a === MobAction.Cast ? -2.4 : Math.sin(t * 1.2 + sgn) * 0.15 - 0.2;
        out.rot[r + 2] = sgn * 0.15;
        break;
      }
      case 'head':
        out.rot[r + 1] = clamp(s.headYaw, -1, 1);
        out.rot[r] = clamp(s.headPitch, -0.8, 0.8);
        if (a === MobAction.Graze) out.rot[r] = -0.9 + Math.sin(t * 9) * 0.06;
        if (s.kind === MobKind.Thornmaw) out.rot[r] = 0;
        break;
      case 'neck':
        out.rot[r] = a === MobAction.Graze ? -0.7 : clamp(s.headPitch, -0.8, 0.8) * 0.5;
        break;
      case 'ear':
        out.rot[r] = s.fast ? 0.6 : 0.4 * k;
        break;
      case 'tail':
        if (s.kind === MobKind.Glimmerfin) out.rot[r + 1] = Math.sin(t * 8 + phase) * 0.5;
        else if (s.kind === MobKind.Cluckit && s.fast) out.rot[r] = -0.6;
        else out.rot[r + 1] = Math.sin(t * 3) * 0.3;
        break;
      case 'wingL':
      case 'wingR': {
        const sgn = role === 'wingL' ? 1 : -1;
        if (s.kind === MobKind.Cluckit) {
          const flap = !s.onGround || s.fast;
          out.rot[r + 2] = flap ? sgn * (0.4 + Math.sin(t * 10 * Math.PI * 2) * 0.6) : 0;
        } else {
          const f = s.fast || a === MobAction.Swoop ? 14 : 8;
          out.rot[r + 2] = sgn * (0.2 + Math.sin(t * f * 2 * Math.PI * 0.25) * 0.9) * -1;
        }
        break;
      }
      case 'finL':
      case 'finR':
        out.rot[r + 2] = (role === 'finL' ? 1 : -1) * Math.sin(t * 6) * 0.4;
        break;
      case 'jaw':
        out.rot[r] = attacking ? 0.5 : 0;
        if (s.kind === MobKind.Cragcrawler) out.rot[r + 1] = (parts[i].at[0] < 0 ? 1 : -1) * (attacking ? 0.4 : Math.sin(t * 6) * 0.1);
        break;
      case 'jawTop':
        out.rot[r] = attacking || a === MobAction.Roar ? 0.3 + 0.6 * Math.min(1, s.actionT * 3) : 0.3 + Math.sin(t * 1.4) * 0.08;
        break;
      case 'cap':
        if (a === MobAction.Inflate) {
          out.scale[i] = 1 + 0.45 * p;
          out.emissiveBoost = 0.5 + 0.5 * Math.sin(t * (4 + 8 * p) * Math.PI * 2);
        }
        break;
      case 'halo': {
        const speed = s.enraged ? 3.2 : 0.8;
        const ang = t * speed + (idx * Math.PI * 2) / 8;
        out.pos[r] = Math.cos(ang) * 0.9;
        out.pos[r + 1] = Math.sin(ang) * 0.9;
        out.rot[r + 2] = ang;
        break;
      }
      case 'orbit': {
        const ang = t * 1.5 + (idx * Math.PI) / 2;
        out.pos[r] = Math.cos(ang) * 1.0;
        out.pos[r + 2] = Math.sin(ang) * 1.0;
        out.pos[r + 1] = Math.sin(t * 2 + idx) * 0.1;
        out.rot[r + 1] = -ang;
        break;
      }
      case 'stem':
        out.rot[r + 2] = Math.sin(t * 1.3 + i) * 0.05;
        break;
      case 'leaf': {
        out.rot[r + 1] = (idx * Math.PI) / 3;
        const lift = a === MobAction.Burrow || a === MobAction.Emerge ? 0.6 : 0;
        out.rot[r] = lift + Math.sin(t * 1.1 + idx) * 0.05;
        break;
      }
      case 'vineL':
      case 'vineR': {
        const sgn = role === 'vineL' ? 1 : -1;
        out.rot[r] = Math.sin(t * 2 + idx * 0.7) * 0.25;
        if (a === MobAction.Attack && idx === 0) out.rot[r + 1] = sgn * (1.2 - 2.4 * p);
        if (a === MobAction.Slam && idx === 0) out.rot[r] = -0.9 + 1.6 * p;
        break;
      }
      case 'cape':
        out.rot[r] = 0.1 + Math.min(0.6, k * 0.5) + Math.sin(t * 4) * 0.05;
        break;
      case 'bowstring':
        out.pos[r + 2] = a === MobAction.Draw ? 0.12 * p : 0;
        break;
      case 'weapon':
        if (attacking && (s.kind === MobKind.AshenKnight || s.kind === MobKind.AnvilheartColossus)) out.rot[r] = -0.6 * (1 - p);
        break;
      case 'spin':
        out.rot[r] = t * 9;
        out.rot[r + 1] = t * 7;
        break;
      default:
        break;
    }
  }
  if (s.phase2 && (s.kind === MobKind.AshenKnight || s.kind === MobKind.AnvilheartColossus || s.kind === MobKind.BrineclawMatriarch)) out.emissiveBoost = Math.max(out.emissiveBoost, 0.6);

  // ---- root motion ----
  if (biped) out.rootY = Math.abs(sin) * 0.05 * k;
  if (s.kind === MobKind.Hopling && !s.onGround) out.rootPitch = 0.25;
  if (s.kind === MobKind.Duskwing || s.kind === MobKind.RimeWarden || s.kind === MobKind.Stormtalon) out.rootY = Math.sin(t * 2.2) * 0.08;
  if (s.kind === MobKind.Glimmerfin) out.rootRoll = Math.sin(t * 3) * 0.08;
  if (a === MobAction.Stunned) {
    out.rootPitch = 0.3;
    out.rootRoll = Math.sin(t * 3) * 0.15;
  }
  if (a === MobAction.Charge && s.kind === MobKind.SunforgedSentinel) out.rootRoll = 0; // spin is applied by the renderer's yaw
  if (a === MobAction.Burrow) out.rootY = -3 * Math.min(1, p * 1.2);
  if (a === MobAction.Emerge) out.rootY = -3 * Math.max(0, 1 - s.actionT * 2);
  if (a === MobAction.Inflate) out.rootY += Math.sin(t * 30) * 0.02 * p;
  out.rootPitch += -s.hurt * 0.15;
  if (s.deathT >= 0) {
    out.rootRoll = Math.min(1, s.deathT / 0.4) * (Math.PI / 2);
    out.rootY -= Math.min(0.2, s.deathT * 0.5);
  }
}
