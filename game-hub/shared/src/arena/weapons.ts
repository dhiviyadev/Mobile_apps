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
// Wire ids reserved for the weapons package (append only, never renumber): Smg 5, Crossbow 6,
// BurstRifle 7, Marksman 8, Lmg 9, HandCannon 10, MachinePistol 11.

export type FireMode = 'auto' | 'semi' | 'burst';
export type WeaponKind = 'hitscan' | 'projectile' | 'melee';
export type ReloadKind = 'mag' | 'shell';
export type WeaponClass = 'rifle' | 'smg' | 'shotgun' | 'sniper' | 'crossbow' | 'lmg' | 'marksman' | 'pistol' | 'melee';

/** Flight of a projectile weapon's bolt. */
export interface ProjectileSpec {
  /** Launch speed (m/s). */
  speed: number;
  /** Downward acceleration (m/s²). */
  gravity: number;
  /** Collision radius (m). */
  radius: number;
  /** Seconds before it expires in the air. */
  life: number;
}

export interface MeleeSpec {
  rays: number;
  /** Total horizontal arc (rad). */
  fan: number;
}

/** How bots use a weapon (the bots consume these numbers). */
export interface BotWeaponProfile {
  /** Metres the bot tries to hold. */
  prefRange: number;
  /** Fires only when dist < range × engageMul. */
  engageMul: number;
  /** Base aim error tolerance (rad)... */
  tolerance: number;
  /** ...plus distTol / max(4, dist). */
  distTol: number;
  /** Seconds of ADS before firing (0 = never ADS). */
  scopeFirst: number;
}

export interface WeaponDef {
  id: WeaponId;
  /** Stable kebab-case key (test ids, settings). */
  key: string;
  name: string;
  short: string;
  /** One line for the loadout card. */
  blurb: string;
  slot: 0 | 1 | 2; // primary, secondary, melee
  cls: WeaponClass;
  kind: WeaponKind;
  fireMode: FireMode;
  /** Derived: fireMode !== 'semi' (holding fire keeps shooting). */
  automatic: boolean;
  /** Burst weapons: rounds per burst and seconds between them (0 otherwise). */
  burstCount: number;
  burstInterval: number;
  damage: number;
  headMultiplier: number;
  /** Seconds between shots. */
  interval: number;
  magazine: number;
  reserve: number;
  reloadKind: ReloadKind;
  reloadTime: number;
  /** Shell reloads: seconds per shell (0 for magazine reloads). */
  shellTime: number;
  pellets: number;
  /** Cone half-angle (radians) when standing still, hip-fire. */
  spread: number;
  /** Multiplier on spread when fully aimed down sights. */
  aimSpreadMul: number;
  /** Seconds to aim down sights (0 = instant). */
  adsTime: number;
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
  /** Auto-shoot / aim-assist range (m). */
  autoRange: number;
  projectile: ProjectileSpec | null;
  melee: MeleeSpec | null;
  bot: BotWeaponProfile;
}

