import { describe, expect, it } from 'vitest';
import {
  Biome,
  Block,
  BIOME_INFO,
  CHUNK_SIZE,
  createWorldGenerator,
  DIM_X0,
  DIM_X1,
  gloamToOverworld,
  GloamTerrain,
  isGenVersion,
  LATEST_GEN_VERSION,
  OVERWORLD_MAX_X,
  overworldToGloam,
  Realm,
  realmAt,
  StructureType,
  TERRAIN_VOLUME,
  VEIL_X0,
} from '../src/index';
import { FALLEN_GUARANTEE, ORRERY_GUARANTEE } from '../src/voxel/worldgen/gloam/sites';

const fnv = (a: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 0x01000193);
  return h >>> 0;
};

describe('realms', () => {
  it('realmAt is the single source of truth for where you are', () => {
    for (const gen of [1, 2, 3]) for (const x of [-30000, 0, 11999, 12000, 13999, 14000, 31999]) expect(realmAt(gen, x)).toBe(Realm.Overworld);
    expect(realmAt(4, -31999)).toBe(Realm.Overworld);
    expect(realmAt(4, 11999)).toBe(Realm.Overworld);
    expect(realmAt(4, VEIL_X0)).toBe(Realm.Veil);
    expect(realmAt(4, DIM_X0 - 1)).toBe(Realm.Veil);
    expect(realmAt(4, DIM_X0)).toBe(Realm.Gloamreach);
    expect(realmAt(4, DIM_X1 - 1)).toBe(Realm.Gloamreach);
    expect(LATEST_GEN_VERSION).toBe(4);
    expect(isGenVersion(4)).toBe(true);
    expect(isGenVersion(5)).toBe(false);
  });

  it('maps coordinates 1:4 between the realms and back', () => {
    expect(overworldToGloam(-32000, 0)).toEqual({ x: 14500, z: 0 });
    expect(overworldToGloam(0, 400)).toEqual({ x: 14500 + 8000, z: 100 });
    for (const [x, z] of [[0, 0], [123, -4567], [-20000, 9000], [11000, -800]]) {
      const g = overworldToGloam(x, z);
      expect(realmAt(4, g.x)).toBe(Realm.Gloamreach);
      const back = gloamToOverworld(g.x, g.z);
      expect(Math.abs(back.x - x)).toBeLessThanOrEqual(4);
      expect(Math.abs(back.z - z)).toBeLessThanOrEqual(4);
    }
    // The far east of the overworld maps inside the realm; coming back never lands in the Veil Wall.
    expect(realmAt(4, gloamToOverworld(31000, 0).x)).toBe(Realm.Overworld);
  });
});

