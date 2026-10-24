/**
 * Arcfire Arena weapons (design-arena-weapons §12.1): the 12-weapon table, the weapon state machine
 * (fire modes, bursts, shell reloads, auto-reload, ADS, the knife fan), crossbow bolts and loadouts.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  ARENA_MAPS,
  ArenaSimulation,
  type ArenaEvent,
  ballisticAim,
  BOT_PRIMARY_WEIGHTS,
  BoxWorld,
  Buttons,
  CMD_DT,
  createArenaWorld,
  createPlayerSim,
  currentSpread,
  decodeSnapshot,
  encodePoses,
  encodeSnapshot,
  eyePosition,
  flatArenaMap,
  hitboxesFor,
  LOADOUT_TIME,
  makeCommand,
  MELEE_WEAPONS,
  type PlayerSim,
  pickBotLoadout,
  PRIMARY_WEAPONS,
  type Projectile,
  projectilePathHits,
  resolveShot,
  SECONDARY_WEAPONS,
  type SimPlayer,
  stepProjectile,
  TICK_RATE,
  traceProjectileWorld,
  ttkBody,
  type Tuple3,
  viewDir,
  mulberry32,
  WEAPON_COUNT,
  WeaponId,
  weaponDef,
  WEAPONS,
} from '../src';

const world = createArenaWorld(flatArenaMap());
const isInt = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;

/** A player holding `id` in its own slot, ready to fire (drawn, standing still on the floor). */
function holding(id: WeaponId, mag?: number): PlayerSim {
  const d = weaponDef(id);
  const p = createPlayerSim();
  p.slot = d.slot;
  p.weapons[d.slot] = { id, mag: mag ?? d.magazine, reserve: d.reserve };
  return p;
}

/** Applies `n` commands built by `make(i)`; returns the command indices that fired. */
function run(p: PlayerSim, n: number, make: (i: number, p: PlayerSim) => number, seq0 = 1): number[] {
  const shots: number[] = [];
  for (let i = 0; i < n; i++) if (applyCommand(p, makeCommand(seq0 + i, { buttons: make(i, p) }), world, false, 0).shot) shots.push(i);
  return shots;
}

/** The fastest legal semi-auto trigger: press on the command the shot becomes possible, release otherwise. */
const semiPress = (_i: number, p: PlayerSim) => (p.cooldown - CMD_DT <= 1e-6 && p.switching - CMD_DT <= 1e-6 && !p.fireHeld ? Buttons.Fire : 0);

