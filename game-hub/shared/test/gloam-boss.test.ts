import { describe, expect, it } from 'vitest';
import {
  Biome,
  Block,
  BOSS_FOR_STRUCTURE,
  BOSS_SCRIPTS,
  buildTestArena,
  DamageKind,
  EntityEventType,
  FRIENDLY_SPAWNS,
  gloamHostileTable,
  isFriendlyKind,
  isHostileKind,
  MOB_DEFS,
  MobFlag,
  MobKind,
  StructureType,
  Team,
  type StructureInfo,
} from '../src/index';
import { FlatBlocks, FLOOR, run, setupWorld, testPlayer, type TestSetup } from './mobWorld';

function arena(): TestSetup & { info: StructureInfo } {
  const s = setupWorld({ mode: 'survival', time: 0.5, caps: { maxNatural: 0 }, genVersion: 4 });
  const a = buildTestArena(StructureType.EclipseOrrery, 0, FLOOR, 0);
  for (const [x, y, z, id] of a.edits) s.blocks.set(x, y, z, id);
  s.world.extraStructures.push(a.info);
  return { ...s, info: a.info };
}

const hit = (s: TestSetup, id: number, amount: number, by = 'ana') =>
  s.world.damageMob(id, { amount, kind: DamageKind.Melee, attacker: { type: 'player', id: by }, fromX: 0, fromY: FLOOR + 1, fromZ: 5, knockback: 0, lift: 0, ignoreArmor: true });
const boss = (s: TestSetup) => [...s.world.mobs.values()].find((m) => m.boss);

describe('Eclipse Colossus', () => {
  it('guards the Orrery, with three phases and five attacks, all registered', () => {
    expect(BOSS_FOR_STRUCTURE[StructureType.EclipseOrrery]).toBe(MobKind.EclipseColossus);
    const script = BOSS_SCRIPTS[MobKind.EclipseColossus]!;
    expect(script.attacks.map((a) => a.name)).toEqual(['Umbra Drop', 'Prism Volley', 'Eclipse Pulse', 'Call the Hushed', 'Orbit Sweep']);
    expect(script.phaseAt).toHaveLength(2);
    expect(MOB_DEFS[MobKind.EclipseColossus].maxHealth).toBeGreaterThan(MOB_DEFS[MobKind.AshenKnight].maxHealth);
  });

  it('wakes when a player enters, scales for two and fights through all three phases', () => {
    const s = arena();
    s.players.push(testPlayer('ana', 0.5, FLOOR, 5.5), testPlayer('bo', -3.5, FLOOR, 5.5));
    run(s.world, 3);
    const b = boss(s)!;
    expect(b.kind).toBe(MobKind.EclipseColossus);
    expect(b.maxHealth).toBeCloseTo(420 * 1.5);
    const seen = new Set<string>();
    const phases = new Set<number>([1]);
    const take = (secs: number) => {
      for (let i = 0; i < secs * 20; i++) {
        s.world.step();
        for (const p of s.players) p.health = 20;
        if (b.boss?.current) seen.add(b.boss.current.name);
        if (b.boss) phases.add(b.boss.phase);
      }
    };
    take(25);
    hit(s, b.id, b.maxHealth * 0.45);
    take(30);
    expect(b.boss!.phase).toBe(2);
    hit(s, b.id, b.maxHealth * 0.3);
    take(40);
    expect(b.boss!.phase).toBe(3);
    expect([...phases].sort()).toEqual([1, 2, 3]);
    expect([...seen].sort()).toEqual(['Call the Hushed', 'Eclipse Pulse', 'Orbit Sweep', 'Prism Volley', 'Umbra Drop']);
    // Its Hushed are minions that crumble with it.
    const hushed = [...s.world.mobs.values()].filter((m) => m.kind === MobKind.Hushwalker && m.has(MobFlag.Minion));
    expect(hushed.length).toBeGreaterThan(0);
    for (let i = 0; i < 20 && b.alive; i++) {
      hit(s, b.id, b.maxHealth, 'ana');
      run(s.world, 2);
    }
    expect(b.alive).toBe(false);
    run(s.world, 3);
    // The altar goes dormant exactly once; each participant gets the Eclipse Glaive.
    const altar = s.setBlocks.filter(([x, y, z]) => x === s.info.altar.x && y === s.info.altar.y && z === s.info.altar.z);
    expect(altar).toEqual([[s.info.altar.x, s.info.altar.y, s.info.altar.z, Block.BossAltarDormant]]);
    const unique = s.drops.flatMap((d) => d.stacks).find((st) => st.item === 'eclipse_glaive');
    expect(unique?.count).toBeGreaterThanOrEqual(1);
    expect(s.drops.flatMap((d) => d.stacks).some((st) => st.item === 'starfall_ingot')).toBe(true);
    for (const m of hushed) expect(m.alive).toBe(false);
    expect(s.announced.some((t) => t.includes('Eclipse Colossus has fallen'))).toBe(true);
  });

  it('every attack telegraphs before it hurts', () => {
    const s = arena();
    const p = testPlayer('ana', 0.5, FLOOR, 3.5);
    s.players.push(p);
    let firstAction = -1;
    let firstHit = -1;
    for (let i = 0; i < 600 && firstHit < 0; i++) {
      s.world.step();
      const b = boss(s);
      if (firstAction < 0 && b && s.world.events.some((e) => e.type === EntityEventType.Telegraph || (e.type === EntityEventType.MobAction && e.id === b.id))) firstAction = i;
      if (b && p.hits.some((h) => h.req.attacker?.type === 'mob' && h.req.attacker.id === b.id)) firstHit = i;
      p.health = 20;
    }
    expect(firstHit).toBeGreaterThan(0);
    expect(firstHit - firstAction).toBeGreaterThanOrEqual(10);
  });
});

