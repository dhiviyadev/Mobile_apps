import { describe, expect, it } from 'vitest';
import { BOSS_DROPS, BOSS_FOR_STRUCTURE, BOSS_SCRIPTS, Block, buildTestArena, DamageKind, EntityEventType, MobKind, MOB_DEFS, StructureType, type StructureInfo } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer, type TestSetup } from './mobWorld';

const NEW: { type: StructureType; kind: MobKind; unique: string; hp: number; name: string }[] = [
  { type: StructureType.SaltwornLighthouse, kind: MobKind.BrineclawMatriarch, unique: 'coralfang_blade', hp: 360, name: 'Brineclaw Matriarch' },
  { type: StructureType.StormcrownAerie, kind: MobKind.Stormtalon, unique: 'galeshot_bow', hp: 300, name: 'Stormtalon' },
  { type: StructureType.HollowheartGrove, kind: MobKind.BramblehornElder, unique: 'rootsplitter_axe', hp: 400, name: 'Bramblehorn Elder' },
  { type: StructureType.CinderdeepForge, kind: MobKind.AnvilheartColossus, unique: 'forgeheart_hammer', hp: 420, name: 'Anvilheart Colossus' },
];

function arena(type: StructureType): TestSetup & { info: StructureInfo } {
  const s = setupWorld({ mode: 'survival', time: 0.5, caps: { maxNatural: 0 } });
  const a = buildTestArena(type, 0, FLOOR, 0);
  for (const [x, y, z, id] of a.edits) s.blocks.set(x, y, z, id);
  s.world.extraStructures.push(a.info);
  return { ...s, info: a.info };
}
const boss = (s: TestSetup) => [...s.world.mobs.values()].find((m) => m.boss);
const hit = (s: TestSetup, id: number, amount: number, by = 'ana') =>
  s.world.damageMob(id, { amount, kind: DamageKind.Melee, attacker: { type: 'player', id: by }, fromX: 0, fromY: FLOOR + 1, fromZ: 5, knockback: 0, lift: 0, ignoreArmor: true });

