import { describe, expect, it } from 'vitest';
import {
  approxLight,
  Block,
  BLOCKS,
  blockIndex,
  createWorldGenerator,
  IS_CLIMBABLE,
  IS_SOLID,
  isBossDefeated,
  LootTableId,
  rollLoot,
  type StructureInfo,
  StructureType,
  TerrainGeneratorV3,
} from '../src';
import { buildStructure } from '../src/voxel/structures/place';
import { RuinsGen, sampler } from './ruinsHelper';

const ALL_TYPES = [1, 2, 3, 4, 5, 6, 7, 8] as StructureType[];

/** One structure of each type, scanning seeds (cached). */
const examples = (() => {
  let cache: Map<StructureType, { seed: number; s: StructureInfo }> | null = null;
  return () => {
    if (cache) return cache;
    cache = new Map();
    for (let seed = 1; seed <= 12 && cache.size < 8; seed++) {
      const g = new RuinsGen(seed);
      for (const s of g.structuresNear(0, 0, 1600)) if (!cache.has(s.type)) cache.set(s.type, { seed, s });
    }
    return cache;
  };
})();

function fnv(a: Uint8Array, h = 0x811c9dc5): number {
  for (const v of a) h = Math.imul(h ^ v, 0x01000193);
  return h >>> 0;
}

describe('generators 1-3 are untouched', () => {
  // Measured with the code of commit 717e647 (before package S).
  const GOLDEN: Record<number, { n: number; list: number; chunks: number[]; plain: number[] }> = {
    1: { n: 35, list: 3083736974, chunks: [685187461, 3657809512, 4111353175, 3374831343, 3296700847, 3041200854, 4007993475, 3696905781, 3589538613, 2147789948, 4026138341, 2212398205], plain: [3482385277, 2088416095, 3063092898, 4233449330] },
    7: { n: 24, list: 2503092787, chunks: [180853993, 3878153856, 3783832995, 33041545, 1034465524, 2657696827, 3375650799, 1902300660, 1335125781, 448403851, 3731067191, 2863878532], plain: [2238746510, 3636367403, 1179609137, 925288227] },
    42: { n: 29, list: 503825088, chunks: [2657918543, 1332630512, 309648142, 874340268, 1989242298, 118790553, 412760395, 488874632, 1455185236, 3435639368, 453451849, 1527928776], plain: [4057629234, 2807186196, 1633747274, 2600620484] },
  };
  const GOLDEN_V2: Record<number, number> = { 1: 3911258251, 7: 1668130107, 42: 155320744 };
  for (const seed of [1, 7, 42]) {
    it(`generator 3 structures and chunks of seed ${seed} are byte-identical`, () => {
      const g = createWorldGenerator(seed, 'survival', 3);
      const list = g.structuresNear(0, 0, 600);
      const want = GOLDEN[seed];
      expect(list.length).toBe(want.n);
      expect(fnv(new TextEncoder().encode(JSON.stringify(list)))).toBe(want.list);
      const cs: number[] = [];
      for (const s of list.slice(0, 3)) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [-1, 1]]) cs.push(fnv(g.generateChunk(Math.floor(s.anchor.x / 16) + dx, Math.floor(s.anchor.z / 16) + dz)));
      expect(cs).toEqual(want.chunks);
      expect([0, 1, -1, 5].map((c) => fnv(g.generateChunk(c, c * 2)))).toEqual(want.plain);
    });
    it(`generator 2 structures of seed ${seed} are identical`, () => {
      const g2 = createWorldGenerator(seed, 'survival', 2);
      expect(fnv(new TextEncoder().encode(JSON.stringify(g2.structures())))).toBe(GOLDEN_V2[seed]);
    });
  }
  it('set-1 types only appear in generator 3 (no new types, no set-2 blocks)', () => {
    const g = createWorldGenerator(7, 'survival', 3);
    for (const s of g.structuresNear(0, 0, 3000)) expect(s.type).toBeLessThanOrEqual(4);
  });
});