describe('weapon table', () => {
  it('is complete and consistent', () => {
    expect(WEAPONS).toHaveLength(WEAPON_COUNT);
    expect(new Set(WEAPONS.map((w) => w.key)).size).toBe(WEAPON_COUNT);
    expect(new Set(WEAPONS.map((w) => w.name)).size).toBe(WEAPON_COUNT);
    WEAPONS.forEach((w, i) => {
      expect(w.id, w.name).toBe(i);
      expect(isInt(w.interval * 60), `${w.name} interval`).toBe(true);
      expect(isInt(w.burstInterval * 60), `${w.name} burstInterval`).toBe(true);
      expect(isInt(w.reloadTime * 60), `${w.name} reloadTime`).toBe(true);
      expect(isInt(w.shellTime * 60), `${w.name} shellTime`).toBe(true);
      expect(w.magazine).toBeLessThanOrEqual(255);
      expect(w.reserve).toBeLessThanOrEqual(65535);
      expect(w.kind === 'projectile').toBe(w.projectile !== null);
      expect(w.kind === 'melee').toBe(w.melee !== null);
      expect(w.automatic).toBe(w.fireMode !== 'semi');
      expect(w.fireMode === 'burst').toBe(w.burstCount > 1);
      expect(w.reloadKind === 'shell').toBe(w.shellTime > 0);
      expect(w.blurb.length).toBeGreaterThan(10);
    });
    expect(PRIMARY_WEAPONS).toHaveLength(8);
    expect(SECONDARY_WEAPONS).toHaveLength(3);
    for (const id of PRIMARY_WEAPONS) expect(weaponDef(id).slot).toBe(0);
    for (const id of SECONDARY_WEAPONS) expect(weaponDef(id).slot).toBe(1);
    for (const id of MELEE_WEAPONS) expect(weaponDef(id).slot).toBe(2);
    expect(new Set([...PRIMARY_WEAPONS, ...SECONDARY_WEAPONS, ...MELEE_WEAPONS]).size).toBe(WEAPON_COUNT);
  });

  it('keeps the wire ids', () => {
    expect([WeaponId.Rifle, WeaponId.Shotgun, WeaponId.Sniper, WeaponId.Pistol, WeaponId.Blade]).toEqual([0, 1, 2, 3, 4]);
    expect([WeaponId.Smg, WeaponId.Crossbow, WeaponId.BurstRifle, WeaponId.Marksman, WeaponId.Lmg, WeaponId.HandCannon, WeaponId.MachinePistol]).toEqual([
      5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('uses generic, original names', () => {
    const banned =
      /\b(AK|M4|M16|AR-?15|MP5|Uzi|Glock|Deagle|Desert Eagle|AWP|Barrett|Kar98|SPAS|Vandal|Phantom|Operator|Sheriff|Spectre|Odin|Ares|Judge|Bulldog|Guardian|Marshal)\b/i;
    for (const w of WEAPONS) for (const text of [w.name, w.short, w.blurb]) expect(text, text).not.toMatch(banned);
    expect(WEAPONS.map((w) => w.name)).toEqual(
      expect.arrayContaining(['Assault Rifle', 'SMG', 'Shotgun', 'Sniper Rifle', 'Crossbow', 'Burst Rifle', 'Marksman Rifle', 'LMG', 'Pistol', 'Hand Cannon', 'Machine Pistol', 'Combat Knife']),
    );
  });

  it('is balanced: autos kill in 0.38-0.55 s, the precision weapons one-shot the head', () => {
    for (const w of WEAPONS.filter((d) => d.fireMode !== 'semi' && d.kind === 'hitscan' && d.pellets === 1)) {
      expect(ttkBody(w, 10), w.name).toBeGreaterThanOrEqual(0.38);
      expect(ttkBody(w, 10), w.name).toBeLessThanOrEqual(0.55);
    }
    const mks = weaponDef(WeaponId.Marksman);
    expect(ttkBody(mks, 10)).toBeCloseTo(0.5, 6);
    for (const id of [WeaponId.Sniper, WeaponId.Crossbow]) expect(weaponDef(id).damage * weaponDef(id).headMultiplier).toBeGreaterThanOrEqual(100);
    const sg = weaponDef(WeaponId.Shotgun);
    expect(sg.damage * sg.pellets).toBeGreaterThanOrEqual(100); // all pellets at 5 m (inside falloffStart)
    expect(sg.falloffStart).toBeGreaterThanOrEqual(5);
    const hc = weaponDef(WeaponId.HandCannon);
    expect(hc.damage * hc.headMultiplier).toBeGreaterThanOrEqual(100);
    expect(hc.falloffStart).toBeGreaterThanOrEqual(25);
  });
});

describe('fire modes', () => {
  for (const w of WEAPONS) {
    it(`${w.name} fires at its exact rate`, () => {
      const n = Math.round(w.interval * 60);
      const held = holding(w.id, w.magazine > 0 ? 255 : 0);
      const shots = run(held, 120, () => Buttons.Fire);
      if (w.fireMode === 'auto') expect(shots).toHaveLength(Math.floor(119 / n) + 1);
      else if (w.fireMode === 'burst') {
        expect(shots.slice(0, 6)).toEqual([0, 4, 8, 26, 30, 34]);
        expect(shots).toHaveLength(15);
      } else {
        expect(shots).toEqual([0]); // holding a semi-auto fires once
        expect(run(holding(w.id, 255), 120, semiPress)).toHaveLength(Math.floor(119 / n) + 1);
      }
    });
  }

  it('finishes a burst from one short press; switching cancels it', () => {
    const p = holding(WeaponId.BurstRifle);
    const shots = run(p, 40, (i) => (i === 0 ? Buttons.Fire : 0));
    expect(shots).toEqual([0, 4, 8]);
    expect(p.weapons[0].mag).toBe(21);
    const q = holding(WeaponId.BurstRifle);
    let fired = 0;
    for (let i = 0; i < 20; i++) {
      const ev = applyCommand(q, makeCommand(i + 1, { buttons: i === 0 ? Buttons.Fire : 0, slot: i === 5 ? 1 : 255 }), world, false, 0);
      if (ev.shot && ev.shot.weapon === WeaponId.BurstRifle) fired++;
    }
    expect(q.burstLeft).toBe(0);
    expect(fired).toBeLessThanOrEqual(2);
  });
});

describe('reloads', () => {
  it('loads the shotgun shell by shell; a fresh press interrupts, holding fire on empty does not', () => {
    const p = holding(WeaponId.Shotgun, 2);
    const loaded: number[] = [];
    for (let i = 0; i < 200; i++) {
      const ev = applyCommand(p, makeCommand(i + 1, { buttons: i === 0 ? Buttons.Reload : 0 }), world, false, 0);
      if (ev.shellLoaded) loaded.push(i);
    }
    // First shell after 0.55 s (33 commands), then one every 0.45 s (27 commands).
    expect(loaded).toEqual([33, 60, 87, 114]);
    expect(p.weapons[0]).toMatchObject({ mag: 6, reserve: 20 });

    const q = holding(WeaponId.Shotgun, 2);
    run(q, 40, (i) => (i === 0 ? Buttons.Reload : 0)); // one shell in
    expect(q.weapons[0].mag).toBe(3);
    const ev = applyCommand(q, makeCommand(100, { buttons: Buttons.Fire }), world, false, 0);
    expect(ev.reloadCancelled).toBe(true);
    expect(ev.shot).not.toBeNull();
    expect(q.reload).toBe(0);

    const r = holding(WeaponId.Shotgun, 0);
    const fired = run(r, 33 + 27 * 5 + 2, () => Buttons.Fire);
    expect(fired).toEqual([33 + 27 * 5]); // the first shot comes only after the full reload
    expect(r.weapons[0].mag).toBe(5);
  });

  it('reloads an empty magazine by itself once the last shot has cycled', () => {
    const reloadAt = (holdFor: number) => {
      const p = holding(WeaponId.Rifle, 3);
      for (let i = 0; i < 30; i++) {
        if (applyCommand(p, makeCommand(i + 1, { buttons: i < holdFor ? Buttons.Fire : 0 }), world, false, 0).reloadStarted) return i;
      }
      return -1;
    };
    // Shots at 0, 6 and 12. Released after the last shot: the reload starts when its cooldown ends.
    expect(reloadAt(13)).toBe(18);
    // Still holding the trigger on the empty magazine starts it at once (as before).
    expect(reloadAt(30)).toBe(13);
    // The crossbow reloads after every bolt and is ready again 1.2 s after the shot.
    const x = holding(WeaponId.Crossbow);
    const shots = run(x, 150, semiPress);
    expect(shots.slice(0, 3)).toEqual([0, 72, 144]);
    expect(x.weapons[0].reserve).toBe(18);
  });
});

describe('aiming down sights', () => {
  it('ramps in over adsTime, so a quick-scope is not accurate', () => {
    const p = holding(WeaponId.Sniper);
    const hip = currentSpread(p);
    expect(hip).toBeCloseTo(0.06, 6);
    applyCommand(p, makeCommand(1, { buttons: Buttons.Aim }), world, false, 0);
    expect(currentSpread(p)).toBeGreaterThan(0.9 * hip);
    run(p, 19, () => Buttons.Aim, 2);
    expect(p.ads).toBe(1);
    expect(currentSpread(p)).toBe(0);
    run(p, 20, () => 0, 30);
    expect(p.ads).toBe(0);
  });

  it('never aims while reloading or with the knife', () => {
    const p = holding(WeaponId.Rifle, 10);
    applyCommand(p, makeCommand(1, { buttons: Buttons.Reload | Buttons.Aim }), world, false, 0);
    run(p, 10, () => Buttons.Aim, 2);
    expect(p.aiming).toBe(false);
    expect(p.ads).toBe(0);
    const k = holding(WeaponId.Blade);
    run(k, 10, () => Buttons.Aim);
    expect(k.aiming).toBe(false);
  });
});

describe('combat knife', () => {
  const swing = () => applyCommand(holding(WeaponId.Blade), makeCommand(1, { buttons: Buttons.Fire }), world, false, 0).shot!;

  it('sweeps a fan of rays and deals one swing of damage', () => {
    const shot = swing();
    expect(shot.dirs).toHaveLength(5);
    expect(shot.dirs[0]).toEqual(viewDir(0, 0));
    // Target 2.0 m away, 0.25 rad to the left of the view (yaw 0 looks toward -Z).
    const at = (d: number) => ({ id: 't', boxes: hitboxesFor({ x: -Math.sin(0.25) * d, y: 0, z: -Math.cos(0.25) * d, crouching: false }) });
    const near = resolveShot(shot, world, [at(2.0)]);
    expect(near.damage).toEqual([expect.objectContaining({ id: 't', damage: 55 })]);
    expect(resolveShot(shot, world, [at(2.8)]).damage).toHaveLength(0);
    const walled = new BoxWorld([...world.boxes, { minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: -1.2, maxZ: -1 }]);
    expect(resolveShot(shot, walled, [at(2.0)]).damage).toHaveLength(0);
  });
});

describe('crossbow bolts', () => {
  const xbow = weaponDef(WeaponId.Crossbow);
  const spec = xbow.projectile!;

  it('drops under gravity and stops at walls', () => {
    const wallWorld = createArenaWorld(flatArenaMap({ boxes: [{ minX: -5, maxX: 5, minY: 0, maxY: 6, minZ: -41, maxZ: -40, kind: 'wall' }] }));
    const end = traceProjectileWorld([0, 1.6, 0], [0, 0, -spec.speed], spec, wallWorld);
    expect(end.kind).toBe('world');
    expect(end.pos[2]).toBeCloseTo(-40, 5);
    expect(end.pos[1]).toBeCloseTo(1.6 - 0.5 * spec.gravity * (40 / spec.speed) ** 2, 1);
    expect(Math.abs(end.pos[1] - (1.6 - 0.5 * spec.gravity * (40 / spec.speed) ** 2))).toBeLessThan(0.02);
    expect(end.normal).toEqual([0, 0, 1]);
    expect(end.t).toBeCloseTo(40 / spec.speed, 3);
  });

  it('steps exactly like the world trace', () => {
    const map0 = createArenaWorld(ARENA_MAPS[0]);
    const rnd = mulberry32(99);
    for (let i = 0; i < 50; i++) {
      const o: Tuple3 = [(rnd() - 0.5) * 20, 1 + rnd() * 2, (rnd() - 0.5) * 20];
      const d = viewDir(rnd() * Math.PI * 2, (rnd() - 0.6) * 0.8);
      const v: Tuple3 = [d[0] * spec.speed, d[1] * spec.speed, d[2] * spec.speed];
      const trace = traceProjectileWorld(o, v, spec, map0);
      const pr: Projectile = { id: 1, owner: 'a', ownerIndex: 0, team: 0, weapon: WeaponId.Crossbow, ox: o[0], oy: o[1], oz: o[2], vx: v[0], vy: v[1], vz: v[2], age: 0, spawnTick: 0, rewind: 0, seq: 0 };
      let hit = null;
      for (let s = 0; s < 200 && !hit; s++) hit = stepProjectile(pr, spec, map0, () => [], 2);
      expect(hit).toEqual(trace);
    }
  });

  it('finds targets on its path for auto-shoot, with drop', () => {
    // A target whose feet are at eye height 50 m away: a level shot passes under it, the lifted one hits.
    const target = [{ id: 't', boxes: hitboxesFor({ x: 0, y: 1.6, z: -50, crouching: false }) }];
    const level: Tuple3 = [0, 0, -spec.speed];
    expect(projectilePathHits([0, 1.6, 0], level, spec, world, target, 1)).toBeNull();
    const aim = ballisticAim(0, 0.9, -50, spec.speed, spec.gravity)!;
    const d = viewDir(0, aim.pitch);
    expect(projectilePathHits([0, 1.6, 0], [d[0] * spec.speed, d[1] * spec.speed, d[2] * spec.speed], spec, world, target, 1)).toBe('t');
  });
});

/** A live match on the flat fixture map; `ids` join in order (team modes alternate teams 0, 1, 0, 1). */
function liveSim(mode: '1v1' | '2v2', ids: string[], primary = WeaponId.Crossbow): { sim: ArenaSimulation; p: Record<string, SimPlayer> } {
  const sim = new ArenaSimulation(flatArenaMap(), mode, { seed: 3 });
  const p: Record<string, SimPlayer> = {};
  for (const id of ids) p[id] = sim.addPlayer({ id, name: id, color: 1, primary });
  sim.startMatch();
  for (let i = 0; i < LOADOUT_TIME * TICK_RATE + 2; i++) sim.step();
  expect(sim.phase).toBe('live');
  sim.drainEvents();
  return { sim, p };
}

function place(s: SimPlayer, x: number, z: number): void {
  Object.assign(s.sim, { x, y: 0, z, vx: 0, vy: 0, vz: 0, onGround: true });
}

/** Aims at a target point with the bolt's drop, fully scoped, and fires once (viewTick = when it was seen). */
function fireBolt(sim: ArenaSimulation, shooter: SimPlayer, tx: number, ty: number, tz: number, viewTick = sim.tick): void {
  const [ex, ey, ez] = eyePosition(shooter.sim);
  const spec = weaponDef(WeaponId.Crossbow).projectile!;
  const yaw = Math.atan2(-(tx - ex), -(tz - ez));
  const pitch = ballisticAim(tx - ex, ty - ey, tz - ez, spec.speed, spec.gravity)!.pitch;
  let seq = shooter.sim.lastSeq;
  for (let i = 0; i < 16; i++) sim.queueCommand(shooter.id, makeCommand(++seq, { yaw, pitch, buttons: Buttons.Aim, viewTick }));
  sim.queueCommand(shooter.id, makeCommand(++seq, { yaw, pitch, buttons: Buttons.Aim | Buttons.Fire, viewTick }));
}

/** Steps until no bolt is in flight (or `ticks` pass); returns the events. */
function settle(sim: ArenaSimulation, ticks = 120): ArenaEvent[] {
  const out: ArenaEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    out.push(...sim.drainEvents());
    if (out.some((e) => e.type === 'proj') && sim.projectiles.list.length === 0) break;
  }
  return out;
}

describe('crossbow in the simulation', () => {
  it('kills a stationary player with one headshot: proj, projEnd, hit, kill', () => {
    const { sim, p } = liveSim('1v1', ['a', 'b']);
    place(p.a, 0, 0);
    place(p.b, 0, -20);
    const head = hitboxesFor({ x: 0, y: 0, z: -20, crouching: false }).head;
    fireBolt(sim, p.a, 0, (head.minY + head.maxY) / 2, -20);
    const ev = settle(sim).filter((e) => ['proj', 'projEnd', 'hit', 'kill', 'shot'].includes(e.type));
    expect(ev.map((e) => e.type)).toEqual(['proj', 'projEnd', 'hit', 'kill']);
    expect(ev[1]).toMatchObject({ hitId: 'b', headshot: true });
    expect(ev[2]).toMatchObject({ victim: 'b', damage: 100, headshot: true, killed: true });
    expect(p.a.stats).toMatchObject({ shots: 1, hits: 1, kills: 1 });
  });

  it('passes teammates, never hits its owner, and expires after its flight time', () => {
    const { sim, p } = liveSim('2v2', ['a', 'b', 'c', 'd']);
    expect([p.a.team, p.c.team]).toEqual([0, 0]);
    place(p.a, 0, 0);
    place(p.c, 0, -10); // teammate in the line of fire
    place(p.b, 0, -20);
    place(p.d, 30, 30);
    fireBolt(sim, p.a, 0, 1.1, -20);
    const ev = settle(sim);
    expect(ev.find((e) => e.type === 'projEnd')).toMatchObject({ hitId: 'b' });
    expect(p.c.sim.hp).toBe(100);
    expect(p.b.sim.hp).toBe(25);

    // Into the open sky: the bolt starts inside its owner's head box and must ignore it.
    const sky = liveSim('1v1', ['a', 'b']);
    place(sky.p.a, 0, 0);
    place(sky.p.b, 40, 40);
    let seq = sky.p.a.sim.lastSeq;
    sky.sim.queueCommand('a', makeCommand(++seq, { pitch: 0.5, buttons: Buttons.Fire }));
    const out = settle(sky.sim, 100);
    const proj = out.find((e) => e.type === 'proj')!;
    const end = out.find((e) => e.type === 'projEnd')!;
    expect(end).toMatchObject({ hitId: null, normal: null });
    if (proj.type !== 'proj' || end.type !== 'projEnd') throw new Error('types');
    expect(end.tick - proj.tick).toBe(2.5 * TICK_RATE - 1); // 150 segments, two per tick, the first in the firing tick
    expect(sky.p.a.sim.hp).toBe(100);
  });

  it('is cleared when a new round starts', () => {
    const { sim, p } = liveSim('1v1', ['a', 'b']);
    place(p.a, 0, 0);
    place(p.b, 40, 40);
    fireBolt(sim, p.a, 0, 30, -60);
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.projectiles.list).toHaveLength(1);
    sim.startMatch();
    expect(sim.projectiles.list).toHaveLength(0);
  });

  it('hits what the shooter saw (rewound for the whole flight, capped)', () => {
    const { sim, p } = liveSim('1v1', ['a', 'b']);
    place(p.a, 0, 0);
    place(p.b, 0, -8);
    for (let i = 0; i < 5; i++) sim.step();
    const seenAt = sim.tick - 4; // the target stood still from seenAt through now
    place(p.b, 2.5, -8); // ...and sidesteps now
    sim.step();
    fireBolt(sim, p.a, 0, 1.1, -8, seenAt);
    const ev = settle(sim, 40);
    expect(ev.find((e) => e.type === 'projEnd')).toMatchObject({ hitId: 'b' });

    // A view tick far beyond the 220 ms cap is clamped, so aiming at the stale position misses.
    const late = liveSim('1v1', ['a', 'b']);
    place(late.p.a, 0, 0);
    place(late.p.b, 0, -8);
    for (let i = 0; i < 5; i++) late.sim.step();
    const stale = late.sim.tick - 4;
    place(late.p.b, 2.5, -8);
    for (let i = 0; i < 20; i++) late.sim.step();
    fireBolt(late.sim, late.p.a, 0, 1.1, -8, stale);
    const ev2 = settle(late.sim, 40);
    expect(ev2.find((e) => e.type === 'projEnd')).toMatchObject({ hitId: null });
    expect(late.p.b.sim.hp).toBe(100);
  });
});

describe('loadouts', () => {
  it('validates picks per slot', () => {
    const sim = new ArenaSimulation(flatArenaMap(), '1v1');
    sim.addPlayer({ id: 'a', name: 'A', color: 1 });
    sim.addPlayer({ id: 'b', name: 'B', color: 2 });
    sim.startMatch();
    expect(sim.phase).toBe('loadout');
    const a = sim.players.get('a')!;
    sim.setLoadout('a', WeaponId.Sniper, WeaponId.HandCannon);
    expect(a.sim.weapons.map((w) => w.id)).toEqual([WeaponId.Sniper, WeaponId.HandCannon, WeaponId.Blade]);
    sim.setLoadout('a', WeaponId.Pistol, WeaponId.Rifle);
    sim.setLoadout('a', 'smg', { id: 5 });
    sim.setLoadout('a', 99, -1);
    expect([a.primary, a.secondary]).toEqual([WeaponId.Sniper, WeaponId.HandCannon]);
    sim.setLoadout('a', WeaponId.Lmg, WeaponId.MachinePistol);
    expect(a.sim.weapons.map((w) => [w.id, w.mag])).toEqual([[WeaponId.Lmg, 80], [WeaponId.MachinePistol, 20], [WeaponId.Blade, 0]]);
  });

  it('gives bots weighted picks of every weapon', () => {
    const rnd = mulberry32(5);
    const counts = new Map<WeaponId, number>();
    const second = new Set<WeaponId>();
    for (let i = 0; i < 1000; i++) {
      const lo = pickBotLoadout(rnd);
      counts.set(lo.primary, (counts.get(lo.primary) ?? 0) + 1);
      second.add(lo.secondary);
    }
    for (const id of PRIMARY_WEAPONS) expect(counts.get(id) ?? 0, weaponDef(id).name).toBeGreaterThan(0);
    expect(second).toEqual(new Set(SECONDARY_WEAPONS));
    expect(Math.abs((counts.get(WeaponId.Rifle) ?? 0) / 10 - 18)).toBeLessThanOrEqual(4);
    expect(BOT_PRIMARY_WEIGHTS.reduce((s, [, w]) => s + w, 0)).toBe(100);
  });
});

describe('weapon state on the wire', () => {
  it('round-trips ADS, burst and the new weapon ids', () => {
    const self = createPlayerSim(WeaponId.Lmg, WeaponId.MachinePistol);
    Object.assign(self, { ads: 0.25, burstLeft: 2 });
    const back = decodeSnapshot(encodeSnapshot(1, 1, self, encodePoses([{ index: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 1, hp: 100, weapon: WeaponId.MachinePistol }])), 0);
    expect(back.self!.ads).toBeCloseTo(0.25, 6);
    expect(back.self!.burstLeft).toBe(2);
    expect(back.self!.weapons.map((w) => [w.id, w.mag, w.reserve])).toEqual([[9, 80, 80], [11, 20, 60], [4, 0, 0]]);
    expect(back.poses[0].weapon).toBe(11);
  });
});
