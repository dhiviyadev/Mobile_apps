import { describe, expect, it } from 'vitest';
import { MAX_TAMED, MobFlag, MobKind } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer } from './mobWorld';

function feedUntilTamed(s: ReturnType<typeof setupWorld>, id: number, who = 'ana'): void {
  const p = s.players.find((q) => q.id === who)!;
  for (let i = 0; i < 40; i++) {
    p.held = 'block:HayBale';
    if (s.world.interact(id, p, 'block:HayBale') === 'tamed') return;
  }
  throw new Error('never tamed');
}

describe('taming', () => {
  it('feeding a liked item tames (seeded), and consumes it in survival', () => {
    const s = setupWorld({ caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 0.5, FLOOR, 2.5);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Woolback, 0.5, FLOOR, 0.5)!;
    expect(s.world.interact(m.id, p, 'apple')).toBe('none');
    p.held = null;
    expect(s.world.interact(m.id, p, 'block:HayBale')).toBe('none'); // nothing in hand to consume
    feedUntilTamed(s, m.id);
    expect(m.has(MobFlag.Tamed)).toBe(true);
    expect(m.owner).toBe('ana');
    expect(s.world.interact(m.id, p, null)).toBe('name');
    s.players.push(testPlayer('bo', 1, FLOOR, 1));
    expect(s.world.interact(m.id, s.players[1], null)).toBe('not-owner');
  });

  it('two tamed lovers make a tamed baby, then wait 300 s; babies grow after 480 s', () => {
    const s = setupWorld({ mode: 'sandbox', caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 0.5, FLOOR, 4.5, false);
    s.players.push(p);
    const a = s.world.spawnMob(MobKind.Woolback, 0.5, FLOOR, 0.5)!;
    const b = s.world.spawnMob(MobKind.Woolback, 2.5, FLOOR, 0.5)!;
    feedUntilTamed(s, a.id);
    feedUntilTamed(s, b.id);
    expect(s.world.interact(a.id, p, 'block:HayBale')).toBe('love');
    expect(s.world.interact(b.id, p, 'block:HayBale')).toBe('love');
    p.held = null;
    run(s.world, 10);
    const babies = [...s.world.mobs.values()].filter((m) => m.has(MobFlag.Baby));
    expect(babies.length).toBe(1);
    expect(babies[0].has(MobFlag.Tamed)).toBe(true);
    expect(a.breedCooldown).toBeGreaterThan(s.world.time + 280);
    expect(s.world.interact(a.id, p, 'block:HayBale')).toBe('none');
    run(s.world, 481);
    expect(babies[0].has(MobFlag.Baby)).toBe(false);
  });

  it('rename only by the owner, sanitised to 16 chars; the world keeps at most 64', () => {
    const s = setupWorld({ mode: 'sandbox', caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 0.5, FLOOR, 4.5, false);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Hopling, 0.5, FLOOR, 0.5)!;
    for (let i = 0; i < 40 && !m.has(MobFlag.Tamed); i++) s.world.interact(m.id, p, 'apple');
    expect(s.world.rename(m.id, 'bo', 'Nope')).toBe(false);
    expect(s.world.rename(m.id, 'ana', 'Sir Hops-a-lot the Third')).toBe(true);
    expect(m.name.length).toBeLessThanOrEqual(16);
    for (let i = 0; i < MAX_TAMED; i++) s.world.dormant.push({ ...s.world.saveMobs()[0] });
    const w2 = s.world.spawnMob(MobKind.Hopling, 3.5, FLOOR, 0.5)!;
    expect(s.world.interact(w2.id, p, 'apple')).toBe('cap');
  });

  it('dormancy keeps tamed creatures far away and brings them back', () => {
    const s = setupWorld({ mode: 'sandbox', caps: { maxNatural: 0 } });
    const p = testPlayer('ana', 0.5, FLOOR, 4.5, false);
    s.players.push(p);
    const m = s.world.spawnMob(MobKind.Woolback, 0.5, FLOOR, 0.5)!;
    feedUntilTamed(s, m.id);
    s.world.rename(m.id, 'ana', 'Fluffy');
    p.x = 200;
    run(s.world, 1);
    expect(s.world.mobs.has(m.id)).toBe(false);
    expect(s.world.dormant.length).toBe(1);
    p.x = 0.5;
    run(s.world, 2);
    const back = [...s.world.mobs.values()].find((q) => q.name === 'Fluffy');
    expect(back?.has(MobFlag.Tamed)).toBe(true);
  });
});