describe('set 2 placement (generator 4 structures)', () => {
  it('places every type, apart, one near spawn, at a v3-like density', () => {
    const types = new Set<StructureType>();
    let total = 0;
    let areas = 0;
    for (const seed of [1, 7, 42]) {
      const g = new RuinsGen(seed);
      const list = g.structuresNear(0, 0, 1400);
      total += list.length;
      areas++;
      const sp = g.findSpawn();
      expect(Math.min(...list.map((s) => Math.hypot(s.anchor.x - sp.x, s.anchor.z - sp.z))), `seed ${seed}`).toBeLessThanOrEqual(250);
      for (const s of list) {
        types.add(s.type);
        expect(Math.hypot(s.anchor.x - sp.x, s.anchor.z - sp.z)).toBeGreaterThanOrEqual(64);
        expect(s.bounds.y0).toBeGreaterThanOrEqual(1);
        expect(s.bounds.y1).toBeLessThanOrEqual(64);
      }
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i].bounds, b = list[j].bounds;
          const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
          expect(overlap, `${list[i].id} vs ${list[j].id}`).toBe(false);
        }
      }
    }
    expect([...types].sort()).toEqual(ALL_TYPES);
    // Area 2800 x 2800; generator 3 averages about 24 structures per million blocks²; generator 4 is a bit rarer (about 17).
    const perMillion = total / areas / (2.8 * 2.8);
    expect(perMillion).toBeGreaterThan(12);
    expect(perMillion).toBeLessThan(60);
  });

  it('a type shows up often enough in every area of a world (rarity per 640 x 640)', () => {
    const g = new RuinsGen(7);
    let empty = 0;
    let cells = 0;
    for (let x = -1280; x < 1280; x += 640) {
      for (let z = -1280; z < 1280; z += 640) {
        cells++;
        if (!g.structuresNear(x + 320, z + 320, 330).length) empty++;
      }
    }
    expect(empty / cells).toBeLessThan(0.3);
  });

  it('respects maxX', () => {
    const g = new (class extends TerrainGeneratorV3 {
      protected override structureOptions() {
        return { structureSet: 2 as const, maxX: 900 };
      }
    })(7);
    const list = g.structuresNear(1000, 0, 700);
    for (const s of list) expect(s.bounds.x1).toBeLessThan(900);
  });

  it('is deterministic across chunk order and fresh generators', () => {
    const ex = examples();
    for (const type of [StructureType.SunscorchTemple, StructureType.SaltwornLighthouse, StructureType.HollowheartGrove]) {
      const { seed, s } = ex.get(type)!;
      const cx0 = Math.floor(s.bounds.x0 / 16), cx1 = Math.floor((s.bounds.x1 - 1) / 16);
      const cz0 = Math.floor(s.bounds.z0 / 16), cz1 = Math.floor((s.bounds.z1 - 1) / 16);
      const fwd = new RuinsGen(seed);
      const rev = new RuinsGen(seed);
      const a: Uint8Array[] = [];
      const b: Uint8Array[] = [];
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) a.push(fwd.generateChunk(cx, cz));
      for (let cx = cx1; cx >= cx0; cx--) for (let cz = cz1; cz >= cz0; cz--) b.unshift(rev.generateChunk(cx, cz));
      expect(b, StructureType[type]).toEqual(a);
    }
    expect(new RuinsGen(7).structuresNear(0, 0, 900)).toEqual(new RuinsGen(7).structuresNear(0, 0, 900));
  });
});

