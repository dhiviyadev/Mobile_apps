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
import { meshChunk, PAD, paddedIndex, PADDED_VOLUME } from '../src/voxel/mesher';

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
  const emptyVol = () => new Uint8Array(PADDED_VOLUME);

  it('emits 6 quads for a single block', () => {
    const vol = emptyVol();
    vol[paddedIndex(5, 10, 5)] = Block.Stone;
    const m = meshChunk(vol);
    expect(m.opaque.vertexCount).toBe(24);
    expect(m.opaque.indices.length).toBe(36);
    expect(m.liquid.vertexCount).toBe(0);
  });

  it('merges a flat 16x16 floor into very few quads', () => {
    const vol = emptyVol();
    for (let x = -1; x <= 16; x++) for (let z = -1; z <= 16; z++) vol[paddedIndex(x, 0, z)] = Block.Stone;
    const m = meshChunk(vol);
    // Top face is one quad; sides are hidden by the padded neighbours; bottom is the world floor.
    expect(m.opaque.vertexCount).toBe(4);
  });

  it('culls faces between neighbours and keeps faces against the padding border', () => {
    const vol = emptyVol();
    vol[paddedIndex(15, 5, 0)] = Block.Stone;
    vol[paddedIndex(16, 5, 0)] = Block.Stone; // in the neighbour chunk
    const m = meshChunk(vol);
    expect(m.opaque.vertexCount).toBe(5 * 4); // +X face hidden by the neighbour
  });

  it('meshes water separately and lowers surface water', () => {
    const vol = emptyVol();
    vol[paddedIndex(3, 4, 3)] = Block.Water;
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
    vol[paddedIndex(4, 0, 4)] = Block.Stone;
    vol[paddedIndex(5, 1, 4)] = Block.Stone; // wall beside the top face
    const m = meshChunk(vol);
    const lights = new Set<number>();
    for (let i = 0; i < m.opaque.vertexCount; i++) lights.add(m.opaque.lights[i * 2]);
    expect(lights.size).toBeGreaterThan(3);
  });

  it('meshes a real terrain chunk fast enough for a worker', () => {
    const gen = new TerrainGenerator(99);
    const vol = new Uint8Array(PADDED_VOLUME);
    const chunks = new Map<string, Uint8Array>();
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) chunks.set(`${cx},${cz}`, gen.generateChunk(cx, cz));
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      for (let z = -1; z <= CHUNK_SIZE; z++) {
        for (let x = -1; x <= CHUNK_SIZE; x++) {
          const cx = Math.floor(x / 16);
          const cz = Math.floor(z / 16);
          const c = chunks.get(`${cx},${cz}`)!;
          vol[(y * PAD + (z + 1)) * PAD + (x + 1)] = c[blockIndex(x - cx * 16, y, z - cz * 16)];
        }
      }
    }
    const t0 = performance.now();
    const m = meshChunk(vol);
    const ms = performance.now() - t0;
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
