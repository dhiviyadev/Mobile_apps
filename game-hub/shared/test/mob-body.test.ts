import { describe, expect, it } from 'vitest';
import { Block, collides, collidesBox, fallDamage, MobKind, PLAYER_WIDTH, stepMobBody, tickEffects, StatusKind, applyDamage, DamageKind } from '../src/index';
import { FLOOR, FlatBlocks, setupWorld } from './mobWorld';

function mob(kind: MobKind, x = 0.5, y = FLOOR + 3, z = 0.5, blocks = new FlatBlocks()) {
  const s = setupWorld({ blocks });
  const m = s.world.spawnMob(kind, x, y, z)!;
  return { m, s, get: blocks.get };
}

describe('mob body', () => {
  it('lands on the floor', () => {
    const { m, get } = mob(MobKind.Woolback);
    for (let i = 0; i < 40; i++) stepMobBody(m, get, 0.05, 1);
    expect(m.y).toBeCloseTo(FLOOR, 5);
    expect(m.onGround).toBe(true);
  });

  it('auto-jumps a 1-block step but not a 2-block wall', () => {
    const b = new FlatBlocks();
    b.fill(3, FLOOR, -3, 12, FLOOR, 3, Block.Stone);
    const { m, get } = mob(MobKind.Mudlurch, 0.5, FLOOR, 0.5, b);
    for (let i = 0; i < 60; i++) {
      m.intent.vx = 3;
      stepMobBody(m, get, 0.05, 1);
    }
    expect(m.x).toBeGreaterThan(3.5);
    expect(m.y).toBeCloseTo(FLOOR + 1, 3);

    const b2 = new FlatBlocks();
    b2.fill(3, FLOOR, -3, 3, FLOOR + 1, 3, Block.Stone);
    const r = mob(MobKind.Mudlurch, 0.5, FLOOR, 0.5, b2);
    for (let i = 0; i < 60; i++) {
      r.m.intent.vx = 3;
      stepMobBody(r.m, r.get, 0.05, 1);
    }
    expect(r.m.x).toBeLessThan(3);
  });

  it('floats to the water surface', () => {
    const b = new FlatBlocks();
    b.fill(-3, FLOOR - 4, -3, 3, FLOOR - 1, 3, Block.Water);
    const { m, get } = mob(MobKind.Woolback, 0.5, FLOOR - 3.5, 0.5, b);
    for (let i = 0; i < 80; i++) stepMobBody(m, get, 0.05, 1);
    expect(m.y).toBeGreaterThan(FLOOR - 1.5);
  });

  it('lets a Cragcrawler climb a 4-high wall', () => {
    const b = new FlatBlocks();
    b.fill(2, FLOOR, -3, 20, FLOOR + 3, 3, Block.Stone);
    const { m, get } = mob(MobKind.Cragcrawler, 0.5, FLOOR, 0.5, b);
    for (let i = 0; i < 120; i++) {
      m.intent.vx = 3;
      m.intent.climb = true;
      stepMobBody(m, get, 0.05, 1);
    }
    expect(m.y).toBeGreaterThanOrEqual(FLOOR + 4 - 0.01);
  });

  it('does not tunnel when falling fast onto a thin floor', () => {
    const b = new FlatBlocks(2);
    b.fill(-2, 20, -2, 2, 20, 2, Block.Stone);
    const { m, get } = mob(MobKind.Mudlurch, 0.5, 30, 0.5, b);
    m.vy = -30;
    for (let i = 0; i < 40; i++) stepMobBody(m, get, 0.05, 1);
    expect(m.y).toBeCloseTo(21, 3);
  });

  it('collidesBox with the player half width equals collides', () => {
    const b = new FlatBlocks();
    for (const [x, y, z] of [[0.5, FLOOR, 0.5], [0.5, FLOOR - 0.5, 0.5], [3.2, FLOOR + 0.1, -1]]) {
      expect(collidesBox(b.get, x, y, z, PLAYER_WIDTH / 2, 1.8)).toBe(collides(b.get, x, y, z));
    }
  });
});

describe('combat (creature cases)', () => {
  it('fall damage: 13 b/s is safe, 20 b/s deals 4', () => {
    expect(fallDamage(13)).toBe(0);
    expect(fallDamage(20)).toBe(4);
  });

  it('burn ticks and slow multiplier with its floor', () => {
    const { m } = mob(MobKind.Mudlurch);
    applyDamage(m, { amount: 1, kind: DamageKind.Melee, attacker: null, fromX: 0, fromY: 0, fromZ: 0, knockback: 0, lift: 0, effects: [{ kind: StatusKind.Burn, strength: 1, seconds: 2 }, { kind: StatusKind.Slow, strength: 0.95, seconds: 2 }] });
    let burnt = 0;
    const mul = tickEffects(m, 1, (a) => (burnt += a));
    expect(burnt).toBeCloseTo(1);
    expect(mul).toBeCloseTo(0.2);
  });

  it('a mob hit from the side is pushed away and up', () => {
    const { m } = mob(MobKind.Woolback);
    const r = applyDamage(m, { amount: 2, kind: DamageKind.Melee, attacker: null, fromX: m.x - 1, fromY: m.y, fromZ: m.z, knockback: 5, lift: 3 });
    expect(r.dvx).toBeGreaterThan(4);
    expect(m.vy).toBeCloseTo(3);
  });
});
