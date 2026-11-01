import { describe, expect, it } from 'vitest';
import {
  Biome,
  BIOME_INFO,
  Block,
  blockIndex,
  CHUNK_SIZE,
  createWorldGenerator,
  hasSupport,
  IS_SOLID,
  LAVA_LEVEL,
  SEA_LEVEL,
  SUPPORT,
  Support,
  TerrainGeneratorV1,
  TerrainGeneratorV2,
  TreeSpecies,
} from '../src';
import { buildRegion, meshChunk } from '../src/voxel/mesher';

const fnv = (a: Uint8Array) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** Block reader over a set of generated chunks (generated on demand). */
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

describe('generator 1 is frozen', () => {
  const GOLDEN: [number, number, number, string][] = [
    [1234, 3, -2, '7897fd67'],
    [42, 0, 0, '3a692003'],
    [7, -5, 9, '160ed795'],
    [99, -1, 1, '60f57f3b'],
    [20251, 10, -31, '640fd093'],
  ];
  it('produces the same bytes as before the world upgrade', () => {
    for (const [seed, cx, cz, hash] of GOLDEN) {
      expect(fnv(new TerrainGeneratorV1(seed).generateChunk(cx, cz))).toBe(hash);
      expect(fnv(createWorldGenerator(seed, 'sandbox', 1).generateChunk(cx, cz))).toBe(hash);
    }
    expect(new TerrainGeneratorV1(5).findSpawn()).toEqual({ x: 0.5, y: 28, z: 0.5 });
    expect(createWorldGenerator(5, 'sandbox', 1).structures()).toEqual([]);
  });
});

