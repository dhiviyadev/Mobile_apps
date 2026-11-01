import { describe, expect, it } from 'vitest';
import {
  Block,
  type ClientEvent,
  createWorldGenerator,
  DamageKind,
  decodeAttack,
  decodeInvOp,
  decodeInvSync,
  decodeShoot,
  decodeSurvivalEvents,
  decodeVitals,
  encodeAttack,
  encodeInvOp,
  encodeInvSync,
  encodeRecord,
  encodeShoot,
  encodeVitals,
  type EntityWorldApi,
  HandFlags,
  InteractKind,
  Item,
  LoadedAmmo,
  loadedOf,
  OFFHAND,
  packRecords,
  type ProjectileSpawn,
  RefType,
  SURVIVAL,
  type SurvivalEvent,
  type SurvivalHost,
  SurvivalSim,
  Team,
} from '../src/index';

/** A flat world: stone up to y 9, air above; overrides per cell. */
function makeWorld() {
  const cells = new Map<string, number>();
  const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? (y < 10 ? Block.Stone : Block.Air);
  return { get, set: (x: number, y: number, z: number, id: number) => cells.set(`${x},${y},${z}`, id) };
}

function makeSim(opts: { creative?: boolean; pvp?: boolean; keep?: boolean; time?: number } = {}) {
  const world = makeWorld();
  let now = 1_000_000;
  let time = opts.time ?? 0.5;
  const shots: ProjectileSpawn[] = [];
  const mobHits: { id: number; amount: number }[] = [];
  const announced: string[] = [];
  const teleports: [string, number, number, number][] = [];
  let skipped = 0;
  const api: EntityWorldApi = {
    raycast: () => ({ id: 7, distance: 2 }),
    damageMob: (id, req) => {
      mobHits.push({ id, amount: req.amount });
      return { dealt: req.amount, blocked: false, killed: false, ignored: false, dvx: 0, dvy: 0, dvz: 0 };
    },
    spawnProjectile: (s) => (shots.push(s), shots.length),
    removeProjectile: () => {},
    onBlockChanged: () => {},
    mobsNear: () => [],
    overlapsCell: () => false,
    mobName: () => 'a Mudlurch',
  };
  const host: SurvivalHost = {
    getBlock: () => world.get,
    generator: createWorldGenerator(1, 'survival'),
    now: () => now,
    random: () => 0,
    timeOfDay: () => time,
    skipNight: () => {
      skipped++;
      time = 0.23;
    },
    teleport: (id, x, y, z) => teleports.push([id, x, y, z]),
    announce: (t) => announced.push(t),
    entities: () => api,
  };
  const sim = new SurvivalSim(host, { pvp: !!opts.pvp, keepInventory: !!opts.keep, creative: !!opts.creative }, { satchelsExpire: true });
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) {
      now += 50;
      sim.preTick();
      sim.tick(0.05);
    }
  };
  const advance = (ms: number) => (now += ms);
  return { sim, world, step, advance, shots, mobHits, announced, teleports, skipped: () => skipped };
}

const damages = (ev: SurvivalEvent[]) => ev.filter((e): e is Extract<SurvivalEvent, { type: 'damage' }> => e.type === 'damage');

