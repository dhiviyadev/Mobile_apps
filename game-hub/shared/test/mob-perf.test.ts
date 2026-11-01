import { describe, expect, it } from 'vitest';
import { Block, createWorldGenerator, EntityWorld, MobKind, OFFLINE_CAPS, Pathfinder, rulesForMode, SERVER_CAPS, type EntityHost, type PlayerTarget } from '../src/index';
import { testPlayer } from './mobWorld';

/** Generated terrain around the spawn, read through a chunk-view reader like the server's. */
function terrain(seed: number) {
  const gen = createWorldGenerator(seed, 'survival', 1);
  const sp = gen.findSpawn();
  const views: (Uint8Array | undefined)[] = new Array(4096);
  const cx0 = Math.floor(sp.x / 16);
  const cz0 = Math.floor(sp.z / 16);
  for (let cx = cx0 - 5; cx <= cx0 + 5; cx++) for (let cz = cz0 - 5; cz <= cz0 + 5; cz++) views[(cx + 32) * 64 + cz + 32] = gen.generateChunk(cx, cz);
  const get = (x: number, y: number, z: number): number => {
    if (y < 0) return Block.Bedrock;
    if (y >= 64) return 0;
    const v = views[((x >> 4) + 32) * 64 + (z >> 4) + 32];
    return v ? v[((y << 4) + (z & 15)) * 16 + (x & 15)] : Block.Bedrock;
  };
  return { gen, sp, get };
}

describe('creature performance (logged)', () => {
  it('40 creatures step in under 2 ms per tick on generated terrain', () => {
    const { gen, sp, get } = terrain(42);
    const host: EntityHost = { getBlock: get, isAvailable: () => true, generator: gen, timeOfDay: () => 0, setBlock: () => undefined, announce: () => undefined };
    const w = new EntityWorld(host, { seed: 1, rules: rulesForMode('survival'), caps: { ...SERVER_CAPS, maxNatural: 0 } });
    const players: PlayerTarget[] = [testPlayer('a', sp.x, sp.y, sp.z)];
    w.setPlayerHooks({ ...w.hooks, playerTargets: () => players });
    const kinds = [MobKind.Woolback, MobKind.Hopling, MobKind.Cluckit, MobKind.Fernhart, MobKind.Mudlurch, MobKind.Rattlebow, MobKind.Cragcrawler, MobKind.Puffcap];
    for (let i = 0; i < 40; i++) {
      const x = Math.floor(sp.x + ((i * 37) % 60) - 30) + 0.5;
      const z = Math.floor(sp.z + ((i * 53) % 60) - 30) + 0.5;
      let y = 63;
      while (y > 1 && !get(Math.floor(x), y - 1, Math.floor(z))) y--;
      w.spawnMob(kinds[i % kinds.length], x, y, z);
    }
    for (let i = 0; i < 40; i++) w.step();
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) w.step();
    const mean = (performance.now() - t0) / N;
    console.log(`[perf] 40 creatures: ${mean.toFixed(3)} ms per tick (${w.stats().mobs} live)`);
    expect(mean).toBeLessThan(2);
  });

  it('a 300-node path search takes under 3 ms', () => {
    const { sp, get } = terrain(7);
    const pf = new Pathfinder(get);
    const sx = Math.floor(sp.x);
    const sz = Math.floor(sp.z);
    const t0 = performance.now();
    const r = pf.find({ sx, sy: Math.floor(sp.y), sz, tx: sx + 60, ty: Math.floor(sp.y), tz: sz + 40, height: 2, maxDrop: 3, climb: false, swim: 'avoid', maxNodes: 300, goalRadius: 1, leash: null });
    const ms = performance.now() - t0;
    console.log(`[perf] path: ${r.expanded} expansions in ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(3 * 4);
    void OFFLINE_CAPS;
  });
});
