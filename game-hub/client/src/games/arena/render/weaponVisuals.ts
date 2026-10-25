/**
 * How each weapon looks, sounds and moves when it fires (design-arena-weapons §9.3/§9.4): tracer, muzzle
 * flash, casings, which part cycles, the reload animation, viewmodel kick and the camera recoil pattern,
 * crosshair, sight and the fire-mode tag on the HUD.
 */
import { WeaponId } from '@hub/shared';
import type { SfxName } from '../../../core/audio/sfx';
import type { CrosshairStyle, FireModeTag } from '../ui/ArenaHud';

export type FlashStyle = 'star' | 'brake' | 'small' | 'wide';
export type EjectKind = 'rifle' | 'pistol' | 'shell' | 'none';
export type ActionKind = 'carrier' | 'slide' | 'pump' | 'bolt' | 'cylinder' | 'string' | 'none';
export type ReloadAnim = 'mag' | 'box' | 'shell' | 'bolt' | 'cylinder' | 'crossbow' | 'none';
export type OpticKind = 'iron' | 'reddot' | 'holo' | 'optic2x' | 'scope' | 'ring' | 'none';

export interface RecoilVisual {
  /** Viewmodel kick back (m), up (rad), roll (rad), and how fast it settles (1/s). */
  back: number;
  up: number;
  roll: number;
  recover: number;
  /** Camera yaw pattern for shot i of a spray: recoilYaw · A · sin(i·w + phi). */
  A: number;
  w: number;
  phi: number;
}

export interface WeaponVisual {
  sound: SfxName;
  tracer: { color: number; width: number; life: number } | null;
  flash: { size: number; style: FlashStyle; color: number } | null;
  eject: EjectKind;
  /** Seconds after the shot the casing flies. */
  ejectDelay: number;
  action: ActionKind;
  reloadAnim: ReloadAnim;
  recoil: RecoilVisual;
  crosshair: CrosshairStyle;
  optic: OpticKind;
  mode: FireModeTag;
  /** Viewmodel position from the hip (camera space, m). */
  hip: [number, number, number];
}

const R = (back: number, up: number, roll: number, recover: number, A = 1, w = 0.5, phi = 0): RecoilVisual => ({ back, up, roll, recover, A, w, phi });
const RIFLE_HIP: [number, number, number] = [0.135, -0.135, -0.4];
const PISTOL_HIP: [number, number, number] = [0.12, -0.12, -0.34];