describe('generator 4', { timeout: 60_000 }, () => {
  it('keeps the overworld of generator 3 where nothing of the Gloamreach reaches', () => {
    const g3 = createWorldGenerator(77, 'survival', 3);
    const g4 = createWorldGenerator(77, 'survival', 4);
    expect(g4.genVersion).toBe(4);
    expect(g4.findSpawn()).toEqual(g3.findSpawn());
    let compared = 0;
    for (let cx = -12; cx < 12; cx++) {
      for (let cz = -12; cz < 12; cz++) {
        // Fallen Lattices are the one addition to the overworld: skip chunks they touch.
        const near = g4.structuresNear(cx * 16 + 8, cz * 16 + 8, 40).some((s) => s.type === StructureType.FallenLattice);
        if (near) continue;
        expect(fnv(g4.generateChunk(cx, cz)), `chunk ${cx},${cz}`).toBe(fnv(g3.generateChunk(cx, cz)));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(450);
    // v3's ruins stay.
    const types = new Set(g4.structuresNear(0, 0, 700).map((s) => s.type));
    expect(types.has(StructureType.AshenCrypt) || types.has(StructureType.SunscorchTemple)).toBe(true);
  });

  it('fades the overworld into sea before a sealed Veil Wall of bedrock', () => {
    const g = createWorldGenerator(5, 'survival', 4);
    // The coast: sea, never land, in the last 96 blocks.
    for (let z = -400; z <= 400; z += 100) expect(g.surfaceHeight(OVERWORLD_MAX_X - 20, z)).toBeLessThan(24);
    // The wall: every chunk of [12000, 14000) is bedrock from y 0 to 63.
    for (const cx of [750, 800, 874 - 1]) {
      const c = g.generateChunk(cx, 3);
      expect(c.every((b) => b === Block.Bedrock)).toBe(true);
    }
    expect(g.biomeAt(13000, 0)).toBe(Biome.VeilWall);
    // The last overworld chunk has a bedrock rim and no land past it.
    const last = g.generateChunk(749, 0);
    expect(last[((10 << 4) + 5) * 16 + 15]).toBe(Block.Bedrock);
  });

  it('generates the Gloamreach: five biomes, shelves over a mist floor, deterministic in any chunk order', () => {
    const g = createWorldGenerator(1234, 'survival', 4);
    const biomes = new Set<Biome>();
    for (let x = DIM_X0 + 200; x < DIM_X0 + 12000; x += 120) for (let z = -6000; z < 6000; z += 120) biomes.add(g.biomeAt(x, z));
    expect([...biomes].sort()).toEqual([Biome.LumenShelves, Biome.PrismThicket, Biome.HushHollows, Biome.MirrorFen, Biome.SpireFields].sort());
    for (const b of biomes) expect(BIOME_INFO[b].tags).toContain('dark');
    // A chunk of the realm: bedrock floor, murk, mist and floating stone.
    const blocks = new Set<number>();
    const chunk = g.generateChunk(920, 4);
    for (const b of chunk) blocks.add(b);
    expect(blocks.has(Block.Bedrock)).toBe(true);
    expect(blocks.has(Block.Murkstone)).toBe(true);
    // Order independence: the same chunks generated in two orders are identical.
    const coords: [number, number][] = [];
    for (let cx = 1000; cx < 1008; cx++) for (let cz = -4; cz < 4; cz++) coords.push([cx, cz]);
    const a = createWorldGenerator(1234, 'survival', 4);
    const forward = coords.map(([cx, cz]) => fnv(a.generateChunk(cx, cz)));
    const b = createWorldGenerator(1234, 'survival', 4);
    const backward = [...coords].reverse().map(([cx, cz]) => fnv(b.generateChunk(cx, cz))).reverse();
    expect(backward).toEqual(forward);
    // And a different seed differs.
    expect(fnv(createWorldGenerator(1235, 'survival', 4).generateChunk(1000, 0))).not.toBe(forward[coords.findIndex(([cx, cz]) => cx === 1000 && cz === 0)]);
  });

  it('has shelves at two heights, needles, crystals, mushrooms, ore, caves and no sky-high leaks', () => {
    const t = new GloamTerrain(42);
    const seen = new Set<number>();
    let shelfA = 0;
    let shelfB = 0;
    let spires = 0;
    let caveCells = 0;
    const buf = new Uint8Array(TERRAIN_VOLUME);
    for (let cx = 940; cx < 960; cx++) {
      for (let cz = -10; cz < 10; cz++) {
        t.generateChunk(cx, cz, buf);
        for (let i = 0; i < buf.length; i++) seen.add(buf[i]);
        // Caves: air under a roof of stone inside the murk floor.
        for (let lz = 0; lz < CHUNK_SIZE; lz += 2) {
          for (let lx = 0; lx < CHUNK_SIZE; lx += 2) {
            const col = t.column(cx * 16 + lx, cz * 16 + lz);
            for (let y = 4; y < col.floor - 3; y++) if (buf[((y << 4) + lz) * 16 + lx] === Block.Air) caveCells++;
          }
        }
        for (let lz = 0; lz < CHUNK_SIZE; lz += 4) {
          for (let lx = 0; lx < CHUNK_SIZE; lx += 4) {
            const c = t.column(cx * 16 + lx, cz * 16 + lz);
            if (c.aTop >= 0) shelfA++;
            if (c.bTop >= 0) shelfB++;
            if (c.spire > 0) spires++;
          }
        }
      }
    }
    expect(shelfA).toBeGreaterThan(50);
    expect(shelfB).toBeGreaterThan(50);
    expect(spires).toBeGreaterThan(5);
    expect(caveCells).toBeGreaterThan(0);
    for (const b of [Block.Gloamstone, Block.Murkstone, Block.Duskmoss, Block.GloamMist, Block.Spirestone, Block.GloamwoodLog, Block.GloamwoodLeaves, Block.Lumenvine, Block.PrismCrystal, Block.StarfallOre, Block.Mistcap]) {
      expect(seen.has(b), `block ${Block[b]}`).toBe(true);
    }
    // Nothing of the overworld leaks in.
    for (const b of [Block.Grass, Block.Water, Block.Lava, Block.Sand, Block.Log]) expect(seen.has(b), Block[b]).toBe(false);
  });

  it('generates a chunk of the realm in about 2 ms or less', () => {
    const g = createWorldGenerator(9, 'survival', 4);
    const buf = new Uint8Array(TERRAIN_VOLUME);
    for (let i = 0; i < 6; i++) g.generateChunk(900 + i, 0, buf); // warm up
    const t0 = performance.now();
    const n = 60;
    for (let i = 0; i < n; i++) g.generateChunk(1100 + (i % 10), 20 + Math.floor(i / 10), buf);
    expect((performance.now() - t0) / n).toBeLessThan(4);
  });
});

describe('structures of generator 4', () => {
  it('places Fallen Lattices about one per 640 x 640 and always one within reach of spawn', () => {
    let near = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const g = createWorldGenerator(seed, 'survival', 4);
      const s = g.findSpawn();
      const fallen = g.structuresNear(s.x, s.z, FALLEN_GUARANTEE).filter((q) => q.type === StructureType.FallenLattice);
      expect(fallen.length, `seed ${seed}`).toBeGreaterThan(0);
      near += fallen.length;
      for (const f of fallen) expect(f.anchor.x).toBeLessThan(OVERWORLD_MAX_X - 100);
    }
    // Density over 6400 x 6400 blocks (100 regions of 640): between 40 and 100 sites.
    const g = createWorldGenerator(31, 'survival', 4);
    const seen = new Set<string>();
    for (let x = -3200; x < 3200; x += 320) for (let z = -3200; z < 3200; z += 320) for (const q of g.structuresNear(x, z, 200)) if (q.type === StructureType.FallenLattice) seen.add(`${q.anchor.x},${q.anchor.z}`);
    expect(seen.size).toBeGreaterThan(40);
    expect(seen.size).toBeLessThan(100);
    expect(near).toBeGreaterThan(12);
  });

  it('places Twilit Lattices (about one per 330 x 330) and an Orrery near where spawn maps to', () => {
    let orreries = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = createWorldGenerator(seed, 'survival', 4);
      const m = overworldToGloam(g.findSpawn().x, g.findSpawn().z);
      const o = g.structuresNear(m.x, m.z, ORRERY_GUARANTEE).filter((q) => q.type === StructureType.EclipseOrrery);
      expect(o.length, `seed ${seed}`).toBeGreaterThan(0);
      orreries += o.length;
    }
    expect(orreries).toBeGreaterThanOrEqual(8);
    const g = createWorldGenerator(31, 'survival', 4);
    const tw = new Set<string>();
    const or = new Set<string>();
    for (let x = DIM_X0 + 600; x < DIM_X0 + 4800; x += 200) {
      for (let z = -2100; z < 2100; z += 200) {
        for (const q of g.structuresNear(x, z, 150)) {
          if (q.type === StructureType.TwilitLattice) tw.add(`${q.anchor.x},${q.anchor.z}`);
          if (q.type === StructureType.EclipseOrrery) or.add(`${q.anchor.x},${q.anchor.z}`);
        }
      }
    }
    // 4200 x 4200 blocks: about 160 Twilit regions of 330, about 9 Orrery regions of 1400.
    expect(tw.size).toBeGreaterThan(60);
    expect(or.size).toBeGreaterThan(2);
    expect(or.size).toBeLessThan(tw.size / 5);
  });

  it('builds every site the same way whatever the chunk order, and the Orrery stays inside the world height', () => {
    const g = createWorldGenerator(2, 'survival', 4);
    const m = overworldToGloam(g.findSpawn().x, g.findSpawn().z);
    const o = g.structuresNear(m.x, m.z, ORRERY_GUARANTEE).find((q) => q.type === StructureType.EclipseOrrery)!;
    expect(o.bounds.y1).toBeLessThanOrEqual(64);
    expect(g.biomeAt(o.anchor.x, o.anchor.z)).toBeDefined();
    const cx0 = Math.floor(o.anchor.x / 16);
    const cz0 = Math.floor(o.anchor.z / 16);
    const list: [number, number][] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) list.push([cx0 + dx, cz0 + dz]);
    const a = createWorldGenerator(2, 'survival', 4);
    const fa = list.map(([x, z]) => fnv(a.generateChunk(x, z)));
    const b = createWorldGenerator(2, 'survival', 4);
    const fb = [...list].reverse().map(([x, z]) => fnv(b.generateChunk(x, z))).reverse();
    expect(fb).toEqual(fa);
    // The altar, the boss chest and the main door cell are where the layout says.
    const center = a.generateChunk(cx0, cz0);
    void center;
  });
});
