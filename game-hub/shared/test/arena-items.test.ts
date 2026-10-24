/**
 * Arcfire Arena interactive items: respawning health packs and ammo crates
 * (design-arena-maps §4.2, §12.1 #5) on an open fixture map.
 */
import { describe, expect, it } from 'vitest';
import {
  type ArenaEvent,
  ArenaSimulation,
  applyPickup,
  createPlayerSim,
  flatArenaMap,
  type MapPickup,
  MAX_HP,
  PICKUP,
  pickupTouches,
  pickupValue,
  TICK_RATE,
  WeaponId,
  weaponDef,
} from '../src';

const HEALTH: MapPickup = { kind: 'health', x: 0, y: 0, z: 0 };
const AMMO: MapPickup = { kind: 'ammo', x: 10, y: 0, z: 0 };

/** Two players on a flat map with a health pack at the origin and an ammo crate at (10, 0, 0). */
function setup(phase: 'live' | 'warmup' = 'live') {
  const sim = new ArenaSimulation(flatArenaMap({ pickups: [HEALTH, AMMO] }), '1v1');
  const a = sim.addPlayer({ id: 'a', name: 'A', color: 1 });
  const b = sim.addPlayer({ id: 'b', name: 'B', color: 2 });
  if (phase === 'live') {
    sim.startMatch();
    sim.phaseTimer = 0;
    sim.step();
    expect(sim.phase).toBe('live');
  }
  sim.drainEvents();
  return { sim, a, b };
}

const pickups = (events: ArenaEvent[]) => events.filter((e): e is Extract<ArenaEvent, { type: 'pickup' }> => e.type === 'pickup');

describe('health packs', () => {
  it('heal +50 HP, emit a pickup event and come back after 20 s in a live round', () => {
    const { sim, a } = setup();
    Object.assign(a.sim, { x: 0.3, y: 0, z: -0.4, hp: 40 });
    sim.step();
    expect(a.sim.hp).toBe(90);
    expect(pickups(sim.drainEvents())).toEqual([{ type: 'pickup', id: 'a', index: 0, kind: 'health', amount: 50 }]);
    expect(sim.pickups.ready[0]).toBe(sim.tick + PICKUP.healthRespawn * TICK_RATE);
    expect(sim.pickups.ready[0] - sim.tick).toBe(600);
    // Still standing on it: nothing until it respawns, then it heals again.
    a.sim.hp = 20;
    for (let i = 0; i < 599; i++) sim.step();
    expect(a.sim.hp).toBe(20);
    sim.step();
    expect(a.sim.hp).toBe(70);
    expect(pickups(sim.drainEvents())).toHaveLength(1);
  });

  it('caps at MAX_HP and is not consumed at full health', () => {
    const { sim, a } = setup();
    Object.assign(a.sim, { x: 0, y: 0, z: 0, hp: MAX_HP });
    sim.step();
    expect(pickups(sim.drainEvents())).toEqual([]);
    expect(sim.pickups.ready[0]).toBe(0);
    a.sim.hp = 85;
    sim.step();
    expect(a.sim.hp).toBe(MAX_HP);
    expect(pickups(sim.drainEvents())[0].amount).toBe(15);
  });

  it('goes to the first player in insertion order on a shared tick', () => {
    const { sim, a, b } = setup();
    Object.assign(b.sim, { x: 0.2, y: 0, z: 0, hp: 30 });
    Object.assign(a.sim, { x: -0.2, y: 0, z: 0, hp: 30 });
    sim.step();
    expect(a.sim.hp).toBe(80);
    expect(b.sim.hp).toBe(30);
    expect(pickups(sim.drainEvents()).map((e) => e.id)).toEqual(['a']);
  });

  it('is collected when jumping over it (feet 1.0 m above) but not from 1.5 m', () => {
    const { sim, a } = setup();
    // No commands are queued, so the player hangs where it is put.
    Object.assign(a.sim, { x: 0, y: 1.5, z: 0, hp: 40, onGround: false, vy: 0 });
    sim.step();
    expect(a.sim.hp).toBe(40);
    expect(pickupTouches(a.sim, HEALTH)).toBe(false);
    a.sim.y = 1.0;
    expect(pickupTouches(a.sim, HEALTH)).toBe(true);
    sim.step();
    expect(a.sim.hp).toBe(90);
  });

  it('ignores the dead, the far and anyone below the pickup', () => {
    const s = createPlayerSim();
    s.hp = 10;
    expect(pickupTouches(s, { ...HEALTH, x: PICKUP.radius + 0.01 })).toBe(false);
    expect(pickupTouches(s, { ...HEALTH, x: PICKUP.radius - 0.01 })).toBe(true);
    expect(pickupTouches(s, { ...HEALTH, y: 0.6 })).toBe(false);
    s.alive = false;
    expect(pickupTouches(s, HEALTH)).toBe(false);
  });
});