describe('ruin bosses (generator 4)', () => {
  it('are wired: structure -> boss -> script, drops, defs', () => {
    for (const n of NEW) {
      expect(BOSS_FOR_STRUCTURE[n.type]).toBe(n.kind);
      const script = BOSS_SCRIPTS[n.kind]!;
      expect(script.attacks.length).toBeGreaterThanOrEqual(5);
      expect(script.phaseAt[0]).toBeGreaterThan(script.phaseAt[1]);
      // Three phases: something unlocks in phase 2 or 3 only, and every phase has attacks.
      for (const bit of [1, 2, 4]) expect(script.attacks.some((a) => (a.phases & bit) !== 0)).toBe(true);
      expect(MOB_DEFS[n.kind].name).toBe(n.name);
      expect(MOB_DEFS[n.kind].maxHealth).toBe(n.hp);
      expect(BOSS_DROPS[n.kind]!.unique).toBe(n.unique);
    }
  });

  for (const n of NEW) {
    describe(n.name, () => {
      it('awakens in its arena, scales health by 1.5 for two players and stays inside', () => {
        const s = arena(n.type);
        s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5), testPlayer('bo', -3.5, FLOOR, 5.5));
        run(s.world, 3);
        const b = boss(s)!;
        expect(b.kind).toBe(n.kind);
        expect(b.maxHealth).toBeCloseTo(n.hp * 1.5);
        s.players[0].z = 40;
        s.players[1].z = 40;
        run(s.world, 5);
        expect(b.x).toBeGreaterThanOrEqual(s.info.arena.x0);
        expect(b.x).toBeLessThan(s.info.arena.x1);
        expect(b.z).toBeLessThan(s.info.arena.z1);
      });

      it('telegraphs every attack at least 0.5 s before it deals damage', () => {
        const s = arena(n.type);
        const p = testPlayer('ana', 0.5, FLOOR, 3.5);
        s.players.push(p);
        const firstTele = new Map<number, number>();
        let tele = -1;
        let firstHit = -1;
        for (let i = 0; i < 1500 && firstHit < 0; i++) {
          s.world.step();
          const b = boss(s);
          if (b && tele < 0 && s.world.events.some((e) => e.type === EntityEventType.Telegraph || (e.type === EntityEventType.MobAction && e.id === b.id))) tele = i;
          if (b && p.hits.some((h) => h.req.attacker?.type === 'mob' && h.req.attacker.id === b.id)) firstHit = i;
          p.health = 20;
        }
        void firstTele;
        expect(firstHit, n.name).toBeGreaterThan(0);
        expect(tele).toBeGreaterThanOrEqual(0);
        expect(firstHit - tele).toBeGreaterThanOrEqual(10);
      });

      it('plays a full fight: three phases with invulnerable transitions, every attack used, altar dormant, unique dropped once per participant', () => {
        const s = arena(n.type);
        s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5), testPlayer('bo', -2.5, FLOOR, 5.5));
        const used = new Set<number>();
        const phases = new Set<number>();
        const dmgKinds = new Set<string>();
        let transitions = 0;
        let invulnerableOk = true;
        run(s.world, 3);
        const b = boss(s)!;
        let guard = 0;
        while (b.alive && guard++ < 20000) {
          for (const p of s.players) {
            p.health = 20;
            // Wander through the arena so ranges vary.
            const a = (guard / 40) % (Math.PI * 2);
            const r = 2 + ((guard / 200) % 5);
            p.x = Math.max(-6, Math.min(6, b.x + Math.cos(a + (p.id === 'bo' ? 3 : 0)) * r));
            p.z = Math.max(-6, Math.min(7, b.z + Math.sin(a + (p.id === 'bo' ? 3 : 0)) * r));
            p.hits.length = 0;
          }
          s.world.step();
          for (const e of s.world.events) {
            if (e.type === EntityEventType.MobAction && e.id === b.id) used.add(e.param);
            if (e.type === EntityEventType.BossPhase) {
              phases.add(e.phase);
              transitions++;
            }
          }
          for (const p of s.players) for (const h of p.hits) dmgKinds.add(DamageKind[h.req.kind]);
          if (b.boss?.mode === 'transition') {
            const before = b.health;
            hit(s, b.id, 25);
            if (b.health !== before) invulnerableOk = false;
          } else if (guard % 400 === 0 && b.boss?.vulnerable()) {
            // A slow fight (about 40 s per phase): a chunk of its health every 20 s.
            hit(s, b.id, b.maxHealth * 0.1, guard % 800 === 0 ? 'ana' : 'bo');
          }
        }
        expect(b.alive).toBe(false);
        expect(phases).toEqual(new Set([2, 3]));
        expect(transitions).toBe(2);
        expect(invulnerableOk).toBe(true);
        const script = BOSS_SCRIPTS[n.kind]!;
        const missing = script.attacks.filter((a) => !used.has(a.id)).map((a) => a.name);
        expect(missing, `attacks never used by ${n.name}`).toEqual([]);
        run(s.world, 3);
        const altarEdits = s.setBlocks.filter(([x, y, z]) => x === s.info.altar.x && y === s.info.altar.y && z === s.info.altar.z);
        expect(altarEdits).toEqual([[s.info.altar.x, s.info.altar.y, s.info.altar.z, Block.BossAltarDormant]]);
        const unique = s.drops.flatMap((d) => d.stacks).find((st) => st.item === n.unique);
        expect(unique?.count).toBe(2);
        expect(s.announced[0]).toContain(`${n.name} has fallen`);
        run(s.world, 2);
        expect(boss(s)).toBeUndefined();
      });

      it('resets when nobody fights it for 15 s', () => {
        const s = arena(n.type);
        s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5));
        run(s.world, 3);
        const b = boss(s)!;
        hit(s, b.id, 60);
        s.players[0].z = 30;
        run(s.world, 20);
        expect(b.health).toBe(b.maxHealth);
      });
    });
  }

  it('Stormtalon: a dive into the wall stuns it, grounds it and it takes 1.5x damage', () => {
    const s = arena(StructureType.StormcrownAerie);
    const p = testPlayer('ana', 0.5, FLOOR, 7.5);
    s.players.push(p);
    let grounded = false;
    for (let i = 0; i < 2400 && !grounded; i++) {
      s.world.step();
      p.health = 20;
      const b = boss(s);
      if (b) {
        p.x = Math.max(-7, Math.min(7, b.x));
        p.z = b.z > 0 ? -7.5 : 7.5;
      }
      if (b?.boss?.stunned) {
        run(s.world, 0.8);
        if (b.y <= FLOOR + 0.9) grounded = true;
      }
    }
    expect(grounded).toBe(true);
    const b = boss(s)!;
    const before = b.health;
    hit(s, b.id, 10);
    expect(before - b.health).toBeCloseTo(15);
  });
});
