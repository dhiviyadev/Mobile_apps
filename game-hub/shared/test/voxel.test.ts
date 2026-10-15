import { describe, expect, it } from 'vitest';
import {
  Block,
  blockIndex,
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  CHUNK_VOLUME,
  collides,
  createBody,
  createWorldGenerator,
  generateParkourCourse,
  maxJumpDistance,
  packPos,
  PLAYER_EYE,
  raycastVoxels,
  SEA_LEVEL,
  stepBody,
  TerrainGenerator,
  unpackPos,
  VOXEL_PHYSICS,
} from '../src';
import { buildRegion, type MeshBuffers, meshChunk, REGION_SIZE, REGION_VOLUME, regionIndex } from '../src/voxel/mesher';

/** A tiny sparse world for physics/raycast tests. */
function sparseWorld(blocks: [number, number, number, number][]) {
  const map = new Map<number, number>();
  for (const [x, y, z, b] of blocks) map.set(packPos(x, y, z), b);
  return (x: number, y: number, z: number) => (y < 0 ? Block.Bedrock : (map.get(packPos(x, y, z)) ?? 0));
}

function floor(size: number, y = 0, extra: [number, number, number, number][] = []) {
  const blocks: [number, number, number, number][] = [];
  for (let x = -size; x <= size; x++) for (let z = -size; z <= size; z++) blocks.push([x, y, z, Block.Stone]);
  return sparseWorld([...blocks, ...extra]);
}

const still = { strafe: 0, forward: 0, yaw: 0, jump: false, sprint: false, crouch: false, autoJump: false };

describe('chunk helpers', () => {
  it('packs and unpacks positions', () => {
    for (const p of [[0, 0, 0], [-511, 63, 300], [12345, 7, -9999]] as [number, number, number][]) {
      expect(unpackPos(packPos(...p))).toEqual(p);
    }
  });
});

describe('terrain generator', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new TerrainGenerator(1234).generateChunk(3, -2);
    const b = new TerrainGenerator(1234).generateChunk(3, -2);
    const c = new TerrainGenerator(999).generateChunk(3, -2);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('produces bedrock, a surface, and water at sea level in low areas', () => {
    const gen = new TerrainGenerator(42);
    let sawWater = false;
    let sawGrass = false;
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const chunk = gen.generateChunk(cx, cz);
        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
          expect(chunk[i]).toBe(Block.Bedrock); // y = 0 layer
        }
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          if (chunk[i] === Block.Water) sawWater = true;
          if (chunk[i] === Block.Grass) sawGrass = true;
        }
      }
    }
    expect(sawGrass).toBe(true);
    expect(sawWater).toBe(true);
  });

  it('carves some caves', () => {
    const gen = new TerrainGenerator(7);
    let caveAir = 0;
    for (let cx = 0; cx < 4; cx++) {
      const chunk = gen.generateChunk(cx, 0);
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 2; y < 15; y++) if (chunk[blockIndex(x, y, z)] === Block.Air) caveAir++;
    }
    expect(caveAir).toBeGreaterThan(20);
  });

  it('chooses a dry spawn', () => {
    const gen = new TerrainGenerator(5);
    const s = gen.findSpawn();
    expect(s.y).toBeGreaterThan(SEA_LEVEL + 1);
    expect(gen.column(Math.floor(s.x), Math.floor(s.z)).height).toBe(s.y - 1);
  });

  it('generates a chunk quickly', () => {
    const gen = new TerrainGenerator(1);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) gen.generateChunk(i, i);
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(40);
  });
});