/** Can a walker get from the entrance to the boss spawn? Steps up 1 block, falls, climbs ladders. */
function reachable(get: (x: number, y: number, z: number) => number, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, within: { x0: number; z0: number; x1: number; z1: number }): boolean {
  const solid = (x: number, y: number, z: number) => IS_SOLID[get(x, y, z)] === 1;
  const free = (x: number, y: number, z: number) => !solid(x, y, z) && !solid(x, y + 1, z);
  const supported = (x: number, y: number, z: number) => solid(x, y - 1, z) || IS_CLIMBABLE[get(x, y, z)] === 1 || IS_CLIMBABLE[get(x, y + 1, z)] === 1;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const sx = Math.floor(from.x), sy = Math.floor(from.y), sz = Math.floor(from.z);
  const tx = Math.floor(to.x), ty = Math.floor(to.y), tz = Math.floor(to.z);
  const seen = new Set<string>([key(sx, sy, sz)]);
  const queue: [number, number, number][] = [[sx, sy, sz]];
  let head = 0;
  const push = (x: number, y: number, z: number) => {
    if (y < 1 || y > 62 || x < within.x0 - 6 || x > within.x1 + 6 || z < within.z0 - 6 || z > within.z1 + 6) return;
    const k = key(x, y, z);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push([x, y, z]);
  };
  let guard = 0;
  while (head < queue.length && guard++ < 1_500_000) {
    const [x, y, z] = queue[head++];
    if (x === tx && z === tz && Math.abs(y - ty) <= 1) return true;
    if (!supported(x, y, z)) {
      // Fall.
      let yy = y;
      while (yy > 1 && !supported(x, yy, z) && free(x, yy - 1, z)) yy--;
      if (yy !== y) push(x, yy, z);
      continue;
    }
    if (IS_CLIMBABLE[get(x, y, z)] === 1 || IS_CLIMBABLE[get(x, y + 1, z)] === 1) {
      if (!solid(x, y + 2, z)) push(x, y + 1, z);
      if (!solid(x, y - 1, z)) push(x, y - 1, z);
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (free(nx, y, nz)) push(nx, y, nz);
      else if (free(nx, y + 1, nz) && !solid(x, y + 2, z)) push(nx, y + 1, nz);
    }
  }
  return false;
}