describe('SurvivalSim', () => {
  it('times breaks, drops and picks up items, and consumes placed blocks', () => {
    const { sim, step, advance } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    expect(sim.validateBreak('a', 1, 9, 0, Block.Stone)).toBe('not digging');
    p.inv.set(0, { item: Item.WoodenPickaxe, count: 1, meta: 0 });
    sim.digStart('a', 1, 9, 0);
    expect(sim.validateBreak('a', 1, 9, 0, Block.Stone)).toBe('too fast');
    advance(800);
    expect(sim.validateBreak('a', 1, 9, 0, Block.Stone)).toBeNull();
    sim.onEdit('a', 1, 9, 0, Block.Stone, Block.Air);
    expect(p.inv.get(0)!.meta).toBe(1); // wear
    step(1.5);
    expect(p.inv.count(Block.Cobble)).toBe(1);
    p.selected = 2;
    p.inv.set(2, { item: Block.Dirt, count: 2, meta: 0 });
    expect(sim.validatePlace('a', Block.Stone, Block.Air)).toBe('not held');
    expect(sim.validatePlace('a', Block.Dirt, Block.Air)).toBeNull();
    sim.onEdit('a', 2, 10, 0, Block.Air, Block.Dirt);
    expect(p.inv.get(2)!.count).toBe(1);
  });

  it('crafts at a workbench only when one is near', () => {
    const { sim, world } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    p.inv.set(0, { item: Block.Planks, count: 8, meta: 0 });
    p.inv.set(1, { item: Item.Stick, count: 4, meta: 0 });
    sim.invOp('a', 1, { op: 'craft', recipe: 23, times: 1 });
    expect(p.inv.count(Item.WoodenSword)).toBe(0);
    world.set(2, 10, 0, Block.Workbench);
    sim.invOp('a', 2, { op: 'craft', recipe: 23, times: 1 });
    expect(p.inv.count(Item.WoodenSword)).toBe(1);
    expect(p.invAck).toBe(2);
  });

  it('melee: cooldown, PvP rule, rewind window, shields and axes', () => {
    const { sim, step, advance } = makeSim({ pvp: false });
    const a = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    const b = sim.addPlayer('b', 2, 'Ben', null, null, { x: 0.5, y: 10, z: -1.5 });
    a.protectedUntil = b.protectedUntil = 0;
    a.inv.set(0, { item: Item.WoodenSword, count: 1, meta: 0 });
    const swing = (yaw = 0) => sim.attack('a', { seq: 1, target: { refType: RefType.Player, id: 2 }, ex: 0.5, ey: 11.62, ez: 0.5, yaw, pitch: -0.25, crit: false, sprint: false });
    step(0.1);
    swing();
    expect(b.health).toBe(20); // PvP off
    sim.setRules({ pvp: true });
    advance(600);
    swing();
    expect(b.health).toBe(16);
    const dmg = damages(sim.takeEvents());
    expect(dmg[0].dvz).toBeLessThan(0);
    swing(); // cooldown
    expect(b.health).toBe(16);
    // Rewind: B moved away 200 ms ago -> still hit; 450 ms ago -> missed.
    advance(600);
    b.hurtTime = 0;
    step(0.2);
    b.x = 6;
    step(0.15);
    swing();
    expect(b.health).toBe(12);
    advance(600);
    b.hurtTime = 0;
    step(0.5);
    swing();
    expect(b.health).toBe(12);
    // Shield in front blocks 70% (the guard needs 0.2 s raised).
    b.x = 0.5;
    b.yaw = Math.PI; // facing +Z, toward A
    b.inv.set(OFFHAND, { item: Item.WoodenShield, count: 1, meta: 0 });
    sim.setHand('b', 0, HandFlags.Guard, 0);
    advance(600);
    step(0.3);
    swing();
    expect(b.health).toBeCloseTo(12 - 4 * 0.3, 5);
    // An axe disables the shield for 1.6 s.
    a.inv.set(0, { item: Item.StoneAxe, count: 1, meta: 0 });
    advance(1000);
    b.hurtTime = 0;
    step(0.1);
    swing();
    expect(b.shieldDisabledUntil).toBeGreaterThan(sim.now() + 1500);
    // Mobs: raycast + damageMob.
  });

  it('melee on creatures goes through the creature api', () => {
    const { sim, mobHits } = makeSim();
    sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    sim.attack('a', { seq: 1, target: { refType: RefType.Mob, id: 7 }, ex: 0.5, ey: 11.62, ez: 0.5, yaw: 0, pitch: 0, crit: true, sprint: false });
    expect(mobHits).toEqual([{ id: 7, amount: 1 }]); // fist; crit needs a real fall
  });

  it('bows charge on the server clock, use ammo and spawn projectiles; crossbows load and fire', () => {
    const { sim, step, advance, shots } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    p.inv.set(0, { item: Item.Bow, count: 1, meta: 0 });
    p.inv.set(5, { item: Item.Arrow, count: 3, meta: 0 });
    sim.setHand('a', 0, HandFlags.Use, 0);
    advance(300);
    sim.shoot('a', { seq: 4, ox: 0.5, oy: 11.62, oz: 0.5, yaw: 0, pitch: 0, charge: 1 });
    expect(shots).toHaveLength(1);
    expect(shots[0].damage).toBe(5.5); // capped by the server's draw time (charge 0.5)
    expect(shots[0].pickupItem).toBe('arrow');
    expect(shots[0].team).toBe(Team.Player);
    expect(p.inv.count(Item.Arrow)).toBe(2);
    sim.shoot('a', { seq: 5, ox: 0.5, oy: 11.62, oz: 0.5, yaw: 0, pitch: 0, charge: 1 });
    expect(shots).toHaveLength(1); // needs a new draw
    p.inv.set(1, { item: Item.Crossbow, count: 1, meta: 0 });
    p.inv.set(6, { item: Item.Bolt, count: 2, meta: 0 });
    sim.setHand('a', 1, HandFlags.Use, 0);
    step(0.6);
    expect(loadedOf(p.inv.metas[1])).toBe(LoadedAmmo.None);
    step(0.7);
    expect(loadedOf(p.inv.metas[1])).toBe(LoadedAmmo.Bolt);
    expect(p.inv.count(Item.Bolt)).toBe(1);
    sim.setHand('a', 1, 0, 0);
    sim.shoot('a', { seq: 6, ox: 0.5, oy: 11.62, oz: 0.5, yaw: 0, pitch: 0, charge: 1 });
    expect(shots[1].damage).toBe(11);
    expect(Math.hypot(shots[1].vx, shots[1].vy, shots[1].vz)).toBeCloseTo(48, 3);
    expect(loadedOf(p.inv.metas[1])).toBe(LoadedAmmo.None);
  });

  it('eats over one second, regenerates with food and starves no lower than 6 HP', () => {
    const { sim, step } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    p.protectedUntil = 0;
    p.food = 10;
    p.inv.set(0, { item: Item.Bread, count: 2, meta: 0 });
    sim.setHand('a', 0, HandFlags.Use, 0);
    step(1.1);
    expect(p.inv.count(Item.Bread)).toBe(1);
    expect(p.food).toBeGreaterThan(15.9);
    sim.setHand('a', 0, 0, 0);
    p.health = 10;
    p.lastHurtMs = -1e9;
    step(3.1);
    expect(p.health).toBe(11);
    p.food = 0;
    p.health = 7;
    step(17);
    expect(p.health).toBe(6);
    step(20);
    expect(p.health).toBe(6);
  });

  it('death drops one owner-only satchel, keep-items skips it, respawn uses the bedroll', () => {
    const { sim, world, step, advance, teleports } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', 'k1', null, { x: 0.5, y: 10, z: 0.5 });
    const q = sim.addPlayer('b', 2, 'Ben', 'k2', null, { x: 30.5, y: 10, z: 0.5 });
    p.protectedUntil = q.protectedUntil = 0;
    p.inv.set(0, { item: Item.IronSword, count: 1, meta: 3 });
    p.inv.set(9, { item: Block.Dirt, count: 20, meta: 0 });
    world.set(3, 10, 3, Block.Bedroll);
    sim.interact('a', InteractKind.UseBedroll, 3, 10, 3);
    expect(p.spawn).toEqual({ x: 3, y: 10, z: 3 });
    sim.debugDamage('a', 25);
    expect(p.alive).toBe(false);
    expect(p.inv.isEmpty()).toBe(true);
    const satchels = [...sim.drops.list.values()].filter((d) => d.satchel);
    expect(satchels).toHaveLength(1);
    expect(satchels[0].satchel!.items).toHaveLength(2);
    expect(p.dead!.satchel).not.toBeNull();
    // Someone else can't take it within 5 minutes.
    sim.setPose('b', 0.5, 10, 0.5, 0, 0, false, false);
    step(1);
    expect(q.inv.isEmpty()).toBe(true);
    sim.respawn('a');
    expect(p.alive).toBe(true);
    expect(p.health).toBe(20);
    expect(teleports.at(-1)![1]).toBeGreaterThan(2);
    // The owner picks it up.
    sim.setPose('a', 0.5, 10, 0.5, 0, 0, false, false);
    step(0.5);
    expect(p.inv.count(Item.IronSword)).toBe(1);
    // Keep items.
    sim.setRules({ keepInventory: true });
    advance(4000);
    sim.debugDamage('a', 25);
    expect(p.inv.count(Item.IronSword)).toBe(1);
  });

  it('takes fall damage beyond 4 blocks and protects just-respawned players', () => {
    const { sim } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 20, z: 0.5 });
    sim.setPose('a', 0.5, 20, 0.5, 0, 0, false, false);
    sim.setPose('a', 0.5, 10, 0.5, 0, 0, false, false);
    expect(p.health).toBe(20); // spawn protection
    p.protectedUntil = 0;
    for (let y = 20; y >= 10; y -= 1) sim.setPose('a', 0.5, y, 0.5, 0, 0, false, false);
    expect(p.health).toBe(14);
  });

  it('skips the night once every player rests, and creative never hurts anyone', () => {
    const night = makeSim({ time: 0.95 });
    const p = night.sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    night.world.set(1, 10, 0, Block.Bedroll);
    night.sim.interact('a', InteractKind.UseBedroll, 1, 10, 0);
    expect(p.resting).toBe(true);
    night.step(2.2);
    expect(night.skipped()).toBe(1);
    const c = makeSim({ creative: true });
    const q = c.sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    expect(c.sim.damagePlayer('a', { amount: 5, kind: DamageKind.Melee, attacker: { type: 'mob', id: 1 }, fromX: 0, fromY: 0, fromZ: 0, knockback: 1, lift: 0 }).ignored).toBe(true);
    expect(q.health).toBe(20);
    q.creativeItem = Item.Bow;
    c.sim.setHand('a', 0, HandFlags.Use, Item.Bow);
    c.advance(900);
    c.sim.shoot('a', { seq: 1, ox: 0.5, oy: 11.6, oz: 0.5, yaw: 0, pitch: 0, charge: 1 });
    expect(c.shots[0].pickupItem).toBeNull();
    expect(c.shots[0].stickSeconds).toBe(10);
  });

  it('applies mob damage with knockback, burn and the record shape', () => {
    const { sim, step } = makeSim();
    const p = sim.addPlayer('a', 1, 'Ana', null, null, { x: 0.5, y: 10, z: 0.5 });
    p.protectedUntil = 0;
    sim.takeEvents();
    const res = sim.damagePlayer('a', { amount: 3, kind: DamageKind.Projectile, attacker: { type: 'mob', id: 9 }, fromX: 0.5, fromY: 11, fromZ: 3, knockback: 4, lift: 2, effects: [{ kind: 2, strength: 1, seconds: 2 }] });
    expect(res.dealt).toBe(3);
    const [d] = damages(sim.takeEvents());
    expect(d.source).toEqual({ refType: RefType.Mob, id: 9 });
    expect(d.dvz).toBeLessThan(0);
    expect(p.knockUntil).toBeGreaterThan(sim.now());
    step(2.5);
    expect(p.health).toBeLessThanOrEqual(15.5);
    expect(p.takeVitals(sim.now(), true)!.hpHalf).toBe(Math.ceil(p.health * 2));
  });

  it('tick stays within budget with 16 players and 160 drops', () => {
    const { sim, step } = makeSim();
    for (let i = 0; i < 16; i++) sim.addPlayer(`p${i}`, i + 1, `P${i}`, null, null, { x: i * 3 + 0.5, y: 10, z: 0.5 });
    for (let i = 0; i < 160; i++) sim.drops.spawn(Block.Dirt, 1, 0, (i % 40) * 2 + 100, 11, Math.floor(i / 40) * 2 + 100);
    step(2);
    const t0 = performance.now();
    step(5);
    const perTick = (performance.now() - t0) / 100;
    console.log(`SurvivalSim.tick: ${perTick.toFixed(3)} ms (16 players, 160 drops)`);
    // The design budget is 0.5 ms on a desktop core; shared CI runners are slower and noisier.
    // Either way it is a tiny share of the 50 ms room tick.
    expect(perTick).toBeLessThan(process.env.CI ? 2 : 0.5);
  });
});

