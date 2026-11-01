import { describe, expect, it } from 'vitest';
import { Biome, Block, buildTestArena, FRIENDLY_SPAWNS, isHostileKind, MobFlag, MobKind, StructureType, Team } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer } from './mobWorld';

const live = (s: ReturnType<typeof setupWorld>) => [...s.world.mobs.values()].filter((m) => m.alive);

describe('spawning', () => {
  it('sandbox at night spawns no hostiles', () => {
    const s = setupWorld({ mode: 'sandbox', time: 0 });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5, false));
    run(s.world, 120);
    expect(live(s).some((m) => isHostileKind(m.kind))).toBe(false);
  });

  it('survival at noon spawns friendly kinds from the biome table only, never close to players', () => {
    const s = setupWorld({ time: 0.5, biome: Biome.Forest });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    const allowed = new Set(FRIENDLY_SPAWNS[Biome.Forest]!.map((e) => e.kind));
    let tooClose = false;
    run(s.world, 60, () => {
      for (const m of live(s)) if (m.ageTicks === 1 && Math.hypot(m.x, m.z) < 19) tooClose = true;
    });
    const mobs = live(s);
    expect(mobs.length).toBeGreaterThan(0);
    expect(mobs.every((m) => allowed.has(m.kind))).toBe(true);
    expect(tooClose).toBe(false);
  });

  it('hostiles spawn only in the dark: torches prevent them', () => {
    const s = setupWorld({ time: 0 });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    run(s.world, 60);
    expect(live(s).some((m) => m.team === Team.Hostile)).toBe(true);

    const lit = setupWorld({ time: 0 });
    lit.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    for (let x = -48; x <= 48; x += 6) for (let z = -48; z <= 48; z += 6) lit.blocks.set(x, FLOOR, z, Block.Torch);
    run(lit.world, 60);
    expect(live(lit).some((m) => m.team === Team.Hostile && !m.def.fly)).toBe(false);
  });

  it('per-player and room caps hold after 600 simulated seconds', () => {
    const s = setupWorld({ time: 0 });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    let max = 0;
    run(s.world, 600, () => (max = Math.max(max, live(s).filter((m) => !m.has(MobFlag.Guard)).length)));
    expect(max).toBeLessThanOrEqual(s.world.caps.maxNatural + s.world.caps.fishPerPlayer);
    expect(live(s).filter((m) => m.team === Team.Hostile).length).toBeLessThanOrEqual(s.world.caps.hostilePerPlayer);
  });

  it('despawns creatures beyond 64 blocks and Duskwings after dawn', () => {
    const s = setupWorld({ time: 0.5 });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    const far = s.world.spawnMob(MobKind.Woolback, 80.5, FLOOR, 0.5)!;
    const wing = s.world.spawnMob(MobKind.Duskwing, 10.5, FLOOR + 5, 0.5)!;
    run(s.world, 12);
    expect(s.world.mobs.has(far.id)).toBe(false);
    expect(s.world.mobs.has(wing.id)).toBe(false);
  });

  it('structure guards spawn near the entrance and respawn after 300 s', () => {
    const s = setupWorld({ time: 0.5, caps: { maxNatural: 0 } });
    const a = buildTestArena(StructureType.SunscorchTemple, 0, FLOOR, 0);
    for (const [x, y, z, id] of a.edits) s.blocks.set(x, y, z, id);
    s.world.extraStructures.push(a.info);
    s.players.push(testPlayer('ana', 0.5, FLOOR, 30.5));
    run(s.world, 1);
    const guards = live(s).filter((m) => m.has(MobFlag.Guard));
    expect(guards.length).toBe(a.info.guardSpawns.length);
    s.world.crumble(guards[0]);
    run(s.world, 10);
    expect(live(s).filter((m) => m.has(MobFlag.Guard)).length).toBe(guards.length - 1);
    run(s.world, 300);
    expect(live(s).filter((m) => m.has(MobFlag.Guard)).length).toBe(guards.length);
  });
});