describe('ammo crates', () => {
  it('add half of each max reserve to primary and secondary, never past the max, and leave the knife alone', () => {
    const { sim, a } = setup();
    const [rifle, pistol, knife] = a.sim.weapons;
    expect([rifle.id, pistol.id, knife.id]).toEqual([WeaponId.Rifle, WeaponId.Pistol, WeaponId.Blade]);
    rifle.reserve = 10;
    pistol.reserve = 40;
    Object.assign(a.sim, { x: 10, y: 0, z: 0.5 });
    sim.step();
    expect(rifle.reserve).toBe(55); // +45 of 90
    expect(pistol.reserve).toBe(weaponDef(WeaponId.Pistol).reserve); // topped up (+8)
    expect(knife).toEqual({ id: WeaponId.Blade, mag: 0, reserve: 0 });
    expect(pickups(sim.drainEvents())).toEqual([{ type: 'pickup', id: 'a', index: 1, kind: 'ammo', amount: 53 }]);
    expect(sim.pickups.ready[1] - sim.tick).toBe(PICKUP.ammoRespawn * TICK_RATE);
  });

  it('is not consumed with full reserves', () => {
    const { sim, a } = setup();
    Object.assign(a.sim, { x: 10, y: 0, z: 0 });
    sim.step();
    expect(pickups(sim.drainEvents())).toEqual([]);
    expect(sim.pickups.ready[1]).toBe(0);
    expect(pickupValue(a.sim, 'ammo')).toBe(0);
  });

  it('reports the same value it applies', () => {
    const s = createPlayerSim(WeaponId.Sniper);
    s.weapons[0].reserve = 0;
    s.weapons[1].reserve = 47;
    const v = pickupValue(s, 'ammo');
    expect(v).toBe(Math.ceil(15 * PICKUP.ammoFraction) + 1);
    expect(applyPickup(s, 'ammo')).toBe(v);
    expect(s.weapons[0].reserve).toBe(8);
    expect(applyPickup(createPlayerSim(), 'health')).toBe(0);
  });
});

describe('pickup timing', () => {
  it('respawns after 8 s in warmup', () => {
    const { sim, a } = setup('warmup');
    expect(sim.phase).toBe('warmup');
    Object.assign(a.sim, { x: 0, y: 0, z: 0, hp: 50 });
    sim.step();
    expect(a.sim.hp).toBe(100);
    expect(sim.pickups.ready[0] - sim.tick).toBe(PICKUP.warmupRespawn * TICK_RATE);
    expect(sim.pickups.ready[0] - sim.tick).toBe(240);
  });

  it('is available again at the start of every round and frozen outside live play', () => {
    const { sim, a, b } = setup();
    Object.assign(a.sim, { x: 0, y: 0, z: 0, hp: 50 });
    sim.step();
    expect(sim.pickups.ready[0]).toBeGreaterThan(sim.tick);
    // End the round; the next one starts with everything back.
    sim.eliminate(b.id);
    sim.step();
    expect(sim.phase).toBe('roundEnd');
    sim.phaseTimer = 0;
    sim.step();
    expect(sim.phase).toBe('loadout');
    expect(sim.pickups.ready).toEqual([0, 0]);
    // Loadout: standing on a pack does nothing.
    Object.assign(a.sim, { x: 0, y: 0, z: 0, hp: 50 });
    for (let i = 0; i < 5; i++) sim.step();
    expect(a.sim.hp).toBe(50);
    expect(sim.pickups.ready[0]).toBe(0);
  });

  it('resizes with the map', () => {
    const { sim } = setup();
    sim.changeMap(flatArenaMap({ pickups: [HEALTH, HEALTH, AMMO] }));
    expect(sim.pickups.ready).toEqual([0, 0, 0]);
    sim.changeMap(flatArenaMap());
    expect(sim.pickups.ready).toEqual([]);
  });
});