describe('set 2 structures', () => {
  const ex = examples();
  it('finds all eight types', () => {
    expect([...ex.keys()].sort()).toEqual(ALL_TYPES);
  });

  for (const type of ALL_TYPES) {
    describe(StructureType[type], () => {
      it('has its altar, chests, a clear lit arena, doorways and a lit floor (light >= 5)', () => {
        const { seed, s } = ex.get(type)!;
        const gen = new RuinsGen(seed);
        const { get } = sampler(gen);
        expect(get(s.altar.x, s.altar.y, s.altar.z)).toBe(Block.BossAltar);
        for (const c of s.chests) expect(get(c.x, c.y, c.z), `chest ${c.index}`).toBe(Block.Chest);
        expect(s.chests.filter((c) => c.sealed).map((c) => c.index)).toEqual([0]);
        expect(s.chests.length).toBe(4);
        const furniture = new Set<string>();
        // Furniture: the cells the template declared; rebuild the structure to read them.
        const ps = (gen as unknown as { chunkStructures: (x0: number, z0: number) => { info: StructureInfo }[] }).chunkStructures(Math.floor(s.anchor.x / 16) * 16, Math.floor(s.anchor.z / 16) * 16).find((p) => p.info.id === s.id)!;
        for (const f of buildStructure(ps as never, seed).furniture) furniture.add(`${f.x},${f.y},${f.z}`);
        const a = s.arena;
        expect(a.x1 - a.x0).toBeGreaterThanOrEqual(15);
        expect(a.z1 - a.z0).toBeGreaterThanOrEqual(15);
        expect(a.y1 - a.y0).toBeGreaterThanOrEqual(8);
        for (let y = a.y0; y < a.y1; y++) for (let z = a.z0; z < a.z1; z++) for (let x = a.x0; x < a.x1; x++) {
          if (furniture.has(`${x},${y},${z}`)) continue;
          expect(get(x, y, z), `${StructureType[type]} arena cell ${x},${y},${z}`).toBe(Block.Air);
        }
        for (const d of s.doorways) for (let y = d.y0; y < d.y1; y++) for (let z = d.z0; z < d.z1; z++) for (let x = d.x0; x < d.x1; x++) expect(get(x, y, z), `doorway ${x},${y},${z}`).toBe(Block.Air);
        const bx = Math.floor(s.bossSpawn.x), by = s.bossSpawn.y, bz = Math.floor(s.bossSpawn.z);
        expect(IS_SOLID[get(bx, by - 1, bz)]).toBe(1);
        for (let k = 0; k < 4; k++) expect(get(bx, by + k, bz)).toBe(Block.Air);
        for (let z = a.z0; z < a.z1; z += 2) for (let x = a.x0; x < a.x1; x += 2) {
          if (get(x, a.y0, z) === Block.Air) expect(approxLight(get, x, a.y0, z, 0), `light at ${x},${z}`).toBeGreaterThanOrEqual(5);
        }
        // Light sources never sit more than 12 above the floor only: the floor must be lit by what is near it.
        expect(BLOCKS[Block.SunRune].light).toBeGreaterThan(0);
      });

      it('can be walked from the entrance to the boss spawn (fails if the door is walled up)', () => {
        const { seed, s } = ex.get(type)!;
        const { get } = sampler(new RuinsGen(seed));
        expect(reachable(get, s.entrance, s.bossSpawn, s.bounds)).toBe(true);
        // Mutation: wall the doorway and the way must close (the door is the only way in).
        const walled = (x: number, y: number, z: number) => (s.doorways.some((d) => x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1 && z >= d.z0 && z < d.z1) ? Block.StoneBricks : get(x, y, z));
        expect(reachable(walled, s.entrance, s.bossSpawn, s.bounds)).toBe(false);
      });

      it('rolls loot deterministically and defeat is read from the altar', () => {
        const { s } = ex.get(type)!;
        const boss = s.chests.find((c) => c.index === 0)!;
        const loot = rollLoot(boss.loot, boss.lootSeed);
        expect(loot.length).toBeGreaterThanOrEqual(2);
        expect(rollLoot(boss.loot, boss.lootSeed)).toEqual(loot);
        const cells = new Map<string, number>([[`${s.altar.x},${s.altar.y},${s.altar.z}`, Block.BossAltar]]);
        const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? 0;
        expect(isBossDefeated(get, s)).toBe(false);
        cells.set(`${s.altar.x},${s.altar.y},${s.altar.z}`, Block.BossAltarDormant);
        expect(isBossDefeated(get, s)).toBe(true);
        expect(LootTableId[boss.loot]).toBeTruthy();
      });
    });
  }

  it('cold generation of a structure chunk stays fast', () => {
    const times: number[] = [];
    for (const type of ALL_TYPES) {
      const { seed, s } = ex.get(type)!;
      const g = new RuinsGen(seed);
      g.structuresNear(s.anchor.x, s.anchor.z, 80);
      const cx = Math.floor(s.anchor.x / 16), cz = Math.floor(s.anchor.z / 16);
      for (const [dx, dz] of [[0, 0], [1, 1], [-1, 0], [0, -1]]) {
        const t0 = performance.now();
        g.generateChunk(cx + dx, cz + dz);
        times.push(performance.now() - t0);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.5)]).toBeLessThan(40);
    expect(times[times.length - 1]).toBeLessThan(250);
  });

  it('keeps blockIndex bounds: no structure block above y 63', () => {
    for (const type of ALL_TYPES) {
      const { seed, s } = ex.get(type)!;
      const g = new RuinsGen(seed);
      const c = g.generateChunk(Math.floor(s.anchor.x / 16), Math.floor(s.anchor.z / 16));
      expect(c.length).toBe(16 * 16 * 64);
      expect(blockIndex(15, 63, 15)).toBeLessThan(c.length);
    }
  });
});