describe('greedy mesher', () => {
  const emptyVol = () => new Uint8Array(REGION_VOLUME);
  /** Sky / block light bytes of every non-emissive vertex matching `filter` (position x, y, z). */
  const vertexLight = (m: MeshBuffers, filter: (x: number, y: number, z: number) => boolean) => {
    const out: { sky: number; block: number }[] = [];
    for (let i = 0; i < m.vertexCount; i++) {
      if (m.lights[i * 4 + 3] === 0 && filter(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2])) {
        out.push({ sky: m.lights[i * 4 + 1], block: m.lights[i * 4 + 2] });
      }
    }
    return out;
  };

  it('indexes the 3x3 chunk region', () => {
    expect(REGION_SIZE).toBe(48);
    expect(REGION_VOLUME).toBe(48 * 48 * CHUNK_HEIGHT);
    expect(regionIndex(-16, 0, -16)).toBe(0);
    expect(regionIndex(31, CHUNK_HEIGHT - 1, 31)).toBe(REGION_VOLUME - 1);
    const chunks: (Uint8Array | null)[] = [...Array(9)].map((_, i) => new Uint8Array(CHUNK_VOLUME).fill(i + 1));
    chunks[0] = null;
    const region = buildRegion(chunks);
    expect(region[regionIndex(-16, 3, -16)]).toBe(0); // missing chunk reads as air
    expect(region[regionIndex(0, 3, -16)]).toBe(2);
    expect(region[regionIndex(5, 3, 5)]).toBe(5);
    expect(region[regionIndex(16, 3, 31)]).toBe(9);
    expect(region[regionIndex(-1, 3, 16)]).toBe(7);
  });

  it('emits 6 quads for a single block', () => {
    const vol = emptyVol();
    vol[regionIndex(5, 10, 5)] = Block.Stone;
    const m = meshChunk(vol);
    expect(m.opaque.vertexCount).toBe(24);
    expect(m.opaque.indices.length).toBe(36);
    expect(m.liquid.vertexCount).toBe(0);
  });

  it('merges a flat 16x16 floor into very few quads', () => {
    const vol = emptyVol();
    for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) vol[regionIndex(x, 0, z)] = Block.Stone;
    const m = meshChunk(vol);
    // Top face is one quad; sides are hidden by the neighbours; bottom is the world floor.
    expect(m.opaque.vertexCount).toBe(4);
  });

  it('culls faces between neighbours and keeps faces against the chunk border', () => {
    const vol = emptyVol();
    vol[regionIndex(15, 5, 0)] = Block.Stone;
    vol[regionIndex(16, 5, 0)] = Block.Stone; // in the neighbour chunk
    const m = meshChunk(vol);
    expect(m.opaque.vertexCount).toBe(5 * 4); // +X face hidden by the neighbour
  });

  it('meshes water separately and lowers surface water', () => {
    const vol = emptyVol();
    vol[regionIndex(3, 4, 3)] = Block.Water;
    const m = meshChunk(vol);
    expect(m.opaque.vertexCount).toBe(0);
    expect(m.liquid.vertexCount).toBe(24);
    const ys = new Set<number>();
    for (let i = 0; i < m.liquid.vertexCount; i++) ys.add(m.liquid.positions[i * 3 + 1]);
    expect(ys.has(4.875)).toBe(true);
    expect(ys.has(5)).toBe(false);
  });

  it('applies ambient occlusion next to walls', () => {
    const vol = emptyVol();
    vol[regionIndex(4, 0, 4)] = Block.Stone;
    vol[regionIndex(5, 1, 4)] = Block.Stone; // wall beside the top face
    const m = meshChunk(vol);
    const lights = new Set<number>();
    for (let i = 0; i < m.opaque.vertexCount; i++) lights.add(m.opaque.lights[i * 4]);
    expect(lights.size).toBeGreaterThan(3);
  });

  it('bakes sky and block light into vertices', () => {
    const vol = emptyVol();
    // Solid ground up to y = 9 with two sealed one-block pockets; one holds a lamp neighbour.
    for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) for (let y = 0; y < 10; y++) vol[regionIndex(x, y, z)] = Block.Stone;
    vol[regionIndex(3, 5, 3)] = Block.Air; // dark pocket
    vol[regionIndex(10, 5, 10)] = Block.Air; // lamp-lit pocket
    vol[regionIndex(11, 5, 10)] = Block.Lamp;
    const m = meshChunk(vol);
    const inPocket = (px: number, pz: number) => (x: number, y: number, z: number) => x >= px && x <= px + 1 && z >= pz && z <= pz + 1 && y >= 5 && y <= 6;
    const surface = vertexLight(m.opaque, (_x, y) => y === 10);
    const dark = vertexLight(m.opaque, inPocket(3, 3));
    const lamp = vertexLight(m.opaque, (x, y, z) => inPocket(10, 10)(x, y, z) && x <= 11);
    expect(surface.length).toBeGreaterThan(0);
    expect(surface.every((l) => l.sky === 255 && l.block === 0)).toBe(true);
    expect(dark.length).toBe(24);
    expect(dark.every((l) => l.sky === 0 && l.block === 0)).toBe(true);
    expect(lamp.length).toBeGreaterThan(0);
    expect(lamp.every((l) => l.sky === 0 && l.block === 14 * 17)).toBe(true);
    // The lamp's own faces stay full-bright.
    let emissive = 0;
    for (let i = 0; i < m.opaque.vertexCount; i++) if (m.opaque.lights[i * 4 + 3] === 255) emissive++;
    expect(emissive).toBe(4); // only the face looking into the pocket is visible
  });

  it('does not merge faces with different light', () => {
    // A floor under a roof with a skylight: the floor brightens towards the hole.
    const vol = emptyVol();
    for (let x = -16; x < 32; x++) {
      for (let z = -16; z < 32; z++) {
        vol[regionIndex(x, 0, z)] = Block.Stone;
        vol[regionIndex(x, 4, z)] = Block.Stone;
      }
    }
    vol[regionIndex(12, 4, 12)] = Block.Air;
    const m = meshChunk(vol);
    const floor: number[] = [];
    let lit = 0;
    for (let q = 0; q < m.opaque.vertexCount; q += 4) {
      if (m.opaque.positions[q * 3 + 1] !== 1 || m.opaque.positions[(q + 2) * 3 + 1] !== 1) continue;
      floor.push(q);
      const sky = [0, 1, 2, 3].map((k) => m.opaque.lights[(q + k) * 4 + 1]);
      if (sky.some((s) => s > 0)) lit++;
      // Merged quads (bigger than one block) must carry uniform light.
      const xs = [0, 1, 2, 3].map((k) => m.opaque.positions[(q + k) * 3]);
      const zs = [0, 1, 2, 3].map((k) => m.opaque.positions[(q + k) * 3 + 2]);
      const big = Math.max(...xs) - Math.min(...xs) > 1 || Math.max(...zs) - Math.min(...zs) > 1;
      if (big) expect(new Set(sky).size).toBe(1);
    }
    expect(lit).toBeGreaterThan(50);
    expect(floor.length).toBeGreaterThan(lit);
    // Under the skylight the floor is bright; far away it is dark.
    const under = vertexLight(m.opaque, (x, y, z) => y === 1 && x >= 12 && x <= 13 && z >= 12 && z <= 13);
    expect(Math.min(...under.map((l) => l.sky))).toBeGreaterThan(200);
    const corner = vertexLight(m.opaque, (x, y, z) => y === 1 && x === 0 && z === 0);
    expect(corner.every((l) => l.sky < under[0].sky)).toBe(true);
  });

  it('meshes and lights a real terrain region fast enough for a worker', () => {
    const gen = new TerrainGenerator(99);
    const chunks: Uint8Array[] = [];
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) chunks.push(gen.generateChunk(cx, cz));
    const region = buildRegion(chunks);
    const center = chunks[4];
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) expect(region[regionIndex(x, y, z)]).toBe(center[blockIndex(x, y, z)]);
      }
    }
    meshChunk(region); // warm up the JIT
    const runs = 5;
    const t0 = performance.now();
    let m = meshChunk(region);
    for (let i = 1; i < runs; i++) m = meshChunk(region);
    const ms = (performance.now() - t0) / runs;
    console.log(`[mesher] light + mesh of one 48x64x48 region: ${ms.toFixed(2)} ms, ${m.opaque.vertexCount + m.liquid.vertexCount} vertices`);
    expect(m.opaque.vertexCount).toBeGreaterThan(100);
    expect(ms).toBeLessThan(80);
  });
});