describe('generator 2', () => {
  it('is deterministic, differs across seeds and reuses its output buffer', () => {
    const a = new TerrainGeneratorV2(1234).generateChunk(3, -2);
    expect(new TerrainGeneratorV2(1234).generateChunk(3, -2)).toEqual(a);
    expect(new TerrainGeneratorV2(99).generateChunk(3, -2)).not.toEqual(a);
    const out = new Uint8Array(a.length);
    expect(new TerrainGeneratorV2(1234).generateChunk(3, -2, out)).toBe(out);
    expect(createWorldGenerator(1, 'survival').genVersion).toBe(2);
  });

  it('covers all 18 biomes', () => {
    const union = new Set<Biome>();
    for (const seed of [1, 42, 999]) {
      const g = new TerrainGeneratorV2(seed);
      const seen = new Set<Biome>();
      for (let x = -512; x < 512; x += 8) for (let z = -512; z < 512; z += 8) seen.add(g.column(x, z).biome);
      expect(seen.size, `seed ${seed}: ${[...seen].map((b) => BIOME_INFO[b].name).join(', ')}`).toBeGreaterThanOrEqual(14);
      for (const b of seen) union.add(b);
    }
    expect(union.size).toBe(18);
    expect(BIOME_INFO).toHaveLength(18);
  });

  it('layers bedrock, slate, lava and ores properly', () => {
    const g = new TerrainGeneratorV2(1);
    const counts = new Map<number, number>();
    let slate = false;
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const c = g.generateChunk(cx, cz);
        for (let i = 0; i < 256; i++) expect(c[i]).toBe(Block.Bedrock);
        for (let y = 0; y < 64; y++) {
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              const b = c[blockIndex(x, y, z)];
              counts.set(b, (counts.get(b) ?? 0) + 1);
              if (b === Block.Slate) {
                expect(y).toBeLessThanOrEqual(10);
                slate = true;
              }
              if (b === Block.Lava && !g.nearStructure(cx * 16 + x, cz * 16 + z, 0)) expect(y).toBeLessThanOrEqual(LAVA_LEVEL);
            }
          }
        }
      }
    }
    const n = (b: Block) => counts.get(b) ?? 0;
    expect(slate).toBe(true);
    expect(n(Block.CoalOre)).toBeGreaterThan(n(Block.IronOre));
    expect(n(Block.IronOre)).toBeGreaterThan(n(Block.GoldOre));
    expect(n(Block.GoldOre)).toBeGreaterThan(n(Block.CobaltOre));
    expect(n(Block.CobaltOre)).toBeGreaterThan(0);
  });

  it('gives every plant its support and builds trees across chunk borders', () => {
    const g = new TerrainGeneratorV2(42);
    const get = sampler(g);
    let plants = 0;
    for (let x = -48; x < 48; x++) {
      for (let z = -48; z < 48; z++) {
        for (let y = 1; y < 63; y++) {
          const b = get(x, y, z);
          if (SUPPORT[b] === Support.None) continue;
          plants++;
          expect(hasSupport(get, x, y, z, b), `${b} at ${x},${y},${z}`).toBe(true);
        }
      }
    }
    expect(plants).toBeGreaterThan(100);
    // Trunks of trees near chunk borders exist in whichever chunk holds them.
    let checked = 0;
    for (let cellX = -12; cellX < 12; cellX++) {
      for (let cellZ = -12; cellZ < 12; cellZ++) {
        const t = g.treeInCell(cellX, cellZ);
        if (!t || t.species === TreeSpecies.JungleBush) continue;
        const lx = ((t.x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        if (lx > 1 && lx < 14) continue;
        expect(IS_SOLID[get(t.x, t.y, t.z)]).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('spawns dry, on open ground, at the column height', () => {
    for (const seed of [5, 1234, 77]) {
      const g = createWorldGenerator(seed, 'sandbox');
      const s = g.findSpawn();
      const v2 = new TerrainGeneratorV2(seed);
      const col = v2.column(Math.floor(s.x), Math.floor(s.z));
      expect(s.y).toBe(col.height + 1);
      expect(col.height).toBeGreaterThan(SEA_LEVEL + 1);
      const get = sampler(v2);
      expect(get(Math.floor(s.x), s.y, Math.floor(s.z))).toBe(Block.Air);
      expect(g.findSpawn()).toEqual(s);
    }
  });

  it('generates chunks fast enough for tablets', () => {
    const g = new TerrainGeneratorV2(1);
    const s = g.structures()[0];
    for (let i = 0; i < 4; i++) g.generateChunk(20 + i, 20); // warm up the JIT
    const times: number[] = [];
    const time = (cx: number, cz: number) => {
      const t0 = performance.now();
      g.generateChunk(cx, cz);
      times.push(performance.now() - t0);
    };
    for (let i = 0; i < 19; i++) time(i - 9, (i * 7) % 13 - 6);
    time(Math.floor(s.anchor.x / 16), Math.floor(s.anchor.z / 16));
    // Mean of the 16 fastest of 20: other test files run in parallel and can stall a few.
    const ms = times.sort((a, b) => a - b).slice(0, 16).reduce((a, b) => a + b, 0) / 16;
    console.log(`[worldgen] v2 generateChunk: ${ms.toFixed(2)} ms (mean of the 16 fastest of 20 chunks)`);
    expect(ms).toBeLessThan(15);
  });

  it('meshes a rainforest region in time', () => {
    const g = new TerrainGeneratorV2(1);
    let at: [number, number] | null = null;
    for (let x = -480; x < 480 && !at; x += 16) for (let z = -480; z < 480 && !at; z += 16) if (g.column(x, z).biome === Biome.Rainforest) at = [Math.floor(x / 16), Math.floor(z / 16)];
    expect(at).not.toBeNull();
    const chunks: Uint8Array[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) chunks.push(g.generateChunk(at![0] + dx, at![1] + dz));
    const region = buildRegion(chunks);
    for (let i = 0; i < 3; i++) meshChunk(region); // warm up the JIT
    // Median of 5 runs: other test files run in parallel and can stall one run.
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      meshChunk(region);
      runs.push(performance.now() - t0);
    }
    const ms = runs.sort((x, y) => x - y)[2];
    console.log(`[mesher] v2 rainforest region: ${ms.toFixed(2)} ms (median of 5)`);
    expect(ms).toBeLessThan(80);
  });
});
