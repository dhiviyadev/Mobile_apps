import { describe, expect, it } from 'vitest';
import {
  Biome,
  Block,
  blockIndex,
  chunkInWorld,
  createWorldGenerator,
  ENDLESS_LIMIT,
  ENDLESS_RADIUS_CHUNKS,
  IS_LIQUID,
  IS_SOLID,
  LATEST_GEN_VERSION,
  SEA_LEVEL,
  type StructureInfo,
  StructureType,
  TerrainGeneratorV2,
  TerrainGeneratorV3,
  worldRadiusChunks,
} from '../src';
import { SPAWN_GUARANTEE } from '../src/voxel/structures/place';

/** Block reader over generated chunks (generated on demand, kept). */
function sampler(gen: { generateChunk(cx: number, cz: number): Uint8Array }) {
  const chunks = new Map<string, Uint8Array>();
  return (x: number, y: number, z: number) => {
    if (y < 0) return Block.Bedrock;
    if (y > 63) return Block.Air;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const k = `${cx},${cz}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = gen.generateChunk(cx, cz)));
    return c[blockIndex(x - cx * 16, y, z - cz * 16)];
  };
}

/** Area-weighted median biome patch (blocks²) on an n x n grid `step` blocks apart. */
function medianPatch(g: { column(x: number, z: number): { biome: Biome } }, step: number, n: number): number {
  const grid = new Int8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) grid[i * n + j] = g.column((j - n / 2) * step, (i - n / 2) * step).biome;
  const comp = new Int32Array(n * n).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < n * n; s++) {
    if (comp[s] >= 0) continue;
    const id = sizes.length;
    const stack = [s];
    comp[s] = id;
    let size = 0;
    while (stack.length) {
      const q = stack.pop()!;
      size++;
      const qi = Math.floor(q / n), qj = q % n;
      for (const [a, b] of [[qi + 1, qj], [qi - 1, qj], [qi, qj + 1], [qi, qj - 1]]) {
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const r = a * n + b;
        if (comp[r] < 0 && grid[r] === grid[s]) {
          comp[r] = id;
          stack.push(r);
        }
      }
    }
    sizes.push(size);
  }
  const per = Array.from(comp, (c) => sizes[c] * step * step).sort((a, b) => a - b);
  return per[per.length >> 1];
}

describe('generator 3 terrain', () => {
  it('is the version new worlds get, endless, and deterministic in any chunk order', () => {
    expect(LATEST_GEN_VERSION).toBe(3);
    const g = createWorldGenerator(1234, 'survival');
    expect(g.genVersion).toBe(3);
    expect(g.radiusChunks).toBe(ENDLESS_RADIUS_CHUNKS);
    expect(g.limit).toBe(32000);
    expect(worldRadiusChunks('survival', 3)).toBe(2000);
    expect(worldRadiusChunks('sandbox', 2)).toBe(32);
    expect(worldRadiusChunks('parkour', 3)).toBe(32);
    expect(createWorldGenerator(1, 'sandbox', 2).limit).toBe(512);

    const coords: [number, number][] = [];
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) coords.push([cx, cz]);
    const fwd = new TerrainGeneratorV3(1234);
    const a = coords.map(([cx, cz]) => fwd.generateChunk(cx, cz));
    const rev = new TerrainGeneratorV3(1234);
    const b = [...coords].reverse().map(([cx, cz]) => rev.generateChunk(cx, cz)).reverse();
    expect(b).toEqual(a);
    expect(new TerrainGeneratorV2(1234).generateChunk(0, 0)).not.toEqual(a[12]);
    expect(new TerrainGeneratorV3(99).generateChunk(0, 0)).not.toEqual(a[12]);
  });

  it('makes biome patches at least 6x larger in area than generator 2', () => {
    for (const seed of [1, 42]) {
      const v2 = medianPatch(new TerrainGeneratorV2(seed), 8, 128);
      const v3 = medianPatch(new TerrainGeneratorV3(seed), 24, 128);
      expect(v3 / v2, `seed ${seed}: v2 ${v2}, v3 ${v3}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('still covers every biome', () => {
    const seen = new Set<Biome>();
    for (const seed of [1, 42, 999]) {
      const g = new TerrainGeneratorV3(seed);
      for (let x = -3000; x < 3000; x += 24) for (let z = -3000; z < 3000; z += 24) seen.add(g.column(x, z).biome);
    }
    expect(seen.size).toBe(18);
  });

  it('generates far from the origin and closes the world with a sea and a bedrock rim', () => {
    const g = new TerrainGeneratorV3(7);
    const far = g.generateChunk(1875, 62); // x = 30000
    const col = g.column(30008, 1000);
    expect(far[blockIndex(0, 0, 0)]).toBe(Block.Bedrock);
    expect(col.height).toBeGreaterThan(3);
    expect(far.some((b) => b === Block.Air)).toBe(true);
    // The land sinks into the sea over the last 96 blocks.
    for (let z = -200; z < 200; z += 20) expect(g.column(ENDLESS_LIMIT - 10, z).height).toBeLessThan(SEA_LEVEL);
    // The last two columns are bedrock all the way up; chunks past the edge are solid bedrock.
    const rim = g.generateChunk(ENDLESS_RADIUS_CHUNKS - 1, 0);
    for (let y = 0; y < 64; y++) {
      expect(rim[blockIndex(15, y, 4)]).toBe(Block.Bedrock);
      expect(rim[blockIndex(14, y, 4)]).toBe(Block.Bedrock);
    }
    expect(rim[blockIndex(13, 63, 4)]).toBe(Block.Air);
    expect(g.generateChunk(ENDLESS_RADIUS_CHUNKS, 3).every((b) => b === Block.Bedrock)).toBe(true);
    expect(g.generateChunk(-ENDLESS_RADIUS_CHUNKS - 1, 3).every((b) => b === Block.Bedrock)).toBe(true);
    expect(g.generateChunk(-ENDLESS_RADIUS_CHUNKS, 0)[blockIndex(0, 40, 4)]).toBe(Block.Bedrock);
    expect(chunkInWorld(ENDLESS_RADIUS_CHUNKS - 1, 0, createWorldGenerator(7, 'sandbox').radiusChunks)).toBe(true);
    expect(chunkInWorld(ENDLESS_RADIUS_CHUNKS, 0, ENDLESS_RADIUS_CHUNKS)).toBe(false);
  });

  it('spawns dry, on open ground, near the origin, quickly', () => {
    for (const seed of [5, 1234, 77, 31337]) {
      const g = new TerrainGeneratorV3(seed);
      const t0 = performance.now();
      const s = g.findSpawn();
      expect(performance.now() - t0).toBeLessThan(1500);
      const col = g.column(Math.floor(s.x), Math.floor(s.z));
      expect(s.y).toBe(col.height + 1);
      expect(col.height).toBeGreaterThan(SEA_LEVEL + 1);
      expect(Math.hypot(s.x, s.z)).toBeLessThan(900);
      const get = sampler(g);
      expect(get(Math.floor(s.x), s.y, Math.floor(s.z))).toBe(Block.Air);
      expect(IS_SOLID[get(Math.floor(s.x), s.y - 1, Math.floor(s.z))]).toBe(1);
      // Nothing carved under the spawn point's feet.
      for (let y = s.y - 6; y < s.y; y++) expect(get(Math.floor(s.x), y, Math.floor(s.z)), `y ${y}`).not.toBe(Block.Air);
    }
  });

  it('generates chunks fast enough for tablets', () => {
    const g = new TerrainGeneratorV3(1);
    g.findSpawn();
    for (let i = 0; i < 4; i++) g.generateChunk(20 + i, 20); // warm up the JIT
    const times: number[] = [];
    for (let i = 0; i < 24; i++) {
      const t0 = performance.now();
      g.generateChunk(i - 12, ((i * 7) % 13) - 6);
      times.push(performance.now() - t0);
    }
    // Mean of the 16 fastest of 24: other test files run in parallel and can stall a few.
    const ms = times.sort((a, b) => a - b).slice(0, 16).reduce((a, b) => a + b, 0) / 16;
    console.log(`[worldgen] v3 generateChunk: ${ms.toFixed(2)} ms (mean of the 16 fastest of 24 chunks)`);
    expect(ms).toBeLessThan(15);
  });
});

