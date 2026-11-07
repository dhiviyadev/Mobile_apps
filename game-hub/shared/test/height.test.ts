/** Build height 256: chunk arrays, generated terrain, meshing and light of tall builds. */
import { describe, expect, it } from 'vitest';
import {
  Block,
  blockIndex,
  blockInWorld,
  CHUNK_HEIGHT,
  CHUNK_LAYER,
  CHUNK_SIZE,
  chunkBlock,
  chunkLayers,
  createWorldGenerator,
  decodeEdits,
  decodeWorld,
  encodeEdits,
  encodeWorld,
  ensureLayers,
  packPos,
  SECTION_HEIGHT,
  TERRAIN_HEIGHT,
  TERRAIN_VOLUME,
  topOfContent,
  unpackPos,
} from '../src';
import { decodeEntitySnapshot, encodeEntitySnapshot } from '../src/voxel/entities/net';
import { buildRegion, type ChunkMesh, meshChunk, meshStats, REGION_LAYER, regionIndex, regionLayers } from '../src/voxel/mesher';

const BRICK = Block.Brick;

/** The 3x3 chunks around (cx, cz), row by row (buildRegion order). */
function around(gen: ReturnType<typeof createWorldGenerator>, cx: number, cz: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push(gen.generateChunk(cx + dx, cz + dz));
  return out;
}

const fingerprint = (m: ChunkMesh): string => {
  let h = 0x811c9dc5;
  for (const b of [m.opaque, m.liquid]) {
    for (const a of [b.positions, b.uvs, b.tiles, b.lights, b.indices]) {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    }
  }
  return `${m.opaque.vertexCount}/${m.liquid.vertexCount}/${h >>> 0}`;
};

describe('build height', () => {
  it('is 256 everywhere, within what edits and saves store', () => {
    expect(CHUNK_HEIGHT).toBe(256);
    expect(blockInWorld(0, 255, 0)).toBe(true);
    expect(blockInWorld(0, 256, 0)).toBe(false);
    expect(blockInWorld(0, -1, 0)).toBe(false);
    for (const p of [[3, 255, -7], [-31999, 200, 31999], [0, 64, 0]] as [number, number, number][]) expect(unpackPos(packPos(...p))).toEqual(p);
    const edits = [{ x: 1, y: 255, z: -2, id: BRICK }, { x: -300, y: 200, z: 9, id: Block.Glass }];
    expect(decodeEdits(encodeEdits(edits, true), true)).toEqual(edits);
  });

  it('keeps a saved world file with blocks at y 200+ intact', () => {
    const edits = [{ x: 4, y: 230, z: 4, id: BRICK }, { x: 4, y: 255, z: 4, id: Block.Lamp }, { x: 5, y: 3, z: 5, id: Block.Air }];
    const file = encodeWorld({ id: 'TALL23', seed: 77, mode: 'sandbox', private: true, timeOfDay: 0.4, savedAt: 1_700_000_000_000, edits: encodeEdits(edits, true), genVersion: 3 });
    const back = decodeWorld('TALL23', file);
    expect(decodeEdits(back.edits, true)).toEqual(edits);
  });

  it('sends creature positions up at the build height', () => {
    const snap = { tick: 7, mobs: [], projectiles: [{ id: 3, kind: 1, flags: 0, x: 10.5, y: 250.25, z: -4, vx: 0, vy: -3, vz: 0 }], hazards: [], bosses: [] };
    const back = decodeEntitySnapshot(encodeEntitySnapshot(snap as never), { x: 10, z: -4 });
    expect(back.projectiles[0].y).toBeCloseTo(250.25, 1);
  });
});

describe('chunk arrays', () => {
  it('hold whole sections up to what is built; everything above reads as air', () => {
    const c = new Uint8Array(TERRAIN_VOLUME);
    c[blockIndex(1, 63, 2)] = BRICK;
    expect(chunkLayers(c)).toBe(64);
    expect(chunkBlock(c, 1, 63, 2)).toBe(BRICK);
    expect(chunkBlock(c, 1, 200, 2)).toBe(Block.Air);
    expect(ensureLayers(c, 63)).toBe(c); // already tall enough: the same array
    const grown = ensureLayers(c, 200);
    expect(chunkLayers(grown)).toBe(208); // the section holding y 200
    expect(chunkLayers(grown) % SECTION_HEIGHT).toBe(0);
    expect(grown.subarray(0, c.length)).toEqual(c);
    expect(grown.subarray(c.length).every((b) => b === 0)).toBe(true);
    expect(chunkLayers(ensureLayers(c, 255))).toBe(CHUNK_HEIGHT);
    grown[blockIndex(0, 199, 0)] = BRICK;
    expect(topOfContent(grown, CHUNK_LAYER)).toBe(200);
    expect(topOfContent(new Uint8Array(CHUNK_LAYER * 32), CHUNK_LAYER)).toBe(0);
  });

  it('come from every generator 64 high, with layers 64..255 air', () => {
    for (const [mode, gen] of [['sandbox', 1], ['sandbox', 2], ['sandbox', 3], ['survival', 3], ['parkour', 3]] as const) {
      const g = createWorldGenerator(2024, mode, gen);
      for (const [cx, cz] of [[0, 0], [3, -2], [-5, 7]]) {
        const c = g.generateChunk(cx, cz);
        expect(c.length, `${mode} v${gen}`).toBe(TERRAIN_VOLUME);
        expect(chunkLayers(c)).toBe(TERRAIN_HEIGHT);
        for (let y = TERRAIN_HEIGHT; y < CHUNK_HEIGHT; y++) {
          for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) if (chunkBlock(c, x, y, z) !== Block.Air) throw new Error(`${mode} v${gen}: block at ${x},${y},${z}`);
        }
      }
    }
  });
});

