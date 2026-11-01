import { describe, expect, it } from 'vitest';
import { Block, buildTestArena, DamageKind, EntityEventType, MobFlag, MobKind, StructureType, type StructureInfo } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer, type TestSetup } from './mobWorld';

function arena(type: StructureType, mode: 'survival' | 'sandbox' = 'survival'): TestSetup & { info: StructureInfo } {
  const s = setupWorld({ mode, time: 0.5, caps: { maxNatural: 0 } });
  const a = buildTestArena(type, 0, FLOOR, 0);
  for (const [x, y, z, id] of a.edits) s.blocks.set(x, y, z, id);
  s.world.extraStructures.push(a.info);
  return { ...s, info: a.info };
}

const hit = (s: TestSetup, id: number, amount: number, by = 'ana') =>
  s.world.damageMob(id, { amount, kind: DamageKind.Melee, attacker: { type: 'player', id: by }, fromX: 0, fromY: FLOOR + 1, fromZ: 5, knockback: 0, lift: 0, ignoreArmor: true });

const boss = (s: TestSetup) => [...s.world.mobs.values()].find((m) => m.boss);

describe('bosses', () => {
  it('awakens when a survival player enters the arena, not in sandbox or with a dormant altar', () => {
    const s = arena(StructureType.SunscorchTemple);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 12));
    run(s.world, 1);
    expect(boss(s)).toBeUndefined();
    s.players[0].z = 5.5;
    run(s.world, 0.5);
    expect(boss(s)?.kind).toBe(MobKind.SunforgedSentinel);

    const sb = arena(StructureType.SunscorchTemple, 'sandbox');
    sb.players.push(testPlayer('ana', 0.5, FLOOR, 5.5));
    run(sb.world, 1);
    expect(boss(sb)).toBeUndefined();

    const d = arena(StructureType.FrostCitadel);
    d.blocks.set(d.info.altar.x, d.info.altar.y, d.info.altar.z, Block.BossAltarDormant);
    d.players.push(testPlayer('ana', 0.5, FLOOR, 5.5));
    run(d.world, 1);
    expect(boss(d)).toBeUndefined();
  });

  it('scales health by 1.5 for two players and stays inside the arena', () => {
    const s = arena(StructureType.AshenCrypt);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5), testPlayer('bo', -3.5, FLOOR, 5.5));
    run(s.world, 3);
    const b = boss(s)!;
    expect(b.maxHealth).toBeCloseTo(340 * 1.5);
    s.players[0].z = 40;
    s.players[1].z = 40;
    run(s.world, 5);
    expect(b.x).toBeGreaterThanOrEqual(s.info.arena.x0);
    expect(b.x).toBeLessThan(s.info.arena.x1);
    expect(b.z).toBeLessThan(s.info.arena.z1);
  });

  it('every attack telegraphs before dealing damage', () => {
    for (const type of [StructureType.SunscorchTemple, StructureType.FrostCitadel, StructureType.OvergrownShrine, StructureType.AshenCrypt]) {
      const s = arena(type);
      const p = testPlayer('ana', 0.5, FLOOR, 3.5);
      s.players.push(p);
      let firstAction = -1;
      let firstHit = -1;
      for (let i = 0; i < 400 && firstHit < 0; i++) {
        s.world.step();
        const b = boss(s);
        if (firstAction < 0 && b && s.world.events.some((e) => (e.type === EntityEventType.MobAction && e.id === b.id) || e.type === EntityEventType.Telegraph)) firstAction = i;
        if (b && p.hits.some((h) => h.req.attacker?.type === 'mob' && h.req.attacker.id === b.id)) firstHit = i;
        p.health = 20;
      }
      expect(firstHit, `type ${type}`).toBeGreaterThan(0);
      expect(firstAction, `type ${type}`).toBeGreaterThanOrEqual(0);
      expect(firstHit - firstAction, `type ${type}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('changes phase at the thresholds with an invulnerable transition', () => {
    const s = arena(StructureType.SunscorchTemple);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5));
    run(s.world, 3);
    const b = boss(s)!;
    hit(s, b.id, b.maxHealth * 0.55);
    run(s.world, 0.2);
    expect(b.boss!.phase).toBe(2);
    expect(b.boss!.mode).toBe('transition');
    const before = b.health;
    hit(s, b.id, 50);
    expect(b.health).toBe(before);
  });

  it('resets after 15 s without targets and is removed after 60 s with nobody near', () => {
    const s = arena(StructureType.FrostCitadel);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5));
    run(s.world, 3);
    const b = boss(s)!;
    hit(s, b.id, 60);
    s.players[0].z = 30;
    run(s.world, 20);
    expect(b.health).toBe(b.maxHealth);
    s.players[0].z = 200;
    run(s.world, 62);
    expect(s.world.mobs.has(b.id)).toBe(false);
  });

  it('defeat sets the altar dormant exactly once, drops the unique per participant and crumbles minions', () => {
    const s = arena(StructureType.OvergrownShrine);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5), testPlayer('bo', -2.5, FLOOR, 5.5));
    run(s.world, 3);
    const b = boss(s)!;
    const minion = s.world.spawnMob(MobKind.Puffcap, 3.5, FLOOR, 3.5, { flags: MobFlag.Minion })!;
    b.boss!.minions.add(minion.id);
    minion.bossId = b.id;
    hit(s, b.id, b.maxHealth * 0.3, 'ana');
    run(s.world, 2);
    hit(s, b.id, b.maxHealth * 0.3, 'bo');
    run(s.world, 2);
    for (let i = 0; i < 20 && b.alive; i++) {
      hit(s, b.id, b.maxHealth, 'ana');
      run(s.world, 2);
    }
    expect(b.alive).toBe(false);
    run(s.world, 3);
    const altarEdits = s.setBlocks.filter(([x, y, z]) => x === s.info.altar.x && y === s.info.altar.y && z === s.info.altar.z);
    expect(altarEdits).toEqual([[s.info.altar.x, s.info.altar.y, s.info.altar.z, Block.BossAltarDormant]]);
    const unique = s.drops.flatMap((d) => d.stacks).find((st) => st.item === 'thornheart_bow');
    expect(unique?.count).toBe(2);
    expect(minion.alive).toBe(false);
    expect(s.announced[0]).toContain('Thornmaw has fallen');
    // Never again in this world.
    run(s.world, 2);
    expect(boss(s)).toBeUndefined();
  });

  it('a charge into a pillar stuns and stunned bosses take 1.5x damage', () => {
    const s = arena(StructureType.AshenCrypt);
    const p = testPlayer('ana', 0.5, FLOOR, 7.5);
    s.players.push(p);
    let stunned = false;
    for (let i = 0; i < 1200 && !stunned; i++) {
      s.world.step();
      p.health = 20;
      const b = boss(s);
      if (b) {
        // Stay at charging range, against a wall.
        p.x = Math.max(-7, Math.min(7, b.x));
        p.z = b.z > 0 ? -7.5 : 7.5;
      }
      if (b?.boss?.stunned) stunned = true;
    }
    expect(stunned).toBe(true);
    const b = boss(s)!;
    const before = b.health;
    hit(s, b.id, 10);
    expect(before - b.health).toBeCloseTo(15);
  });
});