describe('player physics', () => {
  it('falls and lands on the ground', () => {
    const get = floor(4);
    const body = createBody(0.5, 5, 0.5);
    for (let i = 0; i < 120; i++) stepBody(body, still, get, 1 / 60, PLAYER_EYE);
    expect(body.y).toBeCloseTo(1, 5);
    expect(body.onGround).toBe(true);
  });

  it('jumps about 1.25 blocks high', () => {
    const get = floor(4);
    const body = createBody(0.5, 1, 0.5);
    stepBody(body, still, get, 1 / 60, PLAYER_EYE);
    let peak = 0;
    stepBody(body, { ...still, jump: true }, get, 1 / 60, PLAYER_EYE);
    for (let i = 0; i < 60; i++) {
      stepBody(body, still, get, 1 / 60, PLAYER_EYE);
      peak = Math.max(peak, body.y - 1);
    }
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.45);
  });

  it('cannot walk through walls', () => {
    const wall: [number, number, number, number][] = [];
    for (let z = -4; z <= 4; z++) for (let y = 1; y <= 3; y++) wall.push([3, y, z, Block.Stone]);
    const get = floor(6, 0, wall);
    const body = createBody(0.5, 1, 0.5);
    for (let i = 0; i < 180; i++) stepBody(body, { ...still, strafe: 1, yaw: 0 }, get, 1 / 60, PLAYER_EYE);
    expect(body.x).toBeLessThanOrEqual(3 - 0.3 + 1e-3);
    expect(collides(get, body.x, body.y, body.z)).toBe(false);
  });

  it('auto-jumps onto a single step but not a 2-high wall', () => {
    const step: [number, number, number, number][] = [];
    for (let x = 3; x <= 8; x++) for (let z = -4; z <= 4; z++) step.push([x, 1, z, Block.Stone]);
    const body = createBody(0.5, 1, 0.5);
    const get = floor(8, 0, step);
    for (let i = 0; i < 60; i++) stepBody(body, { ...still, strafe: 1, autoJump: true }, get, 1 / 60, PLAYER_EYE);
    expect(body.x).toBeGreaterThan(3);
    for (let i = 0; i < 30; i++) stepBody(body, still, get, 1 / 60, PLAYER_EYE);
    expect(body.y).toBeCloseTo(2, 3);

    const wall = [...step];
    for (let z = -4; z <= 4; z++) wall.push([3, 2, z, Block.Stone]);
    const body2 = createBody(0.5, 1, 0.5);
    const get2 = floor(8, 0, wall);
    for (let i = 0; i < 120; i++) stepBody(body2, { ...still, strafe: 1, autoJump: true }, get2, 1 / 60, PLAYER_EYE);
    expect(body2.x).toBeLessThan(3);
  });

  it('crouching stops you walking off an edge', () => {
    const get = sparseWorld([[0, 0, 0, Block.Stone]]);
    const body = createBody(0.5, 1, 0.5);
    for (let i = 0; i < 5; i++) stepBody(body, still, get, 1 / 60, PLAYER_EYE);
    for (let i = 0; i < 120; i++) stepBody(body, { ...still, strafe: 1, crouch: true }, get, 1 / 60, PLAYER_EYE);
    expect(body.y).toBeCloseTo(1, 3);
    expect(body.x).toBeLessThan(1.3);
  });

  it('swims up when jump is held in water', () => {
    const blocks: [number, number, number, number][] = [];
    for (let y = 1; y <= 6; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) blocks.push([x, y, z, Block.Water]);
    const get = floor(4, 0, blocks);
    const body = createBody(0.5, 1, 0.5);
    for (let i = 0; i < 60; i++) stepBody(body, { ...still, jump: true }, get, 1 / 60, PLAYER_EYE);
    expect(body.y).toBeGreaterThan(2);
    expect(body.inWater || body.y > 5).toBe(true);
  });

  it('respects the horizontal speed limit', () => {
    const get = floor(40);
    const body = createBody(0.5, 1, 0.5);
    for (let i = 0; i < 120; i++) stepBody(body, { ...still, forward: 1, sprint: true }, get, 1 / 60, PLAYER_EYE);
    expect(Math.hypot(body.vx, body.vz)).toBeCloseTo(VOXEL_PHYSICS.sprintSpeed, 3);
  });
});