export const WEAPON_VISUALS: Record<WeaponId, WeaponVisual> = {
  [WeaponId.Rifle]: {
    sound: 'ar_shot', tracer: { color: 0xffe7a8, width: 1, life: 0.09 }, flash: { size: 0.5, style: 'star', color: 0xffd090 },
    eject: 'rifle', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'mag', recoil: R(0.03, 0.1, 0.02, 9, 2.5, 0.55, 0.3),
    crosshair: 'cross', optic: 'reddot', mode: 'AUTO', hip: RIFLE_HIP,
  },
  [WeaponId.Shotgun]: {
    sound: 'shotgun', tracer: { color: 0xffd9a0, width: 0.6, life: 0.07 }, flash: { size: 0.85, style: 'wide', color: 0xffc070 },
    eject: 'shell', ejectDelay: 0.3, action: 'pump', reloadAnim: 'shell', recoil: R(0.07, 0.3, 0.05, 5),
    crosshair: 'ring', optic: 'iron', mode: 'PUMP', hip: [0.13, -0.13, -0.38],
  },
  [WeaponId.Sniper]: {
    sound: 'sniper', tracer: { color: 0xd8fbff, width: 1.6, life: 0.18 }, flash: { size: 0.8, style: 'brake', color: 0xffd8a0 },
    eject: 'rifle', ejectDelay: 0.55, action: 'bolt', reloadAnim: 'bolt', recoil: R(0.08, 0.35, 0.04, 4),
    crosshair: 'dot', optic: 'scope', mode: 'BOLT', hip: [0.13, -0.13, -0.36],
  },
  [WeaponId.Pistol]: {
    sound: 'pistol', tracer: { color: 0xffe7a8, width: 0.9, life: 0.08 }, flash: { size: 0.35, style: 'small', color: 0xffd090 },
    eject: 'pistol', ejectDelay: 0.01, action: 'slide', reloadAnim: 'mag', recoil: R(0.03, 0.2, 0.03, 10),
    crosshair: 'cross', optic: 'iron', mode: 'SEMI', hip: PISTOL_HIP,
  },
  [WeaponId.Blade]: {
    sound: 'melee', tracer: null, flash: null, eject: 'none', ejectDelay: 0, action: 'none', reloadAnim: 'none', recoil: R(0, 0, 0, 10),
    crosshair: 'dot', optic: 'none', mode: '', hip: [0.13, -0.13, -0.3],
  },
  [WeaponId.Smg]: {
    sound: 'smg_shot', tracer: { color: 0xffefc0, width: 0.8, life: 0.07 }, flash: { size: 0.35, style: 'small', color: 0xffd8a0 },
    eject: 'pistol', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'mag', recoil: R(0.02, 0.06, 0.03, 14, 3, 0.9, 1.1),
    crosshair: 'cross', optic: 'iron', mode: 'AUTO', hip: [0.13, -0.13, -0.37],
  },
  [WeaponId.Crossbow]: {
    sound: 'xbow_shot', tracer: null, flash: null, eject: 'none', ejectDelay: 0, action: 'string', reloadAnim: 'crossbow', recoil: R(0.04, 0.12, 0.02, 6),
    crosshair: 'chevron', optic: 'ring', mode: '', hip: [0.13, -0.14, -0.4],
  },
  [WeaponId.BurstRifle]: {
    sound: 'burst_shot', tracer: { color: 0xffe0a0, width: 1, life: 0.09 }, flash: { size: 0.45, style: 'star', color: 0xffd090 },
    eject: 'rifle', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'mag', recoil: R(0.028, 0.09, 0.015, 10, 1.5, 0.7, 0.2),
    crosshair: 'cross', optic: 'holo', mode: 'BURST', hip: [0.13, -0.13, -0.36],
  },
  [WeaponId.Marksman]: {
    sound: 'dmr_shot', tracer: { color: 0xfff0d0, width: 1.2, life: 0.12 }, flash: { size: 0.6, style: 'brake', color: 0xffd090 },
    eject: 'rifle', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'mag', recoil: R(0.05, 0.18, 0.02, 6),
    crosshair: 'cross', optic: 'optic2x', mode: 'SEMI', hip: RIFLE_HIP,
  },
  [WeaponId.Lmg]: {
    sound: 'lmg_shot', tracer: { color: 0xffb36b, width: 1.1, life: 0.1 }, flash: { size: 0.55, style: 'star', color: 0xffc080 },
    eject: 'rifle', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'box', recoil: R(0.03, 0.08, 0.03, 10, 3.5, 0.4, 2),
    crosshair: 'cross', optic: 'iron', mode: 'AUTO', hip: [0.14, -0.14, -0.4],
  },
  [WeaponId.HandCannon]: {
    sound: 'hc_shot', tracer: { color: 0xffd6a0, width: 1.3, life: 0.1 }, flash: { size: 0.65, style: 'wide', color: 0xffc070 },
    eject: 'none', ejectDelay: 0, action: 'cylinder', reloadAnim: 'cylinder', recoil: R(0.06, 0.45, 0.05, 5),
    crosshair: 'cross', optic: 'iron', mode: 'SEMI', hip: PISTOL_HIP,
  },
  [WeaponId.MachinePistol]: {
    sound: 'mp_shot', tracer: { color: 0xffefc0, width: 0.7, life: 0.06 }, flash: { size: 0.3, style: 'small', color: 0xffd8a0 },
    eject: 'pistol', ejectDelay: 0.01, action: 'carrier', reloadAnim: 'mag', recoil: R(0.02, 0.08, 0.04, 14, 3.5, 1.1, 0.5),
    crosshair: 'cross', optic: 'iron', mode: 'AUTO', hip: PISTOL_HIP,
  },
};
