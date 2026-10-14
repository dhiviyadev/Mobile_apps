/**
 * Low-poly weapon models built from boxes (original designs), used for the
 * first-person viewmodel. Each model is one merged geometry with vertex colours.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WeaponId } from '@hub/shared';

type Part = [w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx?: number];

const DARK = 0x2b2f3a;
const MID = 0x4a5160;
const LIGHT = 0x8a93a6;
const ORANGE = 0xff7a45;
const TEAL = 0x2fd3c8;
const STEEL = 0xd8dde8;

/** Parts in metres; the muzzle points toward -Z. */
const MODELS: Record<WeaponId, Part[]> = {
  [WeaponId.Rifle]: [
    [0.07, 0.11, 0.42, 0, 0, 0, DARK],
    [0.035, 0.035, 0.3, 0, 0.02, -0.34, MID],
    [0.06, 0.15, 0.07, 0, -0.11, -0.04, MID, 0.25],
    [0.06, 0.09, 0.2, 0, -0.01, 0.28, DARK],
    [0.05, 0.05, 0.12, 0, 0.08, -0.02, LIGHT],
    [0.072, 0.02, 0.3, 0, 0.035, -0.08, ORANGE],
    [0.05, 0.11, 0.05, 0, -0.1, 0.12, DARK, -0.2],
  ],
  [WeaponId.Shotgun]: [
    [0.09, 0.12, 0.36, 0, 0, 0.02, DARK],
    [0.05, 0.05, 0.42, 0, 0.03, -0.36, MID],
    [0.07, 0.06, 0.18, 0, -0.04, -0.3, LIGHT],
    [0.07, 0.1, 0.22, 0, -0.03, 0.3, 0x6b4a30],
    [0.092, 0.025, 0.2, 0, 0.065, 0, TEAL],
    [0.05, 0.11, 0.05, 0, -0.1, 0.1, DARK, -0.2],
  ],
  [WeaponId.Sniper]: [
    [0.07, 0.1, 0.5, 0, 0, 0.05, DARK],
    [0.03, 0.03, 0.5, 0, 0.02, -0.45, MID],
    [0.06, 0.06, 0.28, 0, 0.1, -0.02, DARK],
    [0.065, 0.065, 0.02, 0, 0.1, -0.16, TEAL],
    [0.065, 0.11, 0.24, 0, -0.02, 0.36, MID],
    [0.072, 0.02, 0.4, 0, -0.045, 0.02, ORANGE],
    [0.05, 0.11, 0.05, 0, -0.1, 0.14, DARK, -0.2],
  ],
  [WeaponId.Pistol]: [
    [0.06, 0.08, 0.24, 0, 0.02, -0.04, DARK],
    [0.055, 0.14, 0.07, 0, -0.08, 0.05, MID, -0.25],
    [0.062, 0.02, 0.2, 0, 0.065, -0.05, ORANGE],
    [0.03, 0.03, 0.06, 0, 0.03, -0.18, LIGHT],
  ],
  [WeaponId.Blade]: [
    [0.035, 0.035, 0.14, 0, 0, 0.08, DARK],
    [0.07, 0.025, 0.03, 0, 0, 0, ORANGE],
    [0.012, 0.05, 0.32, 0, 0.005, -0.16, STEEL],
    [0.014, 0.012, 0.3, 0, 0.03, -0.15, 0xffffff],
  ],
};

/** Where muzzle flashes appear, per weapon (model space). */
export const MUZZLE: Record<WeaponId, [number, number, number]> = {
  [WeaponId.Rifle]: [0, 0.02, -0.5],
  [WeaponId.Shotgun]: [0, 0.03, -0.58],
  [WeaponId.Sniper]: [0, 0.02, -0.71],
  [WeaponId.Pistol]: [0, 0.03, -0.22],
  [WeaponId.Blade]: [0, 0, -0.3],
};

export function buildWeaponGeometry(id: WeaponId): THREE.BufferGeometry {
  const parts = MODELS[id].map(([w, h, d, x, y, z, color, rx]) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  return mergeGeometries(parts)!;
}
