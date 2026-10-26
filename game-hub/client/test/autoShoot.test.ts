/** Auto-shoot: the server's hit test on what the client draws, fire-mode aware, never through walls or at team mates. */
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  ballisticAim,
  BoxWorld,
  Buttons,
  createArenaWorld,
  createPlayerSim,
  flatArenaMap,
  makeCommand,
  type PlayerSim,
  type Tuple3,
  WeaponId,
  weaponDef,
} from '@hub/shared';
import { ACQUIRE_MS, type AimTarget, AutoShoot, type AutoShootContext, buildAimTargets, fireBit, GRACE_MS } from '../src/games/arena/features/AutoShoot';

const world = createArenaWorld(flatArenaMap());
const EYE: Tuple3 = [0, 1.6, 0];

function holding(id: WeaponId): PlayerSim {
  const d = weaponDef(id);
  const p = createPlayerSim();
  p.slot = d.slot;
  p.weapons[d.slot] = { id, mag: d.magazine, reserve: d.reserve };
  return p;
}

/** Enemies standing at the given points (feet). */
function targets(...at: [number, number, number][]): AimTarget[] {
  return buildAimTargets(new Map(at.map((p, i) => [`e${i}`, { x: p[0], y: p[1], z: p[2], crouching: false, alive: true }])), () => true);
}

function ctx(p: PlayerSim, t: AimTarget[], over: Partial<AutoShootContext> = {}): AutoShootContext {
  return { enabled: true, canAct: true, p, eye: EYE, yaw: 0, pitch: 0, targets: t, world, ...over };
}

/** Feeds frames every 16 ms for `ms`; returns whether it wanted to fire at the end. */
function run(a: AutoShoot, from: number, ms: number, c: AutoShootContext): boolean {
  let wants = false;
  for (let t = from; t <= from + ms; t += 16) wants = a.update(t, c);
  return wants;
}

describe('auto-shoot targeting', () => {
  it('stays off unless enabled', () => {
    const a = new AutoShoot();
    expect(run(a, 0, 500, ctx(holding(WeaponId.Rifle), targets([0, 0, -10]), { enabled: false }))).toBe(false);
    expect(a.state).toBe('off');
  });

  it('fires at an enemy under the crosshair only after the acquire delay', () => {
    const a = new AutoShoot();
    const c = ctx(holding(WeaponId.Rifle), targets([0, 0, -10]));
    expect(a.update(0, c)).toBe(false);
    expect(a.onTarget).toBe(true);
    expect(a.update(ACQUIRE_MS - 10, c)).toBe(false);
    expect(a.update(ACQUIRE_MS + 1, c)).toBe(true);
    expect(a.state).toBe('firing');
    // Not when input is paused or the phase forbids shooting.
    expect(run(new AutoShoot(), 0, 300, { ...c, canAct: false })).toBe(false);
  });

  it('never fires through walls, beyond its range, or at team mates', () => {
    const p = holding(WeaponId.Rifle);
    const walled = new BoxWorld([...world.boxes, { minX: -3, maxX: 3, minY: 0, maxY: 4, minZ: -6, maxZ: -5 }]);
    expect(run(new AutoShoot(), 0, 300, ctx(p, targets([0, 0, -10]), { world: walled }))).toBe(false);
    expect(run(new AutoShoot(), 0, 300, ctx(holding(WeaponId.Smg), targets([0, 0, -50])))).toBe(false); // SMG autoRange 45
    expect(run(new AutoShoot(), 0, 300, ctx(holding(WeaponId.Rifle), targets([0, 0, -50])))).toBe(true);
    const mates = buildAimTargets(
      new Map([
        ['mate', { x: 0, y: 0, z: -10, crouching: false, alive: true }],
        ['dead', { x: 0, y: 0, z: -12, crouching: false, alive: false }],
        ['foe', { x: 5, y: 0, z: -10, crouching: false, alive: true }],
      ]),
      (id) => id !== 'mate',
    );
    expect(mates.map((t) => t.id)).toEqual(['foe']);
    expect(run(new AutoShoot(), 0, 300, ctx(p, mates))).toBe(false);
  });

  it('uses the knife fan: 2 m yes, 3 m no', () => {
    const k = holding(WeaponId.Blade);
    expect(run(new AutoShoot(), 0, 200, ctx(k, targets([0.6, 0, -2])))).toBe(true);
    expect(run(new AutoShoot(), 0, 200, ctx(k, targets([0, 0, -3])))).toBe(false);
  });

  it('follows the crossbow bolt drop', () => {
    const x = holding(WeaponId.Crossbow);
    const spec = weaponDef(WeaponId.Crossbow).projectile!;
    // Feet at eye height 50 m away: a level bolt passes under; aimed up by the drop, it hits.
    const far = targets([0, 1.6, -50]);
    expect(run(new AutoShoot(), 0, 200, ctx(x, far))).toBe(false);
    const pitch = ballisticAim(0, 0.9, -50, spec.speed, spec.gravity)!.pitch;
    expect(run(new AutoShoot(), 0, 200, ctx(x, far, { pitch }))).toBe(true);
  });

  it('only takes sniper shots from the hip up close, any range once scoped', () => {
    const s = holding(WeaponId.Sniper);
    expect(run(new AutoShoot(), 0, 200, ctx(s, targets([0, 0, -30])))).toBe(false);
    expect(run(new AutoShoot(), 0, 200, ctx(s, targets([0, 0, -8])))).toBe(true);
    s.ads = 1;
    expect(run(new AutoShoot(), 0, 200, ctx(s, targets([0, 0, -30])))).toBe(true);
  });

  it('keeps automatic weapons firing briefly after the target slips off; semi weapons stop at once', () => {
    for (const [id, grace] of [[WeaponId.Smg, true], [WeaponId.Pistol, false]] as const) {
      const a = new AutoShoot();
      const p = holding(id);
      const on = ctx(p, targets([0, 0, -10]));
      const off = ctx(p, targets([5, 0, -10]));
      expect(run(a, 0, 200, on)).toBe(true);
      expect(a.update(200 + GRACE_MS - 20, off)).toBe(grace);
      expect(a.update(200 + GRACE_MS + 30, off)).toBe(false);
    }
  });
});