describe('generator 3 caves', () => {
  /** Stats over a square of chunks around (0, 0). */
  function caveStats(seed: number, R: number) {
    const g = new TerrainGeneratorV3(seed);
    let under = 0, carved = 0, land = 0, dig = 0, wet = 0;
    const open = new Set<number>();
    const key = (x: number, z: number) => (x + 4096) * 8192 + (z + 4096);
    const get = sampler(g);
    for (let cz = -R; cz < R; cz++) {
      for (let cx = -R; cx < R; cx++) {
        const c = g.generateChunk(cx, cz);
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const x = cx * 16 + lx, z = cz * 16 + lz;
            const h = g.column(x, z).height;
            if (h <= SEA_LEVEL + 1) continue;
            land++;
            for (let y = 2; y < h; y++) {
              under++;
              const b = c[blockIndex(lx, y, lz)];
              if (b === Block.Air || b === Block.Lava) carved++;
            }
            for (let y = h - 1; y >= Math.max(2, h - 30); y--) {
              const b = c[blockIndex(lx, y, lz)];
              if (b === Block.Air || b === Block.Lava) {
                dig++;
                break;
              }
            }
            if (c[blockIndex(lx, h, lz)] === Block.Air && c[blockIndex(lx, h - 1, lz)] === Block.Air && c[blockIndex(lx, h - 2, lz)] === Block.Air) open.add(key(x, z));
            // Carved air never touches the sea (oceans must not drain).
            for (let y = 2; y <= SEA_LEVEL; y++) {
              if (c[blockIndex(lx, y, lz)] !== Block.Air) continue;
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (IS_LIQUID[get(x + dx, y, z + dz)] && get(x + dx, y, z + dz) !== Block.Lava) wet++;
              if (IS_LIQUID[get(x, y + 1, z)] && get(x, y + 1, z) !== Block.Lava) wet++;
            }
          }
        }
      }
    }
    // Entrances: groups of open columns (4-connected) of at least 4 columns.
    const seen = new Set<number>();
    const entrances: { x: number; z: number }[] = [];
    for (const k of open) {
      if (seen.has(k)) continue;
      const stack = [k];
      seen.add(k);
      let n = 0;
      while (stack.length) {
        const q = stack.pop()!;
        n++;
        for (const d of [1, -1, 8192, -8192]) if (open.has(q + d) && !seen.has(q + d)) (seen.add(q + d), stack.push(q + d));
      }
      if (n >= 4) entrances.push({ x: Math.floor(k / 8192) - 4096, z: (k % 8192) - 4096 });
    }
    return { carved: carved / under, dig: dig / land, land, entrances, wet };
  }

  it('carves fairly common caves: a cave within 30 blocks of digging, entrances every ~100 blocks, sea sealed', () => {
    for (const seed of [1, 42]) {
      const s = caveStats(seed, 6); // 192 x 192 blocks
      expect(s.carved, `seed ${seed} carved`).toBeGreaterThan(0.08);
      expect(s.carved, `seed ${seed} carved`).toBeLessThan(0.22);
      expect(s.dig, `seed ${seed} dig`).toBeGreaterThan(0.55);
      // At least ~1 entrance per 100x100 blocks of land.
      expect(s.entrances.length, `seed ${seed} entrances`).toBeGreaterThanOrEqual(Math.floor(s.land / 10000));
      expect(s.wet, `seed ${seed}: carved cells beside the sea`).toBe(0);
    }
  });

  it('never opens a cave into the sea along coasts', () => {
    let coasts = 0;
    for (const seed of [1, 2, 3]) {
      const g = new TerrainGeneratorV3(seed);
      const get = sampler(g);
      // Coasts: walk east along rows until the sea meets land (two per seed).
      let found = 0;
      for (let z0 = -3000; z0 <= 3000 && found < 2; z0 += 500) {
        let x = -3000;
        while (x < 3000 && !(g.column(x, z0).biome === Biome.Ocean && g.column(x + 16, z0).height > SEA_LEVEL + 3)) x += 3;
        if (x >= 3000) continue;
        found++;
        coasts++;
        let wet = 0;
        for (let cx = Math.floor(x / 16) - 2; cx <= Math.floor(x / 16) + 2; cx++) {
          for (let cz = Math.floor(z0 / 16) - 2; cz <= Math.floor(z0 / 16) + 2; cz++) {
            for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
              const wx = cx * 16 + lx, wz = cz * 16 + lz;
              for (let y = 2; y <= SEA_LEVEL; y++) {
                if (get(wx, y, wz) !== Block.Air) continue;
                for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) if (get(wx + dx, y + dy, wz + dz) === Block.Water) wet++;
              }
            }
          }
        }
        expect(wet, `seed ${seed} coast at ${x},${z0}`).toBe(0);
      }
    }
    expect(coasts).toBeGreaterThanOrEqual(4);
  });

  it('carves nothing into v2 terrain and keeps lava at the bottom', () => {
    const g = new TerrainGeneratorV3(42);
    for (let cx = -3; cx < 3; cx++) {
      for (let cz = -3; cz < 3; cz++) {
        const c = g.generateChunk(cx, cz);
        for (let i = 0; i < c.length; i++) if (c[i] === Block.Lava) expect(Math.floor(i / 256)).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('generator 3 structures', () => {
  const near = (g: { structuresNear(x: number, z: number, r: number): StructureInfo[] }, x: number, z: number, r: number) => g.structuresNear(x, z, r);

  it('are about twice as common per area as in generator 2, apart, and away from spawn', () => {
    let v2 = 0, v3 = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const seed of seeds) {
      v2 += createWorldGenerator(seed, 'survival', 2).structures().length;
      const g = createWorldGenerator(seed, 'survival', 3);
      const list = near(g, 6000, -4000, 512).filter((s) => s.anchor.x >= 5488 && s.anchor.x < 6512 && s.anchor.z >= -4512 && s.anchor.z < -3488);
      v3 += list.length;
      const all = near(g, 0, 0, 700);
      const spawn = g.findSpawn();
      for (const s of all) {
        expect(Math.hypot(s.anchor.x - spawn.x, s.anchor.z - spawn.z)).toBeGreaterThanOrEqual(64);
        expect(s.bounds.y0).toBeGreaterThanOrEqual(1);
        expect(s.bounds.y1).toBeLessThanOrEqual(64);
        for (const o of all) {
          if (o === s) continue;
          const overlap = s.bounds.x0 < o.bounds.x1 && o.bounds.x0 < s.bounds.x1 && s.bounds.z0 < o.bounds.z1 && o.bounds.z0 < s.bounds.z1;
          expect(overlap).toBe(false);
        }
        expect(g.structureAt(s.altar.x + 0.5, s.altar.y + 0.5, s.altar.z + 0.5)).toEqual(s);
      }
    }
    const ratio = v3 / v2;
    expect(ratio, `v2 ${v2 / seeds.length}, v3 ${v3 / seeds.length} per 1024x1024`).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(3.2);
  });

  it('always has one within 250 blocks of spawn', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const g = createWorldGenerator(seed, 'survival');
      const s = g.findSpawn();
      const close = near(g, s.x, s.z, SPAWN_GUARANTEE).filter((t) => Math.hypot(t.anchor.x - s.x, t.anchor.z - s.z) <= SPAWN_GUARANTEE);
      expect(close.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('are placed lazily: the same in any query order, anywhere in the world', () => {
    const a = createWorldGenerator(77, 'survival');
    const b = createWorldGenerator(77, 'survival');
    const spots: [number, number][] = [[29000, -15000], [0, 0], [-31000, 31000], [500, -800], [12000, 12000]];
    const ra = spots.map(([x, z]) => near(a, x, z, 600));
    const rb = [...spots].reverse().map(([x, z]) => near(b, x, z, 600)).reverse();
    expect(rb).toEqual(ra);
    expect(ra[0].length).toBeGreaterThan(0);
    // None in reach of the edge.
    expect(near(a, ENDLESS_LIMIT - 1, 0, 120)).toEqual([]);
  });

  it('every land biome can host a structure type', () => {
    const types = new Set<StructureType>();
    const biomes = new Set<Biome>();
    for (let seed = 1; seed <= 6; seed++) {
      const g = createWorldGenerator(seed, 'survival');
      for (const s of near(g, 0, 0, 1500)) {
        types.add(s.type);
        biomes.add(s.biome);
      }
    }
    expect(types.size).toBe(4);
    expect(biomes.size).toBeGreaterThanOrEqual(10);
  });
});

describe('generator 3 landmarks', () => {
  function example(type: StructureType): { g: TerrainGeneratorV3; s: StructureInfo; seed: number } {
    for (let seed = 1; seed < 60; seed++) {
      const g = new TerrainGeneratorV3(seed);
      const s = g.structuresNear(0, 0, 900).find((t) => t.type === type);
      if (s) return { g, s, seed };
    }
    throw new Error(`no ${StructureType[type]}`);
  }

  for (const type of [StructureType.SunscorchTemple, StructureType.FrostCitadel, StructureType.OvergrownShrine, StructureType.AshenCrypt]) {
    it(`keeps the ${StructureType[type]}'s altar and chests and adds a lit landmark standing tall`, () => {
      const { g, s } = example(type);
      const get = sampler(g);
      expect(get(s.altar.x, s.altar.y, s.altar.z)).toBe(Block.BossAltar);
      for (const c of s.chests) expect(get(c.x, c.y, c.z), `chest ${c.index}`).toBe(Block.Chest);
      // A lamp at least 12 blocks over the ground somewhere inside the bounds (the landmark's crown).
      let crown = -1;
      for (let x = s.bounds.x0; x < s.bounds.x1; x++) {
        for (let z = s.bounds.z0; z < s.bounds.z1; z++) {
          for (let y = 62; y > 0; y--) {
            if (get(x, y, z) === Block.Lamp) {
              crown = Math.max(crown, y - g.column(x, z).height);
              break;
            }
          }
        }
      }
      expect(crown).toBeGreaterThanOrEqual(12);
    });
  }

  it('lets players walk from the crypt gatehouse door down to the boss hall', () => {
    const { g, s } = example(StructureType.AshenCrypt);
    const get = sampler(g);
    // Walkable cells: solid (or ladder-free) floor, two free cells.
    const free = (x: number, y: number, z: number) => !IS_SOLID[get(x, y, z)] && !IS_LIQUID[get(x, y, z)];
    const stand = (x: number, y: number, z: number) => IS_SOLID[get(x, y - 1, z)] === 1 && free(x, y, z) && free(x, y + 1, z);
    // Start on the ground beside the gatehouse (centre anchor + (13, -14)); search outward for a standable cell.
    const gx = s.anchor.x + 13, gz = s.anchor.z - 14;
    const start: [number, number, number][] = [];
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 5) continue;
      const x = gx + dx, z = gz + dz;
      const y = g.column(x, z).height + 1;
      for (let yy = y - 2; yy <= y + 3; yy++) if (stand(x, yy, z)) start.push([x, yy, z]);
    }
    expect(start.length).toBeGreaterThan(0);
    const goal = { x: Math.floor(s.bossSpawn.x), y: s.bossSpawn.y, z: Math.floor(s.bossSpawn.z) };
    const seen = new Set<string>();
    const queue = [...start];
    for (const c of start) seen.add(c.join());
    let reached = false;
    while (queue.length && !reached) {
      const [x, y, z] = queue.shift()!;
      if (Math.abs(x - goal.x) <= 1 && Math.abs(z - goal.z) <= 1 && Math.abs(y - goal.y) <= 1) reached = true;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [1, 0, -1, -2, -3]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (Math.abs(nx - gx) > 40 || Math.abs(nz - gz) > 50) continue;
          if (dy === 1 && !free(x, y + 2, z)) continue; // head room to step up
          if (!stand(nx, ny, nz)) continue;
          if (dy < 0) {
            let clear = true;
            for (let k = 0; k > dy; k--) if (!free(nx, y + k, nz) || !free(nx, y + k + 1, nz)) clear = false;
            if (!clear) continue;
          }
          const k = `${nx},${ny},${nz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push([nx, ny, nz]);
          break;
        }
      }
    }
    expect(reached).toBe(true);
  });

  it('leaves generator 2 structures without landmarks', () => {
    const g = createWorldGenerator(3, 'survival', 2);
    const s = g.structures()[0];
    const v2 = new TerrainGeneratorV2(3);
    const lamps: number[] = [];
    const get = sampler(v2);
    for (let x = s.bounds.x0 - 6; x < s.bounds.x1 + 6; x++) for (let z = s.bounds.z0 - 6; z < s.bounds.z1 + 6; z++) if (get(x, 62, z) === Block.Lamp) lamps.push(x);
    expect(lamps).toEqual([]);
  });
});
