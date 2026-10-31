import { describe, expect, it } from 'vitest';
import { Block, EntityEventType, MobAction, MobKind, MobVariant, ProjectileKind, DamageKind } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer } from './mobWorld';

const NIGHT = 0;

describe('hostile creatures', () => {
  it('a Mudlurch chases and hits only after its windup', () => {
    const s = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 6.5, FLOOR, 0.5);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Mudlurch, 0.5, FLOOR, 0.5)!;
    let windupAt = -1;
    let hitAt = -1;
    for (let i = 0; i < 200 && hitAt < 0; i++) {
      s.world.step();
      if (windupAt < 0 && s.world.events.some((e) => e.type === EntityEventType.MobAction && e.id === m.id && e.action === MobAction.Attack)) windupAt = i;
      if (p.hits.length) hitAt = i;
    }
    expect(windupAt).toBeGreaterThan(0);
    expect(hitAt - windupAt).toBeGreaterThanOrEqual(7); // 0.4 s windup at 20 Hz
    expect(p.hits[0].req.kind).toBe(DamageKind.Melee);
    expect(p.hits[0].req.attacker).toEqual({ type: 'mob', id: m.id });
  });

  it('the swing misses if the target stepped away during the windup', () => {
    const s = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 1.8, FLOOR, 0.5);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Mudlurch, 0.5, FLOOR, 0.5)!;
    for (let i = 0; i < 40; i++) {
      s.world.step();
      if (m.action === MobAction.Attack && p.x < 4) p.x = 5;
    }
    expect(p.hits.length).toBe(0);
  });

  it('a Rattlebow keeps its distance and only fires with line of sight', () => {
    const s = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 10.5, FLOOR, 0.5);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Rattlebow, 0.5, FLOOR, 0.5)!;
    let shots = 0;
    run(s.world, 8, () => (shots += s.world.events.filter((e) => e.type === EntityEventType.MobAction && e.id === m.id && e.action === MobAction.Attack).length));
    expect(shots).toBeGreaterThan(0);
    const d = Math.hypot(m.x - p.x, m.z - p.z);
    expect(d).toBeGreaterThan(4);

    const s2 = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    s2.blocks.fill(5, FLOOR, -30, 5, FLOOR + 6, 30, Block.Stone);
    const p2 = testPlayer('bo', 10.5, FLOOR, 0.5);
    s2.players.push(p2);
    s2.world.spawnMob(MobKind.Rattlebow, 0.5, FLOOR, 0.5);
    run(s2.world, 4);
    expect(s2.world.projectiles.list.filter((q) => q.kind === ProjectileKind.MobArrow).length).toBe(0);
  });

  it('a Puffcap inflates and bursts (falloff, blocks unchanged) or deflates when the target leaves', () => {
    const s = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 2.5, FLOOR, 0.5);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Puffcap, 0.5, FLOOR, 0.5)!;
    run(s.world, 3);
    expect(m.alive).toBe(false);
    expect(p.hits.length).toBeGreaterThan(0);
    expect(p.hits[0].req.kind).toBe(DamageKind.Burst);
    expect(p.hits[0].req.amount).toBeLessThan(7);
    expect(s.blocks.edits.size).toBe(0);
    expect(s.world.hazards.list.length).toBe(1);
    expect(s.drops.length).toBe(0);

    const s2 = setupWorld({ time: NIGHT, caps: { maxNatural: 0 } });
    const p2 = testPlayer('bo', 2.5, FLOOR, 0.5);
    s2.players.push(p2);
    const m2 = s2.world.spawnMob(MobKind.Puffcap, 0.5, FLOOR, 0.5)!;
    for (let i = 0; i < 60; i++) {
      s2.world.step();
      if (m2.action === MobAction.Inflate) p2.x = 20;
    }
    expect(m2.alive).toBe(true);
  });

  it('a Mudlurch dries in daylight under open sky (not the Sand variant)', () => {
    const s = setupWorld({ time: 0.5, caps: { maxNatural: 0 } });
    s.players.push(testPlayer('ana', 30, FLOOR, 30, true));
    const m = s.world.spawnMob(MobKind.Mudlurch, 0.5, FLOOR, 0.5)!;
    const sand = s.world.spawnMob(MobKind.Mudlurch, 3.5, FLOOR, 0.5, { variant: MobVariant.Sand })!;
    run(s.world, 3);
    expect(m.health).toBeLessThan(m.maxHealth - 1.5);
    expect(sand.health).toBe(sand.maxHealth);
  });
});

describe('friendly creatures', () => {
  it('a hit Woolback flees and its herd panics', () => {
    const s = setupWorld({ mode: 'sandbox', caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 0.5, FLOOR, -2, false);
    s.players.push(p);
    const a = s.world.spawnMob(MobKind.Woolback, 0.5, FLOOR, 0.5)!;
    const b = s.world.spawnMob(MobKind.Woolback, 3.5, FLOOR, 0.5)!;
    run(s.world, 0.2);
    s.world.damageMob(a.id, { amount: 2, kind: DamageKind.Melee, attacker: { type: 'player', id: 'ana' }, fromX: p.x, fromY: p.y + 1.5, fromZ: p.z, knockback: 4, lift: 2 });
    const d0 = Math.hypot(a.x - p.x, a.z - p.z);
    run(s.world, 2);
    expect(Math.hypot(a.x - p.x, a.z - p.z)).toBeGreaterThan(d0 + 3);
    expect(b.panicUntil).toBeGreaterThan(0);
  });

  it('friendly creatures never damage players', () => {
    const s = setupWorld({ time: 0.5 });
    const p = testPlayer('ana', 0.5, FLOOR, 0.5);
    s.players.push(p);
    for (let i = 0; i < 6; i++) s.world.spawnMob(MobKind.Woolback, i - 2.5, FLOOR, 1.5);
    run(s.world, 10);
    expect(p.hits.length).toBe(0);
  });

  it('wanders around when left alone', () => {
    const s = setupWorld({ mode: 'sandbox', caps: { maxNatural: 0 } });
    s.players.push(testPlayer('ana', 30, FLOOR, 30, false));
    const m = s.world.spawnMob(MobKind.Hopling, 0.5, FLOOR, 0.5)!;
    let moved = 0;
    let lx = m.x;
    run(s.world, 20, () => {
      moved += Math.abs(m.x - lx);
      lx = m.x;
    });
    expect(moved).toBeGreaterThan(2);
  });
});
