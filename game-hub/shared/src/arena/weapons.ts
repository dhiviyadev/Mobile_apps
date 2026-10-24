/**
 * Weapon definitions. All values are in SI units (metres, seconds, radians).
 * Names are generic on purpose; models and sounds are original.
 */

export enum WeaponId {
  // Values AND member names 0-4 are unchanged (wire ids, snapshot bytes, schema `primary`).
  Rifle = 0,
  Shotgun = 1,
  Sniper = 2,
  Pistol = 3,
  Blade = 4,
  // Appended by the weapons upgrade; append only, never renumber.
  Smg = 5,
  Crossbow = 6,
  BurstRifle = 7,
  Marksman = 8,
  Lmg = 9,
  HandCannon = 10,
  MachinePistol = 11,
}
export const WEAPON_COUNT = 12;

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

/** Fire intervals and reload times are whole 60 Hz commands (a command subtracts 1/60 s). */
const cmds = (n: number): number => n / 60;

type Stats = Omit<WeaponDef, 'automatic' | 'burstCount' | 'burstInterval' | 'shellTime' | 'projectile' | 'melee' | 'reloadKind' | 'pellets'> &
  Partial<Pick<WeaponDef, 'burstCount' | 'burstInterval' | 'shellTime' | 'projectile' | 'melee' | 'reloadKind' | 'pellets'>>;

function def(s: Stats): WeaponDef {
  return {
    burstCount: 0, burstInterval: 0, shellTime: 0, projectile: null, melee: null, reloadKind: 'mag', pellets: 1,
    ...s,
    automatic: s.fireMode !== 'semi',
  };
}