describe('Gloamreach creatures and spawning', () => {
  it('has nine new kinds with original names: three friendly, five hostile, one boss', () => {
    const kinds = [MobKind.Lanternhorn, MobKind.Bobblesnout, MobKind.Glimmerhare, MobKind.Wispling, MobKind.Shardback, MobKind.Hushwalker, MobKind.Glintcaster, MobKind.Murkpuff, MobKind.EclipseColossus];
    expect(kinds.every((k) => k >= 44 && k <= 59)).toBe(true);
    expect(kinds.filter(isFriendlyKind)).toHaveLength(3);
    expect(kinds.filter(isHostileKind)).toHaveLength(5);
    expect(new Set(kinds.map((k) => MOB_DEFS[k].name)).size).toBe(9);
    expect(MOB_DEFS[MobKind.Wispling].fly).toBe(true);
    expect(MOB_DEFS[MobKind.Wispling].attack?.effects?.length).toBeGreaterThan(0);
    expect(MOB_DEFS[MobKind.Shardback].climb).toBe(true);
    expect(MOB_DEFS[MobKind.Glintcaster].attack?.type).toBe('ranged');
    expect(MOB_DEFS[MobKind.Hushwalker].attack?.type).toBe('melee');
    for (const k of kinds) expect(MOB_DEFS[k].daylight, MOB_DEFS[k].name).toBe('none');
  });

  it('spawn tables follow the realm: biome friendlies, only realm hostiles', () => {
    for (const b of [Biome.LumenShelves, Biome.PrismThicket, Biome.HushHollows, Biome.MirrorFen, Biome.SpireFields]) {
      expect(FRIENDLY_SPAWNS[b]?.length, `biome ${b}`).toBeGreaterThan(0);
      for (const cave of [false, true]) {
        const kinds = gloamHostileTable(b, cave).map((e) => e.kind);
        expect(kinds.every((k) => [MobKind.Wispling, MobKind.Shardback, MobKind.Hushwalker, MobKind.Glintcaster, MobKind.Murkpuff].includes(k))).toBe(true);
        if (cave) expect(kinds).not.toContain(MobKind.Wispling);
      }
    }
  });

  it('the realm counts as permanent dusk: friendlies graze at "noon" and "midnight", hostiles come at noon, caps hold', () => {
    for (const time of [0.5, 0]) {
      const s = setupWorld({ time, biome: Biome.LumenShelves, genVersion: 4, blocks: new FlatBlocks(FLOOR, Block.Duskmoss) });
      s.players.push(testPlayer('ana', 15000.5, FLOOR, 0.5));
      let hostileMax = 0;
      run(s.world, 240, () => {
        hostileMax = Math.max(hostileMax, [...s.world.mobs.values()].filter((m) => m.alive && m.team === Team.Hostile).length);
      });
      const mobs = [...s.world.mobs.values()].filter((m) => m.alive);
      const friendly = mobs.filter((m) => isFriendlyKind(m.kind));
      const hostile = mobs.filter((m) => isHostileKind(m.kind));
      expect(friendly.length, `time ${time}`).toBeGreaterThan(0);
      expect(friendly.every((m) => FRIENDLY_SPAWNS[Biome.LumenShelves]!.some((e) => e.kind === m.kind))).toBe(true);
      expect(hostileMax, `time ${time}`).toBeGreaterThan(0);
      expect(hostile.every((m) => [MobKind.Wispling, MobKind.Shardback, MobKind.Hushwalker, MobKind.Glintcaster, MobKind.Murkpuff].includes(m.kind))).toBe(true);
      // The halved hostile cap still applies.
      expect(hostile.length).toBeLessThanOrEqual(s.world.caps.hostilePerPlayer);
    }
  });

  it('the overworld at the same hour is unchanged: no friendlies at night, and nothing spawns inside the Veil Wall', () => {
    const night = setupWorld({ time: 0, biome: Biome.Plains, genVersion: 4 });
    night.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    run(night.world, 120);
    expect([...night.world.mobs.values()].some((m) => isFriendlyKind(m.kind))).toBe(false);
    const wall = setupWorld({ time: 0.5, genVersion: 4 });
    wall.players.push(testPlayer('ana', 13000.5, FLOOR, 0.5));
    run(wall.world, 120);
    expect(wall.world.mobs.size).toBe(0);
  });

  it('no hostile spawns right beside a lamp in the realm', () => {
    const blocks = new FlatBlocks(FLOOR, Block.Duskmoss);
    for (let x = 14950; x <= 15050; x += 5) for (let z = -50; z <= 50; z += 5) blocks.set(x, FLOOR, z, Block.Moonlamp);
    const s = setupWorld({ time: 0, biome: Biome.PrismThicket, genVersion: 4, blocks });
    s.players.push(testPlayer('ana', 15000.5, FLOOR, 0.5));
    run(s.world, 120);
    expect([...s.world.mobs.values()].some((m) => m.team === Team.Hostile && !m.def.fly)).toBe(false);
  });
});
