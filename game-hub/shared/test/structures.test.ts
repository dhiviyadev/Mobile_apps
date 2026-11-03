import { describe, expect, it } from 'vitest';
import {
  approxLight,
  Block,
  blockIndex,
  createWorldGenerator,
  IS_SOLID,
  isBossDefeated,
  LootTableId,
  rollLoot,
  type StructureInfo,
  StructureType,
  TerrainGeneratorV2,
} from '../src';
import { buildStructure, computeStructures } from '../src/voxel/structures/place';

/** Reads cells through generated chunks; `order` changes which chunks are generated first. */
function sampler(gen: TerrainGeneratorV2) {
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
  return { get, chunks };
}

/** One structure of each type, scanning seeds. */
function examples(): Map<StructureType, { seed: number; s: StructureInfo }> {
  const found = new Map<StructureType, { seed: number; s: StructureInfo }>();
  for (let seed = 1; seed <= 40 && found.size < 4; seed++) {
    for (const s of createWorldGenerator(seed, 'survival', 2).structures()) if (!found.has(s.type)) found.set(s.type, { seed, s });
  }
  return found;
}

describe('structure placement', () => {
  it('places 6..16 per world, inside it, apart, away from spawn, every type somewhere', () => {
    const types = new Set<StructureType>();
    for (let seed = 1; seed <= 20; seed++) {
      const g = createWorldGenerator(seed, 'survival', 2);
      const list = g.structures();
      expect(list.length, `seed ${seed}`).toBeGreaterThanOrEqual(6);
      expect(list.length).toBeLessThanOrEqual(16);
      const spawn = g.findSpawn();
      for (const s of list) {
        types.add(s.type);
        const b = s.bounds;
        expect(Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.z0), Math.abs(b.z1))).toBeLessThan(512);
        expect(b.y0).toBeGreaterThanOrEqual(1);
        expect(b.y1).toBeLessThanOrEqual(63);
        expect(Math.hypot(s.anchor.x - spawn.x, s.anchor.z - spawn.z)).toBeGreaterThanOrEqual(96);
        for (const o of list) {
          if (o === s) continue;
          const overlap = b.x0 < o.bounds.x1 && o.bounds.x0 < b.x1 && b.z0 < o.bounds.z1 && o.bounds.z0 < b.z1;
          expect(overlap).toBe(false);
        }
        expect(g.structureAt(s.altar.x + 0.5, s.altar.y + 0.5, s.altar.z + 0.5)).toBe(s);
        expect(g.structuresNear(s.anchor.x, s.anchor.z, 1)).toContain(s);
      }
    }
    expect(types.size).toBe(4);
  });

  it('is the same from a fresh generator', () => {
    const a = computeStructures(new TerrainGeneratorV2(9), 9).map((p) => p.info);
    expect(createWorldGenerator(9, 'sandbox', 2).structures()).toEqual(a);
  });
});

describe('structure blocks', () => {
  const ex = examples();
  it('finds all four types', () => {
    expect([...ex.keys()].sort()).toEqual([1, 2, 3, 4]);
  });

  for (const type of [StructureType.SunscorchTemple, StructureType.FrostCitadel, StructureType.OvergrownShrine, StructureType.AshenCrypt]) {
    it(`builds the ${StructureType[type]} with its altar, chests, arena and doorways`, () => {
      const { seed, s } = ex.get(type)!;
      const gen = new TerrainGeneratorV2(seed);
      const { get } = sampler(gen);
      expect(get(s.altar.x, s.altar.y, s.altar.z)).toBe(Block.BossAltar);
      for (const c of s.chests) expect(get(c.x, c.y, c.z), `chest ${c.index}`).toBe(Block.Chest);
      expect(s.chests.filter((c) => c.sealed).map((c) => c.index)).toEqual([0]);
      const placed = computeStructures(gen, seed).find((p) => p.info.id === s.id)!;
      const furniture = new Set(buildStructure(placed, seed).furniture.map((f) => `${f.x},${f.y},${f.z}`));
      const a = s.arena;
      expect(a.x1 - a.x0).toBeGreaterThanOrEqual(15);
      expect(a.z1 - a.z0).toBeGreaterThanOrEqual(15);
      expect(a.y1 - a.y0).toBeGreaterThanOrEqual(8);
      for (let y = a.y0; y < a.y1; y++) {
        for (let z = a.z0; z < a.z1; z++) {
          for (let x = a.x0; x < a.x1; x++) {
            if (furniture.has(`${x},${y},${z}`)) continue;
            expect(get(x, y, z), `arena cell ${x},${y},${z}`).toBe(Block.Air);
          }
        }
      }
      for (const d of s.doorways) for (let y = d.y0; y < d.y1; y++) for (let z = d.z0; z < d.z1; z++) for (let x = d.x0; x < d.x1; x++) expect(get(x, y, z)).toBe(Block.Air);
      const bx = Math.floor(s.bossSpawn.x), by = s.bossSpawn.y, bz = Math.floor(s.bossSpawn.z);
      expect(IS_SOLID[get(bx, by - 1, bz)]).toBe(1);
      for (let k = 0; k < 3; k++) expect(get(bx, by + k, bz)).toBe(Block.Air);
      // Lit floor: no pitch-dark spots for creatures to spawn in.
      for (let z = a.z0; z < a.z1; z += 2) for (let x = a.x0; x < a.x1; x += 2) if (get(x, a.y0, z) === Block.Air) expect(approxLight(get, x, a.y0, z, 0), `light at ${x},${z}`).toBeGreaterThanOrEqual(4);
    });
  }

  it('generates the same bytes in any chunk order', () => {
    const { seed, s } = ex.get(StructureType.SunscorchTemple)!;
    const cx0 = Math.floor(s.bounds.x0 / 16), cx1 = Math.floor((s.bounds.x1 - 1) / 16);
    const cz0 = Math.floor(s.bounds.z0 / 16), cz1 = Math.floor((s.bounds.z1 - 1) / 16);
    const fwd = new TerrainGeneratorV2(seed);
    const rev = new TerrainGeneratorV2(seed);
    const a: Uint8Array[] = [];
    const b: Uint8Array[] = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) a.push(fwd.generateChunk(cx, cz));
    for (let cx = cx1; cx >= cx0; cx--) for (let cz = cz1; cz >= cz0; cz--) b.unshift(rev.generateChunk(cx, cz));
    expect(b).toEqual(a);
  });

  it('rolls loot deterministically, honours guarantees, and reads defeat from the altar', () => {
    const { s } = ex.get(StructureType.FrostCitadel)!;
    const boss = s.chests.find((c) => c.index === 0)!;
    expect(boss.loot).toBe(LootTableId.CitadelBoss);
    const loot = rollLoot(boss.loot, boss.lootSeed);
    expect(rollLoot(boss.loot, boss.lootSeed)).toEqual(loot);
    expect(loot.some((l) => l.item === 'cobalt_shield')).toBe(true);
    const cells = new Map<string, number>([[`${s.altar.x},${s.altar.y},${s.altar.z}`, Block.BossAltar]]);
    const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? 0;
    expect(isBossDefeated(get, s)).toBe(false);
    cells.set(`${s.altar.x},${s.altar.y},${s.altar.z}`, Block.BossAltarDormant);
    expect(isBossDefeated(get, s)).toBe(true);
  });
});
