/**
 * Weapon definitions. All values are in SI units (metres, seconds, radians).
 * Names are generic on purpose; models and sounds are original.
 */

export enum WeaponId {
  Rifle = 0,
  Shotgun = 1,
  Sniper = 2,
  Pistol = 3,
  Blade = 4,
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  short: string;
  slot: 0 | 1 | 2; // primary, secondary, melee
  damage: number;
  headMultiplier: number;
  /** Seconds between shots. */
  interval: number;
  /** Holding fire keeps shooting. */
  automatic: boolean;
  magazine: number;
  reserve: number;
  reloadTime: number;
  pellets: number;
  /** Cone half-angle (radians) when standing still, hip-fire. */
  spread: number;
  /** Multiplier on spread when aiming down sights. */
  aimSpreadMul: number;
  /** Extra spread when moving at full speed / airborne. */
  moveSpread: number;
  airSpread: number;
  /** Extra spread added per shot (bloom), its cap, and recovery per second. */
  bloom: number;
  bloomMax: number;
  bloomRecovery: number;
  /** Camera kick per shot (radians) applied on the client. */
  recoil: number;
  recoilYaw: number;
  range: number;
  /** Damage starts falling off at this distance, reaching `falloffMin` × damage at `range`. */
  falloffStart: number;
  falloffMin: number;
  /** Field of view when aiming (degrees). */
  aimFov: number;
  /** Movement speed multiplier while holding / aiming this weapon. */
  moveMul: number;
  aimMoveMul: number;
  drawTime: number;
}

const W: WeaponDef[] = [
  {
    id: WeaponId.Rifle, name: 'Rifle', short: 'RFL', slot: 0, damage: 24, headMultiplier: 1.8, interval: 0.1, automatic: true,
    magazine: 30, reserve: 90, reloadTime: 2.1, pellets: 1, spread: 0.022, aimSpreadMul: 0.3, moveSpread: 0.035, airSpread: 0.1,
    bloom: 0.006, bloomMax: 0.04, bloomRecovery: 0.12, recoil: 0.011, recoilYaw: 0.004, range: 120, falloffStart: 30, falloffMin: 0.7,
    aimFov: 55, moveMul: 0.95, aimMoveMul: 0.6, drawTime: 0.45,
  },
  {
    id: WeaponId.Shotgun, name: 'Scattergun', short: 'SCT', slot: 0, damage: 14, headMultiplier: 1.4, interval: 0.85, automatic: true,
    magazine: 6, reserve: 24, reloadTime: 2.5, pellets: 9, spread: 0.075, aimSpreadMul: 0.8, moveSpread: 0.015, airSpread: 0.03,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.06, recoilYaw: 0.01, range: 30, falloffStart: 7, falloffMin: 0.25,
    aimFov: 65, moveMul: 0.95, aimMoveMul: 0.7, drawTime: 0.5,
  },
  {
    id: WeaponId.Sniper, name: 'Longshot', short: 'LNG', slot: 0, damage: 90, headMultiplier: 1.7, interval: 1.25, automatic: false,
    magazine: 5, reserve: 15, reloadTime: 2.9, pellets: 1, spread: 0.06, aimSpreadMul: 0, moveSpread: 0.08, airSpread: 0.2,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.07, recoilYaw: 0.006, range: 250, falloffStart: 250, falloffMin: 1,
    aimFov: 22, moveMul: 0.88, aimMoveMul: 0.45, drawTime: 0.6,
  },
  {
    id: WeaponId.Pistol, name: 'Sidearm', short: 'SDA', slot: 1, damage: 26, headMultiplier: 1.9, interval: 0.2, automatic: false,
    magazine: 12, reserve: 48, reloadTime: 1.4, pellets: 1, spread: 0.018, aimSpreadMul: 0.45, moveSpread: 0.02, airSpread: 0.06,
    bloom: 0.012, bloomMax: 0.04, bloomRecovery: 0.2, recoil: 0.02, recoilYaw: 0.004, range: 80, falloffStart: 20, falloffMin: 0.6,
    aimFov: 62, moveMul: 1, aimMoveMul: 0.75, drawTime: 0.3,
  },
  {
    id: WeaponId.Blade, name: 'Blade', short: 'BLD', slot: 2, damage: 55, headMultiplier: 1, interval: 0.6, automatic: true,
    magazine: 0, reserve: 0, reloadTime: 0, pellets: 1, spread: 0, aimSpreadMul: 1, moveSpread: 0, airSpread: 0,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.015, recoilYaw: 0.02, range: 2.3, falloffStart: 3, falloffMin: 1,
    aimFov: 72, moveMul: 1.12, aimMoveMul: 1.12, drawTime: 0.25,
  },
];

export const WEAPONS: readonly WeaponDef[] = W;
export const PRIMARY_WEAPONS = [WeaponId.Rifle, WeaponId.Shotgun, WeaponId.Sniper] as const;
export const weaponDef = (id: WeaponId): WeaponDef => W[id] ?? W[0];
export const isPrimary = (id: number): id is WeaponId => id === WeaponId.Rifle || id === WeaponId.Shotgun || id === WeaponId.Sniper;