describe('raycast', () => {
  it('hits the first solid block and reports the face', () => {
    const get = sparseWorld([[5, 1, 0, Block.Stone], [8, 1, 0, Block.Dirt]]);
    const hit = raycastVoxels(get, 0.5, 1.5, 0.5, 1, 0, 0, 10)!;
    expect(hit).toMatchObject({ x: 5, y: 1, z: 0, nx: -1, ny: 0, nz: 0, block: Block.Stone });
    expect(raycastVoxels(get, 0.5, 1.5, 0.5, -1, 0, 0, 10)).toBeNull();
  });

  it('ignores water and respects max distance', () => {
    const get = sparseWorld([[2, 1, 0, Block.Water], [4, 1, 0, Block.Stone]]);
    expect(raycastVoxels(get, 0.5, 1.5, 0.5, 1, 0, 0, 2.5)).toBeNull();
    expect(raycastVoxels(get, 0.5, 1.5, 0.5, 1, 0, 0, 5)?.block).toBe(Block.Stone);
  });
});

describe('parkour course', () => {
  it('is deterministic and every jump is within reach', () => {
    const a = generateParkourCourse(77);
    const b = generateParkourCourse(77);
    expect([...a.blocks.entries()]).toEqual([...b.blocks.entries()]);
    expect(a.checkpoints.length).toBeGreaterThan(4);
    expect(a.finish.length).toBe(25);

    // Walk the course blocks above cloud level in placement order and check spacing.
    const course = [...a.blocks.entries()]
      .map(([k, id]) => ({ p: unpackPos(k), id }))
      .filter((b) => b.id !== Block.Cloud || b.p[1] >= 38);
    const ys = course.map((c) => c.p[1]);
    expect(Math.min(...ys)).toBeGreaterThan(a.killY);
    // Every course block has another course block within a sprint jump.
    for (const c of course) {
      const near = course.some((o) => o !== c && Math.hypot(o.p[0] - c.p[0], o.p[2] - c.p[2]) <= maxJumpDistance(o.p[1] - c.p[1], true) + 0.01 && Math.abs(o.p[1] - c.p[1]) <= 1);
      expect(near).toBe(true);
    }
  });

  it('builds parkour chunks via the generator factory', () => {
    const gen = createWorldGenerator(5, 'parkour');
    expect(gen.course).not.toBeNull();
    const chunk = gen.generateChunk(0, 0);
    expect(chunk[blockIndex(0, 38, 0)]).toBe(Block.Checkpoint);
    expect(gen.findSpawn().y).toBe(39);
  });
});