const W: WeaponDef[] = [
  {
    id: WeaponId.Rifle, key: 'assault-rifle', name: 'Rifle', short: 'RFL', blurb: '', slot: 0, cls: 'rifle', kind: 'hitscan', fireMode: 'auto', automatic: true,
    burstCount: 0, burstInterval: 0, damage: 24, headMultiplier: 1.8, interval: 0.1,
    magazine: 30, reserve: 90, reloadKind: 'mag', reloadTime: 2.1, shellTime: 0, pellets: 1, spread: 0.022, aimSpreadMul: 0.3, adsTime: 0, moveSpread: 0.035, airSpread: 0.1,
    bloom: 0.006, bloomMax: 0.04, bloomRecovery: 0.12, recoil: 0.011, recoilYaw: 0.004, range: 120, falloffStart: 30, falloffMin: 0.7,
    aimFov: 55, moveMul: 0.95, aimMoveMul: 0.6, drawTime: 0.45, autoRange: 100, projectile: null, melee: null,
    bot: { prefRange: 14, engageMul: 0.7, tolerance: 0.07, distTol: 0.6, scopeFirst: 0 },
  },
  {
    id: WeaponId.Shotgun, key: 'shotgun', name: 'Scattergun', short: 'SCT', blurb: '', slot: 0, cls: 'shotgun', kind: 'hitscan', fireMode: 'auto', automatic: true,
    burstCount: 0, burstInterval: 0, damage: 14, headMultiplier: 1.4, interval: 0.85,
    magazine: 6, reserve: 24, reloadKind: 'mag', reloadTime: 2.5, shellTime: 0, pellets: 9, spread: 0.075, aimSpreadMul: 0.8, adsTime: 0, moveSpread: 0.015, airSpread: 0.03,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.06, recoilYaw: 0.01, range: 30, falloffStart: 7, falloffMin: 0.25,
    aimFov: 65, moveMul: 0.95, aimMoveMul: 0.7, drawTime: 0.5, autoRange: 18, projectile: null, melee: null,
    bot: { prefRange: 5, engageMul: 0.45, tolerance: 0.12, distTol: 0, scopeFirst: 0 },
  },
  {
    id: WeaponId.Sniper, key: 'sniper-rifle', name: 'Longshot', short: 'LNG', blurb: '', slot: 0, cls: 'sniper', kind: 'hitscan', fireMode: 'semi', automatic: false,
    burstCount: 0, burstInterval: 0, damage: 90, headMultiplier: 1.7, interval: 1.25,
    magazine: 5, reserve: 15, reloadKind: 'mag', reloadTime: 2.9, shellTime: 0, pellets: 1, spread: 0.06, aimSpreadMul: 0, adsTime: 0, moveSpread: 0.08, airSpread: 0.2,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.07, recoilYaw: 0.006, range: 250, falloffStart: 250, falloffMin: 1,
    aimFov: 22, moveMul: 0.88, aimMoveMul: 0.45, drawTime: 0.6, autoRange: 300, projectile: null, melee: null,
    bot: { prefRange: 24, engageMul: 0.9, tolerance: 0.03, distTol: 0, scopeFirst: 0.35 },
  },
  {
    id: WeaponId.Pistol, key: 'pistol', name: 'Sidearm', short: 'SDA', blurb: '', slot: 1, cls: 'pistol', kind: 'hitscan', fireMode: 'semi', automatic: false,
    burstCount: 0, burstInterval: 0, damage: 26, headMultiplier: 1.9, interval: 0.2,
    magazine: 12, reserve: 48, reloadKind: 'mag', reloadTime: 1.4, shellTime: 0, pellets: 1, spread: 0.018, aimSpreadMul: 0.45, adsTime: 0, moveSpread: 0.02, airSpread: 0.06,
    bloom: 0.012, bloomMax: 0.04, bloomRecovery: 0.2, recoil: 0.02, recoilYaw: 0.004, range: 80, falloffStart: 20, falloffMin: 0.6,
    aimFov: 62, moveMul: 1, aimMoveMul: 0.75, drawTime: 0.3, autoRange: 60, projectile: null, melee: null,
    bot: { prefRange: 10, engageMul: 0.6, tolerance: 0.06, distTol: 0.5, scopeFirst: 0 },
  },
  {
    id: WeaponId.Blade, key: 'combat-knife', name: 'Blade', short: 'BLD', blurb: '', slot: 2, cls: 'melee', kind: 'melee', fireMode: 'auto', automatic: true,
    burstCount: 0, burstInterval: 0, damage: 55, headMultiplier: 1, interval: 0.6,
    magazine: 0, reserve: 0, reloadKind: 'mag', reloadTime: 0, shellTime: 0, pellets: 1, spread: 0, aimSpreadMul: 1, adsTime: 0, moveSpread: 0, airSpread: 0,
    bloom: 0, bloomMax: 0, bloomRecovery: 1, recoil: 0.015, recoilYaw: 0.02, range: 2.3, falloffStart: 3, falloffMin: 1,
    aimFov: 72, moveMul: 1.12, aimMoveMul: 1.12, drawTime: 0.25, autoRange: 2.4, projectile: null, melee: null,
    bot: { prefRange: 1.2, engageMul: 1, tolerance: 0.3, distTol: 0, scopeFirst: 0 },
  },
];

export const WEAPONS: readonly WeaponDef[] = W;
export const PRIMARY_WEAPONS: readonly WeaponId[] = [WeaponId.Rifle, WeaponId.Shotgun, WeaponId.Sniper];
export const SECONDARY_WEAPONS: readonly WeaponId[] = [WeaponId.Pistol];
export const MELEE_WEAPONS: readonly WeaponId[] = [WeaponId.Blade];
export const DEFAULT_PRIMARY = WeaponId.Rifle;
export const DEFAULT_SECONDARY = WeaponId.Pistol;
export const MELEE_WEAPON = WeaponId.Blade;

export const weaponDef = (id: number): WeaponDef => W[id] ?? W[0];
export const isWeaponId = (id: unknown): id is WeaponId => typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < W.length;
export const isPrimary = (id: unknown): id is WeaponId => isWeaponId(id) && W[id].slot === 0;
export const isSecondary = (id: unknown): id is WeaponId => isWeaponId(id) && W[id].slot === 1;

/** Bot loadout. Uniform primary (one rnd draw), default secondary; the weapons package weights it. */
export function pickBotLoadout(rnd: () => number): { primary: WeaponId; secondary: WeaponId } {
  return { primary: PRIMARY_WEAPONS[Math.floor(rnd() * PRIMARY_WEAPONS.length)], secondary: DEFAULT_SECONDARY };
}