describe('auto-shoot fire bit', () => {
  /** Fire bits for `n` commands, applied to the player like the client's prediction. */
  function shots(p: PlayerSim, n: number, wants = true): number[] {
    const out: number[] = [];
    const def = () => weaponDef(p.weapons[p.slot].id);
    for (let i = 0; i < n; i++) {
      const fire = fireBit(p, def(), wants);
      const ev = applyCommand(p, makeCommand(i + 1, { buttons: fire ? Buttons.Fire : 0 }), world, false, 0);
      if (fire && p.reload > 0 && !ev.reloadStarted) throw new Error('fired while reloading');
      if (ev.shot) out.push(i);
    }
    return out;
  }

  for (const id of [WeaponId.Pistol, WeaponId.Marksman, WeaponId.HandCannon, WeaponId.Crossbow, WeaponId.Sniper]) {
    it(`${weaponDef(id).name}: semi-automatic at the maximum legal rate`, () => {
      const d = weaponDef(id);
      const n = Math.round(d.interval * 60);
      const p = holding(id);
      p.weapons[p.slot].mag = 255;
      expect(shots(p, 120)).toHaveLength(Math.floor(119 / n) + 1);
    });
  }

  it('holds the trigger for automatic and burst weapons', () => {
    const p = holding(WeaponId.Rifle);
    expect(shots(p, 60)).toHaveLength(10);
    const b = holding(WeaponId.BurstRifle);
    expect(shots(b, 30).slice(0, 4)).toEqual([0, 4, 8, 26]);
  });

  it('never fires while reloading or on an empty magazine', () => {
    const p = holding(WeaponId.Pistol);
    p.weapons[1].mag = 0;
    expect(fireBit(p, weaponDef(WeaponId.Pistol), true)).toBe(false);
    p.weapons[1].mag = 5;
    p.reload = 0.5;
    expect(fireBit(p, weaponDef(WeaponId.Pistol), true)).toBe(false);
    // Emptying the crossbow: it waits for the automatic reload instead of dry-firing.
    const x = holding(WeaponId.Crossbow);
    const fired = shots(x, 100);
    expect(fired).toEqual([0, 72]);
    expect(fireBit(holding(WeaponId.Rifle), weaponDef(WeaponId.Rifle), false)).toBe(false);
  });
});