// design-arena-weapons §1.2. Automatic and burst weapons kill in 0.40-0.53 s (body, 10 m) and differ in
// handling; the Sniper Rifle, Crossbow and Hand Cannon are the one-shot-headshot weapons beyond shotgun range.
const W: WeaponDef[] = [
  def({
    id: WeaponId.Rifle, key: 'assault-rifle', name: 'Assault Rifle', short: 'AR', slot: 0, cls: 'rifle', kind: 'hitscan', fireMode: 'auto',
    blurb: 'Full-auto all-rounder with a red-dot sight. Strong at mid range.',
    damage: 22, headMultiplier: 1.75, interval: cmds(6), magazine: 30, reserve: 90, reloadTime: cmds(120),
    spread: 0.018, aimSpreadMul: 0.3, adsTime: 0.2, moveSpread: 0.03, airSpread: 0.09, bloom: 0.005, bloomMax: 0.035, bloomRecovery: 0.12,
    recoil: 0.01, recoilYaw: 0.004, range: 140, falloffStart: 35, falloffMin: 0.7, aimFov: 55, moveMul: 0.95, aimMoveMul: 0.6, drawTime: 0.45, autoRange: 100,
    bot: { prefRange: 14, engageMul: 0.7, tolerance: 0.07, distTol: 0.6, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Shotgun, key: 'shotgun', name: 'Shotgun', short: 'SG', slot: 0, cls: 'shotgun', kind: 'hitscan', fireMode: 'auto',
    blurb: 'Nine pellets per pump. One shot up close; hold to keep pumping.',
    // Shell by shell: the first shell takes reloadTime, every further one shellTime.
    damage: 12, headMultiplier: 1.5, interval: cmds(48), magazine: 6, reserve: 24, reloadKind: 'shell', reloadTime: cmds(33), shellTime: cmds(27), pellets: 9,
    spread: 0.07, aimSpreadMul: 0.8, adsTime: 0.2, moveSpread: 0.015, airSpread: 0.03, bloom: 0, bloomMax: 0, bloomRecovery: 1,
    recoil: 0.06, recoilYaw: 0.01, range: 35, falloffStart: 8, falloffMin: 0.2, aimFov: 65, moveMul: 0.95, aimMoveMul: 0.7, drawTime: 0.5, autoRange: 18,
    bot: { prefRange: 5, engageMul: 0.45, tolerance: 0.12, distTol: 0, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Sniper, key: 'sniper-rifle', name: 'Sniper Rifle', short: 'SR', slot: 0, cls: 'sniper', kind: 'hitscan', fireMode: 'semi',
    blurb: 'Bolt action with a 4× scope. Scope in fully before you fire; headshots always kill.',
    damage: 90, headMultiplier: 1.7, interval: cmds(75), magazine: 5, reserve: 15, reloadTime: cmds(174),
    spread: 0.06, aimSpreadMul: 0, adsTime: 0.32, moveSpread: 0.08, airSpread: 0.2, bloom: 0, bloomMax: 0, bloomRecovery: 1,
    recoil: 0.07, recoilYaw: 0.006, range: 300, falloffStart: 300, falloffMin: 1, aimFov: 22, moveMul: 0.88, aimMoveMul: 0.45, drawTime: 0.6, autoRange: 300,
    bot: { prefRange: 24, engageMul: 0.9, tolerance: 0.03, distTol: 0, scopeFirst: 0.35 },
  }),
  def({
    id: WeaponId.Pistol, key: 'pistol', name: 'Pistol', short: 'PST', slot: 1, cls: 'pistol', kind: 'hitscan', fireMode: 'semi',
    blurb: 'Reliable semi-auto sidearm.',
    damage: 25, headMultiplier: 2, interval: cmds(9), magazine: 12, reserve: 48, reloadTime: cmds(78),
    spread: 0.015, aimSpreadMul: 0.45, adsTime: 0.12, moveSpread: 0.02, airSpread: 0.06, bloom: 0.012, bloomMax: 0.04, bloomRecovery: 0.2,
    recoil: 0.018, recoilYaw: 0.004, range: 90, falloffStart: 22, falloffMin: 0.6, aimFov: 62, moveMul: 1, aimMoveMul: 0.8, drawTime: 0.3, autoRange: 60,
    bot: { prefRange: 10, engageMul: 0.6, tolerance: 0.06, distTol: 0.5, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Blade, key: 'combat-knife', name: 'Combat Knife', short: 'KNF', slot: 2, cls: 'melee', kind: 'melee', fireMode: 'auto',
    blurb: 'Two hits. Always equipped.',
    // Five rays over ±0.3 rad; a swing deals the best ray's damage, never the sum.
    damage: 55, headMultiplier: 1, interval: cmds(30), magazine: 0, reserve: 0, reloadTime: 0, melee: { rays: 5, fan: 0.6 },
    spread: 0, aimSpreadMul: 1, adsTime: 0, moveSpread: 0, airSpread: 0, bloom: 0, bloomMax: 0, bloomRecovery: 1,
    recoil: 0.015, recoilYaw: 0.02, range: 2.4, falloffStart: 3, falloffMin: 1, aimFov: 72, moveMul: 1.12, aimMoveMul: 1.12, drawTime: 0.2, autoRange: 2.4,
    bot: { prefRange: 1.2, engageMul: 1, tolerance: 0.3, distTol: 0, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Smg, key: 'smg', name: 'SMG', short: 'SMG', slot: 0, cls: 'smg', kind: 'hitscan', fireMode: 'auto',
    blurb: 'Very fast fire and accurate on the move. Falls off past 15 m.',
    damage: 16, headMultiplier: 1.5, interval: cmds(4), magazine: 32, reserve: 96, reloadTime: cmds(102),
    spread: 0.03, aimSpreadMul: 0.5, adsTime: 0.15, moveSpread: 0.012, airSpread: 0.05, bloom: 0.004, bloomMax: 0.03, bloomRecovery: 0.15,
    recoil: 0.007, recoilYaw: 0.006, range: 70, falloffStart: 14, falloffMin: 0.5, aimFov: 65, moveMul: 1.05, aimMoveMul: 0.75, drawTime: 0.35, autoRange: 45,
    bot: { prefRange: 8, engageMul: 0.6, tolerance: 0.08, distTol: 0.6, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Crossbow, key: 'crossbow', name: 'Crossbow', short: 'XBW', slot: 0, cls: 'crossbow', kind: 'projectile', fireMode: 'semi',
    blurb: 'Silent bolts with travel time and drop. Headshots kill; reloads after every shot.',
    // Drop: about 0.35 m at 30 m and 1.4 m at 60 m. "range" only feeds the UI and the bots.
    damage: 75, headMultiplier: 2, interval: cmds(12), magazine: 1, reserve: 20, reloadTime: cmds(60),
    projectile: { speed: 95, gravity: 7, radius: 0.06, life: 2.5 },
    spread: 0.012, aimSpreadMul: 0, adsTime: 0.22, moveSpread: 0.02, airSpread: 0.08, bloom: 0, bloomMax: 0, bloomRecovery: 1,
    recoil: 0.03, recoilYaw: 0.004, range: 230, falloffStart: 230, falloffMin: 1, aimFov: 45, moveMul: 0.95, aimMoveMul: 0.6, drawTime: 0.45, autoRange: 70,
    bot: { prefRange: 18, engageMul: 0.3, tolerance: 0.035, distTol: 0.3, scopeFirst: 0.2 },
  }),
  def({
    id: WeaponId.BurstRifle, key: 'burst-rifle', name: 'Burst Rifle', short: 'BST', slot: 0, cls: 'rifle', kind: 'hitscan', fireMode: 'burst',
    blurb: 'Three-round bursts. Two headshots in one burst take a player down.',
    // `interval` is the pause after a burst; the burst itself fires every burstInterval.
    damage: 27, headMultiplier: 1.8, interval: cmds(18), burstCount: 3, burstInterval: cmds(4), magazine: 24, reserve: 72, reloadTime: cmds(126),
    spread: 0.012, aimSpreadMul: 0.25, adsTime: 0.22, moveSpread: 0.03, airSpread: 0.1, bloom: 0.004, bloomMax: 0.02, bloomRecovery: 0.15,
    recoil: 0.009, recoilYaw: 0.003, range: 150, falloffStart: 45, falloffMin: 0.75, aimFov: 50, moveMul: 0.95, aimMoveMul: 0.6, drawTime: 0.45, autoRange: 110,
    bot: { prefRange: 16, engageMul: 0.7, tolerance: 0.06, distTol: 0.5, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.Marksman, key: 'marksman-rifle', name: 'Marksman Rifle', short: 'MKS', slot: 0, cls: 'marksman', kind: 'hitscan', fireMode: 'semi',
    blurb: 'Semi-auto with a 2× optic. Three body shots, or a head and a body shot.',
    damage: 42, headMultiplier: 2, interval: cmds(15), magazine: 12, reserve: 36, reloadTime: cmds(138),
    spread: 0.02, aimSpreadMul: 0.1, adsTime: 0.26, moveSpread: 0.05, airSpread: 0.12, bloom: 0.01, bloomMax: 0.03, bloomRecovery: 0.25,
    recoil: 0.03, recoilYaw: 0.005, range: 220, falloffStart: 60, falloffMin: 0.85, aimFov: 38, moveMul: 0.93, aimMoveMul: 0.55, drawTime: 0.5, autoRange: 160,
    bot: { prefRange: 20, engageMul: 0.75, tolerance: 0.04, distTol: 0.4, scopeFirst: 0.2 },
  }),
  def({
    id: WeaponId.Lmg, key: 'lmg', name: 'LMG', short: 'LMG', slot: 0, cls: 'lmg', kind: 'hitscan', fireMode: 'auto',
    blurb: '80-round box for sustained fire. Slow to move and to reload.',
    damage: 18, headMultiplier: 1.6, interval: cmds(5), magazine: 80, reserve: 80, reloadTime: cmds(252),
    spread: 0.035, aimSpreadMul: 0.35, adsTime: 0.35, moveSpread: 0.05, airSpread: 0.15, bloom: 0.004, bloomMax: 0.05, bloomRecovery: 0.08,
    recoil: 0.008, recoilYaw: 0.007, range: 130, falloffStart: 35, falloffMin: 0.7, aimFov: 55, moveMul: 0.85, aimMoveMul: 0.5, drawTime: 0.7, autoRange: 90,
    bot: { prefRange: 15, engageMul: 0.7, tolerance: 0.08, distTol: 0.6, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.HandCannon, key: 'hand-cannon', name: 'Hand Cannon', short: 'HC', slot: 1, cls: 'pistol', kind: 'hitscan', fireMode: 'semi',
    blurb: 'Six heavy rounds. A headshot kills up close.',
    damage: 55, headMultiplier: 2, interval: cmds(27), magazine: 6, reserve: 24, reloadTime: cmds(132),
    spread: 0.012, aimSpreadMul: 0.3, adsTime: 0.16, moveSpread: 0.04, airSpread: 0.1, bloom: 0.02, bloomMax: 0.05, bloomRecovery: 0.3,
    recoil: 0.06, recoilYaw: 0.01, range: 100, falloffStart: 25, falloffMin: 0.6, aimFov: 60, moveMul: 1, aimMoveMul: 0.75, drawTime: 0.4, autoRange: 60,
    bot: { prefRange: 10, engageMul: 0.6, tolerance: 0.05, distTol: 0.4, scopeFirst: 0 },
  }),
  def({
    id: WeaponId.MachinePistol, key: 'machine-pistol', name: 'Machine Pistol', short: 'MP', slot: 1, cls: 'pistol', kind: 'hitscan', fireMode: 'auto',
    blurb: 'Full-auto backup for close quarters.',
    damage: 12, headMultiplier: 1.5, interval: cmds(4), magazine: 20, reserve: 60, reloadTime: cmds(90),
    spread: 0.04, aimSpreadMul: 0.6, adsTime: 0.12, moveSpread: 0.02, airSpread: 0.06, bloom: 0.005, bloomMax: 0.04, bloomRecovery: 0.2,
    recoil: 0.008, recoilYaw: 0.006, range: 50, falloffStart: 10, falloffMin: 0.45, aimFov: 66, moveMul: 1.02, aimMoveMul: 0.8, drawTime: 0.3, autoRange: 30,
    bot: { prefRange: 7, engageMul: 0.6, tolerance: 0.09, distTol: 0.6, scopeFirst: 0 },
  }),
];

export const WEAPONS: readonly WeaponDef[] = W;
/** Loadout display order. */
export const PRIMARY_WEAPONS: readonly WeaponId[] = [
  WeaponId.Rifle, WeaponId.Smg, WeaponId.Shotgun, WeaponId.Sniper, WeaponId.Crossbow, WeaponId.BurstRifle, WeaponId.Marksman, WeaponId.Lmg,
];
export const SECONDARY_WEAPONS: readonly WeaponId[] = [WeaponId.Pistol, WeaponId.HandCannon, WeaponId.MachinePistol];
export const MELEE_WEAPONS: readonly WeaponId[] = [WeaponId.Blade];
export const DEFAULT_PRIMARY = WeaponId.Rifle;
export const DEFAULT_SECONDARY = WeaponId.Pistol;
export const MELEE_WEAPON = WeaponId.Blade;

/** How often bots pick each weapon (weights sum to 100). */
export const BOT_PRIMARY_WEIGHTS: readonly (readonly [WeaponId, number])[] = [
  [WeaponId.Rifle, 18], [WeaponId.Smg, 15], [WeaponId.Shotgun, 10], [WeaponId.Sniper, 7],
  [WeaponId.Crossbow, 8], [WeaponId.BurstRifle, 14], [WeaponId.Marksman, 13], [WeaponId.Lmg, 15],
];
export const BOT_SECONDARY_WEIGHTS: readonly (readonly [WeaponId, number])[] = [[WeaponId.Pistol, 45], [WeaponId.HandCannon, 25], [WeaponId.MachinePistol, 30]];

export const weaponDef = (id: number): WeaponDef => W[id] ?? W[0];
export const isWeaponId = (id: unknown): id is WeaponId => typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < W.length;
export const isPrimary = (id: unknown): id is WeaponId => isWeaponId(id) && W[id].slot === 0;
export const isSecondary = (id: unknown): id is WeaponId => isWeaponId(id) && W[id].slot === 1;

function weighted(table: readonly (readonly [WeaponId, number])[], r: number): WeaponId {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [id, w] of table) {
    if (x < w) return id;
    x -= w;
  }
  return table[table.length - 1][0];
}

/** Bot loadout: weighted primary and secondary (one rnd draw each). */
export function pickBotLoadout(rnd: () => number): { primary: WeaponId; secondary: WeaponId } {
  const primary = weighted(BOT_PRIMARY_WEIGHTS, rnd());
  return { primary, secondary: weighted(BOT_SECONDARY_WEIGHTS, rnd()) };
}

/** Damage multiplier at a distance: 1 up to falloffStart, then linear down to falloffMin at range. */
export function falloffAt(d: WeaponDef, distance: number): number {
  if (distance <= d.falloffStart) return 1;
  return Math.max(d.falloffMin, 1 - ((distance - d.falloffStart) / Math.max(1, d.range - d.falloffStart)) * (1 - d.falloffMin));
}

/** Seconds from the first to the n-th shot (0-based) holding the trigger at the maximum rate, reloads included. */
export function shotTime(d: WeaponDef, n: number): number {
  let t = 0;
  for (let i = 1; i <= n; i++) {
    if (d.burstCount > 1) t += i % d.burstCount === 0 ? d.interval : d.burstInterval;
    else t += d.interval;
    if (d.magazine > 0 && i % d.magazine === 0) t += d.reloadTime;
  }
  return t;
}

/** Time to kill a full-health player with body shots at a distance (every pellet hits), in seconds. */
export function ttkBody(d: WeaponDef, distance = 10): number {
  const perShot = d.damage * d.pellets * falloffAt(d, distance);
  return shotTime(d, Math.ceil(100 / perShot) - 1);
}