describe('meshing tall builds', () => {
  const gen = createWorldGenerator(12345, 'sandbox', 3);

  it('meshes plain terrain exactly as before: 64-high regions, the same mesh in a taller region', () => {
    const chunks = around(gen, 3, -2);
    const region = buildRegion(chunks);
    expect(regionLayers(region)).toBe(TERRAIN_HEIGHT);
    const plain = meshChunk(region);
    expect(meshStats.regionLayers).toBe(64);
    // A neighbour grown to the full height (but empty up there) changes nothing in this mesh or its light.
    chunks[0] = ensureLayers(chunks[0], CHUNK_HEIGHT - 1);
    const tall = buildRegion(chunks);
    expect(regionLayers(tall)).toBe(CHUNK_HEIGHT);
    const again = meshChunk(tall);
    expect(meshStats.lightLayers).toBeLessThanOrEqual(64 + 15);
    expect(fingerprint(again)).toBe(fingerprint(plain));
    // Its light reaches a little higher (the box stops 15 layers above the terrain), with the same values.
    expect(again.light.subarray(0, plain.light.length)).toEqual(plain.light);
    expect(again.light.subarray(plain.light.length).every((l) => l === 0xf0)).toBe(true);
  });

  it('skips the empty sections between the terrain and a block floating at y 250', () => {
    const chunks = around(gen, 3, -2);
    chunks[4] = ensureLayers(chunks[4], 250);
    const base = meshChunk(buildRegion(around(gen, 3, -2)));
    const terrainSections = meshStats.sections;
    chunks[4][blockIndex(7, 250, 7)] = BRICK;
    const m = meshChunk(buildRegion(chunks));
    expect(meshStats.regionLayers).toBe(256);
    expect(meshStats.meshLayers).toBe(251);
    expect(meshStats.sections).toBe(terrainSections + 1); // only the section holding the block is added
    // One more cube: its 6 faces, at the right height.
    expect(m.opaque.vertexCount - base.opaque.vertexCount).toBe(24);
    let top = 0;
    for (let i = 1; i < m.opaque.positions.length; i += 3) top = Math.max(top, m.opaque.positions[i]);
    expect(top).toBe(251);
  });

  it('meshes and lights a tower to y 250 within a few times a plain chunk', () => {
    const chunks = around(gen, 3, -2);
    const plainRegion = buildRegion(chunks);
    const c = ensureLayers(chunks[4], 250);
    for (let y = 30; y <= 250; y++) for (let x = 6; x <= 8; x++) for (let z = 6; z <= 8; z++) if (c[blockIndex(x, y, z)] === Block.Air) c[blockIndex(x, y, z)] = BRICK;
    chunks[4] = c;
    const towerRegion = buildRegion(chunks);
    const time = (region: Uint8Array) => {
      for (let i = 0; i < 3; i++) meshChunk(region);
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) meshChunk(region);
      return (performance.now() - t0) / 10;
    };
    const plainMs = time(plainRegion);
    const towerMs = time(towerRegion);
    console.log(`[height] light + mesh: plain v3 chunk ${plainMs.toFixed(2)} ms, with a tower to y 250 ${towerMs.toFixed(2)} ms`);
    expect(towerMs).toBeLessThan(plainMs * 4 + 2);
  });

  it('shades the ground under a tall roof and lights the roof top like open sky', () => {
    // Stone ground at y 0..9 across the region, a roof at y 200 over all of it, a lamp on the roof.
    const region = new Uint8Array(REGION_LAYER * CHUNK_HEIGHT);
    for (let x = -16; x < 32; x++) {
      for (let z = -16; z < 32; z++) {
        for (let y = 0; y < 10; y++) region[regionIndex(x, y, z)] = Block.Stone;
        region[regionIndex(x, 200, z)] = Block.Stone;
      }
    }
    region[regionIndex(8, 201, 8)] = Block.Lamp;
    const { light } = meshChunk(region);
    const at = (x: number, y: number, z: number) => {
      const i = blockIndex(x, y, z);
      return i < light.length ? light[i] : 0xf0; // above the light box: open sky
    };
    expect(at(8, 100, 8) >> 4).toBe(0); // no sky light under the roof
    expect(at(8, 10, 8) >> 4).toBe(0);
    expect(at(3, 201, 3) >> 4).toBe(15); // on the roof: open sky
    expect(at(9, 201, 8) & 15).toBe(14); // next to the lamp
    expect(at(8, 230, 8)).toBe(0xf0); // far above everything: open sky, no lamp light
    expect(light.length).toBe(CHUNK_LAYER * Math.min(CHUNK_HEIGHT, 202 + 15));
  });
});
