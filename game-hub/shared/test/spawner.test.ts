import { describe, expect, it, vi } from 'vitest';
import { Biome, Block, blockIndex, buildTestArena, createWorldGenerator, EntityWorld, FRIENDLY_SPAWNS, isHostileKind, MobFlag, MobKind, OFFLINE_CAPS, OFFLINE_LOW_CAPS, rulesForMode, SERVER_CAPS, StructureType, Team } from '../src/index';
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

describe('calmer nights', { timeout: 30_000 }, () => {
  it('halves the hostile caps', () => {
    expect(SERVER_CAPS.hostilePerPlayer).toBe(6);
    expect(SERVER_CAPS.flyersPerPlayer).toBe(2);
    expect(OFFLINE_CAPS.hostilePerPlayer).toBe(5);
    expect(OFFLINE_CAPS.flyersPerPlayer).toBe(1);
    expect(OFFLINE_LOW_CAPS.hostilePerPlayer).toBe(4);
  });

  it('tries the surface on every other pass only, and never passes the cap through a whole night', () => {
    // Uncapped, every pass attempts: half of them may use the surface.
    const open = setupWorld({ time: 0, caps: { ...SERVER_CAPS, maxNatural: 1000, hostilePerPlayer: 1000 } });
    open.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    const proto = Object.getPrototypeOf(open.world.spawner) as { hostileAttempt: (...a: unknown[]) => void };
    const spy = vi.spyOn(proto, 'hostileAttempt');
    run(open.world, 60);
    const surface = spy.mock.calls.filter((c) => c[3] === true).length;
    const caves = spy.mock.calls.filter((c) => c[3] === false).length;
    spy.mockRestore();
    expect(surface + caves).toBeGreaterThanOrEqual(58);
    expect(Math.abs(surface - caves)).toBeLessThanOrEqual(1);

    const s = setupWorld({ time: 0, caps: SERVER_CAPS });
    s.players.push(testPlayer('ana', 0.5, FLOOR, 0.5));
    let max = 0;
    run(s.world, 300, () => (max = Math.max(max, live(s).filter((m) => m.team === Team.Hostile && !m.has(MobFlag.Minion) && Math.hypot(m.x, m.z) <= 48).length)));
    expect(max).toBeGreaterThan(0);
    // Counted at each pass within 48 blocks; one wandering in from the edge can briefly make it 7 (was 13 with the old cap).
    expect(max).toBeLessThanOrEqual(7);
  });

  it('keeps cave spawns moderate in a generator-3 cave system', () => {
    const gen = createWorldGenerator(42, 'survival', 3);
    const chunks = new Map<string, Uint8Array>();
    const get = (x: number, y: number, z: number) => {
      if (y < 0) return Block.Bedrock;
      if (y > 63) return Block.Air;
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
      const k = `${cx},${cz}`;
      let c = chunks.get(k);
      if (!c) chunks.set(k, (c = gen.generateChunk(cx, cz)));
      return c[blockIndex(x - cx * 16, y, z - cz * 16)];
    };
    // A roomy cave cell near spawn.
    const sp = gen.findSpawn();
    let at: { x: number; y: number; z: number } | null = null;
    for (let r = 0; r < 120 && !at; r += 4) {
      for (let a = 0; a < 16 && !at; a++) {
        const x = Math.floor(sp.x + Math.cos(a) * r), z = Math.floor(sp.z + Math.sin(a) * r);
        for (let y = 10; y < 24; y++) if (get(x, y - 1, z) !== Block.Air && get(x, y, z) === Block.Air && get(x, y + 1, z) === Block.Air && gen.surfaceHeight(x, z) > y + 6) at = { x, y, z };
      }
    }
    expect(at).not.toBeNull();
    const time = { value: 0 };
    const world = new EntityWorld(
      { getBlock: get, isAvailable: () => true, generator: gen, timeOfDay: () => time.value, setBlock: () => {}, announce: () => {} },
      { seed: 3, rules: rulesForMode('survival'), caps: OFFLINE_CAPS },
    );
    const players = [testPlayer('ana', at!.x + 0.5, at!.y, at!.z + 0.5)];
    world.setPlayerHooks({
      playerTargets: () => players,
      damagePlayer: () => ({ applied: 0, blocked: false, killed: false }) as never,
      dropItems: () => {},
      consumeHeld: () => false,
      heldItem: () => null,
      playerName: (id) => id,
    });
    let max = 0;
    let sum = 0;
    let n = 0;
    run(world, 240, () => {
      const p = players[0];
      const h = [...world.mobs.values()].filter((m) => m.alive && m.team === Team.Hostile && Math.hypot(m.x - p.x, m.z - p.z) <= 48).length;
      max = Math.max(max, h);
      sum += h;
      n++;
    });
    console.log(`[spawner] v3 caves at night: ${(sum / n).toFixed(1)} hostiles on average, ${max} at most (cap ${OFFLINE_CAPS.hostilePerPlayer})`);
    // Creatures wander in and out of the 48-block count radius, so one over the cap can show for a moment.
    expect(max).toBeLessThanOrEqual(OFFLINE_CAPS.hostilePerPlayer + 1);
    expect(sum / n).toBeLessThanOrEqual(OFFLINE_CAPS.hostilePerPlayer);
  });
});