describe('survival protocol', () => {
  it('round-trips C->S messages', () => {
    const a = { seq: 9, target: { refType: 1, id: 300 }, ex: 1.5, ey: 2.25, ez: -3, yaw: 1, pitch: -0.5, crit: true, sprint: false };
    const enc = encodeAttack(a);
    expect(enc.length).toBe(22);
    const back = decodeAttack(enc);
    expect(back.yaw).toBeCloseTo(1, 3);
    expect({ ...back, yaw: 1, pitch: -0.5 }).toEqual(a);
    expect(encodeShoot({ seq: 1, ox: 0, oy: 1, oz: 2, yaw: 0, pitch: 0, charge: 1 }).length).toBe(19);
    expect(decodeShoot(encodeShoot({ seq: 1, ox: 0, oy: 1, oz: 2, yaw: 0, pitch: 0, charge: 0.5 })).charge).toBeCloseTo(0.5, 2);
    for (const op of [{ op: 'move', from: 1, to: 64, count: 3 }, { op: 'craft', recipe: 41, times: 5 }, { op: 'sort' }, { op: 'swapHands' }] as const) {
      expect(decodeInvOp(encodeInvOp(77, op))).toEqual({ seq: 77, op });
    }
  });

  it('round-trips S records, skips unknown types, and InvSync / vitals', () => {
    const dmg: ClientEvent = { type: 'damage', target: { refType: 1, id: 2 }, source: { refType: 2, id: 5 }, amount: 4.5, kind: DamageKind.Melee, flags: 3, dvx: 1.25, dvy: 2, dvz: -3.5, x: 1, y: 2, z: 3, hpAfter: 15.5, maxHp: 20 };
    const rec = encodeRecord(dmg);
    expect(rec.length).toBe(2 + 32);
    const unknown = new Uint8Array([99, 3, 1, 2, 3]);
    const drop: ClientEvent = { type: 'dropSpawn', id: 4, item: 306, count: 1, meta: 12, x: 1, y: 2, z: 3, vx: 1.2, vy: 2.5, vz: 0, satchel: true, yours: true };
    const evs = decodeSurvivalEvents(packRecords([rec, unknown, encodeRecord(drop)]));
    expect(evs).toEqual([dmg, drop]);
    const sync = { ack: 12, full: true, containerFull: false, slots: Array.from({ length: 64 }, (_, i) => [i < 37 ? i : i + 27, i, 1, 0] as [number, number, number, number]) };
    expect(decodeInvSync(encodeInvSync(sync))).toEqual(sync);
    const v = { hpHalf: 33, foodHalf: 40, air: 10, flags: 4, slowPct: 35, slowTenths: 20, burnTenths: 0 };
    expect(decodeVitals(encodeVitals(v))).toEqual(v);
    expect(SURVIVAL.guardArcCos).toBeCloseTo(0.5, 5);
  });
});
